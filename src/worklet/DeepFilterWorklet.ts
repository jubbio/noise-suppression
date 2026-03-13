/**
 * DeepFilterWorklet — lightweight I/O bridge for audio processing.
 *
 * This worklet does NO WASM processing. It only:
 * 1. Collects input samples into frames (ring buffer)
 * 2. Sends complete frames to DeepFilterWorker via MessagePort
 * 3. Receives processed frames back and writes to output ring buffer
 * 4. Outputs processed samples from the output ring buffer
 *
 * All heavy WASM work (df_create, df_process_frame) runs in the Worker
 * on a separate thread, keeping the audio render thread unblocked.
 * This prevents WASAPI buffer underruns that disrupt other apps' audio.
 */

import { WorkletMessageTypes } from '../constants';

class DeepFilterAudioProcessor extends AudioWorkletProcessor {
  private inputBuffer: Float32Array;
  private outputBuffer: Float32Array;
  private inputWritePos = 0;
  private inputReadPos = 0;
  private outputWritePos = 0;
  private outputReadPos = 0;
  private bypass = true;
  private isReady = false;
  private bufferSize: number;
  private frameLength = 480; // Default, updated when Worker sends READY
  private tempFrame: Float32Array | null = null;

  // MessagePort to communicate with DeepFilterWorker
  private workerPort: MessagePort | null = null;

  // Track pending frames to avoid flooding the Worker
  private pendingFrames = 0;
  private readonly maxPendingFrames = 4;

  // Underrun protection: keep last good output frame for crossfade
  private lastGoodFrame: Float32Array | null = null;
  private underrunCount = 0;

  constructor() {
    super();

    this.bufferSize = 8192;
    this.inputBuffer = new Float32Array(this.bufferSize);
    this.outputBuffer = new Float32Array(this.bufferSize);

    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(data: any): void {
    switch (data.type) {
      case WorkletMessageTypes.SET_WORKER_PORT: {
        // Receive MessagePort for direct Worker communication
        this.workerPort = data.port;
        this.workerPort!.onmessage = (e: MessageEvent) => {
          if (e.data.type === 'PROCESSED') {
            this.onProcessedFrame(e.data.samples);
          }
        };
        break;
      }

      case WorkletMessageTypes.SET_FRAME_LENGTH: {
        // Worker finished init, tells us the frame length
        this.frameLength = data.value;
        this.bufferSize = this.frameLength * 12;
        this.inputBuffer = new Float32Array(this.bufferSize);
        this.outputBuffer = new Float32Array(this.bufferSize);
        this.tempFrame = new Float32Array(this.frameLength);
        this.lastGoodFrame = new Float32Array(128);
        // Pre-fill output with silence (2 frames worth of latency for underrun protection)
        this.outputWritePos = this.frameLength * 2;
        this.inputWritePos = 0;
        this.inputReadPos = 0;
        this.outputReadPos = 0;
        this.pendingFrames = 0;
        this.underrunCount = 0;
        this.isReady = true;
        this.port.postMessage({ type: 'READY' });
        break;
      }

      case WorkletMessageTypes.SET_BYPASS:
        this.bypass = Boolean(data.value);
        break;
    }
  }

  /**
   * Called when Worker sends back a processed frame.
   * Write it into the output ring buffer.
   */
  private onProcessedFrame(samples: Float32Array): void {
    this.pendingFrames = Math.max(0, this.pendingFrames - 1);

    for (let i = 0; i < samples.length; i++) {
      this.outputBuffer[this.outputWritePos] = samples[i];
      this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
    }
  }

  private getInputAvailable(): number {
    return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;
  }

  private getOutputAvailable(): number {
    return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;
  }

  process(inputList: Float32Array[][], outputList: Float32Array[][]): boolean {
    const sourceLimit = Math.min(inputList.length, outputList.length);
    const input = inputList[0]?.[0];
    if (!input) return true;

    // Passthrough mode
    if (!this.isReady || this.bypass || !this.workerPort || !this.tempFrame) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        for (let ch = 0; ch < output.length; ch++) {
          output[ch].set(input);
        }
      }
      return true;
    }

    // Write input to ring buffer
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputWritePos] = input[i];
      this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
    }

    // Send complete frames to Worker for processing
    while (
      this.getInputAvailable() >= this.frameLength &&
      this.pendingFrames < this.maxPendingFrames
    ) {
      for (let i = 0; i < this.frameLength; i++) {
        this.tempFrame![i] = this.inputBuffer[this.inputReadPos];
        this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
      }

      // Copy frame data (tempFrame is reused, need a copy for transfer)
      const frameCopy = new Float32Array(this.tempFrame!);
      this.workerPort.postMessage(
        { type: 'FRAME', samples: frameCopy },
        [frameCopy.buffer] // Transfer — zero-copy send
      );
      this.pendingFrames++;
    }

    // Read processed output
    const outputAvailable = this.getOutputAvailable();
    if (outputAvailable >= 128) {
      // Normal path — enough data in output buffer
      this.underrunCount = 0;
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        for (let ch = 0; ch < output.length; ch++) {
          const outputChannel = output[ch];
          let readPos = this.outputReadPos;
          for (let i = 0; i < 128; i++) {
            outputChannel[i] = this.outputBuffer[readPos];
            readPos = (readPos + 1) % this.bufferSize;
          }
        }
      }
      // Save last good output for underrun protection
      if (this.lastGoodFrame) {
        let readPos = this.outputReadPos;
        for (let i = 0; i < 128; i++) {
          this.lastGoodFrame[i] = this.outputBuffer[readPos];
          readPos = (readPos + 1) % this.bufferSize;
        }
      }
      this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;
    } else {
      // Underrun — Worker hasn't returned frame yet
      // Fade out last good frame to avoid hard cut (dalgalanma)
      this.underrunCount++;
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        for (let ch = 0; ch < output.length; ch++) {
          const outputChannel = output[ch];
          if (this.lastGoodFrame && this.underrunCount <= 3) {
            // Gentle fade-out over consecutive underruns
            const gain = Math.max(0, 1 - this.underrunCount * 0.35);
            for (let i = 0; i < 128; i++) {
              // Per-sample fade within the block
              const sampleFade = gain * (1 - i / 128 * 0.3);
              outputChannel[i] = this.lastGoodFrame[i] * sampleFade;
            }
          } else {
            // Too many consecutive underruns — output silence
            outputChannel.fill(0);
          }
        }
      }
    }

    return true;
  }
}

registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);

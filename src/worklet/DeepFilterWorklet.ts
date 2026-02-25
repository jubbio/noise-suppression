import * as wasm_bindgen from '../df3/df';
import { WorkletMessageTypes } from '../constants';
import type { ProcessorOptions, DeepFilterModel } from '../interfaces';

class DeepFilterAudioProcessor extends AudioWorkletProcessor {
  private dfModel: DeepFilterModel | null = null;
  private inputBuffer: Float32Array;
  private outputBuffer: Float32Array;
  private inputWritePos = 0;
  private inputReadPos = 0;
  private outputWritePos = 0;
  private outputReadPos = 0;
  private bypass = true; // Start bypassed — passthrough until WASM is ready
  private isInitialized = false;
  private bufferSize: number;
  private tempFrame: Float32Array | null = null;

  // Adaptive suppression state
  private adaptiveEnabled = false;
  private baseSuppression = 50;   // User-set level (used as max)
  private minSuppression = 10;    // Minimum suppression when quiet
  private currentSuppression = 50;
  private rmsSmoothed = 0;        // Exponentially smoothed RMS
  // Noise floor tracking
  private noiseFloor = 0.001;     // Estimated ambient noise level
  private noiseFloorAlpha = 0.001; // Very slow adaptation for noise floor
  // Thresholds (RMS values, not dB)
  private quietThreshold = 0.005;  // Below this = quiet environment
  private loudThreshold = 0.03;    // Above this = full suppression needed

  constructor(options: AudioWorkletNodeOptions & { processorOptions: ProcessorOptions }) {
    super();

    this.bufferSize = 8192;
    this.inputBuffer = new Float32Array(this.bufferSize);
    this.outputBuffer = new Float32Array(this.bufferSize);

    // Listen for messages immediately (before init, so SET_BYPASS works during warmup)
    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    try {
      // Initialize WASM from pre-compiled module
      wasm_bindgen.initSync(options.processorOptions.wasmModule);

      const modelBytes = new Uint8Array(options.processorOptions.modelBytes);
      const handle = wasm_bindgen.df_create(
        modelBytes,
        options.processorOptions.suppressionLevel ?? 50
      );

      const frameLength = wasm_bindgen.df_get_frame_length(handle);

      this.dfModel = { handle, frameLength };
      this.baseSuppression = options.processorOptions.suppressionLevel ?? 50;
      this.currentSuppression = this.baseSuppression;

      this.bufferSize = frameLength * 4;
      this.inputBuffer = new Float32Array(this.bufferSize);
      this.outputBuffer = new Float32Array(this.bufferSize);

      // Pre-allocate temp frame buffer for processing
      this.tempFrame = new Float32Array(frameLength);

      // Pre-fill output ring buffer with silence (one frameLength worth)
      // so the first process() call after bypass=false has data to output
      this.outputWritePos = frameLength;

      this.isInitialized = true;

      // Notify main thread that WASM init is complete and worklet is ready
      this.port.postMessage({ type: 'READY' });
    } catch (error) {
      console.error('Failed to initialize DeepFilter in AudioWorklet:', error);
      this.isInitialized = false;
      this.port.postMessage({ type: 'ERROR', error: String(error) });
    }
  }

  private handleMessage(data: { type: string; value?: number | boolean }): void {
    switch (data.type) {
      case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:
        if (this.dfModel && typeof data.value === 'number') {
          const level = Math.max(0, Math.min(100, Math.floor(data.value)));
          this.baseSuppression = level;
          if (!this.adaptiveEnabled) {
            this.currentSuppression = level;
            wasm_bindgen.df_set_atten_lim(this.dfModel.handle, level);
          }
        }
        break;
      case WorkletMessageTypes.SET_BYPASS:
        this.bypass = Boolean(data.value);
        break;
      case WorkletMessageTypes.SET_ADAPTIVE:
        this.adaptiveEnabled = Boolean(data.value);
        if (!this.adaptiveEnabled && this.dfModel) {
          // Revert to base level when adaptive is turned off
          this.currentSuppression = this.baseSuppression;
          wasm_bindgen.df_set_atten_lim(this.dfModel.handle, this.baseSuppression);
        }
        break;
    }
  }

  /**
   * Compute RMS of a buffer segment.
   * Runs in audio thread — kept minimal.
   */
  private computeRMS(buf: Float32Array, len: number): number {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += buf[i] * buf[i];
    }
    return Math.sqrt(sum / len);
  }

  /**
   * Adapt suppression level based on current noise environment.
   * Called once per frame (every ~10ms at 48kHz/480 frame).
   *
   * Logic:
   * - Track noise floor with very slow EMA (adapts over seconds)
   * - If RMS is near noise floor → environment is quiet → lower suppression
   * - If RMS is well above noise floor → noisy → raise suppression toward base
   * - Smooth transitions to avoid audible jumps
   */
  private adaptSuppression(rms: number): void {
    if (!this.dfModel) return;

    // Update noise floor estimate (only when signal is relatively quiet)
    if (rms < this.noiseFloor * 3) {
      this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorAlpha) + rms * this.noiseFloorAlpha;
    }

    // Smooth the RMS to avoid reacting to transients
    const alpha = 0.05;
    this.rmsSmoothed = this.rmsSmoothed * (1 - alpha) + rms * alpha;

    // Map smoothed RMS to suppression level
    let targetSuppression: number;
    if (this.rmsSmoothed <= this.quietThreshold) {
      // Quiet environment — minimal suppression saves CPU
      targetSuppression = this.minSuppression;
    } else if (this.rmsSmoothed >= this.loudThreshold) {
      // Noisy environment — full user-set suppression
      targetSuppression = this.baseSuppression;
    } else {
      // Linear interpolation between quiet and loud thresholds
      const t = (this.rmsSmoothed - this.quietThreshold) / (this.loudThreshold - this.quietThreshold);
      targetSuppression = this.minSuppression + t * (this.baseSuppression - this.minSuppression);
    }

    // Only update WASM if level changed by at least 2 (avoid excessive calls)
    const rounded = Math.floor(targetSuppression);
    if (Math.abs(rounded - this.currentSuppression) >= 2) {
      this.currentSuppression = rounded;
      wasm_bindgen.df_set_atten_lim(this.dfModel.handle, rounded);
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
    if (!input) {
      return true;
    }

    // Passthrough mode - copy input to all output channels
    if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        const channelCount = output.length;
        for (let channelNum = 0; channelNum < channelCount; channelNum++) {
          output[channelNum].set(input);
        }
      }
      return true;
    }

    // Write input to ring buffer
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputWritePos] = input[i];
      this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
    }

    const frameLength = this.dfModel.frameLength;

    while (this.getInputAvailable() >= frameLength) {
      // Extract frame from ring buffer
      for (let i = 0; i < frameLength; i++) {
        this.tempFrame[i] = this.inputBuffer[this.inputReadPos];
        this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
      }

      // Adaptive suppression: adjust level based on noise environment
      if (this.adaptiveEnabled) {
        const rms = this.computeRMS(this.tempFrame, frameLength);
        this.adaptSuppression(rms);
      }

      const processed = wasm_bindgen.df_process_frame(this.dfModel.handle, this.tempFrame);

      // Write to output ring buffer
      for (let i = 0; i < processed.length; i++) {
        this.outputBuffer[this.outputWritePos] = processed[i];
        this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
      }
    }

    const outputAvailable = this.getOutputAvailable();
    if (outputAvailable >= 128) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        const channelCount = output.length;

        for (let channelNum = 0; channelNum < channelCount; channelNum++) {
          const outputChannel = output[channelNum];
          let readPos = this.outputReadPos;

          for (let i = 0; i < 128; i++) {
            outputChannel[i] = this.outputBuffer[readPos];
            readPos = (readPos + 1) % this.bufferSize;
          }
        }
      }
      this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;
    }
    return true;
  }
}

registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);

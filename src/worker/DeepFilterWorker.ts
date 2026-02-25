/**
 * DeepFilterWorker — runs WASM processing OFF the audio render thread.
 *
 * Chrome uses a single audio render thread for ALL AudioContexts and tabs.
 * Running df_create() or df_process_frame() on that thread causes buffer
 * underruns → other apps' audio stutters on Windows (WASAPI).
 *
 * This Worker runs on its own thread. The AudioWorklet sends input frames
 * via a MessagePort, this Worker processes them with WASM, and sends
 * processed frames back. The audio thread never touches WASM.
 *
 * Communication: AudioWorklet ←MessagePort→ DeepFilterWorker
 */

import * as wasm_bindgen from '../df3/df';

interface DeepFilterModel {
  handle: number;
  frameLength: number;
}

let model: DeepFilterModel | null = null;
let workletPort: MessagePort | null = null;

// Adaptive suppression state
let adaptiveEnabled = false;
let baseSuppression = 50;
let minSuppression = 10;
let currentSuppression = 50;
let rmsSmoothed = 0;
let noiseFloor = 0.001;
const noiseFloorAlpha = 0.001;
const quietThreshold = 0.005;
const loudThreshold = 0.03;

function computeRMS(buf: Float32Array, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += buf[i] * buf[i];
  }
  return Math.sqrt(sum / len);
}

function adaptSuppression(rms: number): void {
  if (!model) return;

  if (rms < noiseFloor * 3) {
    noiseFloor = noiseFloor * (1 - noiseFloorAlpha) + rms * noiseFloorAlpha;
  }

  const alpha = 0.05;
  rmsSmoothed = rmsSmoothed * (1 - alpha) + rms * alpha;

  let target: number;
  if (rmsSmoothed <= quietThreshold) {
    target = minSuppression;
  } else if (rmsSmoothed >= loudThreshold) {
    target = baseSuppression;
  } else {
    const t = (rmsSmoothed - quietThreshold) / (loudThreshold - quietThreshold);
    target = minSuppression + t * (baseSuppression - minSuppression);
  }

  const rounded = Math.floor(target);
  if (Math.abs(rounded - currentSuppression) >= 2) {
    currentSuppression = rounded;
    wasm_bindgen.df_set_atten_lim(model.handle, rounded);
  }
}

function processFrame(input: Float32Array): Float32Array {
  if (!model) return input;

  if (adaptiveEnabled) {
    adaptSuppression(computeRMS(input, input.length));
  }

  return wasm_bindgen.df_process_frame(model.handle, input);
}

// Handle messages from main thread (init, config) and worklet (audio frames)
self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  switch (type) {
    case 'INIT': {
      // Initialize WASM and create model — this is the heavy part
      // Running here instead of audio thread prevents WASAPI buffer underruns
      const { wasmModule, modelBytes, suppressionLevel } = event.data;
      try {
        wasm_bindgen.initSync(wasmModule);
        const bytes = new Uint8Array(modelBytes);
        const handle = wasm_bindgen.df_create(bytes, suppressionLevel ?? 50);
        const frameLength = wasm_bindgen.df_get_frame_length(handle);

        model = { handle, frameLength };
        baseSuppression = suppressionLevel ?? 50;
        currentSuppression = baseSuppression;

        (self as any).postMessage({ type: 'READY', frameLength });
      } catch (error) {
        (self as any).postMessage({ type: 'ERROR', error: String(error) });
      }
      break;
    }

    case 'SET_PORT': {
      // Receive MessagePort for direct communication with AudioWorklet
      workletPort = event.data.port;
      workletPort!.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'FRAME') {
          // Process audio frame and send back
          const processed = processFrame(e.data.samples);
          workletPort!.postMessage(
            { type: 'PROCESSED', samples: processed },
            [processed.buffer] // Transfer ownership — zero-copy
          );
        }
      };
      break;
    }

    case 'SET_SUPPRESSION_LEVEL': {
      const level = Math.max(0, Math.min(100, Math.floor(event.data.value)));
      baseSuppression = level;
      if (!adaptiveEnabled && model) {
        currentSuppression = level;
        wasm_bindgen.df_set_atten_lim(model.handle, level);
      }
      break;
    }

    case 'SET_ADAPTIVE': {
      adaptiveEnabled = Boolean(event.data.value);
      if (!adaptiveEnabled && model) {
        currentSuppression = baseSuppression;
        wasm_bindgen.df_set_atten_lim(model.handle, baseSuppression);
      }
      break;
    }
  }
};

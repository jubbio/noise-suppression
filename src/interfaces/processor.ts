import type { AssetConfig } from './asset';

export interface ProcessorAssets {
  wasmModule: WebAssembly.Module;
  modelBytes: ArrayBuffer;
}

export interface DeepFilterNet3ProcessorConfig {
  sampleRate?: number;
  noiseReductionLevel?: number;
  postFilterBeta?: number;
  assetConfig?: AssetConfig;
}

export interface DeepFilterNoiseFilterOptions {
  sampleRate?: number;
  frameSize?: number;
  enableNoiseReduction?: boolean;
  noiseReductionLevel?: number;
  postFilterBeta?: number;
  assetConfig?: AssetConfig;
  enabled?: boolean;
  /** Supply an existing AudioContext to avoid creating a new one (prevents audio disruption on Windows) */
  audioContext?: AudioContext;
}

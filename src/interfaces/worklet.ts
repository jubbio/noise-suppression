/** Legacy — kept for backward compatibility but no longer used by worklet */
export interface ProcessorOptions {
  wasmModule: WebAssembly.Module;
  modelBytes: ArrayBuffer;
  suppressionLevel: number;
}

export interface DeepFilterModel {
  handle: number;
  frameLength: number;
}

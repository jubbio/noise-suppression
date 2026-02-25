import { TrackProcessor, Track, AudioProcessorOptions } from 'livekit-client';

interface AssetConfig {
    cdnUrl?: string;
    version?: string;
}
interface AssetUrls {
    wasm: string;
    model: string;
}

interface DeepFilterNet3ProcessorConfig {
    sampleRate?: number;
    noiseReductionLevel?: number;
    assetConfig?: AssetConfig;
}
interface DeepFilterNoiseFilterOptions {
    sampleRate?: number;
    frameSize?: number;
    enableNoiseReduction?: boolean;
    noiseReductionLevel?: number;
    assetConfig?: AssetConfig;
    enabled?: boolean;
    /** Supply an existing AudioContext to avoid creating a new one (prevents audio disruption on Windows) */
    audioContext?: AudioContext;
}

declare class DeepFilterNet3Core {
    private assetLoader;
    private assets;
    private workletNode;
    private isInitialized;
    private bypassEnabled;
    private config;
    constructor(config?: DeepFilterNet3ProcessorConfig);
    initialize(): Promise<void>;
    createAudioWorkletNode(audioContext: AudioContext): Promise<AudioWorkletNode>;
    /**
     * Wait for the worklet to post a READY message, meaning WASM init is done.
     * Call this after createAudioWorkletNode() to ensure the worklet is fully ready.
     */
    waitForReady(): Promise<void>;
    /**
     * Full warmup: download WASM + model, register worklet, create node, wait for READY.
     * After this resolves, the processor is fully initialized and bypass=true.
     * Connecting a track afterwards is instant (no CPU spike, no audio glitch).
     */
    warmup(audioContext: AudioContext): Promise<AudioWorkletNode>;
    setSuppressionLevel(level: number): void;
    destroy(): void;
    isReady(): boolean;
    setNoiseSuppressionEnabled(enabled: boolean): void;
    setAdaptiveEnabled(enabled: boolean): void;
    isNoiseSuppressionEnabled(): boolean;
    private ensureInitialized;
}

declare class DeepFilterNoiseFilterProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    name: string;
    processedTrack?: MediaStreamTrack;
    audioContext: AudioContext | null;
    sourceNode: MediaStreamAudioSourceNode | null;
    workletNode: AudioWorkletNode | null;
    destination: MediaStreamAudioDestinationNode | null;
    processor: DeepFilterNet3Core;
    enabled: boolean;
    originalTrack?: MediaStreamTrack;
    private externalAudioContext;
    private ownsAudioContext;
    private sampleRate;
    private _isWarmedUp;
    constructor(options?: DeepFilterNoiseFilterOptions);
    static isSupported(): boolean;
    /**
     * Preload / warmup: downloads WASM + model, registers worklet, creates node,
     * waits for READY message from worklet. After this, the processor is fully
     * initialized with bypass=true. Connecting a track is then instant.
     * Safe to call multiple times — only runs once.
     */
    preload(): Promise<void>;
    init: (opts: {
        track?: MediaStreamTrack;
        mediaStreamTrack?: MediaStreamTrack;
    }) => Promise<void>;
    restart: (opts: {
        track?: MediaStreamTrack;
        mediaStreamTrack?: MediaStreamTrack;
    }) => Promise<void>;
    setEnabled: (enable: boolean) => Promise<boolean>;
    setSuppressionLevel(level: number): void;
    isEnabled(): boolean;
    isNoiseSuppressionEnabled(): boolean;
    setAdaptiveEnabled(enabled: boolean): void;
    suspend: () => Promise<void>;
    resume: () => Promise<void>;
    destroy: () => Promise<void>;
    /**
     * Connect (or reconnect) a source track to the already-initialized graph.
     * This is the fast path — no WASM, no worklet registration, just a source node swap.
     */
    private connectSourceTrack;
    private ensureAudioContext;
    /**
     * Full cold-start graph setup (fallback when preload() wasn't called).
     */
    private ensureGraph;
    private teardownGraph;
}
declare function DeepFilterNoiseFilter(options?: DeepFilterNoiseFilterOptions): DeepFilterNoiseFilterProcessor;

declare class AssetLoader {
    private readonly cdnUrl;
    constructor(config?: AssetConfig);
    private getCdnUrl;
    getAssetUrls(): AssetUrls;
    fetchAsset(url: string): Promise<ArrayBuffer>;
}
declare function getAssetLoader(config?: AssetConfig): AssetLoader;

export { AssetLoader, DeepFilterNet3Core, DeepFilterNoiseFilter, DeepFilterNoiseFilterProcessor, getAssetLoader };
export type { AssetConfig, DeepFilterNet3ProcessorConfig, DeepFilterNoiseFilterOptions };

/**
 * Creates a worklet module URL from inline code string
 * This approach works with all bundlers without special configuration
 */

// Track which AudioContexts already have the worklet registered
const registeredContexts = new WeakSet<AudioContext>();

export async function createWorkletModule(audioContext: AudioContext, workletCode: string): Promise<void> {
  if (registeredContexts.has(audioContext)) {
    return; // Already registered on this AudioContext
  }
  const blob = new Blob([workletCode], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(blobUrl);
  registeredContexts.add(audioContext);
}

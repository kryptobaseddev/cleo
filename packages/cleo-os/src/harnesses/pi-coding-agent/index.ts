/**
 * Pi Coding Agent harness adapter — public barrel export.
 *
 * Re-exports the adapter class, type contract, and supporting utilities
 * for the Pi coding agent harness in cleo-os.
 *
 * @packageDocumentation
 */

export { PiCodingAgentAdapter } from './adapter.js';
export { DockerModeAdapter, getSandboxImage, isSandboxedGlobally } from './docker-mode.js';
export {
  getPiBinaryPath,
  getTerminateGraceMs,
  PiWrapper,
  resolveExtensionPaths,
} from './pi-wrapper.js';
export type {
  HarnessAdapter,
  HarnessOutputLine,
  HarnessProcessState,
  HarnessProcessStatus,
  HarnessSpawnOptions,
  HarnessSpawnResult,
} from './types.js';

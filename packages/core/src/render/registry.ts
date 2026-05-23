/**
 * Singleton registry mapping `(command, kind)` → renderer.
 *
 * The registry is process-global; per-command renderers register themselves
 * at module-load time and {@link ./render-envelope.ts | renderEnvelopeForHuman}
 * looks them up at call time. Last-write wins when two registrations target
 * the same `(command, kind)` slot — this keeps test setup simple and lets
 * later modules override earlier registrations when needed.
 *
 * @epic T10114
 * @task T10130
 */

import type { RenderableEnvelope } from '@cleocode/contracts';
import type { RegistryKey, Renderer } from './types.js';

const REGISTRY = new Map<RegistryKey, Renderer>();

/**
 * Register a renderer for a specific `(command, kind)` pair.
 *
 * Last-write wins — registering twice for the same key replaces the previous
 * entry without warning. Callers that need uniqueness checks should call
 * {@link lookupRenderer} first.
 *
 * @typeParam T — envelope payload shape the renderer understands.
 * @param command Command identifier (e.g. `'tasks.list'`).
 * @param kind Envelope discriminator (e.g. `'tree'`, `'table'`).
 * @param renderer Function that converts the envelope to a string.
 */
export function registerRenderer<T>(
  command: string,
  kind: RenderableEnvelope<T>['kind'],
  renderer: Renderer<T>,
): void {
  REGISTRY.set(`${command}:${kind}` as RegistryKey, renderer as Renderer);
}

/**
 * Look up the renderer registered for `(command, kind)`.
 *
 * @typeParam T — expected envelope payload shape.
 * @returns The registered renderer, or `undefined` when none is registered.
 */
export function lookupRenderer<T>(
  command: string,
  kind: RenderableEnvelope<T>['kind'],
): Renderer<T> | undefined {
  return REGISTRY.get(`${command}:${kind}` as RegistryKey) as Renderer<T> | undefined;
}

/**
 * Test-only — clear every registration. Production code MUST NOT call this.
 */
export function _resetRegistryForTests(): void {
  REGISTRY.clear();
}

/**
 * Snapshot the registered keys in sorted order. Useful for telemetry and
 * debug surfaces that need to enumerate which `(command, kind)` slots are
 * covered.
 */
export function listRegisteredRenderers(): RegistryKey[] {
  return Array.from(REGISTRY.keys()).sort() as RegistryKey[];
}

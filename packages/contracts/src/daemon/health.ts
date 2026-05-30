/**
 * Daemon health contracts — the aggregate shape a subsystem's `healthProbe`
 * produces and the Rust supervisor consumes.
 *
 * These types **compose** the FROZEN `supervisor-ipc` v1.0 contract
 * ({@link ChildState}, {@link ChildStatus}, {@link MonitorResponse}) rather than
 * redeclaring it: a single subsystem health row maps onto a supervised
 * {@link ChildStatus}, and a {@link HealthStatus} aggregate projects losslessly
 * onto the {@link MonitorResponse} shape the supervisor already aggregates. This
 * keeps the daemon submodule's probe output on the same wire vocabulary the
 * supervisor monitors with — no parallel health taxonomy.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11366 — daemon lifecycle + subsystem contracts
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { z } from 'zod';
import {
  type ChildState,
  ChildStateSchema,
  type ChildStatus,
  ChildStatusSchema,
} from '../supervisor-ipc/messages.js';

/**
 * The liveness state of a single subsystem.
 *
 * This is the FROZEN `supervisor-ipc` {@link ChildState} (`running` |
 * `restarting` | `stopped`) re-exported under a daemon-facing name so subsystem
 * authors do not reach across into the IPC module. A subsystem maps onto a
 * supervised child, so the two states are deliberately identical.
 */
export type SubsystemState = ChildState;

/**
 * Zod schema for {@link SubsystemState}. Aliases the FROZEN
 * {@link ChildStateSchema} — additive only; never edit the underlying enum.
 */
export const SubsystemStateSchema = ChildStateSchema;

/**
 * A single subsystem's health row.
 *
 * Structurally a superset of the supervisor's {@link ChildStatus}: it carries
 * the same `child_id`/`pid`/`state`/`restart_count` fields (so it projects onto
 * a {@link ChildStatus} without a lossy cast) plus an optional human-readable
 * `detail` for diagnostics that never crosses the IPC wire.
 *
 * The `child_id` is the subsystem's logical name, matching the id the
 * supervisor tracks the corresponding child under.
 */
export const SubsystemHealthSchema = ChildStatusSchema.extend({
  /**
   * Optional human-readable detail (e.g. last error message, queue depth).
   * Diagnostic only — not part of the supervisor wire contract.
   */
  detail: z.string().optional(),
}).strict();

/** A single subsystem's health row (inferred from {@link SubsystemHealthSchema}). */
export type SubsystemHealth = z.infer<typeof SubsystemHealthSchema>;

/**
 * The aggregate health snapshot across every registered subsystem.
 *
 * Projects losslessly onto the supervisor's `monitor` snapshot: each
 * {@link SubsystemHealth} row's supervisor-visible fields ARE a
 * {@link ChildStatus}, so {@link toMonitorChildren} can hand the supervisor a
 * `MonitorResponse.children` array with zero casts.
 */
export const HealthStatusSchema = z
  .object({
    /** One health row per registered subsystem. */
    subsystems: z.array(SubsystemHealthSchema),
    /**
     * `true` iff every subsystem is in the `running` state. A convenience roll-up
     * derived from {@link HealthStatusSchema.shape.subsystems}; recomputed by
     * {@link summarizeHealth} so producers cannot desync it.
     */
    allHealthy: z.boolean(),
  })
  .strict();

/** The aggregate daemon health snapshot (inferred from {@link HealthStatusSchema}). */
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * Project a {@link HealthStatus} onto the FROZEN supervisor `monitor` row array
 * (`MonitorResponse['children']`) without a lossy cast.
 *
 * Each {@link SubsystemHealth} already carries the four supervisor-visible
 * fields of a {@link ChildStatus}; this strips the daemon-only `detail` so the
 * result is byte-compatible with what `cleo-supervisor` aggregates.
 *
 * @param health - The aggregate daemon health snapshot.
 * @returns An array of {@link ChildStatus} rows for a `MonitorResponse`.
 */
export function toMonitorChildren(health: HealthStatus): ChildStatus[] {
  return health.subsystems.map((row): ChildStatus => {
    const { detail: _detail, ...childStatus } = row;
    return childStatus;
  });
}

/**
 * Build the aggregate {@link HealthStatus} from per-subsystem rows, computing
 * the `allHealthy` roll-up so it can never desync from the row states.
 *
 * @param subsystems - One {@link SubsystemHealth} row per registered subsystem.
 * @returns The aggregate health snapshot.
 */
export function summarizeHealth(subsystems: SubsystemHealth[]): HealthStatus {
  return {
    subsystems,
    allHealthy: subsystems.every((row) => row.state === 'running'),
  };
}

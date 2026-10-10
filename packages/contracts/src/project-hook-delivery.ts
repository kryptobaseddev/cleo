/** Provider delivery contracts; runtime installers live in adapters and CAAMP. */
import { z } from 'zod';
import type { HookJsonValue } from './heavy-command-hook.js';
import type { HookInvocation } from './project-hooks.js';

/** Parsed JSON object used by surgical managed writers. */
export type HookConfigObject = { readonly [key: string]: HookJsonValue };
/** One surgical edit; undefined removes exactly the addressed node. */
export interface HookConfigEdit {
  /** JSON property/index path. */
  path: (string | number)[];
  /** Replacement value, or undefined for removal. */
  value?: HookJsonValue;
  /** Append/insert an array element without replacing its siblings. */
  insert?: boolean;
}
/** Receipt authorizing management of one exact config entry. */
export const ProjectHookDeliveryReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.string().min(1).max(128),
    configPath: z.string().min(1).max(4096),
    entries: z
      .array(
        z
          .object({
            event: z.string().min(1).max(128),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            command: z.string().min(1).max(8192),
          })
          .strict(),
      )
      .max(128),
    recordedAt: z.iso.datetime(),
  })
  .strict();
/** Machine-local source and entry ownership receipt. */
export type ProjectHookDeliveryReceipt = z.infer<typeof ProjectHookDeliveryReceiptSchema>;
/** Entry-level provenance without printing commands that may contain secrets. */
export interface ProjectHookEntryInspection {
  /** Native provider event. */
  event: string;
  /** Index in the provider event's entry array. */
  index: number;
  /** Receipt proves project delivery ownership; other ownership remains unknown. */
  owner: 'project' | 'unknown';
  /** Generated entry is attributable only through its retained local receipt. */
  provenance: 'cleo-receipt' | 'unknown';
  /** Entry digest permits review without retaining its command text. */
  hash: string;
  /** Tracked source, only for receipt-owned project checks. */
  source?: '.cleo/hooks.json';
}
/** Inspect/install result; a config file never proves native trust or live support. */
export interface ProjectHookDeliveryResult {
  /** Harness identifier. */
  provider: string;
  /** Observed local binary version, when discoverable. */
  version?: string;
  /** Safe resolved project-local destination, absent when unsupported. */
  configPath?: string;
  /** Delivery state. */
  state: 'planned' | 'current' | 'installed' | 'conflict' | 'unsupported' | 'disabled' | 'missing';
  /** Independent capability evidence. */
  capability: 'verified' | 'documented' | 'unverified';
  /** Native project/definition trust is never granted by CLEO. */
  nativeTrust: 'unverified';
  /** Receipt-backed provenance; legacy config provenance remains unknown. */
  provenance: 'cleo-receipt' | 'unknown';
  /** Sanitized actionable findings. */
  diagnostics: string[];
  /** Reviewed team-config integration aid when automatic local delivery is ineligible. */
  integrationSnippet?: string;
  /** Per-entry attribution, deliberately excluding raw config command strings. */
  entries?: ProjectHookEntryInspection[];
}
/** Explicit cold-path provider sync inputs. */
export interface ProjectHookDeliveryOptions {
  /** Checkout root validated by the core context resolver. */
  projectRoot: string;
  /** Per-checkout Git-private receipt directory. */
  stateDir: string;
  /** Canonical agent events selected from the manifest. */
  events: string[];
  /** Activation was inspected fresh. */
  enabled: boolean;
  /** No files (including lock files) may be written in dry-run mode. */
  dryRun: boolean;
  /** Explicit provider selection; otherwise detect project-local configuration. */
  providers?: string[];
  /** Remove only receipt-owned, unmodified additions instead of synchronizing. */
  rollback?: boolean;
}

/** Provider-normalized request awaiting checkout resolution by core. */
export interface ProjectHookNativeRequest {
  /** Actual triggering directory, independent of harness-specific environment variables. */
  cwd: string;
  /** Provider wire protocol. */
  provider: string;
  /** Optional native event name from the provider input. */
  nativeEvent?: string;
  /** Shared input fields before Git resolves projectRoot and gitCommonDir. */
  input: Omit<HookInvocation, 'projectRoot' | 'gitCommonDir'>;
}
/** Native stdout/stderr and adapter exit code; never an approval rewrite. */
export interface ProjectHookNativeResult {
  /** Provider-format advisory output. */
  stdout: string;
  /** Safe current-invocation diagnostics. */
  stderr: string;
  /** Git verdict failure or zero for advisory/infra failure. */
  exitCode: number;
}

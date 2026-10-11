/** Project-owned checks shared by Git, harness and worktree adapters (T13343). */
import { z } from 'zod';
import type { HookJsonValue } from './heavy-command-hook.js';

/** Invocation origin; CI has stricter failure handling than local adapters. */
export const HookSourceSchema = z.enum(['agent', 'git', 'worktree', 'direct', 'ci']);
/** Shared invocation origin. */
export type HookSource = z.infer<typeof HookSourceSchema>;
/** A checkout-relative path; runtime validation also resolves symlinks. */
export const ProjectHookPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').includes('..') &&
      !/^[A-Za-z]:/.test(value),
    'Expected a project-relative path without traversal',
  );
/** One project definition; CLEO IDs are reserved for shipped infrastructure. */
export const ProjectHookDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,127}$/)
      .refine((value) => !value.startsWith('cleo.'), 'CLEO IDs are reserved'),
    owner: z.literal('project'),
    bindings: z
      .array(z.object({ source: HookSourceSchema, event: z.string().min(1).max(128) }).strict())
      .min(1)
      .max(16),
    executable: z.string().min(1).max(4096),
    handler: ProjectHookPathSchema,
    args: z.array(z.string().max(8192)).max(64).default([]),
    dependencies: z.array(ProjectHookPathSchema).max(128).default([]),
    timeoutMs: z.number().int().min(1).max(120000).default(30000),
    checkerErrorPolicy: z.enum(['warn', 'block']).default('warn'),
  })
  .strict();
/** Validated project checker configuration. Handler is executable's first argument. */
export type ProjectHookDefinition = z.infer<typeof ProjectHookDefinitionSchema>;
/** Tracked single source of truth; array order defines execution order. */
export const ProjectHooksManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    hooks: z.array(ProjectHookDefinitionSchema).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const hook of manifest.hooks) {
      if (ids.has(hook.id))
        context.addIssue({ code: 'custom', message: `Duplicate hook ID: ${hook.id}` });
      ids.add(hook.id);
      const bindings = new Set<string>();
      for (const binding of hook.bindings) {
        const key = `${binding.source}:${binding.event}`;
        if (bindings.has(key))
          context.addIssue({ code: 'custom', message: `Duplicate binding: ${hook.id}:${key}` });
        bindings.add(key);
      }
    }
  });
/** Validated tracked manifest. */
export type ProjectHooksManifest = z.infer<typeof ProjectHooksManifestSchema>;
/** Exact ref update supplied by Git pre-push, including zero object IDs. */
export interface HookRefUpdate {
  /** Local ref name or deletion marker. */
  localRef: string;
  /** Exact local object ID. */
  localOid: string;
  /** Remote ref name. */
  remoteRef: string;
  /** Previous remote object ID. */
  remoteOid: string;
}
/** Native input normalized by the adapter; no harness environment is required. */
export interface HookInvocation {
  /** Protocol version. */
  schemaVersion: 1;
  /** Active checkout root, independently resolved through Git. */
  projectRoot: string;
  /** Git common directory, for attribution across linked checkouts. */
  gitCommonDir: string;
  /** Triggering adapter. */
  source: HookSource;
  /** Canonical event name. */
  event: string;
  /** Optional remote name and URL/path as Git supplies them. */
  remote?: { name: string; location: string };
  /** All pushed ref updates in original order. */
  refs?: HookRefUpdate[];
  /** Agent tool input, passed only to the checker and never persisted. */
  toolInput?: HookJsonValue;
  /** Optional worktree lifecycle identity. */
  worktree?: { taskId: string; path: string };
}
/** Structured checker verdict written as one JSON object on stdout. */
export const ProjectHookVerdictSchema = z
  .object({
    status: z.enum(['pass', 'block', 'warn', 'skip', 'checker-error']),
    message: z.string().max(4096).optional(),
  })
  .strict();
/** Project checker's portable stdout contract. */
export type ProjectHookVerdict = z.infer<typeof ProjectHookVerdictSchema>;
/** Distinct executor result classes. */
export type HookOutcomeStatus = ProjectHookVerdict['status'] | 'timeout' | 'infrastructure-error';
/** Sanitized result: arbitrary child output and inputs are deliberately absent. */
export interface HookOutcome {
  /** Project check ID, or CLEO infrastructure attribution. */
  id: string;
  /** Observed classification. */
  status: HookOutcomeStatus;
  /** Whether this adapter must prevent the operation. */
  blocks: boolean;
  /** Safe executor diagnostic code; child messages are not retained. */
  code: string;
  /** Project diagnostic for the current caller only; excluded from stored receipts. */
  message?: string;
  /** Child exit code; null when no normal exit occurred. */
  exitCode: number | null;
  /** Terminating signal, when present. */
  signal: string | null;
  /** Elapsed execution time in milliseconds. */
  durationMs: number;
}
/** Dependency-injection port; worktree consumes this without importing core. */
export interface HookExecutor {
  /** Execute all matching activated definitions in manifest order. */
  execute(invocation: HookInvocation): Promise<HookOutcome[]>;
}
/** Content hashes approved explicitly on this machine. */
export const HookActivationSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectRoot: z.string(),
    projectIdentity: z.string(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    executables: z.record(z.string(), z.string()),
    activatedAt: z.string(),
  })
  .strict();
/** Activation record is local, excluded from Git and never replicated. */
export type HookActivation = z.infer<typeof HookActivationSchema>;
/** Local feature state; activation never confers native harness trust. */
export const ProjectHooksLocalStateSchema = z
  .object({
    hooks: z.object({ project: z.object({ enabled: z.boolean() }).strict() }).strict(),
    activation: HookActivationSchema.optional(),
  })
  .strict();
/** Local activation settings stored independently of tracked project configuration. */
export type ProjectHooksLocalState = z.infer<typeof ProjectHooksLocalStateSchema>;
/** Bounded last execution metadata; contains no input or arbitrary output. */
export interface HookExecutionReceipt {
  /** Receipt format version. */
  schemaVersion: 1;
  /** Activated source digest. */
  manifestHash: string;
  /** Invocation origin. */
  source: HookSource;
  /** Event without payload. */
  event: string;
  /** Completion timestamp. */
  recordedAt: string;
  /** Sanitized outcomes. */
  outcomes: HookOutcome[];
}
/** Validator for sanitized execution records, rejecting unexpected payload fields. */
export const HookExecutionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: HookSourceSchema,
    event: z.string().max(128),
    recordedAt: z.string(),
    outcomes: z
      .array(
        z
          .object({
            id: z.string().max(128),
            status: z.enum([
              'pass',
              'block',
              'warn',
              'skip',
              'checker-error',
              'timeout',
              'infrastructure-error',
            ]),
            blocks: z.boolean(),
            code: z.string().regex(/^HOOK_[A-Z_]+$/),
            exitCode: z.number().int().nullable(),
            signal: z.string().max(32).nullable(),
            durationMs: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(65),
  })
  .strict();
/** Checkout identity and machine-local receipt paths resolved by Git. */
export interface ProjectHookContext {
  /** Active checkout root. */
  projectRoot: string;
  /** Common Git directory. */
  gitCommonDir: string;
  /** Effective Git hook directory. */
  hooksDir: string;
  /** Per-checkout Git-private CLEO state directory. */
  stateDir: string;
}
/** Resolved handler attribution without executing project code. */
export interface ProjectHookResolution {
  /** Project-owned definition identity. */
  id: string;
  /** Declared policy owner, separate from installer provenance. */
  owner: 'project';
  /** Manifest source path. */
  sourceDefinition: string;
  /** Whether Git currently tracks the manifest. */
  sourceTracked: boolean;
  /** Canonical handler path when it can be resolved safely. */
  handlerPath?: string;
  /** Canonical executable path when available. */
  executablePath?: string;
  /** Bounded diagnostic codes; contains no environment values. */
  diagnostics: string[];
}
/** Read-only activation and ownership diagnostic. */
export interface ProjectHookInspection {
  /** Git-resolved paths. */
  context: ProjectHookContext;
  /** Validated source definitions. */
  manifest: ProjectHooksManifest;
  /** Definition attribution and resolved executable paths. */
  resolvedHooks: ProjectHookResolution[];
  /** Machine-local opt-in flag. */
  enabled: boolean;
  /** Activation is absent, fresh or drifted. */
  activation: 'disabled' | 'missing' | 'active' | 'drifted';
  /** Safe assessment codes. */
  diagnostics: string[];
  /** Native harness trust cannot be inferred from files on disk. */
  nativeTrust: 'unverified';
  /** Native project trust is independent of CLEO activation. */
  nativeProjectTrust: 'unverified';
  /** Exact native hook-definition trust is independent of project trust. */
  nativeHookTrust: 'unverified';
  /** Last bounded execution record when valid. */
  lastExecution?: HookExecutionReceipt;
}

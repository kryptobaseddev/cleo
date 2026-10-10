/** Bound, retained evidence required before promoting project hooks to stable (T13350). */
import { z } from 'zod';

/** Required pilot checks; every named check must pass on the same implementation. */
export const HOOK_PILOT_CHECKS = [
  'packedArtifact',
  'publishedCanary',
  'readOnlyDev',
  'readOnlyProd',
  'liveClaude',
  'liveCodex',
  'hostedCi',
] as const;
/** A required hook pilot check. */
export type HookPilotCheck = (typeof HOOK_PILOT_CHECKS)[number];
/** SHA-256 evidence or implementation digest. */
export const HookPilotDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** An independent, numbered canary release; RC/beta does not satisfy this pilot. */
export const HookPilotCanarySchema = z.string().regex(/^\d{4}\.\d+\.\d+-canary\.\d+$/);
/** Exact live harness versions, kept separate from source-version normalization. */
export const HookPilotHarnessVersionsSchema = z
  .object({
    claude: z.string().min(1).max(128),
    codex: z.string().min(1).max(128),
  })
  .strict();
/** Retained proof path remains inside the evidence artifact directory. */
export const HookPilotProofReferenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !value.split('/').includes('..') &&
          !/^[A-Za-z]:/.test(value),
        'Expected a relative proof path without traversal',
      ),
    sha256: HookPilotDigestSchema,
  })
  .strict();
/** Common identity attached to every retained proof, never inferred from similar releases. */
export const HookPilotIdentitySchema = z
  .object({
    canaryVersion: HookPilotCanarySchema,
    sourceDigest: HookPilotDigestSchema,
    vidaCommit: z.string().regex(/^[a-f0-9]{40}$/),
    harnessVersions: HookPilotHarnessVersionsSchema,
  })
  .strict();
/** A bounded collection of actual pilot receipts. Missing or partial checks hold promotion. */
export const HookPilotEvidenceSchema = HookPilotIdentitySchema.extend({
  schemaVersion: z.literal(1),
  vidaRepository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(256),
  hostedRunId: z.number().int().positive().safe(),
  checks: z
    .object({
      packedArtifact: HookPilotProofReferenceSchema,
      publishedCanary: HookPilotProofReferenceSchema,
      readOnlyDev: HookPilotProofReferenceSchema,
      readOnlyProd: HookPilotProofReferenceSchema,
      liveClaude: HookPilotProofReferenceSchema,
      liveCodex: HookPilotProofReferenceSchema,
      hostedCi: HookPilotProofReferenceSchema,
    })
    .strict(),
}).strict();
/** Validated evidence bundle index. */
export type HookPilotEvidence = z.infer<typeof HookPilotEvidenceSchema>;
/** Structured, redacted proof produced by a real check and retained with its hash. */
export const HookPilotProofSchema = HookPilotIdentitySchema.extend({
  schemaVersion: z.literal(1),
  check: z.enum(HOOK_PILOT_CHECKS),
  status: z.literal('pass'),
  observedAt: z.string().datetime(),
  checkedCount: z.number().int().min(1).max(100000),
  exitCode: z.literal(0),
  mode: z.enum(['packed-artifact', 'published-canary', 'read-only', 'live-harness', 'hosted-ci']),
  packageVersions: z.record(z.string().max(256), z.string().max(128)).optional(),
  ordinaryCommands: z.number().int().min(1).max(100000).optional(),
  disposablePushes: z.number().int().min(1).max(100000).optional(),
  hostedRunId: z.number().int().positive().safe().optional(),
  url: z.string().url().max(2048).optional(),
}).strict();
/** A validated retained proof. */
export type HookPilotProof = z.infer<typeof HookPilotProofSchema>;
/** Minimal authoritative GitHub response required for an actual successful workflow run. */
export const HookPilotHostedRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.literal('completed'),
  conclusion: z.literal('success'),
  path: z.string().max(4096),
  html_url: z.string().url().max(2048),
  repository: z.object({ full_name: z.string().max(256) }),
});
/** Minimal runner/step evidence; an empty never-started job cannot satisfy hosted CI. */
export const HookPilotHostedJobsSchema = z.object({
  jobs: z
    .array(
      z.object({
        name: z.string().max(256),
        status: z.string().max(32),
        conclusion: z.string().nullable(),
        runner_id: z.number().int(),
        runner_name: z.string().nullable(),
        labels: z.array(z.string().max(128)).max(32),
        steps: z
          .array(
            z.object({
              name: z.string().max(512),
              status: z.string().max(32),
              conclusion: z.string().nullable(),
            }),
          )
          .max(256),
      }),
    )
    .max(100),
});
/** A bounded API JSON reader. Production uses gh; tests inject only transport responses. */
export type HookPilotApiReader = (endpoint: string) => string;
/** Inputs that bind validation to the release currently being promoted. */
export interface HookPilotValidationOptions {
  /** Repository checkout used for the normalized implementation digest. */
  root: string;
  /** Retained evidence index; its directory contains all proof files. */
  evidencePath: string;
  /** Stable version receiving promotion; must match the canary's base. */
  stableVersion: string;
  /** Trusted release-side pilot repository; evidence cannot redirect authority. */
  vidaRepository: string;
  /** Authoritative read transport, injectable for sanitized tests. */
  readApi?: HookPilotApiReader;
}
/** Reusable normalized source digest and exact publish cohort. */
export interface HookPilotSourceDigest {
  /** Algorithm format, including inclusion and normalization rules. */
  schemaVersion: 1;
  /** SHA-256 of sorted framed mode/path/content records with manifest normalization. */
  digest: string;
  /** Number of assessed tracked files. */
  fileCount: number;
  /** Package names from release.yml's publish_pkg SSoT. */
  cohort: string[];
}
/** Validation result contains attribution only, never proof payloads or credentials. */
export interface HookPilotValidationResult {
  /** Confirmed independent canary. */
  canaryVersion: string;
  /** Normalized source digest used by this validation. */
  sourceDigest: string;
  /** Exact VidaPeps commit validated by hosted CI. */
  vidaCommit: string;
  /** Required checks validated. */
  checks: HookPilotCheck[];
}

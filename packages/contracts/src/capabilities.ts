/**
 * Adapter capability declarations for CLEO provider adapters.
 *
 * @task T5240
 */

import type { SystemdControlContext } from './resource-governor.js';

export interface AdapterCapabilities {
  supportsHooks: boolean;
  supportedHookEvents: string[];
  supportsSpawn: boolean;
  supportsInstall: boolean;
  supportsInstructionFiles: boolean;
  /** Provider-specific instruction file name, e.g. "CLAUDE.md", ".cursorrules" */
  instructionFilePattern?: string;
  supportsContextMonitor: boolean;
  supportsStatusline: boolean;
  supportsProviderPaths: boolean;
  supportsTransport: boolean;
  supportsTaskSync: boolean;
}

/** Independently assessed provider capability; later stages do not imply earlier ones. */
export type ProviderVerificationStage =
  | 'declared'
  | 'installed'
  | 'delivery'
  | 'workflow'
  | 'lifecycle';

/** External application interaction is separate from CleoOS adapter spawning. */
export type ProviderInteractionChannel = 'external-cli' | 'programmatic-spawn';

/** Content identity of an artifact actually inspected by a verifier. */
export interface ProviderArtifactIdentity {
  /** Absolute artifact path or immutable artifact locator. */
  locator: string;
  /** SHA-256 of the inspected bytes. */
  sha256: string;
}

/** Identities to which an installed workflow verification applies. */
export interface ProviderVerificationIdentity {
  /** Provider identifier within the assessed interaction channel. */
  providerId: string;
  /** Observed executable or SDK version, not a declared minimum. */
  providerVersion: string;
  /** Executable or SDK artifact inspected by the verifier. */
  providerArtifact: ProviderArtifactIdentity;
  /** Installed CLEO version exercised by the scenario. */
  cleoVersion: string;
  /** Installed CLEO artifact, distinct from a source checkout. */
  cleoArtifact: ProviderArtifactIdentity;
  /** Instruction artifacts actually delivered to this invocation. */
  instructions: readonly ProviderArtifactIdentity[];
}

/** Retained evidence supporting one capability, not a self-attested certification. */
export interface ProviderVerificationEvidence {
  /** Nature of the observation; declaration alone cannot prove execution. */
  kind: 'declaration' | 'executable' | 'delivery' | 'repair-scenario' | 'lifecycle';
  /** Retained result or transcript artifact with independently checked bytes. */
  artifact: ProviderArtifactIdentity;
  /** Time of the verifier's observation in ISO-8601 format. */
  observedAt: string;
  /** Independent scenario identity, absent for declaration-only evidence. */
  scenarioId?: string;
  /** Durable repair receipts independently read after the scenario, when applicable. */
  receiptIds?: readonly string[];
}

/** One independently evidenced capability assessment. */
export interface ProviderCapabilityAssessment {
  /** Unverified includes unavailable accounts, interfaces, or identity-mismatched evidence. */
  status: 'verified' | 'unverified' | 'failed';
  /** Explanation of what was observed or what verification is missing. */
  reason: string;
  /** Supporting evidence; a green assertion without retained evidence is insufficient. */
  evidence: readonly ProviderVerificationEvidence[];
}

/** Capability report for exactly one provider interaction channel. */
export interface ProviderChannelVerification {
  /** Channel actually assessed; external CLI evidence cannot certify adapter spawning. */
  channel: ProviderInteractionChannel;
  /** Installed identities, or null when no installed invocation was verified. */
  identity: ProviderVerificationIdentity | null;
  /** Independent assessments; source scanning cannot promote live verification stages. */
  levels: Readonly<Record<ProviderVerificationStage, ProviderCapabilityAssessment>>;
  /** Missing coverage, permission-policy limitations, and follow-up requirements. */
  limitations: readonly string[];
}

/** Read-only adapter source inspection, never an installed-provider certificate. */
export interface ProviderSourceInspection {
  /** Exact directory examined; may be absent in an installed package. */
  directory: string;
  /** Missing is distinct from a failed diagnostic read. */
  status: 'present' | 'missing' | 'failed';
  /** Whether the source directory was observed before any later diagnostic failure. */
  directoryPresent: boolean;
  /** Whether a regular spawn.ts source file was observed. */
  spawnFilePresent: boolean;
  /** Textual hook-name occurrences; comments and strings count, so these are not runtime hooks. */
  hookNameMentions: number;
  /** Explicit read/type failures; an empty list does not establish runtime completeness. */
  diagnostics: readonly string[];
}

/** External CLIs required by the installed repair certification scenarios. */
export type CertifiableProviderCli = 'claude-code' | 'codex' | 'kimi';

/** Captured input to one bounded external CLI observation, not an agent engine. */
export interface ProviderVerificationInvocation {
  /** Provider whose normal, fixed CLI argument grammar will be used. */
  provider: CertifiableProviderCli;
  /** Absolute executable path; PATH discovery is a separate observation. */
  executable: string;
  /** Unique retained invocation identity, independent of the agent's answer. */
  invocationId: string;
  /** Synthetic isolation directory containing every writable root. */
  isolationRoot: string;
  /** Synthetic project directory beneath isolationRoot. */
  projectRoot: string;
  /** Explicit environment; the runner never merges ambient credentials/configuration. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Scenario objective only; expected answers and receipt IDs must not be supplied. */
  prompt: string;
  /** Original absolute execution deadline in Unix milliseconds, including preparation. */
  deadlineAt: number;
  /** Aggregate stdout plus stderr byte ceiling. */
  transcriptByteLimit: number;
  /** Explicit cgroup memory ceiling; fallback process groups do not enforce it. */
  memoryMaxMb: number;
  /** Optional manager connection, used only by control probes/launcher; never child roots.
   * @defaultValue Ambient manager discovery.
   */
  systemdControl?: SystemdControlContext;
  /** Caller cancellation; cleanup does not grant further scenario execution. */
  signal?: AbortSignal;
}

/** Independent observations of the owned transient scope, never a workflow certificate. */
export interface ProviderScopeObservation {
  /** Unique runner-owned unit, independent of provider-authored output. */
  unitName: string;
  /** Actual manager-reported cgroup path, or null when unobserved. */
  cgroupPath: string | null;
  /** Actual kernel memory limit in bytes, or null when unobserved/non-numeric. */
  memoryMaxBytes: number | null;
  /** Actual kernel swap limit in bytes, or null when unobserved/non-numeric. */
  memorySwapMaxBytes: number | null;
  /** PIDs read from the owned cgroup and independently matched against proc membership. */
  observedMemberPids: readonly number[];
  /** Kernel populated state observed during the invocation. */
  populatedBefore: boolean | null;
  /** Kernel populated state after cleanup; null means absent or unobserved, not automatically empty. */
  populatedAfter: boolean | null;
  /** Whether a previously observed owned cgroup was removed after cleanup. */
  removedAfter: boolean;
  /** Observed membership, requested memory/swap bounds and empty scope after cleanup all matched. */
  verified: boolean;
}

/** Bounded process observation; only a separate independent verifier may assess a workflow. */
export interface ProviderVerificationProcessResult {
  /** Invocation identity captured before launch. */
  invocationId: string;
  /** External provider under observation. */
  provider: CertifiableProviderCli;
  /** Exact executable bytes measured immediately before launch. */
  executable: ProviderArtifactIdentity;
  /** Fixed permission-preserving argument vector, excluding the scenario prompt. */
  arguments: readonly string[];
  /** Process outcome, never a repair or provider certification verdict. */
  outcome: 'exited' | 'spawn-failed' | 'cancelled' | 'deadline' | 'transcript-limit';
  /** Actual exit code when observed, otherwise null. */
  exitCode: number | null;
  /** Observed launcher close signal; under systemd this is not proof of the target's signal or OOM. */
  exitSignal: string | null;
  /** Start time of preparation, in ISO-8601. */
  startedAt: string;
  /** End time after bounded cleanup, in ISO-8601. */
  endedAt: string;
  /** Original deadline, never renewed across preparation/launch. */
  deadlineAt: number;
  /** Elapsed time including cleanup, which may exceed the scenario deadline. */
  elapsedMs: number;
  /** Retained stdout, bounded together with stderr. */
  stdout: string;
  /** Retained stderr, bounded together with stdout. */
  stderr: string;
  /** Whether any transcript bytes were withheld. */
  transcriptTruncated: boolean;
  /** Observed direct child closure; does not prove all descendants exited. */
  childClosed: boolean;
  /** Whether the owned POSIX process group was observed absent, or null if unassessed. */
  processGroupGone: boolean | null;
  /** Launch containment selected by the existing core execution service. */
  containment: 'systemd' | 'pgid';
  /** Actual scope observations; null for fallback or no owned unit. */
  scope: ProviderScopeObservation | null;
  /** No process-only observation certifies repair or complete lifecycle behavior. */
  certification: 'unverified';
  /** Explicit scope, cleanup, permission and synchronous-boundary limitations. */
  diagnostics: readonly string[];
}

/** Exact managed instruction bytes staged for an external CLI; reading remains separate evidence. */
export interface ProviderInstructionStaging {
  /** Installed source instruction files independently matched against packed inventories. */
  sources: readonly ProviderArtifactIdentity[];
  /** Self-contained managed bootstrap inside the isolated synthetic project. */
  bootstrap: ProviderArtifactIdentity;
  /** Staging proves availability, not provider expansion or an actual tool read. */
  delivery: 'staged-unverified';
}

/** Installed-file observations accompanying one external CLI process attempt. */
export interface PackedProviderProcessObservation {
  /** Exact installed runner and package manifests checked before execution. */
  artifacts: readonly ProviderArtifactIdentity[];
  /** Managed instruction staging, distinct from independently observed reading. */
  instructions: ProviderInstructionStaging;
  /** Actual bounded external process result; not a provider-authored certificate. */
  process: ProviderVerificationProcessResult;
  /** This prerequisite does not assess the complete repair workflow. */
  workflow: 'unverified';
  /** Repair, delivery and lifecycle evidence still required. */
  limitations: readonly string[];
}

/** One original synthetic observation image retained by the independent verifier. */
export interface ProviderRepairObservationImage {
  /** Authentic row identity, never an identifier supplied in a provider answer. */
  id: string;
  /** Complete SQLite row serialized by the fresh read-only verifier process. */
  rowJson: string;
}

/** Durable job fields inspected independently of a provider transcript. */
export interface ProviderRepairJobImage {
  /** Existing durable job identity. */
  id: string;
  /** Persisted lifecycle status. */
  status: string;
  /** Original immutable prepared input bytes. */
  proposalJson: string;
  /** Persisted SHA-256 of proposalJson. */
  proposalHash: string;
  /** Persisted success or failure outcome bytes, when present. */
  resultJson: string | null;
}

/** Append-only repair metadata captured without invoking domain repair code. */
export interface ProviderRepairMetadataImage {
  /** Canonical metadata key. */
  key: string;
  /** Exact retained JSON bytes. */
  valueJson: string;
}

/** Fresh-process synthetic store snapshot; never a production store inspection request. */
export interface ProviderRepairFixtureState {
  /** Verifier wall-clock timestamp at snapshot capture; required to admit retrieval counters. */
  capturedAtMs?: number;
  /** Original observation rows, including quarantined rows. */
  observations: readonly ProviderRepairObservationImage[];
  /** Existing pending and terminal jobs. */
  jobs: readonly ProviderRepairJobImage[];
  /** Historical receipts, recovery links and lifecycle events. */
  metadata: readonly ProviderRepairMetadataImage[];
}

/** Independently seeded identities, kept out of the model's expected answers. */
export interface ProviderRepairFixtureIdentity {
  /** Canonical synthetic project identity. */
  projectId: string;
  /** Explicit actor owned by this verification invocation. */
  actor: string;
  /** Seeded confirmed content-free trace identity. */
  noiseId: string;
  /** Additional independently seeded affected identities; the exact complete set is required. */
  additionalNoiseIds?: readonly string[];
  /** Seeded substantive incident identity that must be preserved. */
  incidentId: string;
}

/** One independently assessed repair phase; this is not a provider certificate. */
export type ProviderRepairVerificationPhase = 'prepared' | 'repaired' | 'rolled-back';

/** Explicit read-side usage delta; never evidence of content or authority changes. */
export interface ProviderRepairRetrievalChange {
  /** Retained observation identity. */
  id: string;
  /** Original citation count from the independent snapshot. */
  beforeCount: number;
  /** Strictly increased count after retrieval. */
  afterCount: number;
  /** Original retrieval timestamp, absent or null for unused records. */
  beforeUpdatedAt: string | null;
  /** UTC second-precision timestamp within measured snapshot bounds. */
  afterUpdatedAt: string;
}

/** Actual canonical identities demonstrated by an independent state oracle. */
export interface ProviderRepairPhaseEvidence {
  /** Phase whose data postconditions were independently checked. */
  phase: ProviderRepairVerificationPhase;
  /** Authentic durable job, not a reported success string. */
  jobId: string;
  /** Immutable sourced proposal associated with the job. */
  proposalId: string;
  /** Original committed receipt when the phase has one. */
  receiptId: string | null;
  /** Separate recovery receipt; original evidence remains retained. */
  rollbackReceiptId: string | null;
  /** Every admitted usage-counter delta; all other row fields remain exact. */
  retrievalChanges: readonly ProviderRepairRetrievalChange[];
}

/** Actual installed CLI process observation recorded outside the provider's answer. */
export interface ProviderRepairCliObservation {
  /** Literal CLI arguments seen by the independent execution observer. */
  arguments: readonly string[];
  /** Observed CLI exit status, null if no exit was established. */
  exitCode: number | null;
  /** Complete CLI envelope bytes; malformed or truncated JSON is not accepted. */
  stdout: string;
}

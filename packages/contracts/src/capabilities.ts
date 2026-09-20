/**
 * Adapter capability declarations for CLEO provider adapters.
 *
 * @task T5240
 */

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
  /** Caller cancellation; cleanup does not grant further scenario execution. */
  signal?: AbortSignal;
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
  /** No process-only observation certifies repair or complete lifecycle behavior. */
  certification: 'unverified';
  /** Explicit scope, cleanup, permission and synchronous-boundary limitations. */
  diagnostics: readonly string[];
}

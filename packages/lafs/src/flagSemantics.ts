import { getRegistryCode } from "./errorRegistry.js";
import type { FlagInput, LAFSError, LAFSErrorCategory } from "./types.js";

export interface FlagResolution {
  format: "json" | "human";
  source: "flag" | "project" | "user" | "default";
  /** When true, suppress non-essential output for scripting */
  quiet: boolean;
}

export class LAFSFlagError extends Error implements LAFSError {
  code: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LAFSFlagError";
    this.code = code;
    const entry = getRegistryCode(code);
    this.category = (entry?.category ?? "CONTRACT") as LAFSErrorCategory;
    this.retryable = entry?.retryable ?? false;
    this.retryAfterMs = null;
    this.details = details;
  }
}

export function resolveOutputFormat(input: FlagInput): FlagResolution {
  if (input.humanFlag && input.jsonFlag) {
    throw new LAFSFlagError(
      "E_FORMAT_CONFLICT",
      "Cannot combine --human and --json in the same invocation.",
    );
  }

  const quiet = input.quiet ?? false;

  if (input.requestedFormat) {
    return { format: input.requestedFormat, source: "flag", quiet };
  }
  if (input.humanFlag) {
    return { format: "human", source: "flag", quiet };
  }
  if (input.jsonFlag) {
    return { format: "json", source: "flag", quiet };
  }
  if (input.projectDefault) {
    return { format: input.projectDefault, source: "project", quiet };
  }
  if (input.userDefault) {
    return { format: input.userDefault, source: "user", quiet };
  }
  // TTY terminals default to human-readable output for usability.
  // Non-TTY (piped, CI, agents) defaults to JSON per LAFS protocol.
  if (input.tty) {
    return { format: "human", source: "default", quiet };
  }
  return { format: "json", source: "default", quiet };
}

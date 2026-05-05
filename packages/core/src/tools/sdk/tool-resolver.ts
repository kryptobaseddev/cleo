/**
 * ToolResolver SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for project-agnostic tool command resolution (ADR-051,
 * ADR-061). Every validation and evidence-verification pathway MUST import
 * `resolveToolCommand` and `CANONICAL_TOOLS` from this path.
 *
 * The implementation lives in `../../tasks/tool-resolver.ts` (domain location);
 * this file is the SDK-surface barrier that makes the tool harness-agnostic.
 *
 * T1818 will fill this stub with the actual re-export once ADR-064 is written.
 *
 * @arch See ADR-064 (Category B SDK Tool: ToolResolver)
 * @task T1815
 * @epic T1768
 */
export type {
  CanonicalTool,
  ResolutionSource,
  ResolvedToolCommand,
  ResolveToolResult,
} from '../../tasks/tool-resolver.js';

export { CANONICAL_TOOLS, resolveToolCommand } from '../../tasks/tool-resolver.js';

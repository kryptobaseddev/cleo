/**
 * skills list command - LAFS-compliant with JSON-first output
 */

import { randomUUID } from "node:crypto";
import type { LAFSErrorCategory } from "@cleocode/lafs";
import { resolveOutputFormat } from "@cleocode/lafs";
import type { Command } from "commander";
import pc from "picocolors";
import { isHuman } from "../../core/logger.js";
import { resolveProviderSkillsDir } from "../../core/paths/standard.js";
import { getInstalledProviders } from "../../core/registry/detection.js";
import { getProvider } from "../../core/registry/providers.js";
import { discoverSkillsMulti } from "../../core/skills/discovery.js";

interface SkillsListOptions {
  global?: boolean;
  agent?: string;
  json?: boolean;
  human?: boolean;
}

interface LAFSErrorShape {
  code: string;
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

/**
 * Registers the `skills list` subcommand for listing installed skills.
 *
 * @remarks
 * Discovers skills installed across provider skill directories and outputs a summary
 * grouped by provider. Supports filtering by agent and scope.
 *
 * @param parent - The parent `skills` Command to attach the list subcommand to
 *
 * @example
 * ```bash
 * caamp skills list --human
 * caamp skills list --agent claude-code --global
 * ```
 *
 * @public
 */
export function registerSkillsList(parent: Command): void {
  parent
    .command("list")
    .description("List installed skills")
    .option("-g, --global", "List global skills")
    .option("-a, --agent <name>", "List skills for specific agent")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: SkillsListOptions) => {
      const operation = "skills.list";
      const mvi: import("../../core/lafs.js").MVILevel = "standard";

      let format: "json" | "human";
      try {
        format = resolveOutputFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: "json",
        }).format;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, "E_FORMAT_CONFLICT", message, "VALIDATION");
        process.exit(1);
      }

      let dirs: string[] = [];

      if (opts.agent) {
        const provider = getProvider(opts.agent);
        if (!provider) {
          const message = `Provider not found: ${opts.agent}`;
          if (format === "json") {
            emitJsonError(operation, mvi, "E_PROVIDER_NOT_FOUND", message, "NOT_FOUND", {
              agent: opts.agent,
            });
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }
        dirs = opts.global
          ? [resolveProviderSkillsDir(provider, "global")]
          : [resolveProviderSkillsDir(provider, "project")];
      } else if (opts.global) {
        const providers = getInstalledProviders();
        dirs = providers.map((p) => resolveProviderSkillsDir(p, "global")).filter(Boolean);
      } else {
        const providers = getInstalledProviders();
        dirs = providers
          .map((p) => resolveProviderSkillsDir(p, "project"))
          .filter(Boolean);
      }

      const skills = await discoverSkillsMulti(dirs);

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            skills,
            count: skills.length,
            scope: opts.global ? "global" : opts.agent ? `agent:${opts.agent}` : "project",
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      if (skills.length === 0) {
        console.log(pc.dim("No skills found."));
        return;
      }

      console.log(pc.bold(`\n${skills.length} skill(s) found:\n`));

      skills.forEach((skill, index) => {
        const num = (index + 1).toString().padStart(2);
        console.log(`  ${pc.cyan(num)}. ${pc.bold(skill.name.padEnd(30))} ${pc.dim(skill.metadata?.description ?? "")}`);
      });

      console.log(pc.dim(`\nInstall with: caamp skills install <name>`));
      console.log(pc.dim(`Remove with:  caamp skills remove <name>`));
    });
}

function buildEnvelope<T>(
  operation: string,
  mvi: import("../../core/lafs.js").MVILevel,
  result: T | null,
  error: LAFSErrorShape | null,
) {
  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json" as const,
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      operation,
      requestId: randomUUID(),
      transport: "cli" as const,
      strict: true,
      mvi,
      contextVersion: 0,
    },
    success: error === null,
    result,
    error,
    page: null,
  };
}

function emitJsonError(
  operation: string,
  mvi: import("../../core/lafs.js").MVILevel,
  code: string,
  message: string,
  category: LAFSErrorCategory,
  details: Record<string, unknown> = {},
): void {
  const envelope = buildEnvelope(operation, mvi, null, {
    code,
    message,
    category,
    retryable: false,
    retryAfterMs: null,
    details,
  });
  console.error(JSON.stringify(envelope, null, 2));
}

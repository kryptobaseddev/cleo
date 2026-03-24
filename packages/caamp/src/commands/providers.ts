/**
 * providers list|detect|show commands - LAFS-compliant with JSON-first output
 */

import { randomUUID } from "node:crypto";
import type { LAFSErrorCategory } from "@cleocode/lafs";
import { resolveOutputFormat } from "@cleocode/lafs";
import type { Command } from "commander";
import pc from "picocolors";
import { isHuman } from "../core/logger.js";
import {
  CANONICAL_HOOK_EVENTS,
  buildHookMatrix,
  getCommonEvents,
  getHookMappingsVersion,
  getHookSupport,
  getProviderSummary,
  getSupportedEvents,
  toNative,
  translateToAll,
} from "../core/hooks/index.js";
import type { CanonicalHookEvent } from "../core/hooks/types.js";
import { detectAllProviders, detectProjectProviders } from "../core/registry/detection.js";
import {
  buildSkillsMap,
  getAllProviders,
  getCommonHookEvents,
  getProvider,
  getProviderCount,
  getProvidersByHookEvent,
  getProvidersByPriority,
  getRegistryVersion,
  providerSupports,
} from "../core/registry/providers.js";
import type { HookEvent } from "../core/registry/types.js";

interface LAFSErrorShape {
  code: string;
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

/**
 * Registers the `providers` command group with list, detect, show, skills-map, hooks, and capabilities subcommands.
 *
 * @remarks
 * All subcommands support both JSON (default) and human-readable output formats via LAFS-compliant envelopes.
 * The providers command group is the primary interface for querying the provider registry.
 *
 * @param program - The root Commander program to attach the providers command group to
 *
 * @example
 * ```bash
 * caamp providers list --tier high
 * caamp providers detect --project
 * caamp providers show claude-code
 * ```
 *
 * @public
 */
export function registerProvidersCommand(program: Command): void {
  const providers = program
    .command("providers")
    .description("Manage AI agent providers");

  providers
    .command("list")
    .description("List all supported providers")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--tier <tier>", "Filter by priority tier (high, medium, low)")
    .action(async (opts: { json?: boolean; human?: boolean; tier?: string }) => {
      const operation = "providers.list";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      const all = opts.tier
        ? getProvidersByPriority(opts.tier as "high" | "medium" | "low")
        : getAllProviders();

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            providers: all,
            count: all.length,
            version: getRegistryVersion(),
            tier: opts.tier || null,
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      console.log(pc.bold(`\nCAMP Provider Registry v${getRegistryVersion()}`));
      console.log(pc.dim(`${getProviderCount()} providers\n`));

      // Group by priority
      const tiers = ["high", "medium", "low"] as const;
      for (const tier of tiers) {
        const tierProviders = all.filter((p) => p.priority === tier);
        if (tierProviders.length === 0) continue;

        const tierLabel = tier === "high" ? pc.green("HIGH") : tier === "medium" ? pc.yellow("MEDIUM") : pc.dim("LOW");
        console.log(`${tierLabel} priority:`);

        for (const p of tierProviders) {
          const status = p.status === "active"
            ? pc.green("active")
            : p.status === "beta"
              ? pc.yellow("beta")
              : pc.dim(p.status);

          console.log(`  ${pc.bold(p.agentFlag.padEnd(20))} ${p.toolName.padEnd(22)} ${p.vendor.padEnd(16)} [${status}]`);
        }
        console.log();
      }
    });

  providers
    .command("detect")
    .description("Auto-detect installed providers")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--project", "Include project-level detection")
    .action(async (opts: { json?: boolean; human?: boolean; project?: boolean }) => {
      const operation = "providers.detect";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      const results = opts.project
        ? detectProjectProviders(process.cwd())
        : detectAllProviders();

      const installed = results.filter((r) => r.installed);

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            installed: installed.map((r) => ({
              id: r.provider.id,
              toolName: r.provider.toolName,
              methods: r.methods,
              projectDetected: r.projectDetected,
            })),
            notInstalled: results.filter((r) => !r.installed).map((r) => r.provider.id),
            count: {
              installed: installed.length,
              total: results.length,
            },
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      console.log(pc.bold(`\nDetected ${installed.length} installed providers:\n`));

      for (const r of installed) {
        const methods = r.methods.join(", ");
        const project = r.projectDetected ? pc.green(" [project]") : "";
        console.log(`  ${pc.green("✓")} ${pc.bold(r.provider.toolName.padEnd(22))} via ${pc.dim(methods)}${project}`);
      }

      const notInstalled = results.filter((r) => !r.installed);
      if (notInstalled.length > 0) {
        console.log(pc.dim(`\n  ${notInstalled.length} providers not detected`));
      }

      console.log();
    });

  providers
    .command("show")
    .description("Show provider details")
    .argument("<id>", "Provider ID or alias")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (id: string, opts: { json?: boolean; human?: boolean }) => {
      const operation = "providers.show";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      const provider = getProvider(id);

      if (!provider) {
        const message = `Provider not found: ${id}`;
        if (format === "json") {
          emitJsonError(operation, mvi, "E_PROVIDER_NOT_FOUND", message, "NOT_FOUND", {
            id,
          });
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            provider,
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      console.log(pc.bold(`\n${provider.toolName}`));
      console.log(pc.dim(`by ${provider.vendor}\n`));

      console.log(`  ID:              ${provider.id}`);
      console.log(`  Flag:            --agent ${provider.agentFlag}`);
      if (provider.aliases.length > 0) {
        console.log(`  Aliases:         ${provider.aliases.join(", ")}`);
      }
      console.log(`  Status:          ${provider.status}`);
      console.log(`  Priority:        ${provider.priority}`);
      console.log();
      console.log(`  Instruction:     ${provider.instructFile}`);
      console.log(`  Config format:   ${provider.configFormat}`);
      console.log(`  Config key:      ${provider.configKey}`);
      console.log(`  Transports:      ${provider.supportedTransports.join(", ")}`);
      console.log(`  Headers:         ${provider.supportsHeaders ? "yes" : "no"}`);
      console.log();
      console.log(pc.dim("  Paths:"));
      console.log(`  Global dir:      ${provider.pathGlobal}`);
      console.log(`  Project dir:     ${provider.pathProject || "(none)"}`);
      console.log(`  Global config:   ${provider.configPathGlobal}`);
      console.log(`  Project config:  ${provider.configPathProject || "(none)"}`);
      console.log(`  Global skills:   ${provider.pathSkills}`);
      console.log(`  Project skills:  ${provider.pathProjectSkills || "(none)"}`);
      console.log();
    });

  providers
    .command("skills-map")
    .description("Show skills path map for all providers")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--provider <id>", "Filter to a specific provider")
    .action(async (opts: { json?: boolean; human?: boolean; provider?: string }) => {
      const operation = "providers.skills-map";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      let map = buildSkillsMap();

      if (opts.provider) {
        map = map.filter((entry) => entry.providerId === opts.provider);
        if (map.length === 0) {
          const message = `Provider not found: ${opts.provider}`;
          if (format === "json") {
            emitJsonError(operation, mvi, "E_PROVIDER_NOT_FOUND", message, "NOT_FOUND", {
              id: opts.provider,
            });
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }
      }

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            skillsMap: map,
            count: map.length,
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      console.log(pc.bold("\nProvider Skills Map\n"));

      // Table header
      console.log(
        `  ${pc.bold("Provider".padEnd(22))} ${pc.bold("Precedence".padEnd(30))} ${pc.bold("Global Path".padEnd(40))} ${pc.bold("Project Path")}`,
      );
      console.log(`  ${"─".repeat(22)} ${"─".repeat(30)} ${"─".repeat(40)} ${"─".repeat(30)}`);

      for (const entry of map) {
        console.log(
          `  ${entry.toolName.padEnd(22)} ${entry.precedence.padEnd(30)} ${(entry.paths.global ?? "-").padEnd(40)} ${entry.paths.project ?? "-"}`,
        );
      }

      console.log(pc.dim(`\n  ${map.length} providers shown`));
      console.log();
    });

  // ── hooks subcommand group ─────────────────────────────────────────
  const hooks = providers
    .command("hooks")
    .description("Show provider hook event support");

  // hooks list (default)
  hooks
    .command("list", { isDefault: true })
    .description("Show all providers with their hook support summary")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: { json?: boolean; human?: boolean }) => {
      const operation = "providers.hooks.list";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      const all = getAllProviders();
      const summaries = all
        .map((p) => getProviderSummary(p.id))
        .filter((s) => s !== undefined);

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            mappingsVersion: getHookMappingsVersion(),
            canonicalEventCount: CANONICAL_HOOK_EVENTS.length,
            providers: summaries,
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      console.log(pc.bold(`\nCAMP Hook Support (mappings v${getHookMappingsVersion()})\n`));
      console.log(pc.dim(`  ${CANONICAL_HOOK_EVENTS.length} canonical events defined\n`));

      // Table header
      console.log(
        `  ${pc.bold("Provider".padEnd(22))} ${pc.bold("System".padEnd(10))} ${pc.bold("Coverage".padEnd(12))} ${pc.bold("Supported".padEnd(12))} ${pc.bold("Provider-Only")}`,
      );
      console.log(`  ${"─".repeat(22)} ${"─".repeat(10)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(20)}`);

      for (const s of summaries) {
        if (!s) continue;
        const system = s.hookSystem === "none"
          ? pc.dim("none")
          : s.experimental
            ? pc.yellow(s.hookSystem + "*")
            : pc.green(s.hookSystem);
        const coverage = s.coverage > 0
          ? (s.coverage >= 75 ? pc.green : s.coverage >= 40 ? pc.yellow : pc.dim)(`${s.coverage}%`)
          : pc.dim("0%");
        const supported = s.supportedCount > 0
          ? `${s.supportedCount}/${s.totalCanonical}`
          : pc.dim("0");
        const provOnly = s.providerOnly.length > 0 ? String(s.providerOnly.length) : pc.dim("-");

        const provider = getProvider(s.providerId);
        const name = provider?.toolName ?? s.providerId;

        console.log(
          `  ${name.padEnd(22)} ${system.padEnd(20)} ${coverage.padEnd(22)} ${supported.padEnd(22)} ${provOnly}`,
        );
      }

      const withHooks = summaries.filter((s) => s && s.supportedCount > 0);
      console.log(pc.dim(`\n  ${withHooks.length} providers with hook support, ${summaries.length - withHooks.length} without`));
      if (summaries.some((s) => s?.experimental)) {
        console.log(pc.dim("  * = experimental hook system"));
      }
      console.log();
    });

  // hooks matrix
  hooks
    .command("matrix")
    .description("Show cross-provider hook support matrix")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--provider <ids>", "Comma-separated provider IDs to compare")
    .action(async (opts: { json?: boolean; human?: boolean; provider?: string }) => {
      const operation = "providers.hooks.matrix";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      const ids = opts.provider?.split(",").map((s) => s.trim());
      const matrix = buildHookMatrix(ids);

      if (format === "json") {
        const envelope = buildEnvelope(operation, mvi, { matrix }, null);
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable matrix
      const providerNames = matrix.providers.map((id) => {
        const p = getProvider(id);
        return (p?.toolName ?? id).slice(0, 14);
      });

      console.log(pc.bold("\nHook Support Matrix\n"));

      // Header
      const eventCol = "CAAMP Event".padEnd(22);
      const provCols = providerNames.map((n) => pc.bold(n.padEnd(16))).join("");
      console.log(`  ${pc.bold(eventCol)} ${provCols}`);
      console.log(`  ${"─".repeat(22)} ${providerNames.map(() => "─".repeat(16)).join("")}`);

      for (const event of matrix.events) {
        const cells = matrix.providers.map((id) => {
          const m = matrix.matrix[event][id];
          if (!m?.supported) return pc.dim("·".padEnd(16));
          return pc.green((m.nativeName ?? "?").slice(0, 14).padEnd(16));
        }).join("");

        console.log(`  ${event.padEnd(22)} ${cells}`);
      }

      // Common events
      const commonEvents = getCommonEvents(matrix.providers);
      console.log(pc.dim(`\n  Common events: ${commonEvents.length > 0 ? commonEvents.join(", ") : "none"}`));
      console.log();
    });

  // hooks translate
  hooks
    .command("translate")
    .description("Translate a hook event name between CAAMP canonical and provider-native")
    .argument("<event>", "Hook event name (canonical or native)")
    .option("--to <provider>", "Target provider ID for canonical→native translation")
    .option("--from <provider>", "Source provider ID for native→canonical translation")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (event: string, opts: { to?: string; from?: string; json?: boolean; human?: boolean }) => {
      const operation = "providers.hooks.translate";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      if (opts.to) {
        // Canonical → native
        const canonical = event as CanonicalHookEvent;
        if (!CANONICAL_HOOK_EVENTS.includes(canonical)) {
          const msg = `Unknown canonical event: ${event}. Valid: ${CANONICAL_HOOK_EVENTS.join(", ")}`;
          if (format === "json") {
            emitJsonError(operation, mvi, "E_UNKNOWN_EVENT", msg, "VALIDATION");
          } else {
            console.error(pc.red(msg));
          }
          process.exit(1);
        }

        const result = getHookSupport(canonical, opts.to);

        if (format === "json") {
          const envelope = buildEnvelope(operation, mvi, {
            direction: "canonical-to-native",
            providerId: opts.to,
            ...result,
          }, null);
          console.log(JSON.stringify(envelope, null, 2));
        } else {
          if (result.supported) {
            console.log(`\n  ${pc.green(event)} → ${pc.bold(result.native!)} (${opts.to})`);
            if (result.notes) console.log(pc.dim(`  Note: ${result.notes}`));
          } else {
            console.log(`\n  ${pc.red(event)} → ${pc.dim("not supported")} (${opts.to})`);
          }
          console.log();
        }
        return;
      }

      if (opts.from) {
        // Native → canonical (import at top of file)
        const { toCanonical } = await import("../core/hooks/index.js");
        const canonical = toCanonical(event, opts.from);

        if (format === "json") {
          const envelope = buildEnvelope(operation, mvi, {
            direction: "native-to-canonical",
            native: event,
            providerId: opts.from,
            canonical,
            supported: canonical !== null,
          }, null);
          console.log(JSON.stringify(envelope, null, 2));
        } else {
          if (canonical) {
            console.log(`\n  ${pc.bold(event)} (${opts.from}) → ${pc.green(canonical)}`);
          } else {
            console.log(`\n  ${pc.bold(event)} (${opts.from}) → ${pc.dim("no canonical mapping (provider-only event)")}`);
          }
          console.log();
        }
        return;
      }

      // No --to or --from: translate canonical event to all providers
      const canonical = event as CanonicalHookEvent;
      if (!CANONICAL_HOOK_EVENTS.includes(canonical)) {
        const msg = `Unknown canonical event: ${event}. Use --from <provider> for native names, or valid canonical: ${CANONICAL_HOOK_EVENTS.join(", ")}`;
        if (format === "json") {
          emitJsonError(operation, mvi, "E_UNKNOWN_EVENT", msg, "VALIDATION");
        } else {
          console.error(pc.red(msg));
        }
        process.exit(1);
      }

      const { getMappedProviderIds } = await import("../core/hooks/index.js");
      const allIds = getMappedProviderIds();
      const translations = translateToAll(canonical, allIds);

      if (format === "json") {
        const envelope = buildEnvelope(operation, mvi, {
          direction: "canonical-to-all",
          canonical: event,
          translations,
          supportedCount: Object.keys(translations).length,
          totalProviders: allIds.length,
        }, null);
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        console.log(pc.bold(`\n  ${event} across providers:\n`));
        for (const id of allIds) {
          const native = translations[id];
          const provider = getProvider(id);
          const name = (provider?.toolName ?? id).padEnd(22);
          if (native) {
            console.log(`  ${pc.green("✓")} ${name} ${pc.bold(native)}`);
          } else {
            console.log(`  ${pc.dim("·")} ${name} ${pc.dim("not supported")}`);
          }
        }
        console.log();
      }
    });

  providers
    .command("capabilities")
    .description("Show provider capability matrix")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--filter <path>", "Filter to providers supporting a capability dot-path (e.g. spawn.supportsSubagents)")
    .action(async (opts: { json?: boolean; human?: boolean; filter?: string }) => {
      const operation = "providers.capabilities";
      const mvi: import("../core/lafs.js").MVILevel = "standard";

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

      let all = getAllProviders();

      if (opts.filter) {
        all = all.filter((p) => providerSupports(p, opts.filter!));
      }

      const matrix = all.map((p) => ({
        id: p.id,
        toolName: p.toolName,
        skillsPrecedence: p.capabilities.skills.precedence,
        hooksCount: p.capabilities.hooks.supported.length,
        spawnMechanism: p.capabilities.spawn.spawnMechanism,
        spawnFlags: {
          supportsSubagents: p.capabilities.spawn.supportsSubagents,
          supportsProgrammaticSpawn: p.capabilities.spawn.supportsProgrammaticSpawn,
          supportsInterAgentComms: p.capabilities.spawn.supportsInterAgentComms,
          supportsParallelSpawn: p.capabilities.spawn.supportsParallelSpawn,
        },
      }));

      if (format === "json") {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            capabilities: matrix,
            count: matrix.length,
            filter: opts.filter || null,
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      // Human-readable output
      console.log(pc.bold("\nProvider Capability Matrix\n"));

      if (opts.filter) {
        console.log(pc.dim(`  Filter: ${opts.filter}\n`));
      }

      // Table header
      console.log(
        `  ${pc.bold("Provider".padEnd(22))} ${pc.bold("Skills Precedence".padEnd(20))} ${pc.bold("Hooks".padEnd(8))} ${pc.bold("Spawn")}`,
      );
      console.log(`  ${"─".repeat(22)} ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(20)}`);

      for (const row of matrix) {
        const hooks = row.hooksCount > 0 ? String(row.hooksCount) : "-";
        const spawn = row.spawnMechanism ?? "-";
        console.log(
          `  ${row.toolName.padEnd(22)} ${row.skillsPrecedence.padEnd(20)} ${hooks.padEnd(8)} ${spawn}`,
        );
      }

      console.log(pc.dim(`\n  ${matrix.length} providers shown`));
      console.log();
    });
}

function buildEnvelope<T>(
  operation: string,
  mvi: import("../core/lafs.js").MVILevel,
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
  mvi: import("../core/lafs.js").MVILevel,
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

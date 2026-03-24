/**
 * skills install command - LAFS-compliant with JSON-first output
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { LAFSErrorCategory } from "@cleocode/lafs";
import type { Command } from "commander";
import pc from "picocolors";
import {
  buildEnvelope,
  ErrorCategories,
  ErrorCodes,
  emitError,
  emitJsonError,
  outputSuccess,
  resolveFormat,
  type MVILevel,
} from "../../core/lafs.js";
import { MarketplaceClient } from "../../core/marketplace/client.js";
import type { MarketplaceResult } from "../../core/marketplace/types.js";
import { formatNetworkError } from "../../core/network/fetch.js";
import { buildSkillSubPathCandidates } from "../../core/paths/standard.js";
import { getInstalledProviders } from "../../core/registry/detection.js";
import { getProvider } from "../../core/registry/providers.js";
import * as catalog from "../../core/skills/catalog.js";
import { discoverSkill } from "../../core/skills/discovery.js";
import { installSkill } from "../../core/skills/installer.js";
import { recordSkillInstall } from "../../core/skills/lock.js";
import { cloneRepo } from "../../core/sources/github.js";
import { cloneGitLabRepo } from "../../core/sources/gitlab.js";
import { isMarketplaceScoped, parseSource } from "../../core/sources/parser.js";
import type { Provider, SourceType } from "../../types.js";

interface InstallResultItem {
  name: string;
  scopedName: string;
  canonicalPath: string;
  providers: string[];
}

interface FailedResultItem {
  name: string;
  error: string;
}

interface InstallSummary {
  installed: InstallResultItem[];
  failed: FailedResultItem[];
  count: {
    installed: number;
    failed: number;
    total: number;
  };
}

/**
 * Registers the `skills install` subcommand for installing skills from various sources.
 *
 * @remarks
 * Supports GitHub URLs, owner/repo shorthand, marketplace scoped names, and skill library profiles.
 * Uses the canonical+symlink model to store skills once and symlink to each targeted agent.
 *
 * @param parent - The parent `skills` Command to attach the install subcommand to
 *
 * @example
 * ```bash
 * caamp skills install owner/repo
 * caamp skills install @author/skill-name --agent claude-code
 * caamp skills install --profile recommended --all
 * ```
 *
 * @public
 */
export function registerSkillsInstall(parent: Command): void {
  parent
    .command("install")
    .description("Install a skill from GitHub, URL, marketplace, or registered skill library")
    .argument("[source]", "Skill source (GitHub URL, owner/repo, @author/name, skill-name)")
    .option("-a, --agent <name>", "Target specific agent(s)", (v, prev: string[]) => [...prev, v], [])
    .option("-g, --global", "Install globally")
    .option("-y, --yes", "Skip confirmation")
    .option("--all", "Install to all detected agents")
    .option("--profile <name>", "Install a skill library profile (minimal, core, recommended, full)")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (source: string | undefined, opts: {
      agent: string[];
      global?: boolean;
      yes?: boolean;
      all?: boolean;
      profile?: string;
      json?: boolean;
      human?: boolean;
    }) => {
      const operation = "skills.install";
      const mvi: import("../../core/lafs.js").MVILevel = "standard";

      let format: "json" | "human";
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: opts.human ?? false,
          projectDefault: "json",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
        process.exit(1);
      }

      // Determine target providers
      let providers: Provider[];

      if (opts.all) {
        providers = getInstalledProviders();
      } else if (opts.agent.length > 0) {
        providers = opts.agent
          .map((a) => getProvider(a))
          .filter((p): p is Provider => p !== undefined);
      } else {
        providers = getInstalledProviders();
      }

      if (providers.length === 0) {
        const message = "No target providers found. Use --agent or --all.";
        if (format === "json") {
          emitError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
        }
        console.error(pc.red(message));
        process.exit(1);
      }

      // Handle --profile: install an entire skill library profile
      if (opts.profile) {
        await handleProfileInstall(opts.profile, providers, opts.global ?? false, format, operation, mvi);
        return;
      }

      // Require source when not using --profile
      if (!source) {
        const message = "Missing required argument: source";
        if (format === "json") {
          emitError(operation, mvi, ErrorCodes.INVALID_INPUT, message, ErrorCategories.VALIDATION);
        }
        console.error(pc.red(message));
        console.log(pc.dim("Usage: caamp skills install <source> or caamp skills install --profile <name>"));
        process.exit(1);
      }

      if (format === "human") {
        console.log(pc.dim(`Installing to ${providers.length} provider(s)...`));
      }

      let localPath: string | undefined;
      let cleanup: (() => Promise<void>) | undefined;
      let skillName: string;
      let sourceValue: string;
      let sourceType: SourceType;

      // Handle marketplace scoped names
      if (isMarketplaceScoped(source)) {
        const sourceResult = await handleMarketplaceSource(
          source,
          providers,
          opts.global ?? false,
          format,
          operation,
          mvi,
        );

        if (sourceResult.success) {
          localPath = sourceResult.localPath;
          cleanup = sourceResult.cleanup;
          skillName = sourceResult.skillName;
          sourceValue = sourceResult.sourceValue;
          sourceType = sourceResult.sourceType;
        } else {
          process.exit(1);
        }
      } else {
        // Parse source
        const parsed = parseSource(source);
        skillName = parsed.inferredName;
        sourceValue = parsed.value;
        sourceType = parsed.type;

        if (parsed.type === "github" && parsed.owner && parsed.repo) {
          try {
            const result = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, parsed.path);
            localPath = result.localPath;
            cleanup = result.cleanup;
          } catch (error) {
            const message = `Failed to clone GitHub repository: ${formatNetworkError(error)}`;
            if (format === "json") {
              emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
            }
            console.error(pc.red(message));
            process.exit(1);
          }
        } else if (parsed.type === "gitlab" && parsed.owner && parsed.repo) {
          try {
            const result = await cloneGitLabRepo(parsed.owner, parsed.repo, parsed.ref, parsed.path);
            localPath = result.localPath;
            cleanup = result.cleanup;
          } catch (error) {
            const message = `Failed to clone GitLab repository: ${formatNetworkError(error)}`;
            if (format === "json") {
              emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
            }
            console.error(pc.red(message));
            process.exit(1);
          }
        } else if (parsed.type === "local") {
          localPath = parsed.value;
          // Read SKILL.md for the authoritative name
          const discovered = await discoverSkill(localPath);
          if (discovered) {
            skillName = discovered.name;
          }
        } else if (parsed.type === "package") {
          // Check registered skill library for this skill name
          if (!catalog.isCatalogAvailable()) {
            const message = "No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.";
            if (format === "json") {
              emitJsonError(operation, mvi, ErrorCodes.INVALID_INPUT, message, ErrorCategories.VALIDATION);
            }
            console.error(pc.red(message));
            process.exit(1);
          }
          const catalogSkill = catalog.getSkill(parsed.inferredName);
          if (catalogSkill) {
            localPath = catalog.getSkillDir(catalogSkill.name);
            skillName = catalogSkill.name;
            sourceValue = `library:${catalogSkill.name}`;
            sourceType = "library";
            if (format === "human") {
              console.log(`  Found in catalog: ${pc.bold(catalogSkill.name)} v${catalogSkill.version} (${pc.dim(catalogSkill.category)})`);
            }
          } else {
            const message = `Skill not found in catalog: ${parsed.inferredName}`;
            if (format === "json") {
              emitJsonError(operation, mvi, ErrorCodes.SKILL_NOT_FOUND, message, ErrorCategories.NOT_FOUND, {
                availableSkills: catalog.listSkills(),
              });
            }
            console.error(pc.red(message));
            console.log(pc.dim("Available skills: " + catalog.listSkills().join(", ")));
            process.exit(1);
          }
        } else {
          const message = `Unsupported source type: ${parsed.type}`;
          if (format === "json") {
            emitJsonError(operation, mvi, ErrorCodes.INVALID_FORMAT, message, ErrorCategories.VALIDATION);
          }
          console.error(pc.red(message));
          process.exit(1);
        }
      }

      try {
        if (!localPath) {
          const message = "No local skill path resolved for installation";
          if (format === "json") {
            emitJsonError(operation, mvi, ErrorCodes.INTERNAL_ERROR, message, ErrorCategories.INTERNAL);
          }
          console.error(pc.red(message));
          process.exit(1);
        }

        const result = await installSkill(
          localPath,
          skillName!,
          providers,
          opts.global ?? false,
        );

        if (result.success) {
          // Record in lock file
          const isGlobal = (sourceType === "library" || sourceType === "package") ? true : (opts.global ?? false);
          await recordSkillInstall(
            skillName!,
            sourceValue,
            sourceValue,
            sourceType,
            result.linkedAgents,
            result.canonicalPath,
            isGlobal,
          );

          const installedItem: InstallResultItem = {
            name: skillName!,
            scopedName: sourceValue,
            canonicalPath: result.canonicalPath,
            providers: result.linkedAgents,
          };

          const summary: InstallSummary = {
            installed: [installedItem],
            failed: [],
            count: {
              installed: 1,
              failed: 0,
              total: 1,
            },
          };

          if (format === "json") {
            outputSuccess(operation, mvi, summary);
          } else {
            console.log(pc.green(`\n✓ Installed ${pc.bold(skillName)}`));
            console.log(`  Canonical: ${pc.dim(result.canonicalPath)}`);
            console.log(`  Linked to: ${result.linkedAgents.join(", ")}`);

            if (result.errors.length > 0) {
              console.log(pc.yellow("\nWarnings:"));
              for (const err of result.errors) {
                console.log(`  ${pc.yellow("!")} ${err}`);
              }
            }
          }
        } else {
          const summary: InstallSummary = {
            installed: [],
            failed: [{
              name: skillName!,
              error: result.errors.join(", "),
            }],
            count: {
              installed: 0,
              failed: 1,
              total: 1,
            },
          };

          if (format === "json") {
            const envelope = buildEnvelope(operation, mvi, summary, {
              code: ErrorCodes.INSTALL_FAILED,
              message: result.errors.join(", "),
              category: ErrorCategories.INTERNAL,
              retryable: false,
              retryAfterMs: null,
              details: { skillName, sourceValue },
            });
            console.error(JSON.stringify(envelope, null, 2));
          } else {
            console.log(pc.yellow(`\n✗ Failed to install ${pc.bold(skillName)}`));
            console.log(pc.yellow("Errors:"));
            for (const err of result.errors) {
              console.log(`  ${pc.yellow("!")} ${err}`);
            }
          }
          process.exit(1);
        }
      } finally {
        if (cleanup) await cleanup();
      }
    });
}

async function handleProfileInstall(
  profileName: string,
  providers: Provider[],
  isGlobal: boolean,
  format: "json" | "human",
  operation: string,
  mvi: MVILevel,
): Promise<void> {
  if (!catalog.isCatalogAvailable()) {
    const message = "No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.";
    if (format === "json") {
      emitError(operation, mvi, ErrorCodes.INVALID_INPUT, message, ErrorCategories.VALIDATION);
    }
    console.error(pc.red(message));
    process.exit(1);
  }

  const profileSkills = catalog.resolveProfile(profileName);
  if (profileSkills.length === 0) {
    const message = `Profile not found: ${profileName}`;
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.SKILL_NOT_FOUND, message, ErrorCategories.NOT_FOUND, {
        availableProfiles: catalog.listProfiles(),
      });
    }
    console.error(pc.red(message));
    const available = catalog.listProfiles();
    if (available.length > 0) {
      console.log(pc.dim("Available profiles: " + available.join(", ")));
    }
    process.exit(1);
  }

  if (format === "human") {
    console.log(`Installing profile ${pc.bold(profileName)} (${profileSkills.length} skill(s))...`);
    console.log(pc.dim(`Target: ${providers.length} provider(s)`));
  }

  const installed: InstallResultItem[] = [];
  const failed: FailedResultItem[] = [];

  for (const name of profileSkills) {
    const skillDir = catalog.getSkillDir(name);
    try {
      const result = await installSkill(
        skillDir,
        name,
        providers,
        isGlobal,
      );

      if (result.success) {
        if (format === "human") {
          console.log(pc.green(`  + ${name}`));
        }
        await recordSkillInstall(
          name,
          `library:${name}`,
          `library:${name}`,
          "library",
          result.linkedAgents,
          result.canonicalPath,
          true,
        );
        installed.push({
          name,
          scopedName: `library:${name}`,
          canonicalPath: result.canonicalPath,
          providers: result.linkedAgents,
        });
      } else {
        if (format === "human") {
          console.log(pc.yellow(`  ! ${name}: ${result.errors.join(", ")}`));
        }
        failed.push({
          name,
          error: result.errors.join(", "),
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (format === "human") {
        console.log(pc.red(`  x ${name}: ${errorMsg}`));
      }
      failed.push({
        name,
        error: errorMsg,
      });
    }
  }

  const summary: InstallSummary = {
    installed,
    failed,
    count: {
      installed: installed.length,
      failed: failed.length,
      total: profileSkills.length,
    },
  };

  if (format === "json") {
    if (failed.length > 0) {
      const envelope = buildEnvelope(operation, mvi, summary, {
        code: ErrorCodes.INSTALL_FAILED,
        message: `${failed.length} skill(s) failed to install`,
        category: ErrorCategories.INTERNAL,
        retryable: false,
        retryAfterMs: null,
        details: { failed: failed.map(f => f.name) },
      });
      console.error(JSON.stringify(envelope, null, 2));
      process.exit(1);
    } else {
      outputSuccess(operation, mvi, summary);
    }
  } else {
    console.log(`\n${pc.green(`${installed.length} installed`)}, ${failed.length > 0 ? pc.yellow(`${failed.length} failed`) : "0 failed"}`);
    if (failed.length > 0) {
      process.exit(1);
    }
  }
}

interface MarketplaceSourceSuccess {
  success: true;
  localPath: string;
  cleanup: () => Promise<void>;
  skillName: string;
  sourceValue: string;
  sourceType: SourceType;
}

interface MarketplaceSourceError {
  success: false;
}

type MarketplaceSourceResult = MarketplaceSourceSuccess | MarketplaceSourceError;

async function handleMarketplaceSource(
  source: string,
  _providers: Provider[],
  _isGlobal: boolean,
  format: "json" | "human",
  operation: string,
  mvi: MVILevel,
): Promise<MarketplaceSourceResult> {
  if (format === "human") {
    console.log(pc.dim(`Searching marketplace for ${source}...`));
  }

  const client = new MarketplaceClient();
  let skill: import("../../core/marketplace/types.js").MarketplaceResult | null;

  try {
    skill = await client.getSkill(source);
  } catch (error) {
    const message = `Marketplace lookup failed: ${formatNetworkError(error)}`;
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  if (!skill) {
    const message = `Skill not found: ${source}`;
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.SKILL_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  if (format === "human") {
    console.log(`  Found: ${pc.bold(skill.name)} by ${skill.author} (${pc.dim(skill.repoFullName)})`);
  }

  const parsed = parseSource(skill.githubUrl);
  if (parsed.type !== "github" || !parsed.owner || !parsed.repo) {
    const message = "Could not resolve GitHub source";
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.INVALID_FORMAT, message, ErrorCategories.VALIDATION);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  try {
    const subPathCandidates = buildSkillSubPathCandidates(skill.path, parsed.path);
    let cloneError: unknown;
    let cloned = false;
    let localPath: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    for (const subPath of subPathCandidates) {
      try {
        const result = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, subPath);
        if (subPath && !existsSync(result.localPath)) {
          await result.cleanup();
          continue;
        }
        localPath = result.localPath;
        cleanup = result.cleanup;
        cloned = true;
        break;
      } catch (error) {
        cloneError = error;
      }
    }

    if (!cloned) {
      throw cloneError ?? new Error("Unable to resolve skill path from marketplace metadata");
    }

    return {
      success: true,
      localPath: localPath!,
      cleanup: cleanup!,
      skillName: skill.name,
      sourceValue: skill.githubUrl,
      sourceType: parsed.type,
    };
  } catch (error) {
    const message = `Failed to fetch source repository: ${formatNetworkError(error)}`;
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
    }
    console.error(pc.red(message));
    return { success: false };
  }
}

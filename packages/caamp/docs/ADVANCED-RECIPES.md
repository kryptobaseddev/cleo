# CAAMP Advanced Orchestration Recipes

These recipes show how to compose CAAMP's existing APIs for multi-provider automation.
They focus on production patterns: tier filtering, rollback, conflict handling, and single-operation wrappers.

If you want command-line wrappers for these patterns, use the LAFS-compliant `caamp advanced ...` commands documented in [Advanced CLI](ADVANCED-CLI.md).

## How would you implement a batch operation in CAAMP that installs multiple skills and MCP servers across a filtered subset of providers based on tier priority, while maintaining rollback capability if any installation fails?

```typescript
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig, Provider, ProviderPriority } from "@cleocode/caamp";
import {
  getInstalledProviders,
  installMcpServer,
  installSkill,
  removeSkill,
  resolveConfigPath,
} from "@cleocode/caamp";

type Scope = "project" | "global";
const TIER_ORDER: ProviderPriority[] = ["high", "medium", "low"];

interface McpBatchItem {
  serverName: string;
  config: McpServerConfig;
  scope: Scope;
}

interface SkillBatchItem {
  sourcePath: string;
  skillName: string;
  isGlobal: boolean;
}

function filterProvidersByTier(
  providers: Provider[],
  minimumTier: ProviderPriority,
): Provider[] {
  const maxIndex = TIER_ORDER.indexOf(minimumTier);
  return providers
    .filter((provider) => TIER_ORDER.indexOf(provider.priority) <= maxIndex)
    .sort((a, b) => TIER_ORDER.indexOf(a.priority) - TIER_ORDER.indexOf(b.priority));
}

async function snapshotConfigFiles(paths: string[]): Promise<Map<string, string | null>> {
  const snapshots = new Map<string, string | null>();

  for (const path of paths) {
    if (snapshots.has(path)) continue;
    if (!existsSync(path)) {
      snapshots.set(path, null);
      continue;
    }
    snapshots.set(path, await readFile(path, "utf-8"));
  }

  return snapshots;
}

async function restoreConfigSnapshots(snapshots: Map<string, string | null>): Promise<void> {
  for (const [path, content] of snapshots) {
    if (content === null) {
      await rm(path, { force: true });
      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }
}

export async function installBatchWithRollback(
  minimumTier: ProviderPriority,
  mcpItems: McpBatchItem[],
  skillItems: SkillBatchItem[],
  projectDir = process.cwd(),
): Promise<{ success: boolean; error?: string }> {
  const targets = filterProvidersByTier(getInstalledProviders(), minimumTier);

  const candidateConfigPaths = targets.flatMap((provider) => {
    const paths: string[] = [];
    for (const item of mcpItems) {
      const path = resolveConfigPath(provider, item.scope, projectDir);
      if (path) paths.push(path);
    }
    return paths;
  });

  const configSnapshots = await snapshotConfigFiles(candidateConfigPaths);
  const appliedSkills: Array<{ skillName: string; linkedProviders: Provider[]; isGlobal: boolean }> = [];

  try {
    for (const item of mcpItems) {
      for (const provider of targets) {
        const result = await installMcpServer(
          provider,
          item.serverName,
          item.config,
          item.scope,
          projectDir,
        );

        if (!result.success) {
          throw new Error(`MCP install failed for ${provider.id}: ${result.error ?? "unknown error"}`);
        }
      }
    }

    for (const item of skillItems) {
      const result = await installSkill(
        item.sourcePath,
        item.skillName,
        targets,
        item.isGlobal,
        projectDir,
      );

      if (result.errors.length > 0) {
        throw new Error(`Skill install failed for ${item.skillName}: ${result.errors.join("; ")}`);
      }

      const linkedProviders = targets.filter((provider) => result.linkedAgents.includes(provider.id));
      appliedSkills.push({
        skillName: item.skillName,
        linkedProviders,
        isGlobal: item.isGlobal,
      });
    }

    return { success: true };
  } catch (error) {
    for (const item of [...appliedSkills].reverse()) {
      await removeSkill(item.skillName, item.linkedProviders, item.isGlobal, projectDir);
    }

    await restoreConfigSnapshots(configSnapshots);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

This gives you tier-based targeting plus transactional rollback for MCP config files, and best-effort rollback for skill links/copies.

## Design a strategy to handle configuration conflicts when installing MCP servers across agents with overlapping or incompatible configuration requirements using CAAMP's abstraction layer.

Use a preflight + policy + apply workflow:

1. Preflight: detect blocking conflicts before writing anything.
2. Policy: choose `"fail"`, `"skip"`, or `"overwrite"` per conflict type.
3. Apply: install only the operations allowed by policy.

```typescript
import type { McpServerConfig, Provider } from "@cleocode/caamp";
import { getTransform, installMcpServer, listMcpServers } from "@cleocode/caamp";

type Scope = "project" | "global";
type ConflictPolicy = "fail" | "skip" | "overwrite";

interface PlannedInstall {
  serverName: string;
  config: McpServerConfig;
  scope: Scope;
}

interface Conflict {
  providerId: string;
  serverName: string;
  code: "unsupported-transport" | "unsupported-headers" | "existing-mismatch";
  message: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

async function detectConflicts(
  providers: Provider[],
  planned: PlannedInstall[],
  projectDir = process.cwd(),
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];

  for (const provider of providers) {
    for (const item of planned) {
      if (item.config.type && !provider.supportedTransports.includes(item.config.type)) {
        conflicts.push({
          providerId: provider.id,
          serverName: item.serverName,
          code: "unsupported-transport",
          message: `${provider.id} does not support transport ${item.config.type}`,
        });
      }

      if (item.config.headers && !provider.supportsHeaders) {
        conflicts.push({
          providerId: provider.id,
          serverName: item.serverName,
          code: "unsupported-headers",
          message: `${provider.id} does not support remote headers in config`,
        });
      }

      const existing = await listMcpServers(provider, item.scope, projectDir);
      const current = existing.find((entry) => entry.name === item.serverName);
      if (!current) continue;

      const transform = getTransform(provider.id);
      const desired = transform
        ? transform(item.serverName, item.config)
        : item.config;

      if (stableStringify(current.config) !== stableStringify(desired)) {
        conflicts.push({
          providerId: provider.id,
          serverName: item.serverName,
          code: "existing-mismatch",
          message: `${provider.id} already has ${item.serverName} with different config`,
        });
      }
    }
  }

  return conflicts;
}

export async function installWithConflictStrategy(
  providers: Provider[],
  planned: PlannedInstall[],
  policy: ConflictPolicy,
  projectDir = process.cwd(),
): Promise<{ conflicts: Conflict[]; applied: number }> {
  const conflicts = await detectConflicts(providers, planned, projectDir);

  if (policy === "fail" && conflicts.length > 0) {
    return { conflicts, applied: 0 };
  }

  let applied = 0;

  for (const provider of providers) {
    for (const item of planned) {
      const conflict = conflicts.find((c) => c.providerId === provider.id && c.serverName === item.serverName);
      if (conflict && policy === "skip") continue;

      const result = await installMcpServer(
        provider,
        item.serverName,
        item.config,
        item.scope,
        projectDir,
      );

      if (result.success) applied += 1;
    }
  }

  return { conflicts, applied };
}
```

This strategy keeps CAAMP's abstraction layer intact and centralizes conflict decisions in one place.

## How would you update instruction files across multiple agents with different configuration formats (JSON, YAML, TOML) using a single CAAMP operation?

Use one wrapper around `injectAll()`. Instruction files are managed independently from provider config formats, so JSON/YAML/TOML differences do not change the instruction update flow.

```typescript
import type { Provider } from "@cleocode/caamp";
import { getInstalledProviders, groupByInstructFile, injectAll } from "@cleocode/caamp";

export async function updateInstructionsAcrossAgents(
  content: string,
  scope: "project" | "global" = "project",
  projectDir = process.cwd(),
  providers: Provider[] = getInstalledProviders(),
) {
  const grouped = groupByInstructFile(providers);
  const actions = await injectAll(providers, projectDir, scope, content);

  return {
    updatedFiles: actions.size,
    files: [...actions.entries()].map(([file, action]) => ({ file, action })),
    grouping: [...grouped.entries()].map(([file, ps]) => ({
      file,
      providers: ps.map((provider) => provider.id),
    })),
  };
}
```

Use this as the single programmatic operation in your app/service layer.

## How would you use CAAMP's programmatic TypeScript API to configure both global and project-level settings for an AI agent in a single operation?

Wrap both scope writes in one function and return a unified result object.

```typescript
import type { McpServerConfig, Provider } from "@cleocode/caamp";
import {
  injectAll,
  installMcpServer,
  resolveConfigPath,
} from "@cleocode/caamp";

export async function configureProviderGlobalAndProject(
  provider: Provider,
  options: {
    globalServer?: { name: string; config: McpServerConfig };
    projectServer?: { name: string; config: McpServerConfig };
    instructionContent?: string;
  },
  projectDir = process.cwd(),
) {
  const globalConfigPath = resolveConfigPath(provider, "global", projectDir);
  const projectConfigPath = resolveConfigPath(provider, "project", projectDir);

  const globalResult = options.globalServer
    ? await installMcpServer(
      provider,
      options.globalServer.name,
      options.globalServer.config,
      "global",
      projectDir,
    )
    : null;

  const projectResult = options.projectServer && projectConfigPath
    ? await installMcpServer(
      provider,
      options.projectServer.name,
      options.projectServer.config,
      "project",
      projectDir,
    )
    : null;

  const instructionResults = options.instructionContent
    ? {
      global: await injectAll([provider], projectDir, "global", options.instructionContent),
      project: await injectAll([provider], projectDir, "project", options.instructionContent),
    }
    : null;

  return {
    provider: provider.id,
    paths: {
      globalConfigPath,
      projectConfigPath,
    },
    installs: {
      global: globalResult,
      project: projectResult,
    },
    instructions: instructionResults,
  };
}
```

This gives you a single API entry point while still using CAAMP's scope-aware primitives.

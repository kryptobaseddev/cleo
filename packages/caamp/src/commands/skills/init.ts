/**
 * skills init command - scaffold a new skill - LAFS-compliant with JSON-first output
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from "../../core/lafs.js";
import { isHuman } from "../../core/logger.js";

/**
 * Registers the `skills init` subcommand for scaffolding new SKILL.md templates.
 *
 * @remarks
 * Creates a SKILL.md file with the standard template structure in the specified directory.
 * Optionally takes a skill name to pre-fill the template heading.
 *
 * @param parent - The parent `skills` Command to attach the init subcommand to
 *
 * @example
 * ```bash
 * caamp skills init my-skill
 * caamp skills init --dir ./skills/new-skill
 * ```
 *
 * @public
 */
export function registerSkillsInit(parent: Command): void {
  parent
    .command("init")
    .description("Create a new SKILL.md template")
    .argument("[name]", "Skill name")
    .option("-d, --dir <path>", "Output directory", ".")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (name: string | undefined, opts: { dir: string; json?: boolean; human?: boolean }) => {
      const operation = "skills.init";
      const mvi: import("../../core/lafs.js").MVILevel = "standard";

      let format: "json" | "human";
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: "json",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
        process.exit(1);
      }

      const skillName = name ?? "my-skill";
      const skillDir = join(opts.dir, skillName);

      if (existsSync(skillDir)) {
        const message = `Directory already exists: ${skillDir}`;
        if (format === "json") {
          emitJsonError(operation, mvi, ErrorCodes.INVALID_CONSTRAINT, message, ErrorCategories.CONFLICT, {
            path: skillDir,
          });
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      await mkdir(skillDir, { recursive: true });

      const template = `---
name: ${skillName}
description: Describe what this skill does and when to use it
license: MIT
metadata:
  author: your-name
  version: "1.0"
---

# ${skillName}

## When to use this skill

Describe the conditions under which an AI agent should activate this skill.

## Instructions

Provide detailed instructions for the AI agent here.

## Examples

Show example inputs and expected outputs.
`;

      await writeFile(join(skillDir, "SKILL.md"), template, "utf-8");

      const result = {
        name: skillName,
        directory: skillDir,
        template: "SKILL.md",
        created: true,
      };

      if (format === "json") {
        outputSuccess(operation, mvi, result);
        return;
      }

      // Human-readable output
      console.log(pc.green(`✓ Created skill template: ${skillDir}/SKILL.md`));
      console.log(pc.dim("\nNext steps:"));
      console.log(pc.dim("  1. Edit SKILL.md with your instructions"));
      console.log(pc.dim(`  2. Validate: caamp skills validate ${join(skillDir, "SKILL.md")}`));
      console.log(pc.dim(`  3. Install: caamp skills install ${skillDir}`));
    });
}

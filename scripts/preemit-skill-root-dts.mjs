#!/usr/bin/env node
/**
 * Pre-emit the `@cleocode/core/skills/skill-root.d.ts` stub so `tsc -b`
 * (project-references typecheck) can resolve the cycle-breaking import path
 * before any actual build runs.
 *
 * Background: caamp imports `@cleocode/core/skills/skill-root.js` to obtain
 * the skills-root resolver. That single file has zero `@cleocode/*` imports
 * (per `packages/core/src/skills/skill-root.ts`), so its .d.ts can be
 * hand-written without touching the wave-5 core declaration emit.
 *
 * This script duplicates the stub block from `build.mjs` (lines ~665-680) so
 * the CI `Type Check` job (which runs `tsc -b` only, never `pnpm run build`)
 * sees the stub before it walks project references.
 *
 * Wired via root `package.json` "pretypecheck" so it runs automatically.
 *
 * @task T9776 (resolves GAP-MAIN-1 type-check failure on main)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const skillRootDts = `export type SkillSourceType = 'canonical' | 'user' | 'community' | 'agent-created';
export interface IsCanonicalOptions {
  dbSourceType?: SkillSourceType | string;
  manifestNames?: string[];
}
export declare const AGENTS_SKILLS_BRIDGE_PATH: string;
export declare const CLAUDE_SKILLS_AGENTS_SHARED_PATH: string;
export declare function resolveSkillsRoot(): string;
export declare function is_canonical(skillPath: string, options?: IsCanonicalOptions): boolean;
`;

const outDir = resolve(repoRoot, 'packages/core/dist/skills');
const outFile = resolve(outDir, 'skill-root.d.ts');

await mkdir(outDir, { recursive: true });
await writeFile(outFile, skillRootDts, 'utf8');
console.log(`[preemit] wrote ${outFile} (T9776)`);

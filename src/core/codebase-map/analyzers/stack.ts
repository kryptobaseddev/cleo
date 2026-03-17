/**
 * Stack analyzer — detects languages, frameworks, dependencies, package manager, and runtime.
 * Extends project-detect.ts with deep dependency analysis.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../../../store/project-detect.js';
import type { StackAnalysis } from '../index.js';

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'react',
  vue: 'vue',
  angular: '@angular/core',
  svelte: 'svelte',
  solid: 'solid-js',
  preact: 'preact',
  next: 'next',
  nuxt: 'nuxt',
  remix: '@remix-run/node',
  astro: 'astro',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  hono: 'hono',
  nestjs: '@nestjs/core',
  trpc: '@trpc/server',
  graphql: 'graphql',
  prisma: '@prisma/client',
  drizzle: 'drizzle-orm',
  typeorm: 'typeorm',
  sequelize: 'sequelize',
  mongoose: 'mongoose',
};

const LANGUAGE_INDICATORS: Record<string, string[]> = {
  TypeScript: ['tsconfig.json'],
  Python: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  Rust: ['Cargo.toml'],
  Go: ['go.mod'],
  Ruby: ['Gemfile'],
  Java: ['pom.xml', 'build.gradle'],
  PHP: ['composer.json'],
  Elixir: ['mix.exs'],
};

export function analyzeStack(projectRoot: string, projectContext: ProjectContext): StackAnalysis {
  const languages: string[] = [];
  const frameworks: string[] = [];
  const dependencies: StackAnalysis['dependencies'] = [];

  for (const [lang, indicators] of Object.entries(LANGUAGE_INDICATORS)) {
    if (indicators.some((f) => existsSync(join(projectRoot, f)))) {
      languages.push(lang);
    }
  }

  // JavaScript is always present if Node/Bun/Deno
  if (
    projectContext.projectTypes.includes('node') ||
    projectContext.projectTypes.includes('bun') ||
    projectContext.projectTypes.includes('deno')
  ) {
    if (!languages.includes('TypeScript')) {
      languages.push('JavaScript');
    } else {
      languages.push('JavaScript/TypeScript');
    }
  }

  // Parse package.json for deep dependency info
  let packageManager: string | undefined;
  let runtime: string | undefined;

  if (existsSync(join(projectRoot, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;

      for (const [name, version] of Object.entries(deps)) {
        dependencies.push({ name, version: String(version), dev: false });
        const frameworkKey = Object.entries(FRAMEWORK_DEPS).find(([, pkg]) => pkg === name)?.[0];
        if (frameworkKey && !frameworks.includes(frameworkKey)) {
          frameworks.push(frameworkKey);
        }
      }

      for (const [name, version] of Object.entries(devDeps)) {
        dependencies.push({ name, version: String(version), dev: true });
        const frameworkKey = Object.entries(FRAMEWORK_DEPS).find(([, pkg]) => pkg === name)?.[0];
        if (frameworkKey && !frameworks.includes(frameworkKey)) {
          frameworks.push(frameworkKey);
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Detect package manager from lock files
  if (existsSync(join(projectRoot, 'bun.lockb')) || existsSync(join(projectRoot, 'bun.lock'))) {
    packageManager = 'bun';
    runtime = 'bun';
  } else if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
    runtime = 'node';
  } else if (existsSync(join(projectRoot, 'yarn.lock'))) {
    packageManager = 'yarn';
    runtime = 'node';
  } else if (existsSync(join(projectRoot, 'package.json'))) {
    packageManager = 'npm';
    runtime = 'node';
  } else if (
    existsSync(join(projectRoot, 'deno.json')) ||
    existsSync(join(projectRoot, 'deno.jsonc'))
  ) {
    runtime = 'deno';
  }

  return {
    languages,
    frameworks,
    dependencies,
    ...(packageManager ? { packageManager } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/**
 * Integration analyzer — detects external APIs, databases, auth providers, CI/CD, and containerization.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../../../store/project-detect.js';
import type { IntegrationAnalysis } from '../index.js';

const API_SDK_PATTERNS: Record<string, string[]> = {
  aws: ['aws-sdk', '@aws-sdk/client-s3', '@aws-sdk/client-lambda', 'aws-lambda'],
  gcp: ['@google-cloud/storage', '@google-cloud/bigquery', 'google-auth-library'],
  azure: ['@azure/storage-blob', '@azure/identity', '@azure/cosmos'],
  stripe: ['stripe'],
  twilio: ['twilio'],
  sendgrid: ['@sendgrid/mail'],
  resend: ['resend'],
  openai: ['openai'],
  anthropic: ['@anthropic-ai/sdk'],
  github: ['@octokit/rest', '@octokit/core', 'octokit'],
  slack: ['@slack/web-api', '@slack/bolt'],
  discord: ['discord.js', 'discord-api-types'],
};

const DB_SDK_PATTERNS: Record<string, string[]> = {
  postgres: ['pg', 'postgres', '@neondatabase/serverless', 'node-postgres'],
  mysql: ['mysql', 'mysql2'],
  sqlite: ['better-sqlite3', 'sqlite', 'sql.js'],
  mongodb: ['mongodb', 'mongoose'],
  redis: ['redis', 'ioredis', '@upstash/redis'],
  prisma: ['@prisma/client'],
  drizzle: ['drizzle-orm'],
  typeorm: ['typeorm'],
  sequelize: ['sequelize'],
  supabase: ['@supabase/supabase-js'],
  firebase: ['firebase', 'firebase-admin'],
  dynamodb: ['@aws-sdk/client-dynamodb', 'dynamoose'],
};

const AUTH_PATTERNS: Record<string, string[]> = {
  auth0: ['auth0', '@auth0/nextjs-auth0'],
  clerk: ['@clerk/nextjs', '@clerk/clerk-sdk-node'],
  nextauth: ['next-auth', '@auth/core'],
  passport: ['passport'],
  jwt: ['jsonwebtoken', '@types/jsonwebtoken', 'jose'],
  oauth2: ['simple-oauth2', 'oauth2-server'],
  lucia: ['lucia'],
  'better-auth': ['better-auth'],
};

const CICD_FILES: Record<string, string[]> = {
  'github-actions': ['.github/workflows'],
  'gitlab-ci': ['.gitlab-ci.yml'],
  circleci: ['.circleci/config.yml'],
  jenkins: ['Jenkinsfile'],
  travis: ['.travis.yml'],
  buildkite: ['.buildkite/pipeline.yml'],
};

export function analyzeIntegrations(
  projectRoot: string,
  _projectContext: ProjectContext,
): IntegrationAnalysis {
  const apis: string[] = [];
  const databases: string[] = [];
  const auth: string[] = [];
  const cicd: string[] = [];

  // Parse dependencies from package.json
  const allDeps = collectAllDeps(projectRoot);

  for (const [service, pkgs] of Object.entries(API_SDK_PATTERNS)) {
    if (pkgs.some((p) => allDeps.has(p))) {
      apis.push(service);
    }
  }

  for (const [db, pkgs] of Object.entries(DB_SDK_PATTERNS)) {
    if (pkgs.some((p) => allDeps.has(p))) {
      databases.push(db);
    }
  }

  for (const [provider, pkgs] of Object.entries(AUTH_PATTERNS)) {
    if (pkgs.some((p) => allDeps.has(p))) {
      auth.push(provider);
    }
  }

  // Check CI/CD config files
  for (const [system, files] of Object.entries(CICD_FILES)) {
    if (files.some((f) => existsSync(join(projectRoot, f)))) {
      cicd.push(system);
    }
  }

  // Detect containerization
  const containerized =
    existsSync(join(projectRoot, 'Dockerfile')) ||
    existsSync(join(projectRoot, 'docker-compose.yml')) ||
    existsSync(join(projectRoot, 'docker-compose.yaml')) ||
    existsSync(join(projectRoot, 'compose.yml')) ||
    existsSync(join(projectRoot, 'compose.yaml')) ||
    existsSync(join(projectRoot, '.devcontainer/devcontainer.json')) ||
    existsSync(join(projectRoot, 'fly.toml')) ||
    existsSync(join(projectRoot, 'railway.toml'));

  return { apis, databases, auth, cicd, containerized };
}

function collectAllDeps(projectRoot: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const allPkgDeps = {
      ...((pkg.dependencies ?? {}) as Record<string, string>),
      ...((pkg.devDependencies ?? {}) as Record<string, string>),
    };
    for (const name of Object.keys(allPkgDeps)) {
      deps.add(name);
    }
  } catch {
    // ignore
  }
  return deps;
}

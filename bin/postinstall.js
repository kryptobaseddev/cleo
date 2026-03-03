#!/usr/bin/env node
/**
 * NPM Postinstall Hook - Bootstrap Global CLEO System
 * 
 * This script runs automatically after `npm install -g @cleocode/cleo`.
 * It bootstraps the global CLEO system:
 *   - Creates ~/.cleo/ directory structure
 *   - Installs global templates (CLEO-INJECTION.md)
 *   - Sets up CAAMP provider configs
 *   - Installs MCP server to detected providers
 *   - Creates ~/.agents/AGENTS.md hub
 * 
 * This is the ONLY place global setup should happen. Project `cleo init`
 * only creates local ./.cleo/ and registers with NEXUS.
 * 
 * @task T5267
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine if we're running from npm global install or local dev
function isNpmGlobalInstall() {
  const execPath = process.argv[1] || '';
  // Check if running from node_modules/@cleocode/cleo/
  return execPath.includes('node_modules/@cleocode/cleo/') || 
         execPath.includes('node_modules\\@cleocode\\cleo\\');
}

// Get package root
function getPackageRoot() {
  // When running from bin/, go up to package root
  return resolve(__dirname, '..');
}

async function bootstrapGlobalCleo() {
  // Only run for npm global installs, not local dev or other contexts
  if (!isNpmGlobalInstall()) {
    console.log('CLEO: Skipping global bootstrap (not npm global install)');
    return;
  }

  console.log('CLEO: Bootstrapping global system...');

  const cleoHome = join(homedir(), '.cleo');
  const globalTemplatesDir = join(cleoHome, 'templates');
  const globalAgentsDir = join(homedir(), '.agents');

  // Create directories
  await mkdir(globalTemplatesDir, { recursive: true });
  await mkdir(globalAgentsDir, { recursive: true });

  // Copy CLEO-INJECTION.md template
  const packageRoot = getPackageRoot();
  const templateSource = join(packageRoot, 'templates', 'CLEO-INJECTION.md');
  const templateDest = join(globalTemplatesDir, 'CLEO-INJECTION.md');

  if (existsSync(templateSource)) {
    await copyFile(templateSource, templateDest);
    console.log('CLEO: Installed global template (CLEO-INJECTION.md)');
  }

  // Setup CAAMP and MCP (these may fail gracefully if CAAMP isn't fully configured yet)
  try {
    const { getInstalledProviders, inject, buildInjectionContent } = await import('@cleocode/caamp');
    
    // Create ~/.agents/AGENTS.md with CLEO block
    const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');
    let agentsContent = '';
    
    if (existsSync(globalAgentsMd)) {
      agentsContent = await readFile(globalAgentsMd, 'utf-8');
      // Strip old CLEO blocks
      agentsContent = agentsContent.replace(/\n?<!-- CLEO:START -->[\s\S]*?<!-- CLEO:END -->\n?/g, '');
    }

    // Inject CLEO reference
    await inject(globalAgentsMd, '@~/.cleo/templates/CLEO-INJECTION.md');
    console.log('CLEO: Updated ~/.agents/AGENTS.md');

    // Install MCP server to detected providers
    const providers = getInstalledProviders();
    if (providers.length > 0) {
      const { generateMcpServerEntry, getMcpServerName } = await import('../dist/core/mcp/index.js');
      const { installMcpServerToAll } = await import('@cleocode/caamp');
      
      // Detect environment (stable/beta/dev)
      const env = generateMcpServerEntry.length === 1 
        ? { mode: 'stable', source: 'npm' }
        : { mode: 'stable', source: 'npm' };
      
      const serverEntry = generateMcpServerEntry(env);
      const serverName = getMcpServerName(env);
      
      await installMcpServerToAll(providers, serverName, serverEntry, 'global', process.cwd());
      console.log(`CLEO: Installed MCP server to ${providers.length} provider(s)`);
    }
  } catch (err) {
    // CAAMP/MCP setup is optional at install time - will be set up on first use
    console.log('CLEO: CAAMP/MCP setup deferred (will complete on first use)');
  }

  console.log('CLEO: Global bootstrap complete!');
  console.log('CLEO: Run "cleo init" in any project to set up local CLEO.');
}

// Run bootstrap
bootstrapGlobalCleo().catch(err => {
  console.error('CLEO: Bootstrap error (non-fatal):', err.message);
  process.exit(0); // Never fail npm install
});

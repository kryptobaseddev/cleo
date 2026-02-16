/**
 * Dynamic command registry from self-describing script headers.
 *
 * Parses ###CLEO header blocks from script files and builds a registry
 * of available commands with metadata (category, synopsis, flags, etc.).
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

/** Header start/end markers for CLEO command metadata. */
const CLEO_HEADER_START = '###CLEO';
const CLEO_HEADER_END = '###END';

/** Parsed command metadata. */
export interface CommandMeta {
  command: string;
  category: string;
  synopsis: string;
  aliases: string[];
  relevance: string;
  flags: string[];
  exits: string[];
  jsonOutput: boolean;
  jsonDefault: boolean;
  subcommands: string[];
  note: string;
  aliasFor: string;
  scriptName: string;
}

/** Parse a ###CLEO header block from a script file. */
export function parseCommandHeader(scriptPath: string): CommandMeta | null {
  if (!existsSync(scriptPath)) return null;

  const content = readFileSync(scriptPath, 'utf-8');
  const lines = content.split('\n');

  let inHeader = false;
  const headerLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === CLEO_HEADER_START) {
      inHeader = true;
      continue;
    }
    if (line.trim() === CLEO_HEADER_END) break;
    if (inHeader && line.startsWith('# ')) {
      headerLines.push(line.slice(2));
    }
  }

  if (headerLines.length === 0) return null;

  const meta: CommandMeta = {
    command: '',
    category: '',
    synopsis: '',
    aliases: [],
    relevance: '',
    flags: [],
    exits: [],
    jsonOutput: false,
    jsonDefault: false,
    subcommands: [],
    note: '',
    aliasFor: '',
    scriptName: basename(scriptPath),
  };

  for (const line of headerLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'command': meta.command = value; break;
      case 'category': meta.category = value; break;
      case 'synopsis': meta.synopsis = value; break;
      case 'aliases': meta.aliases = value.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'relevance': meta.relevance = value; break;
      case 'flags': meta.flags = value.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'exits': meta.exits = value.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'json_output': meta.jsonOutput = value === 'true'; break;
      case 'json_default': meta.jsonDefault = value === 'true'; break;
      case 'subcommands': meta.subcommands = value.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'note': meta.note = value; break;
      case 'alias_for': meta.aliasFor = value; break;
    }
  }

  return meta.command ? meta : null;
}

/**
 * Scan a scripts directory and build a command registry.
 * Returns a map of command name to metadata.
 */
export function scanAllCommands(scriptsDir: string): Map<string, CommandMeta> {
  const registry = new Map<string, CommandMeta>();

  if (!existsSync(scriptsDir)) return registry;

  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith('.sh') && !file.endsWith('.ts')) continue;

    const meta = parseCommandHeader(join(scriptsDir, file));
    if (meta) {
      registry.set(meta.command, meta);
    }
  }

  return registry;
}

/** Validate a command header has required fields. */
export function validateHeader(meta: CommandMeta): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!meta.command) errors.push('Missing required field: command');
  if (!meta.category) errors.push('Missing required field: category');
  if (!meta.synopsis) errors.push('Missing required field: synopsis');

  return { valid: errors.length === 0, errors };
}

/** Get command-to-script mapping. */
export function getCommandScriptMap(
  scriptsDir: string,
): Record<string, string> {
  const registry = scanAllCommands(scriptsDir);
  const map: Record<string, string> = {};

  for (const [cmd, meta] of registry) {
    map[cmd] = meta.scriptName;
    for (const alias of meta.aliases) {
      map[alias] = meta.scriptName;
    }
  }

  return map;
}

/** Group commands by category. */
export function getCommandsByCategory(
  scriptsDir: string,
): Record<string, CommandMeta[]> {
  const registry = scanAllCommands(scriptsDir);
  const byCategory: Record<string, CommandMeta[]> = {};

  for (const meta of registry.values()) {
    const cat = meta.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(meta);
  }

  return byCategory;
}

/** Filter commands by relevance level. */
export function getCommandsByRelevance(
  scriptsDir: string,
  relevance: string,
): CommandMeta[] {
  const registry = scanAllCommands(scriptsDir);
  return Array.from(registry.values()).filter(
    meta => meta.relevance === relevance,
  );
}

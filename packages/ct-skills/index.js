'use strict';

const path = require('path');
const fs = require('fs');

const LIBRARY_ROOT = __dirname;
const SKILLS_ROOT = path.join(LIBRARY_ROOT, 'skills');
const PROFILES_ROOT = path.join(LIBRARY_ROOT, 'profiles');
const PROTOCOLS_ROOT = path.join(LIBRARY_ROOT, 'protocols');
const SHARED_ROOT = path.join(SKILLS_ROOT, '_shared');

// --- Package metadata ---

/** Package version from package.json */
const version = require('./package.json').version;

/** Absolute path to the package root directory */
const libraryRoot = LIBRARY_ROOT;

// --- Core data ---

/** Parsed skills.json index */
const skillsIndex = JSON.parse(
  fs.readFileSync(path.join(LIBRARY_ROOT, 'skills.json'), 'utf8')
);

/** Parsed manifest.json dispatch registry */
const manifest = JSON.parse(
  fs.readFileSync(path.join(SKILLS_ROOT, 'manifest.json'), 'utf8')
);

/** Parsed _shared/placeholders.json */
const shared = JSON.parse(
  fs.readFileSync(path.join(SHARED_ROOT, 'placeholders.json'), 'utf8')
);

/** All skill entries from skills.json */
const skills = skillsIndex.skills;

// --- Existing API (preserved) ---

/**
 * List all skill names.
 * @returns {string[]}
 */
function listSkills() {
  return skills.map(s => s.name);
}

/**
 * Get skill metadata from skills.json by name.
 * @param {string} name - Skill name (e.g. "ct-research-agent")
 * @returns {object|undefined}
 */
function getSkill(name) {
  return skills.find(s => s.name === name);
}

/**
 * Resolve absolute path to a skill's SKILL.md file.
 * @param {string} name - Skill name
 * @returns {string}
 */
function getSkillPath(name) {
  return path.join(SKILLS_ROOT, name, 'SKILL.md');
}

/**
 * Resolve absolute path to a skill's directory.
 * @param {string} name - Skill name
 * @returns {string}
 */
function getSkillDir(name) {
  return path.join(SKILLS_ROOT, name);
}

/**
 * Get the dispatch matrix from manifest.json.
 * @returns {object}
 */
function getDispatchMatrix() {
  return manifest.dispatch_matrix;
}

/**
 * Read a skill's SKILL.md content as a string.
 * @param {string} name - Skill name
 * @returns {string}
 */
function readSkillContent(name) {
  return fs.readFileSync(getSkillPath(name), 'utf8');
}

// --- New: Core & Dependency awareness ---

/**
 * Get all skills marked as core.
 * @returns {object[]} SkillEntry[] where core === true
 */
function getCoreSkills() {
  return skills.filter(s => s.core === true);
}

/**
 * Get skills filtered by category.
 * @param {string} category - One of: core, recommended, specialist, composition, meta
 * @returns {object[]}
 */
function getSkillsByCategory(category) {
  return skills.filter(s => s.category === category);
}

/**
 * Get direct dependency names for a skill.
 * @param {string} name - Skill name
 * @returns {string[]}
 */
function getSkillDependencies(name) {
  const skill = getSkill(name);
  if (!skill) return [];
  return skill.dependencies || [];
}

/**
 * Resolve the full dependency tree for a set of skill names.
 * Returns deduplicated list with transitive deps. _shared is always included conceptually.
 * @param {string[]} names - Initial skill names
 * @returns {string[]} Full list of skills including transitive dependencies
 */
function resolveDependencyTree(names) {
  const resolved = new Set();
  const queue = [...names];

  while (queue.length > 0) {
    const current = queue.shift();
    if (resolved.has(current)) continue;
    resolved.add(current);

    const deps = getSkillDependencies(current);
    for (const dep of deps) {
      if (!resolved.has(dep)) {
        queue.push(dep);
      }
    }
  }

  return Array.from(resolved);
}

// --- New: Profile-based selection ---

/** Cache for loaded profile definitions */
const _profileCache = new Map();

/**
 * List available profile names.
 * @returns {string[]}
 */
function listProfiles() {
  if (!fs.existsSync(PROFILES_ROOT)) return [];
  return fs.readdirSync(PROFILES_ROOT)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/**
 * Get a profile definition by name.
 * @param {string} name - Profile name (e.g. "minimal", "core", "recommended", "full")
 * @returns {object|undefined}
 */
function getProfile(name) {
  if (_profileCache.has(name)) return _profileCache.get(name);

  const filePath = path.join(PROFILES_ROOT, `${name}.json`);
  if (!fs.existsSync(filePath)) return undefined;

  const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  _profileCache.set(name, profile);
  return profile;
}

/**
 * Resolve a profile to its full skill list, following extends chains
 * and resolving transitive skill dependencies.
 * @param {string} name - Profile name
 * @returns {string[]} Full deduplicated skill list
 */
function resolveProfile(name) {
  const allSkills = new Set();
  const visited = new Set();

  // Walk the extends chain
  let current = name;
  while (current && !visited.has(current)) {
    visited.add(current);
    const profile = getProfile(current);
    if (!profile) break;

    for (const skill of profile.skills) {
      allSkills.add(skill);
    }
    current = profile.extends || null;
  }

  // Resolve transitive dependencies
  return resolveDependencyTree(Array.from(allSkills));
}

// --- New: Shared resources ---

/**
 * List available shared resource names (files in _shared/).
 * @returns {string[]}
 */
function listSharedResources() {
  if (!fs.existsSync(SHARED_ROOT)) return [];
  return fs.readdirSync(SHARED_ROOT)
    .filter(f => !f.startsWith('.'))
    .map(f => f.replace(/\.[^.]+$/, ''));
}

/**
 * Get absolute path to a shared resource file.
 * @param {string} name - Resource name (without extension, e.g. "subagent-protocol-base")
 * @returns {string|undefined}
 */
function getSharedResourcePath(name) {
  if (!fs.existsSync(SHARED_ROOT)) return undefined;
  const files = fs.readdirSync(SHARED_ROOT);
  const match = files.find(f => f.replace(/\.[^.]+$/, '') === name);
  return match ? path.join(SHARED_ROOT, match) : undefined;
}

/**
 * Read a shared resource file content.
 * @param {string} name - Resource name (without extension)
 * @returns {string|undefined}
 */
function readSharedResource(name) {
  const filePath = getSharedResourcePath(name);
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}

// --- New: Protocols ---

/**
 * List available protocol names.
 * @returns {string[]}
 */
function listProtocols() {
  if (!fs.existsSync(PROTOCOLS_ROOT)) return [];
  return fs.readdirSync(PROTOCOLS_ROOT)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

/**
 * Get absolute path to a protocol file.
 * @param {string} name - Protocol name (e.g. "research", "implementation")
 * @returns {string|undefined}
 */
function getProtocolPath(name) {
  const filePath = path.join(PROTOCOLS_ROOT, `${name}.md`);
  return fs.existsSync(filePath) ? filePath : undefined;
}

/**
 * Read a protocol file content.
 * @param {string} name - Protocol name
 * @returns {string|undefined}
 */
function readProtocol(name) {
  const filePath = getProtocolPath(name);
  if (!filePath) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}

// --- New: Validation ---

const VALID_CATEGORIES = ['core', 'recommended', 'specialist', 'composition', 'meta'];

/**
 * Validate a skill's frontmatter fields.
 * @param {string} name - Skill name
 * @returns {{ valid: boolean, issues: { level: string, field: string, message: string }[] }}
 */
function validateSkillFrontmatter(name) {
  const skill = getSkill(name);
  const issues = [];

  if (!skill) {
    return { valid: false, issues: [{ level: 'error', field: 'name', message: `Skill '${name}' not found` }] };
  }

  // Required fields
  if (!skill.name) issues.push({ level: 'error', field: 'name', message: 'Missing name' });
  if (!skill.description) issues.push({ level: 'error', field: 'description', message: 'Missing description' });

  // Version format
  if (!skill.version) {
    issues.push({ level: 'warn', field: 'version', message: 'Missing version' });
  } else if (!/^\d+\.\d+\.\d+$/.test(skill.version)) {
    issues.push({ level: 'warn', field: 'version', message: `Invalid semver: ${skill.version}` });
  }

  // Category validation
  if (skill.category && !VALID_CATEGORIES.includes(skill.category)) {
    issues.push({ level: 'error', field: 'category', message: `Invalid category '${skill.category}', must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  // Core must be boolean
  if (skill.core !== undefined && typeof skill.core !== 'boolean') {
    issues.push({ level: 'error', field: 'core', message: `core must be boolean, got ${typeof skill.core}` });
  }

  // Tier must be 0-3
  if (skill.tier !== undefined && (typeof skill.tier !== 'number' || skill.tier < 0 || skill.tier > 3)) {
    issues.push({ level: 'warn', field: 'tier', message: `Tier should be 0-3, got ${skill.tier}` });
  }

  // Dependencies must reference valid skills
  if (Array.isArray(skill.dependencies)) {
    const allNames = listSkills();
    for (const dep of skill.dependencies) {
      if (!allNames.includes(dep)) {
        issues.push({ level: 'error', field: 'dependencies', message: `Unknown dependency: ${dep}` });
      }
    }
  }

  // Protocol should reference an existing protocol file
  if (skill.protocol && skill.protocol !== 'null') {
    const protoPath = getProtocolPath(skill.protocol);
    if (!protoPath) {
      issues.push({ level: 'warn', field: 'protocol', message: `Protocol file not found: ${skill.protocol}.md` });
    }
  }

  // Description length
  if (skill.description && skill.description.length > 1024) {
    issues.push({ level: 'error', field: 'description', message: `Description too long: ${skill.description.length} chars (max 1024)` });
  }

  return {
    valid: issues.filter(i => i.level === 'error').length === 0,
    issues
  };
}

/**
 * Validate all skills.
 * @returns {Map<string, { valid: boolean, issues: { level: string, field: string, message: string }[] }>}
 */
function validateAll() {
  const results = new Map();
  for (const name of listSkills()) {
    results.set(name, validateSkillFrontmatter(name));
  }
  return results;
}

// --- Exports ---

module.exports = {
  // Existing (preserved)
  skills,
  manifest,
  shared,
  listSkills,
  getSkill,
  getSkillPath,
  getSkillDir,
  getDispatchMatrix,
  readSkillContent,

  // New: Core & Dependency awareness
  getCoreSkills,
  getSkillsByCategory,
  getSkillDependencies,
  resolveDependencyTree,

  // New: Profile-based selection
  listProfiles,
  getProfile,
  resolveProfile,

  // New: Shared resources
  listSharedResources,
  getSharedResourcePath,
  readSharedResource,

  // New: Protocols
  listProtocols,
  getProtocolPath,
  readProtocol,

  // New: Validation
  validateSkillFrontmatter,
  validateAll,

  // New: Package metadata
  version,
  libraryRoot,
};

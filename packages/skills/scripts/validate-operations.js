#!/usr/bin/env node
"use strict";
/**
 * Skill Operation Validator
 *
 * Cross-references all operation names found in skill markdown files
 * against the canonical registry to catch drift before it reaches agents.
 *
 * Usage:
 *   npx tsx packages/skills/scripts/validate-operations.ts
 *   # or via package.json script:
 *   pnpm --filter @cleocode/skills validate:ops
 *
 * Exit codes:
 *   0 — all operations valid
 *   1 — one or more invalid operations found
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
// ESM / CJS compatible __dirname shim (tsx may run in either mode)
const __scriptDir = (() => {
    try {
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            return path.dirname((0, node_url_1.fileURLToPath)(import.meta.url));
        }
    }
    catch {
        // import.meta not available in CJS
    }
    // CJS fallback — __dirname is a global in that context
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
})();
// ---------------------------------------------------------------------------
// Registry extraction
// ---------------------------------------------------------------------------
/**
 * File extensions that should never be treated as operation names.
 * e.g. "check.json", "tasks.db", "check.sh" are file references, not ops.
 */
const FILE_EXTENSIONS = new Set([
    'json', 'sh', 'db', 'md', 'ts', 'js', 'yaml', 'yml', 'txt', 'csv',
    'toml', 'env', 'lock', 'log', 'sql', 'mjs', 'cjs', 'jsonl',
]);
/**
 * Parse the registry.ts source file with regex to extract all
 * { domain, operation } pairs without importing TypeScript directly.
 * This keeps the script dependency-free for the skills package.
 */
function extractRegistryOperations(registryPath) {
    const source = fs.readFileSync(registryPath, 'utf8');
    const ops = new Set();
    const lines = source.split('\n');
    let pendingDomain = null;
    for (const line of lines) {
        const domainMatch = /domain:\s*['"]([^'"]+)['"]/.exec(line);
        const opMatch = /operation:\s*['"]([^'"]+)['"]/.exec(line);
        if (domainMatch) {
            pendingDomain = domainMatch[1];
        }
        if (opMatch && pendingDomain) {
            ops.add(`${pendingDomain}.${opMatch[1]}`);
        }
        // Reset when we hit the closing brace of an object entry.
        if (/^\s*\},?\s*$/.test(line) && pendingDomain) {
            pendingDomain = null;
        }
    }
    return ops;
}
/**
 * Returns the set of 1-based line numbers that should be skipped during
 * validation because they are inside anti-pattern / deprecated sections
 * or carry an explicit skip marker.
 *
 * Detection strategy:
 * - Inline `<!-- validate-skip -->` marker skips that line.
 * - A heading containing skip keywords opens a skip region that lasts until
 *   the next heading of equal or higher level.
 * - A table whose header row contains "Anti-Pattern" / "Bad Pattern" /
 *   "Deprecated" opens a skip region closed by the next blank line or heading.
 */
function buildSkipLineSet(lines) {
    const SKIP_HEADING_KEYWORDS = [
        'anti-pattern',
        'anti_pattern',
        'bad pattern',
        'deprecated',
        'validate-skip',
    ];
    const skipLines = new Set();
    let skipDepth = 0; // heading level that opened the current skip region
    let inSkipRegion = false;
    let inSkipTable = false; // skip-region opened by a bad-pattern table header
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1; // 1-based
        // --- Inline marker ---
        if (line.includes('<!-- validate-skip -->')) {
            skipLines.add(lineNo);
            continue;
        }
        // --- Heading detection ---
        const headingMatch = /^(#{1,6})\s+(.+)/.exec(line);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2].toLowerCase();
            const isSkipHeading = SKIP_HEADING_KEYWORDS.some((kw) => text.includes(kw));
            if (isSkipHeading) {
                inSkipRegion = true;
                inSkipTable = false;
                skipDepth = level;
                skipLines.add(lineNo);
            }
            else if (inSkipRegion && level <= skipDepth) {
                // Equal or higher-level heading closes the region.
                inSkipRegion = false;
                inSkipTable = false;
                skipDepth = 0;
            }
            // Headings always close table-based skip regions.
            if (inSkipTable) {
                inSkipTable = false;
                inSkipRegion = false;
            }
        }
        // --- Table header containing bad-pattern keywords ---
        if (!inSkipRegion && /\|\s*(anti.pattern|bad\s+pattern|deprecated)/i.test(line)) {
            inSkipRegion = true;
            inSkipTable = true;
            skipDepth = 0; // not heading-based; closed by heading or blank line
            skipLines.add(lineNo);
        }
        // Blank line closes a table-based skip region.
        if (inSkipTable && line.trim() === '') {
            inSkipRegion = false;
            inSkipTable = false;
        }
        if (inSkipRegion) {
            skipLines.add(lineNo);
        }
    }
    return skipLines;
}
/**
 * Returns true if the candidate operation string looks like a false positive:
 * - It ends with a dot (trailing punctuation artefact).
 * - It is a known file extension (e.g. "json", "sh", "db").
 * - It contains a hyphen (no registry operation uses hyphens).
 * - It consists only of dots or is empty.
 * - It is a template placeholder like "..." or "xxx".
 */
function isSpuriousOperation(operation) {
    if (!operation || operation.endsWith('.'))
        return true;
    if (operation.includes('-'))
        return true;
    if (/^\.+$/.test(operation))
        return true;
    if (/^[.]{2,}/.test(operation))
        return true; // starts with ..
    if (FILE_EXTENSIONS.has(operation.toLowerCase()))
        return true;
    // Placeholder patterns like "...", "xxx"
    if (/^\.{2,}$/.test(operation))
        return true;
    return false;
}
/**
 * Deduplicate refs: same line + same key only reported once.
 */
function dedup(refs) {
    const seen = new Set();
    return refs.filter((r) => {
        const k = `${r.line}:${r.key}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
/**
 * Scan a single markdown file and return all operation references found
 * outside of skip regions.
 */
function scanFile(filePath, canonicalDomains) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const skipLines = buildSkipLineSet(lines);
    const refs = [];
    // Build a per-file dot-notation regex from canonical domains.
    // We build it once and reuse (reset lastIndex each loop iteration).
    const domainsAlt = [...canonicalDomains].join('|');
    // Pattern 1 — MCP style, single line:
    //   domain: "tasks", operation: "show"
    //   query({ domain: "tasks", operation: "show" })
    const mcpSingleLine = /domain:\s*["']([^"']+)["'].*?operation:\s*["']([^"']+)["']/g;
    // Pattern 3 — dot notation: tasks.show
    // Requires the match starts at a word boundary (not preceded by alphanumeric
    // or dot) and ends at a word boundary (not followed by alphanumeric).
    // The operation part must be [a-z] followed by alphanumerics/dots (no hyphens).
    const dotRe = new RegExp(`(?<![\\w.])(?:${domainsAlt})\\.([a-z][a-z0-9.]*)(?![a-z0-9.])`, 'g');
    // Pattern 4 — CLI style: cleo <domain> <operation>
    // The operation token for CLI must be a simple word (no hyphens, no dots,
    // because CLI subcommands map to simple words or dash-separated flags — but
    // registry operations never contain hyphens).
    const cliRe = /\bcleo\s+([a-z][a-z]*)\s+([a-z][a-z0-9.]*)\b/g;
    let prevDomain = null;
    let prevDomainLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        if (skipLines.has(lineNo)) {
            prevDomain = null;
            continue;
        }
        // --- Pattern 1: single-line MCP ---
        let m;
        mcpSingleLine.lastIndex = 0;
        while ((m = mcpSingleLine.exec(line)) !== null) {
            const domain = m[1];
            const operation = m[2];
            if (!isSpuriousOperation(operation) && domain && !domain.includes('.')) {
                refs.push({ file: filePath, line: lineNo, rawText: m[0], key: `${domain}.${operation}` });
            }
        }
        // --- Pattern 2: multi-line MCP (domain on one line, operation on next) ---
        const domainOnly = /domain:\s*["']([^"']+)["']/.exec(line);
        const opOnly = /operation:\s*["']([^"']+)["']/.exec(line);
        if (domainOnly && !opOnly) {
            prevDomain = domainOnly[1];
            prevDomainLine = lineNo;
        }
        else if (opOnly && !domainOnly && prevDomain && prevDomainLine === lineNo - 1) {
            const domain = prevDomain;
            const operation = opOnly[1];
            if (!isSpuriousOperation(operation) && !domain.includes('.')) {
                const key = `${domain}.${operation}`;
                // Only emit if single-line didn't already capture it.
                const alreadyCaptured = refs.some((r) => r.line === lineNo - 1 && r.key === key);
                if (!alreadyCaptured) {
                    refs.push({
                        file: filePath,
                        line: lineNo,
                        rawText: `domain: "${domain}", operation: "${operation}"`,
                        key,
                    });
                }
            }
            prevDomain = null;
        }
        else {
            if (!domainOnly)
                prevDomain = null;
        }
        // --- Pattern 3: dot notation ---
        dotRe.lastIndex = 0;
        while ((m = dotRe.exec(line)) !== null) {
            const full = m[0];
            const dotIndex = full.indexOf('.');
            const domain = full.slice(0, dotIndex);
            const operation = full.slice(dotIndex + 1);
            if (!canonicalDomains.has(domain))
                continue;
            if (isSpuriousOperation(operation))
                continue;
            const key = `${domain}.${operation}`;
            const alreadyCaptured = refs.some((r) => r.line === lineNo && r.key === key);
            if (!alreadyCaptured) {
                refs.push({ file: filePath, line: lineNo, rawText: full, key });
            }
        }
        // --- Pattern 4: CLI style ---
        cliRe.lastIndex = 0;
        while ((m = cliRe.exec(line)) !== null) {
            const domain = m[1];
            const operation = m[2];
            if (!canonicalDomains.has(domain))
                continue;
            if (isSpuriousOperation(operation))
                continue;
            const key = `${domain}.${operation}`;
            const alreadyCaptured = refs.some((r) => r.line === lineNo && r.key === key);
            if (!alreadyCaptured) {
                refs.push({ file: filePath, line: lineNo, rawText: m[0], key });
            }
        }
    }
    return dedup(refs);
}
/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectMarkdownFiles(fullPath));
        }
        else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push(fullPath);
        }
    }
    return results;
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    const monorepoRoot = path.resolve(__scriptDir, '../../..');
    const registryPath = path.join(monorepoRoot, 'packages/cleo/src/dispatch/registry.ts');
    const skillsDir = path.join(monorepoRoot, 'packages/skills/skills');
    if (!fs.existsSync(registryPath)) {
        console.error(`Registry not found: ${registryPath}`);
        process.exit(1);
    }
    // Build canonical operation set and domain set from registry.
    const registryOps = extractRegistryOperations(registryPath);
    const canonicalDomains = new Set();
    for (const key of registryOps) {
        canonicalDomains.add(key.split('.')[0]);
    }
    console.log(`Validating skills against registry (${registryOps.size} operations)...\n`);
    const allFiles = collectMarkdownFiles(skillsDir).sort();
    let totalFiles = 0;
    let failedFiles = 0;
    for (const filePath of allFiles) {
        const relPath = path.relative(monorepoRoot, filePath);
        const refs = scanFile(filePath, canonicalDomains);
        if (refs.length === 0)
            continue;
        totalFiles++;
        const invalid = refs.filter((r) => !registryOps.has(r.key));
        if (invalid.length === 0) {
            console.log(`  \u2713 ${relPath} \u2014 ${refs.length} reference${refs.length === 1 ? '' : 's'}, all valid`);
        }
        else {
            failedFiles++;
            console.log(`  \u2717 ${relPath} \u2014 ${invalid.length} invalid:`);
            for (const ref of invalid) {
                const dotIdx = ref.key.indexOf('.');
                const domain = ref.key.slice(0, dotIdx);
                const operation = ref.key.slice(dotIdx + 1);
                let reason;
                if (!canonicalDomains.has(domain)) {
                    reason = `domain '${domain}' does not exist`;
                }
                else {
                    reason = `operation '${operation}' not found in domain '${domain}'`;
                }
                console.log(`    Line ${ref.line}: ${ref.key} \u2014 ${reason}`);
            }
        }
    }
    console.log(`\nSummary: ${totalFiles} file${totalFiles === 1 ? '' : 's'} checked, ${failedFiles} failure${failedFiles === 1 ? '' : 's'}`);
    process.exit(failedFiles > 0 ? 1 : 0);
}
main();
//# sourceMappingURL=validate-operations.js.map
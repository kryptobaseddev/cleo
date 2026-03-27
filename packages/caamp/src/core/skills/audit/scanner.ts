/**
 * Security scanning engine for SKILL.md files
 *
 * Scans skill content against 46+ security rules
 * and produces findings with line-level precision.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AuditFinding, AuditResult, AuditRule, AuditSeverity } from '../../../types.js';
import { AUDIT_RULES } from './rules.js';

const SEVERITY_WEIGHTS: Record<AuditSeverity, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
  info: 0,
};

/**
 * Scan a single file against security audit rules.
 *
 * @remarks
 * Checks each line of the file against all active rules and produces findings
 * with line-level precision. Calculates a security score (100 = clean, 0 = dangerous)
 * based on severity-weighted penalties.
 *
 * @param filePath - Absolute path to the file to scan
 * @param rules - Custom rules to scan against (defaults to the built-in 46+ rules)
 * @returns Audit result with findings, score, and pass/fail status
 *
 * @example
 * ```typescript
 * const result = await scanFile("/path/to/SKILL.md");
 * console.log(`Score: ${result.score}/100, Passed: ${result.passed}`);
 * ```
 *
 * @public
 */
export async function scanFile(filePath: string, rules?: AuditRule[]): Promise<AuditResult> {
  if (!existsSync(filePath)) {
    return { file: filePath, findings: [], score: 100, passed: true };
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const activeRules = rules ?? AUDIT_RULES;
  const findings: AuditFinding[] = [];

  for (const rule of activeRules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const match = line.match(rule.pattern);
      if (match) {
        findings.push({
          rule,
          line: i + 1,
          column: (match.index ?? 0) + 1,
          match: match[0],
          context: line.trim(),
        });
      }
    }
  }

  // Calculate score (100 = clean, 0 = very dangerous)
  const totalPenalty = findings.reduce(
    (sum, f) => sum + (SEVERITY_WEIGHTS[f.rule.severity] ?? 0),
    0,
  );
  const score = Math.max(0, 100 - totalPenalty);
  const passed = !findings.some(
    (f) => f.rule.severity === 'critical' || f.rule.severity === 'high',
  );

  return { file: filePath, findings, score, passed };
}

/**
 * Scan a directory of skills for security issues.
 *
 * @remarks
 * Iterates over skill subdirectories and scans each `SKILL.md` file found.
 *
 * @param dirPath - Absolute path to the skills directory to scan
 * @returns Array of audit results, one per scanned SKILL.md
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "../../paths/standard.js";
 *
 * const results = await scanDirectory(getCanonicalSkillsDir());
 * const failing = results.filter(r => !r.passed);
 * ```
 *
 * @public
 */
export async function scanDirectory(dirPath: string): Promise<AuditResult[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');

  if (!existsSync(dirPath)) return [];

  const entries = await readdir(dirPath, { withFileTypes: true });
  const results: AuditResult[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const skillFile = join(dirPath, entry.name, 'SKILL.md');
      if (existsSync(skillFile)) {
        results.push(await scanFile(skillFile));
      }
    }
  }

  return results;
}

/**
 * Convert audit results to SARIF 2.1.0 format (Static Analysis Results Interchange Format).
 *
 * @remarks
 * Produces a standards-compliant SARIF document suitable for CI/CD integration
 * and code scanning tools (e.g. GitHub Code Scanning).
 *
 * @param results - Array of audit results to convert
 * @returns SARIF 2.1.0 JSON object
 *
 * @example
 * ```typescript
 * const results = await scanDirectory("/path/to/skills");
 * const sarif = toSarif(results);
 * writeFileSync("audit.sarif", JSON.stringify(sarif, null, 2));
 * ```
 *
 * @public
 */
export function toSarif(results: AuditResult[]): object {
  return {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'caamp-audit',
            version: '0.1.0',
            rules: AUDIT_RULES.map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.description },
              defaultConfiguration: {
                level: r.severity === 'critical' || r.severity === 'high' ? 'error' : 'warning',
              },
              properties: { category: r.category },
            })),
          },
        },
        results: results.flatMap((result) =>
          result.findings.map((f) => ({
            ruleId: f.rule.id,
            level:
              f.rule.severity === 'critical' || f.rule.severity === 'high' ? 'error' : 'warning',
            message: { text: `${f.rule.description}: ${f.match}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: result.file },
                  region: {
                    startLine: f.line,
                    startColumn: f.column,
                  },
                },
              },
            ],
          })),
        ),
      },
    ],
  };
}

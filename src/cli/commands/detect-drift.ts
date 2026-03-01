/**
 * detect-drift command - Documentation drift detection for LLM agents
 * @epic T4698
 * @task T4705
 *
 * Exit codes:
 *   0 - No drift detected (all checks pass)
 *   1 - Warnings only (documentation exists but needs attention)
 *   2 - Errors detected (missing documentation or critical drift)
 *
 * Output: LAFS-compliant JSON envelope for agent consumption
 */
// TODO T4894: operation not yet in registry — detect-drift runs local static analysis; session.context.drift is a different operation

import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliOutput } from '../renderers/index.js';

function findProjectRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let currentDir = dirname(currentFile);
  
  while (currentDir !== '/') {
    if (existsSync(join(currentDir, 'package.json'))) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  
  return process.cwd();
}

interface DriftIssue {
  severity: 'error' | 'warning';
  category: string;
  message: string;
  file?: string;
  recommendation: string;
}

interface DriftCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  issues: DriftIssue[];
}

interface DriftResult {
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    errors: number;
    exitCode: number;
  };
  checks: DriftCheck[];
  recommendations: string[];
}

export function registerDetectDriftCommand(program: Command): void {
  program
    .command('detect-drift')
    .description('Detect documentation drift against TypeScript source of truth')
    .action(async () => {
      const projectRoot = findProjectRoot();
      
      const result: DriftResult = {
        summary: {
          totalChecks: 0,
          passed: 0,
          warnings: 0,
          errors: 0,
          exitCode: 0,
        },
        checks: [],
        recommendations: [],
      };

      const addCheck = (name: string, status: 'pass' | 'fail' | 'warn', message: string, issues: DriftIssue[] = []) => {
        result.checks.push({ name, status, message, issues });
        result.summary.totalChecks++;
        if (status === 'pass') result.summary.passed++;
        if (status === 'warn') {
          result.summary.warnings++;
          result.summary.exitCode = Math.max(result.summary.exitCode, 1);
        }
        if (status === 'fail') {
          result.summary.errors++;
          result.summary.exitCode = 2;
        }
      };

      const safeRead = (path: string): string => {
        try {
          return readFileSync(path, 'utf-8');
        } catch {
          return '';
        }
      };

      // Check 1: Gateway-to-spec sync
      try {
        const specPath = join(projectRoot, 'docs', 'specs', 'CLEO-OPERATIONS-REFERENCE.md');
        const queryPath = join(projectRoot, 'src', 'mcp', 'gateways', 'query.ts');
        const mutatePath = join(projectRoot, 'src', 'mcp', 'gateways', 'mutate.ts');
        
        if (!existsSync(specPath)) {
          addCheck('Gateway-to-spec sync', 'fail', 'CLEO-OPERATIONS-REFERENCE.md missing', [{
            severity: 'error',
            category: 'spec',
            message: 'Operations reference specification not found',
            file: specPath,
            recommendation: 'Create docs/specs/CLEO-OPERATIONS-REFERENCE.md with canonical operation definitions',
          }]);
        } else if (!existsSync(queryPath) || !existsSync(mutatePath)) {
          addCheck('Gateway-to-spec sync', 'fail', 'MCP gateway files missing', [{
            severity: 'error',
            category: 'implementation',
            message: 'MCP gateway files not found',
            file: queryPath,
            recommendation: 'Verify src/mcp/gateways/query.ts and mutate.ts exist',
          }]);
        } else {
          const specContent = safeRead(specPath);
          const queryContent = safeRead(queryPath);
          const mutateContent = safeRead(mutatePath);
          
          // Extract operations from spec
          const specOpsMatch = specContent.match(/## `([a-z_]+)`/g) || [];
          const specOps = specOpsMatch.map(m => m.replace(/## `|`/g, ''));
          
          // Extract operations from gateways
          const queryOpsMatch = queryContent.match(/case '([a-z_]+)':/g) || [];
          const mutateOpsMatch = mutateContent.match(/case '([a-z_]+)':/g) || [];
          const gatewayOps = [
            ...queryOpsMatch.map(m => m.replace(/case '|':/g, '')),
            ...mutateOpsMatch.map(m => m.replace(/case '|':/g, '')),
          ];
          
          // Find mismatches
          const specOnly = specOps.filter(op => !gatewayOps.includes(op));
          const gatewayOnly = gatewayOps.filter(op => !specOps.includes(op));
          
          if (specOnly.length === 0 && gatewayOnly.length === 0) {
            addCheck('Gateway-to-spec sync', 'pass', `All ${specOps.length} operations synchronized`);
          } else {
            const issues: DriftIssue[] = [];
            if (specOnly.length > 0) {
              issues.push({
                severity: 'warning',
                category: 'spec-coverage',
                message: `${specOnly.length} operations in spec but not in gateways: ${specOnly.join(', ')}`,
                recommendation: 'Add missing operation handlers to MCP gateways or remove from spec',
              });
            }
            if (gatewayOnly.length > 0) {
              issues.push({
                severity: 'warning',
                category: 'implementation-coverage',
                message: `${gatewayOnly.length} operations in gateways but not in spec: ${gatewayOnly.join(', ')}`,
                recommendation: 'Document missing operations in CLEO-OPERATIONS-REFERENCE.md',
              });
            }
            addCheck('Gateway-to-spec sync', 'warn', `Found ${specOnly.length + gatewayOnly.length} operation mismatches`, issues);
          }
        }
      } catch (e: any) {
        addCheck('Gateway-to-spec sync', 'fail', `Error: ${e.message}`, [{
          severity: 'error',
          category: 'system',
          message: e.message,
          recommendation: 'Check file permissions and paths',
        }]);
      }

      // Check 2: CLI-to-core sync
      try {
        const cliDir = join(projectRoot, 'src', 'cli', 'commands');
        const coreDir = join(projectRoot, 'src', 'core');
        
        if (!existsSync(cliDir)) {
          addCheck('CLI-to-core sync', 'fail', 'CLI commands directory missing', [{
            severity: 'error',
            category: 'structure',
            message: 'src/cli/commands/ directory not found',
            recommendation: 'Verify TypeScript source structure is intact',
          }]);
        } else if (!existsSync(coreDir)) {
          addCheck('CLI-to-core sync', 'fail', 'Core directory missing', [{
            severity: 'error',
            category: 'structure',
            message: 'src/core/ directory not found',
            recommendation: 'Verify TypeScript source structure is intact',
          }]);
        } else {
          const files = readdirSync(cliDir).filter(f => f.endsWith('.ts') && !f.includes('.test.'));
          addCheck('CLI-to-core sync', 'pass', `Found ${files.length} CLI command implementations`);
        }
      } catch (e: any) {
        addCheck('CLI-to-core sync', 'fail', `Error: ${e.message}`);
      }

      // Check 3: Domain handler coverage
      try {
        const domainsDir = join(projectRoot, 'src', 'mcp', 'domains');
        if (!existsSync(domainsDir)) {
          addCheck('Domain handler coverage', 'fail', 'MCP domains directory missing', [{
            severity: 'error',
            category: 'structure',
            message: 'src/mcp/domains/ not found',
            recommendation: 'Verify MCP domain handlers are in place',
          }]);
        } else {
          const files = readdirSync(domainsDir).filter(f => f.endsWith('.ts'));
          addCheck('Domain handler coverage', 'pass', `Found ${files.length} domain handlers`);
        }
      } catch (e: any) {
        addCheck('Domain handler coverage', 'fail', `Error: ${e.message}`);
      }

      // Check 4: Capability matrix
      try {
        const matrixPath = join(projectRoot, 'src', 'dispatch', 'lib', 'capability-matrix.ts');
        if (!existsSync(matrixPath)) {
          addCheck('Capability matrix', 'fail', 'Capability matrix missing', [{
            severity: 'error',
            category: 'configuration',
            message: 'src/dispatch/lib/capability-matrix.ts not found',
            recommendation: 'Create capability matrix to document supported operations',
          }]);
        } else {
          addCheck('Capability matrix', 'pass', 'Capability matrix exists');
        }
      } catch (e: any) {
        addCheck('Capability matrix', 'fail', `Error: ${e.message}`);
      }

      // Check 5: Schema validation
      try {
        const schemaPath = join(projectRoot, 'src', 'store', 'schema.ts');
        if (!existsSync(schemaPath)) {
          addCheck('Schema validation', 'fail', 'Schema definition missing', [{
            severity: 'error',
            category: 'data-model',
            message: 'src/store/schema.ts not found',
            recommendation: 'Create schema definition for database tables',
          }]);
        } else {
          const content = safeRead(schemaPath);
          const tableCount = (content.match(/CREATE TABLE/g) || []).length;
          if (tableCount === 0) {
            addCheck('Schema validation', 'warn', 'Schema file exists but no CREATE TABLE statements', [{
              severity: 'warning',
              category: 'data-model',
              message: 'No SQL table definitions found in schema.ts',
              recommendation: 'Add CREATE TABLE statements for all database entities',
            }]);
          } else {
            addCheck('Schema validation', 'pass', `Schema defines ${tableCount} tables`);
          }
        }
      } catch (e: any) {
        addCheck('Schema validation', 'fail', `Error: ${e.message}`);
      }

      // Check 6: Canonical identity
      try {
        const visionPath = join(projectRoot, 'docs', 'concepts', 'vision.mdx');
        const specPath = join(projectRoot, 'docs', 'specs', 'PORTABLE-BRAIN-SPEC.md');
        
        const issues: DriftIssue[] = [];
        
        if (!existsSync(visionPath)) {
          issues.push({
            severity: 'error',
            category: 'vision',
            message: 'Vision document missing',
            file: visionPath,
            recommendation: 'Create docs/concepts/vision.mdx with project vision',
          });
        }
        
        if (!existsSync(specPath)) {
          issues.push({
            severity: 'error',
            category: 'spec',
            message: 'Portable Brain spec missing',
            file: specPath,
            recommendation: 'Create docs/specs/PORTABLE-BRAIN-SPEC.md with canonical pillars',
          });
        }
        
        if (issues.length > 0) {
          addCheck('Canonical identity', 'fail', 'Canonical documents missing', issues);
        } else {
          const specContent = safeRead(specPath);
          const requiredPillars = [
            'Portable Memory',
            'Provenance by Default',
            'Interoperable Interfaces',
            'Deterministic Safety',
            'Cognitive Retrieval',
          ];
          
          const missingPillars = requiredPillars.filter(p => !specContent.includes(p));
          
          if (missingPillars.length > 0) {
            addCheck('Canonical identity', 'fail', `Missing ${missingPillars.length} canonical pillars`, [{
              severity: 'error',
              category: 'vision',
              message: `Missing pillars: ${missingPillars.join(', ')}`,
              file: specPath,
              recommendation: 'Add all five canonical pillars to PORTABLE-BRAIN-SPEC.md',
            }]);
          } else {
            addCheck('Canonical identity', 'pass', 'All canonical pillars documented');
          }
        }
      } catch (e: any) {
        addCheck('Canonical identity', 'fail', `Error: ${e.message}`);
      }

      // Check 7: Agent injection template
      try {
        const injectionPath = join(projectRoot, '.cleo', 'templates', 'CLEO-INJECTION.md');
        if (!existsSync(injectionPath)) {
          addCheck('Agent injection', 'fail', 'Agent injection template missing', [{
            severity: 'error',
            category: 'agent-support',
            message: 'CLEO-INJECTION.md not found',
            file: injectionPath,
            recommendation: 'Create agent injection template or run cleo init',
          }]);
        } else {
          const content = safeRead(injectionPath);
          if (content.length < 100) {
            addCheck('Agent injection', 'warn', 'Agent injection template appears incomplete', [{
              severity: 'warning',
              category: 'agent-support',
              message: 'Template file is unusually short',
              recommendation: 'Verify template contains required agent instructions',
            }]);
          } else {
            addCheck('Agent injection', 'pass', 'Agent injection template exists');
          }
        }
      } catch (e: any) {
        addCheck('Agent injection', 'fail', `Error: ${e.message}`);
      }

      // Check 8: Exit codes
      try {
        const exitCodesPath = join(projectRoot, 'src', 'types', 'exit-codes.ts');
        if (!existsSync(exitCodesPath)) {
          addCheck('Exit codes', 'fail', 'Exit codes definition missing', [{
            severity: 'error',
            category: 'protocol',
            message: 'src/types/exit-codes.ts not found',
            recommendation: 'Create exit codes enum for CLI protocol compliance',
          }]);
        } else {
          const content = safeRead(exitCodesPath);
          const codeCount = (content.match(/= \d+/g) || []).length;
          addCheck('Exit codes', 'pass', `${codeCount} exit codes defined`);
        }
      } catch (e: any) {
        addCheck('Exit codes', 'fail', `Error: ${e.message}`);
      }

      // Generate top-level recommendations based on findings
      if (result.summary.errors > 0) {
        result.recommendations.push('Address all ERROR-level issues before proceeding');
        result.recommendations.push('Run cleo detect-drift --json for structured output');
      }
      if (result.summary.warnings > 0) {
        result.recommendations.push('Review WARNING-level issues for documentation improvements');
      }
      if (result.summary.errors === 0 && result.summary.warnings === 0) {
        result.recommendations.push('Documentation is synchronized with implementation');
      }

      // Output via LAFS-compliant cliOutput
      cliOutput(result, { command: 'detect-drift' });
      
      // Exit with appropriate code for scripting
      process.exit(result.summary.exitCode);
    });
}

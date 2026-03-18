/**
 * Codebase Map — structured codebase analysis for autonomous agent understanding.
 * Runs all analyzers and returns a unified CodebaseMapResult.
 * @epic cognitive-cleo
 */

import type { ProjectContext } from '../store/project-detect.js';
import { detectProjectType } from '../store/project-detect.js';

export interface StackAnalysis {
  languages: string[];
  frameworks: string[];
  dependencies: { name: string; version: string; dev: boolean }[];
  packageManager?: string;
  runtime?: string;
}

export interface ArchAnalysis {
  layers: { name: string; path: string; purpose: string }[];
  entryPoints: { path: string; type: string }[];
  patterns: string[];
}

export interface StructureAnalysis {
  directories: { path: string; purpose: string; fileCount: number }[];
  totalFiles: number;
  totalLines?: number;
}

export interface ConventionAnalysis {
  fileNaming: string;
  importStyle: string;
  linter?: string;
  formatter?: string;
  typeSystem?: string;
  errorHandling?: string;
}

export interface TestingAnalysis {
  framework: string;
  patterns: string[];
  directories: string[];
  hasFixtures: boolean;
  hasMocks: boolean;
  coverageConfigured: boolean;
}

export interface IntegrationAnalysis {
  apis: string[];
  databases: string[];
  auth: string[];
  cicd: string[];
  containerized: boolean;
}

export interface ConcernAnalysis {
  todos: { file: string; line: number; text: string }[];
  largeFiles: { path: string; lines: number }[];
  complexity: { high: number; medium: number; low: number };
}

export interface CodebaseMapResult {
  projectContext: ProjectContext;
  stack: StackAnalysis;
  architecture: ArchAnalysis;
  structure: StructureAnalysis;
  conventions: ConventionAnalysis;
  testing: TestingAnalysis;
  integrations: IntegrationAnalysis;
  concerns: ConcernAnalysis;
  analyzedAt: string;
}

export interface MapCodebaseOptions {
  focus?:
    | 'stack'
    | 'architecture'
    | 'structure'
    | 'conventions'
    | 'testing'
    | 'integrations'
    | 'concerns';
  storeToBrain?: boolean;
}

export async function mapCodebase(
  projectRoot: string,
  options?: MapCodebaseOptions,
): Promise<CodebaseMapResult> {
  const projectContext = detectProjectType(projectRoot);

  const [
    { analyzeStack },
    { analyzeArchitecture },
    { analyzeStructure },
    { analyzeConventions },
    { analyzeTesting },
    { analyzeIntegrations },
    { analyzeConcerns },
  ] = await Promise.all([
    import('./analyzers/stack.js'),
    import('./analyzers/architecture.js'),
    import('./analyzers/structure.js'),
    import('./analyzers/conventions.js'),
    import('./analyzers/testing.js'),
    import('./analyzers/integrations.js'),
    import('./analyzers/concerns.js'),
  ]);

  const focus = options?.focus;

  const result: CodebaseMapResult = {
    projectContext,
    stack:
      !focus || focus === 'stack'
        ? analyzeStack(projectRoot, projectContext)
        : { languages: [], frameworks: [], dependencies: [] },
    architecture:
      !focus || focus === 'architecture'
        ? analyzeArchitecture(projectRoot, projectContext)
        : { layers: [], entryPoints: [], patterns: [] },
    structure:
      !focus || focus === 'structure'
        ? analyzeStructure(projectRoot)
        : { directories: [], totalFiles: 0 },
    conventions:
      !focus || focus === 'conventions'
        ? analyzeConventions(projectRoot, projectContext)
        : { fileNaming: 'unknown', importStyle: 'unknown' },
    testing:
      !focus || focus === 'testing'
        ? analyzeTesting(projectRoot, projectContext)
        : {
            framework: 'unknown',
            patterns: [],
            directories: [],
            hasFixtures: false,
            hasMocks: false,
            coverageConfigured: false,
          },
    integrations:
      !focus || focus === 'integrations'
        ? analyzeIntegrations(projectRoot, projectContext)
        : { apis: [], databases: [], auth: [], cicd: [], containerized: false },
    concerns:
      !focus || focus === 'concerns'
        ? analyzeConcerns(projectRoot)
        : { todos: [], largeFiles: [], complexity: { high: 0, medium: 0, low: 0 } },
    analyzedAt: new Date().toISOString(),
  };

  if (options?.storeToBrain) {
    const { storeMapToBrain } = await import('./store.js');
    await storeMapToBrain(projectRoot, result);
  }

  return result;
}

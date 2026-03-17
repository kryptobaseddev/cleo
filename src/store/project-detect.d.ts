/**
 * Project type detection and configuration.
 * Produces schema-compliant ProjectContext for project-context.json.
 *
 * @epic T4454
 * @task T4530
 */
/** Detected project type. */
export type ProjectType = 'node' | 'python' | 'rust' | 'go' | 'ruby' | 'java' | 'dotnet' | 'bash' | 'elixir' | 'php' | 'deno' | 'bun' | 'unknown';
/** Test framework. */
export type TestFramework = 'jest' | 'vitest' | 'mocha' | 'pytest' | 'bats' | 'cargo' | 'go' | 'rspec' | 'junit' | 'playwright' | 'cypress' | 'ava' | 'uvu' | 'tap' | 'node:test' | 'deno' | 'bun' | 'custom' | 'unknown';
export type FileNamingConvention = 'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase';
export type ImportStyle = 'esm' | 'commonjs' | 'mixed';
/** Schema-compliant project context for LLM agent consumption. */
export interface ProjectContext {
    schemaVersion: string;
    detectedAt: string;
    projectTypes: ProjectType[];
    primaryType?: ProjectType;
    monorepo: boolean;
    testing?: {
        framework?: TestFramework;
        command?: string;
        testFilePatterns?: string[];
        directories?: {
            unit?: string;
            integration?: string;
        };
    };
    build?: {
        command?: string;
        outputDir?: string;
    };
    directories?: {
        source?: string;
        tests?: string;
        docs?: string;
    };
    conventions?: {
        fileNaming?: FileNamingConvention;
        importStyle?: ImportStyle;
        typeSystem?: string;
    };
    llmHints?: {
        preferredTestStyle?: string;
        typeSystem?: string;
        commonPatterns?: string[];
        avoidPatterns?: string[];
    };
}
/** @deprecated Use ProjectContext instead. */
export type ProjectInfo = ProjectContext;
/**
 * Detect project type from directory contents.
 * Returns a schema-compliant ProjectContext object.
 */
export declare function detectProjectType(projectDir: string): ProjectContext;
//# sourceMappingURL=project-detect.d.ts.map
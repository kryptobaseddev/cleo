#!/usr/bin/env node
/**
 * Auto-generate TypeScript declarations for JSON schema files
 * 
 * This script generates .d.ts files from JSON schemas in packages/lafs/schemas/v1/
 * Run via: node scripts/generate-json-types.mjs
 * 
 * @task T-GENERATE-JSON-TYPES
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, '../packages/lafs/schemas/v1');
const OUTPUT_DIR = SCHEMAS_DIR;

// Schema definitions with their TypeScript interfaces
const SCHEMAS = [
  {
    file: 'conformance-profiles.json',
    interfaceName: 'ConformanceProfilesSchema',
    content: `export interface ConformanceProfilesSchema {
  $schema: string;
  version: string;
  tiers: {
    core: string[];
    standard: string[];
    complete: string[];
  };
}

declare const schema: ConformanceProfilesSchema;
export default schema;`
  },
  {
    file: 'error-registry.json',
    interfaceName: 'ErrorRegistrySchema',
    content: `export interface ErrorEntry {
  code: string;
  category: 'CONTRACT' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'SERVER' | 'TRANSPORT' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'PAYMENT' | 'AGENT' | 'PROTOCOL' | 'HOOK';
  description: string;
  retryable: boolean;
  httpStatus: number;
  grpcStatus: string;
  cliExit: number;
  agentAction: 'stop' | 'retry' | 'retry_modified' | 'refresh_context' | 'continue' | 'escalate';
  typeUri: string;
  docUrl: string;
}

export interface ErrorRegistrySchema {
  $schema: string;
  version: string;
  codes: ErrorEntry[];
}

declare const schema: ErrorRegistrySchema;
export default schema;`
  },
  {
    file: 'envelope.schema.json',
    interfaceName: 'EnvelopeSchema',
    content: `export interface EnvelopeSchema {
  $schema: string;
  $id: string;
  title: string;
  type: 'object';
  required: string[];
  properties: Record<string, unknown>;
}

declare const schema: EnvelopeSchema;
export default schema;`
  }
];

function generateTypes() {
  console.log('🔧 Generating TypeScript declarations for JSON schemas...\n');
  
  for (const schema of SCHEMAS) {
    const outputFile = join(OUTPUT_DIR, schema.file.replace('.json', '.d.ts'));
    const declaration = `// Auto-generated from ${schema.file}
// Do not edit manually - run: node scripts/generate-json-types.mjs

${schema.content}
`;
    
    writeFileSync(outputFile, declaration, 'utf-8');
    console.log(`✅ Generated: packages/lafs/schemas/v1/${schema.file.replace('.json', '.d.ts')}`);
  }
  
  console.log('\n✨ Done! TypeScript declarations generated.');
  console.log('💡 Next step: Update packages/lafs/tsconfig.json to include "schemas/**/*.d.ts"');
}

generateTypes();

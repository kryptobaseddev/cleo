#!/usr/bin/env node
/**
 * CLEO API Specification Generator
 *
 * Dynamically generates API specifications from the OperationRegistry.
 * Supports multiple output formats: OpenAPI 3.1, TypeScript client, Markdown docs.
 *
 * Usage:
 *   npm run generate:api -- --format openapi --domain nexus --output docs/specs/cleo-nexus-openapi.json
 *   npm run generate:api -- --format typescript --domain nexus --output src/clients/nexus-client.ts
 *   npm run generate:api -- --format markdown --domain nexus --output docs/specs/CLEO-NEXUS-API-GENERATED.md
 *
 * @task API-GEN-001
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OperationDef } from '../dispatch/registry.js';

// Import the OperationRegistry
const registryModule = await import('../dispatch/registry.js');
const OperationRegistry: OperationDef[] = registryModule.OPERATIONS || [];

interface CliOptions {
  format: string;
  domain: string | null;
  output: string | null;
  version: string;
  help: boolean;
}

// CLI argument parsing
function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    format: 'openapi',
    domain: null,
    output: null,
    version: '1.0.0',
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--format':
      case '-f':
        options.format = args[++i] || 'openapi';
        break;
      case '--domain':
      case '-d':
        options.domain = args[++i] || null;
        break;
      case '--output':
      case '-o':
        options.output = args[++i] || null;
        break;
      case '--version':
      case '-v':
        options.version = args[++i] || '1.0.0';
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
CLEO API Specification Generator

Dynamically generates API specifications from the OperationRegistry.

Usage:
  npm run generate:api -- [options]

Options:
  --format, -f      Output format: openapi|typescript|markdown (default: openapi)
  --domain, -d      Filter to specific domain (e.g., 'nexus', 'tasks')
  --output, -o      Output file path (default: stdout)
  --version, -v     API version (default: 1.0.0)
  --help, -h        Show this help message

Examples:
  # Generate OpenAPI spec for NEXUS domain
  npm run generate:api -- --format openapi --domain nexus --output docs/specs/cleo-nexus-openapi.json

  # Generate TypeScript client for all domains
  npm run generate:api -- --format typescript --output src/clients/cleo-client.ts

  # Generate Markdown documentation
  npm run generate:api -- --format markdown --domain nexus --output docs/specs/nexus-api.md

  # Output to stdout (useful for piping)
  npm run generate:api -- --format openapi --domain nexus | jq .
`);
}

// OpenAPI 3.1 Generator
function generateOpenApi(operations: OperationDef[], version: string): object {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, object> = {};

  // Group operations by path
  for (const op of operations) {
    const pathKey = `/api/${op.gateway}`;
    if (!paths[pathKey]) {
      paths[pathKey] = {};
    }

    const method = 'post';
    const operationId = `${op.domain}.${op.operation}`;

    paths[pathKey][method] = {
      operationId,
      summary: op.description,
      tags: [op.domain],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: generateRequestSchema(op),
          },
        },
      },
      responses: {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: generateResponseSchema(op),
            },
            'application/vnd.lafs+json': {
              schema: generateLafsResponseSchema(op),
            },
          },
        },
        '400': {
          description: 'Bad Request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '404': {
          description: 'Not Found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    };
  }

  // Add common schemas
  schemas['Meta'] = {
    type: 'object',
    required: ['specVersion', 'schemaVersion', 'timestamp', 'operation', 'requestId'],
    properties: {
      specVersion: { type: 'string', example: '1.0.0' },
      schemaVersion: { type: 'string', example: '1.0.0' },
      timestamp: { type: 'string', format: 'date-time' },
      operation: { type: 'string' },
      requestId: { type: 'string' },
      sessionId: { type: 'string' },
      transport: { type: 'string', enum: ['http', 'mcp', 'cli'] },
      strict: { type: 'boolean' },
      mvi: { type: 'string', enum: ['minimal', 'standard', 'full', 'custom'] },
      contextVersion: { type: 'integer' },
      gateway: { type: 'string' },
      domain: { type: 'string' },
      durationMs: { type: 'integer' },
      exitCode: { type: 'integer' },
    },
  };

  schemas['Error'] = {
    type: 'object',
    required: ['code', 'message'],
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      details: { type: 'object' },
      fix: { type: 'string' },
      alternatives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            params: { type: 'object' },
          },
        },
      },
    },
  };

  schemas['LafsEnvelope'] = {
    type: 'object',
    required: ['$schema', '_meta', 'success'],
    properties: {
      $schema: { type: 'string' },
      _meta: { $ref: '#/components/schemas/Meta' },
      success: { type: 'boolean' },
      result: { type: 'object' },
      error: { $ref: '#/components/schemas/Error' },
      page: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['cursor', 'offset', 'none'] },
          nextCursor: { type: 'string' },
          offset: { type: 'integer' },
          hasMore: { type: 'boolean' },
        },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'CLEO NEXUS API',
      version,
      description: 'Cross-project coordination API for the CLEO ecosystem',
      contact: {
        name: 'CLEO Development Team',
        url: 'https://cleo.dev',
      },
    },
    servers: [
      {
        url: 'http://localhost:34567',
        description: 'Local development server',
      },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token for remote access (not required for localhost)',
        },
      },
    },
  };
}

function generateRequestSchema(operation: OperationDef): object {
  const params: Record<string, object> = {};
  const required: string[] = [];

  if (operation.requiredParams) {
    for (const paramName of operation.requiredParams) {
      params[paramName] = { type: 'string' };
      required.push(paramName);
    }
  }

  return {
    type: 'object',
    required: ['domain', 'operation', ...required],
    properties: {
      domain: { type: 'string', enum: [operation.domain] },
      operation: { type: 'string', enum: [operation.operation] },
      params: {
        type: 'object',
        properties: params,
        required,
      },
      _mvi: { type: 'string', enum: ['minimal', 'standard', 'full', 'custom'] },
      _fields: { type: 'array', items: { type: 'string' } },
    },
  };
}

function generateResponseSchema(_operation: OperationDef): object {
  return {
    oneOf: [{ type: 'object' }, { $ref: '#/components/schemas/Error' }],
  };
}

function generateLafsResponseSchema(_operation: OperationDef): object {
  return {
    $ref: '#/components/schemas/LafsEnvelope',
  };
}

// TypeScript Client Generator
function generateTypeScript(operations: OperationDef[], version: string): string {
  const domains = groupByDomain(operations);

  let code = `/**
 * CLEO API Client - Auto-generated
 * 
 * Version: ${version}
 * Generated: ${new Date().toISOString()}
 * 
 * DO NOT EDIT THIS FILE DIRECTLY.
 * Run 'npm run generate:api' to regenerate.
 */

export interface LafsMeta {
  specVersion: string;
  schemaVersion: string;
  timestamp: string;
  operation: string;
  requestId: string;
  sessionId?: string;
  transport: 'http' | 'mcp' | 'cli';
  strict: boolean;
  mvi?: 'minimal' | 'standard' | 'full' | 'custom';
  contextVersion: number;
  gateway: string;
  domain: string;
  durationMs: number;
  exitCode: number;
}

export interface LafsError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fix?: string;
  alternatives?: Array<{ operation: string; params?: Record<string, unknown> }>;
}

export interface LafsEnvelope<T = unknown> {
  $schema: string;
  _meta: LafsMeta;
  success: boolean;
  result?: T;
  error?: LafsError;
  page?: {
    mode: 'cursor' | 'offset' | 'none';
    nextCursor?: string;
    offset?: number;
    hasMore: boolean;
  };
}

export interface ApiClientConfig {
  baseUrl: string;
  defaultMvi?: 'minimal' | 'standard' | 'full' | 'custom';
  headers?: Record<string, string>;
}

export class CleoApiError extends Error {
  constructor(
    public readonly error: LafsError,
    public readonly statusCode: number,
    public readonly headers: Headers,
  ) {
    super(error.message);
    this.name = 'CleoApiError';
  }
}

export class CleoClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = {
      defaultMvi: 'standard',
      ...config,
    };
  }

  private async request<T>(
    gateway: 'query' | 'mutate',
    domain: string,
    operation: string,
    params?: Record<string, unknown>,
    options?: { mvi?: string; fields?: string[]; lafs?: boolean },
  ): Promise<T> {
    const url = new URL(\`/api/\${gateway}\`, this.config.baseUrl);
    
    const body: Record<string, unknown> = {
      domain,
      operation,
      params,
    };

    if (options?.mvi) body._mvi = options.mvi;
    if (options?.fields) body._fields = options.fields;
    if (options?.lafs) body._lafs = true;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    if (options?.lafs) {
      headers['Accept'] = 'application/vnd.lafs+json';
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new CleoApiError(error as LafsError, response.status, response.headers);
    }

    const data = await response.json();
    return data as T;
  }

  // Domain accessors
`;

  // Generate domain methods
  for (const [domainName, domainOps] of Object.entries(domains)) {
    code += `  ${domainName} = {\n`;

    for (const op of domainOps) {
      const methodName = op.operation.replace(/\./g, '_');
      const gateway = op.gateway;
      const hasRequiredParams = op.requiredParams && op.requiredParams.length > 0;

      code += `    /**
     * ${op.description}
     * Gateway: ${gateway}
     */
    ${methodName}: async (params${hasRequiredParams ? '' : '?'}: {
`;

      if (op.requiredParams) {
        for (const paramName of op.requiredParams) {
          code += `      ${paramName}: string;\n`;
        }
      }

      code += `    }): Promise<unknown> => {\n`;
      code += `      return this.request('${gateway}', '${domainName}', '${op.operation}', params);\n`;
      code += `    },\n\n`;
    }

    code += `  };\n\n`;
  }

  code += `}\n
export function createCleoClient(config: ApiClientConfig): CleoClient {
  return new CleoClient(config);
}

export type { CleoClient as ApiClient };
`;

  return code;
}

function groupByDomain(operations: OperationDef[]): Record<string, OperationDef[]> {
  const grouped: Record<string, OperationDef[]> = {};
  for (const op of operations) {
    if (!grouped[op.domain]) {
      grouped[op.domain] = [];
    }
    grouped[op.domain].push(op);
  }
  return grouped;
}

// Markdown Documentation Generator
function generateMarkdown(operations: OperationDef[], version: string): string {
  let md = `# CLEO API Documentation\n\n`;
  md += `**Version**: ${version}  \n`;
  md += `**Generated**: ${new Date().toISOString()}  \n`;
  md += `**Total Operations**: ${operations.length}  \n\n`;

  const domains = groupByDomain(operations);

  for (const [domainName, domainOps] of Object.entries(domains)) {
    md += `## Domain: ${domainName}\n\n`;

    for (const op of domainOps) {
      md += `### ${domainName}.${op.operation} (${op.gateway})\n\n`;
      md += `${op.description}\n\n`;

      if (op.requiredParams && op.requiredParams.length > 0) {
        md += `**Required Parameters**: ${op.requiredParams.join(', ')}\n\n`;
      }

      md += `| Property | Value |\n`;
      md += `|----------|-------|\n`;
      md += `| Gateway | ${op.gateway} |\n`;
      md += `| Tier | ${op.tier} |\n`;
      md += `| Idempotent | ${op.idempotent ? 'Yes' : 'No'} |\n`;
      md += `| Session Required | ${op.sessionRequired ? 'Yes' : 'No'} |\n\n`;

      md += `---\n\n`;
    }
  }

  return md;
}

// Main
async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!OperationRegistry || OperationRegistry.length === 0) {
    console.error('Error: OperationRegistry is empty or not loaded');
    process.exit(1);
  }

  // Filter operations
  let operations = OperationRegistry;
  if (options.domain) {
    operations = operations.filter((op) => op.domain === options.domain);
  }

  if (operations.length === 0) {
    console.error(
      `Error: No operations found${options.domain ? ` for domain '${options.domain}'` : ''}`,
    );
    process.exit(1);
  }

  // Generate output
  let output: string;
  switch (options.format) {
    case 'openapi':
    case 'oas':
    case 'json':
      output = JSON.stringify(generateOpenApi(operations, options.version), null, 2);
      break;
    case 'typescript':
    case 'ts':
      output = generateTypeScript(operations, options.version);
      break;
    case 'markdown':
    case 'md':
      output = generateMarkdown(operations, options.version);
      break;
    default:
      console.error(
        `Error: Unknown format '${options.format}'. Use: openapi, typescript, or markdown`,
      );
      process.exit(1);
  }

  // Write or print output
  if (options.output) {
    const outputPath = path.resolve(options.output);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, output, 'utf-8');
    console.log(`Generated ${options.format} specification: ${outputPath}`);
    console.log(
      `  Operations: ${operations.length}${options.domain ? ` (${options.domain} domain)` : ''}`,
    );
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

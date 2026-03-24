# LAFS Compliance Audit Report

## Executive Summary

This report analyzes all CAAMP command files for LAFS (Language-Agnostic Format Specification) compliance. LAFS requires JSON-first output with proper envelopes, `--human` flag support, and clean pipable output.

### Reference Implementation
- **providers.ts** - Fully LAFS-compliant (list, detect, show commands)
- **skills/list.ts** - Fully LAFS-compliant
- **skills/find.ts** - Fully LAFS-compliant
- **advanced/*.ts** - Uses `runLafsCommand` wrapper (LAFS-compliant by design)

---

## Commands Needing Updates

### 1. doctor.ts
- **Current Output**: Human-readable with optional JSON via `--json`
- **JSON flag**: Yes (but not LAFS envelope)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output doesn't use LAFS envelope structure
  - Missing `--human` flag
  - Doesn't use `isHuman()` from logger module
  - Error output doesn't use LAFS error envelopes
- **Changes Needed**:
  - Add `--human` option alongside existing `--json`
  - Implement `buildEnvelope()` function
  - Wrap all output in LAFS envelope with `_meta`, `success`, `result`, `error`, `page`
  - Use `resolveOutputFormat()` from `@cleocode/lafs`
  - Add `emitJsonError()` for consistent error handling

### 2. skills/audit.ts
- **Current Output**: Human-readable with `--json` and `--sarif` options
- **JSON flag**: Yes (raw JSON, not LAFS envelope)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw, not wrapped in LAFS envelope
  - Missing `--human` flag
  - SARIF output format doesn't fit LAFS pattern (may need special handling)
  - Errors use `console.error()` with picocolors instead of LAFS envelopes
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` for standard output
  - Consider how SARIF format interacts with LAFS (may need separate flag handling)
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for error cases

### 3. skills/validate.ts
- **Current Output**: Human-readable with optional JSON
- **JSON flag**: Yes (raw JSON)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw validation result, not LAFS envelope
  - Missing `--human` flag
  - Error handling doesn't use LAFS envelopes
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` with validation result in `result` field
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for file not found or parse errors

### 4. skills/install.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - All output is human-readable with picocolors
  - Profile installation output is complex and human-focused
  - Errors use `console.error()` with colors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with installation results
  - Structure result to include: installed skills, failed installs, target providers
  - Use `resolveOutputFormat()` for format determination
  - Convert human output to conditional block based on format
  - Add LAFS error envelope for installation failures

### 5. skills/remove.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Interactive mode lists skills in human format
  - Success/error messages use picocolors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with removal results
  - Structure result to include: removed skills, target providers, errors
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for removal failures

### 6. skills/check.ts
- **Current Output**: Human-readable with optional JSON
- **JSON flag**: Yes (raw JSON array)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw array, not LAFS envelope
  - Missing `--human` flag
  - Status display logic is human-focused
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` with check results
  - Structure result to include: skills checked, update availability, versions
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for lock file read failures

### 7. skills/update.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Interactive confirmation prompts not suitable for piped usage
  - Progress output uses picocolors
  - Summary output is human-focused
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with update results
  - Structure result to include: updated skills, failed updates, skipped skills
  - Use `resolveOutputFormat()` for format determination
  - Ensure `--yes` flag works properly with JSON mode
  - Add LAFS error envelope for update failures

### 8. skills/init.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Success message includes "Next steps" in human format
  - Directory exists error uses picocolors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with init result
  - Structure result to include: created directory, skill name, template used
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for directory exists or write failures

### 9. mcp/install.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Dry-run output is human-readable
  - Installation results displayed with icons and colors
  - Summary uses picocolors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with install results
  - Structure result to include: installed servers, target providers, configs written
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for install failures

### 10. mcp/list.ts
- **Current Output**: Human-readable with optional JSON
- **JSON flag**: Yes (raw JSON array)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw array, not LAFS envelope
  - Missing `--human` flag
  - Empty state message is human-focused
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` with server list
  - Structure result to include: servers, count, scope
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for provider not found

### 11. mcp/remove.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Removal results use icons and colors
  - Not-found message uses picocolors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with removal results
  - Structure result to include: removed servers, providers affected, errors
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for removal failures

### 12. mcp/detect.ts
- **Current Output**: Human-readable with optional JSON
- **JSON flag**: Yes (raw JSON array)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw array, not LAFS envelope
  - Missing `--human` flag
  - Legend output at bottom is human-focused
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` with detection results
  - Structure result to include: providers, configs found, servers
  - Use `resolveOutputFormat()` for format determination

### 13. config.ts
- **Current Output**: Human-readable with optional JSON (show command only)
- **JSON flag**: Yes (raw JSON for show command)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw config data, not LAFS envelope
  - Missing `--human` flag
  - `path` subcommand outputs raw path (may be intentional for piping)
  - Error handling doesn't use LAFS envelopes
- **Changes Needed**:
  - Add `--human` option to both subcommands
  - Implement `buildEnvelope()` for `show` command
  - Keep `path` command raw for piping (document as exception)
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for provider not found or read errors

### 14. instructions/update.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Update list is human-formatted
  - Results use icons and colors
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with update results
  - Structure result to include: updated files, file status, providers affected
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for update failures

### 15. instructions/inject.ts
- **Current Output**: Human-readable only
- **JSON flag**: No
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - No JSON output option
  - Dry-run output is human-readable
  - Results use icons and colors with action labels
- **Changes Needed**:
  - Add `--json` and `--human` options
  - Implement `buildEnvelope()` with injection results
  - Structure result to include: processed files, actions taken, providers
  - Use `resolveOutputFormat()` for format determination
  - Add LAFS error envelope for injection failures

### 16. instructions/check.ts
- **Current Output**: Human-readable with optional JSON
- **JSON flag**: Yes (raw JSON array)
- **Human flag**: No
- **LAFS envelopes**: No
- **isHuman()**: No
- **Issues**:
  - JSON output is raw array, not LAFS envelope
  - Missing `--human` flag
  - Status display uses switch statement with colored icons
- **Changes Needed**:
  - Add `--human` option
  - Implement `buildEnvelope()` with check results
  - Structure result to include: files checked, statuses, provider associations
  - Use `resolveOutputFormat()` for format determination

---

## Already Compliant

### 17. providers.ts
- **Status**: FULLY COMPLIANT
- **Features**:
  - Uses `resolveOutputFormat()` from `@cleocode/lafs`
  - Supports `--json` and `--human` flags
  - Uses `isHuman()` from logger module
  - Implements `buildEnvelope()` with proper LAFS structure
  - Implements `emitJsonError()` for error handling
  - All subcommands (list, detect, show) follow pattern

### 18. skills/list.ts
- **Status**: FULLY COMPLIANT
- **Features**:
  - Uses `resolveOutputFormat()` from `@cleocode/lafs`
  - Supports `--json` and `--human` flags
  - Uses `isHuman()` from logger module
  - Implements `buildEnvelope()` with proper LAFS structure
  - Implements `emitJsonError()` for error handling

### 19. skills/find.ts
- **Status**: FULLY COMPLIANT
- **Features**:
  - Uses `resolveOutputFormat()` from `@cleocode/lafs`
  - Supports `--json` and `--human` flags (with `--details` for expanded output)
  - Uses `isHuman()` from logger module
  - Implements `buildEnvelope()` with proper LAFS structure
  - Implements `emitJsonError()` for error handling
  - Complex command with both search and recommend modes properly handled

### 20-25. advanced/*.ts (providers, batch, conflicts, apply, instructions, configure)
- **Status**: LAFS-COMPLIANT (via wrapper)
- **Features**:
  - All use `runLafsCommand()` wrapper from `./lafs.js`
  - Wrapper handles envelope creation automatically
  - Custom `LAFSCommandError` class for structured errors
  - Uses `emitSuccess()` and `emitError()` helpers
  - No `--human` flag needed (these are API-focused commands)

---

## Implementation Pattern

### Standard LAFS Command Template

```typescript
import { randomUUID } from "node:crypto";
import type { LAFSErrorCategory } from "@cleocode/lafs";
import { resolveOutputFormat } from "@cleocode/lafs";
import type { Command } from "commander";
import pc from "picocolors";
import { isHuman } from "../core/logger.js";

interface LAFSErrorShape {
  code: string;
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

export function registerXXXCommand(program: Command): void {
  program
    .command("xxx")
    .description("Command description")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: { json?: boolean; human?: boolean }) => {
      const operation = "command.subcommand";
      const mvi = true;

      let format: "json" | "human";
      try {
        format = resolveOutputFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: "json",
        }).format;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, "E_FORMAT_CONFLICT", message, "VALIDATION");
        process.exit(1);
      }

      try {
        // Command logic here
        const result = { /* ... */ };

        if (format === "json") {
          const envelope = buildEnvelope(operation, mvi, result, null);
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }

        // Human-readable output
        console.log(pc.green("Success message"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (format === "json") {
          emitJsonError(operation, mvi, "E_OPERATION_FAILED", message, "INTERNAL");
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }
    });
}

function buildEnvelope<T>(
  operation: string,
  mvi: boolean,
  result: T | null,
  error: LAFSErrorShape | null,
) {
  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json" as const,
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      operation,
      requestId: randomUUID(),
      transport: "cli" as const,
      strict: true,
      mvi,
      contextVersion: 0,
    },
    success: error === null,
    result,
    error,
    page: null,
  };
}

function emitJsonError(
  operation: string,
  mvi: boolean,
  code: string,
  message: string,
  category: LAFSErrorCategory,
  details: Record<string, unknown> = {},
): void {
  const envelope = buildEnvelope(operation, mvi, null, {
    code,
    message,
    category,
    retryable: false,
    retryAfterMs: null,
    details,
  });
  console.error(JSON.stringify(envelope, null, 2));
}
```

---

## Summary

### Statistics
- **Total Commands**: 25
- **Already Compliant**: 9
  - providers.ts (3 subcommands: list, detect, show)
  - skills/list.ts
  - skills/find.ts
  - advanced/providers.ts
  - advanced/batch.ts
  - advanced/conflicts.ts
  - advanced/apply.ts
  - advanced/instructions.ts
  - advanced/configure.ts
- **Needs Updates**: 16

### Commands by Priority

#### High Priority (Core user-facing commands)
1. `doctor.ts` - System health, frequently used
2. `skills/install.ts` - Primary skill management
3. `skills/remove.ts` - Primary skill management
4. `mcp/install.ts` - Primary MCP management
5. `mcp/remove.ts` - Primary MCP management

#### Medium Priority (Secondary commands)
6. `skills/audit.ts` - Security scanning
7. `skills/validate.ts` - Skill development
8. `skills/check.ts` - Update checking
9. `skills/update.ts` - Batch updates
10. `mcp/list.ts` - Configuration viewing
11. `mcp/detect.ts` - Auto-detection
12. `config.ts` - Configuration management

#### Low Priority (Utility commands)
13. `skills/init.ts` - Skill scaffolding
14. `instructions/update.ts` - Instruction management
15. `instructions/inject.ts` - Instruction management
16. `instructions/check.ts` - Instruction management

### Estimated Effort

| Priority | Commands | Hours per Command | Total Hours |
|----------|----------|-------------------|-------------|
| High | 5 | 2-3 | 10-15 |
| Medium | 7 | 1-2 | 7-14 |
| Low | 4 | 1 | 4 |
| **Total** | **16** | - | **21-33 hours** |

### Key Implementation Notes

1. **SARIF Output**: The `skills/audit.ts` command has a `--sarif` flag for security scanning output. This is a special case that may need to bypass LAFS envelopes when explicitly requested, or SARIF could be wrapped as a string in the result field.

2. **Path Command**: The `config path` subcommand intentionally outputs raw paths for shell piping. This should be documented as an exception to LAFS compliance.

3. **Interactive Commands**: Commands like `skills/update.ts` with confirmation prompts should default to `--yes` behavior when in JSON mode to avoid blocking.

4. **Dry Run Mode**: Commands with `--dry-run` should output structured data in JSON mode showing what would happen.

5. **Error Codes**: Use consistent error codes:
   - `E_FORMAT_CONFLICT` - JSON/human flag conflict
   - `E_PROVIDER_NOT_FOUND` - Invalid provider ID
   - `E_FILE_NOT_FOUND` - Missing input file
   - `E_VALIDATION_FAILED` - Input validation error
   - `E_OPERATION_FAILED` - General operation failure

### Testing Checklist

For each command updated:
- [ ] JSON output validates against LAFS schema
- [ ] Human output displays correctly with colors
- [ ] `--json` flag forces JSON output
- [ ] `--human` flag forces human output
- [ ] Error output uses LAFS envelope in JSON mode
- [ ] No extra newlines in piped JSON output
- [ ] Exit codes are correct (0 for success, 1 for error)
- [ ] `isHuman()` global flag is respected

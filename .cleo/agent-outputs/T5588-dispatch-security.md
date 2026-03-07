# T5588 Dispatch Security Normalization

## Changes to `src/dispatch/lib/security.ts`

1. **Added import**: `import { normalizeTaskId } from '../../core/tasks/id-generator.js';`

2. **Removed unused constant**: `TASK_ID_PATTERN` regex (no longer needed since `normalizeTaskId` handles pattern matching).

3. **Updated `sanitizeTaskId()`**: Changed from manual trim-then-regex-validate to normalize-then-validate flow:
   - Signature changed from `(id: string)` to `(value: unknown)` to match broader input handling
   - Uses `normalizeTaskId(value)` which accepts bare digits (`"1234"`), lowercase prefix (`"t1234"`), and canonical form (`"T1234"`)
   - Returns `null` check replaces manual regex validation
   - Max value check (999999) preserved on the normalized result

4. **Expanded `sanitizeParams()` field coverage**:
   - **String ID fields**: Added `parentId`, `newParentId`, `relatedId`, `targetId` alongside existing `taskId`, `parent`, `epicId`
   - **Array ID fields**: Added `addDepends`, `removeDepends` alongside existing `depends`
   - **Empty string guard preserved**: `parent === ""` still skips sanitization (means "remove parent")

## Changes to `src/dispatch/lib/__tests__/security.test.ts`

1. **Added import**: `sanitizeTaskId` added to the import statement.

2. **New test suite `sanitizeTaskId normalization`** (7 tests):
   - Bare digits → T-prefixed
   - Lowercase t → uppercase T
   - Canonical T-prefixed passthrough
   - Max value exceeded throws
   - Non-string throws
   - Empty string throws
   - Invalid format throws

3. **New test suite `sanitizeParams ID normalization`** (9 tests):
   - `taskId`, `parentId`, `newParentId`, `relatedId`, `targetId` normalization
   - `depends` array with mixed formats
   - `addDepends` array normalization
   - `removeDepends` array normalization
   - Empty string `parent` preserved

## TypeScript Compile Result

`npx tsc --noEmit` passes for the dispatch security module. One pre-existing error in `src/mcp/lib/security.ts` (unused `TASK_ID_PATTERN`) is outside scope.

## Vitest Result

**31 tests passed, 0 failures** in `src/dispatch/lib/__tests__/security.test.ts` (4ms).

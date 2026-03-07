# T5588 MCP Security Normalization

## Changes to `src/mcp/lib/security.ts`

1. **Added import** for `normalizeTaskId` from `../../core/tasks/id-generator.js`
2. **Rewrote `sanitizeTaskId()`** to use normalize-then-validate flow:
   - Accepts `unknown` instead of `string` (type check still throws SecurityError for non-strings)
   - Calls `normalizeTaskId()` which handles bare digits (`"1234"`), lowercase prefix (`"t1234"`), and canonical (`"T1234"`) formats
   - Returns `null` → throws SecurityError for invalid format
   - Still validates numeric value <= 999999
3. **Removed unused `TASK_ID_PATTERN`** constant (normalization logic now lives in `normalizeTaskId`)
4. **Expanded `sanitizeParams()` field coverage**:
   - String ID fields: added `parentId`, `newParentId`, `relatedId`, `targetId` (alongside existing `taskId`, `parent`, `epicId`)
   - Array ID fields: added `addDepends`, `removeDepends` (alongside existing `depends`)
   - **Preserved** the `parent === ""` empty string guard (skips sanitization for "remove parent" semantics)

## Changes to `src/mcp/lib/__tests__/security.test.ts`

1. **Changed** assertions for `sanitizeTaskId("123")` and `sanitizeTaskId("t123")` from expecting throws to expecting normalized values
2. **Added new tests**:
   - `sanitizeTaskId("1234")` returns `"T1234"`
   - `sanitizeTaskId("t1234")` returns `"T1234"`
   - `sanitizeTaskId("T1234")` returns `"T1234"`
   - `sanitizeTaskId("1000000")` throws (exceeds max via normalization)
   - `sanitizeParams({ taskId: "1234" })` returns `{ taskId: "T1234" }`
   - `sanitizeParams({ parentId: "1234" })` returns `{ parentId: "T1234" }`
   - `sanitizeParams({ depends: ["1", "t2", "T3"] })` returns normalized array
   - `sanitizeParams({ addDepends: ["1"] })` returns `{ addDepends: ["T1"] }`
   - `sanitizeParams({ removeDepends: ["t5", "10"] })` returns normalized array
   - `sanitizeParams({ parent: "" })` preserves empty string

## TypeScript Compile Result

`npx tsc --noEmit` — **clean, no errors**

## Vitest Result

**75 tests passed, 0 failures** (1 test file, 8ms runtime)

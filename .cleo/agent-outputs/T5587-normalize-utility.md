# T5587: normalizeTaskId() Utility

## Summary

- **Function added**: `normalizeTaskId(input: unknown): string | null` exported from `src/core/tasks/id-generator.ts`
- **Test file created**: `src/core/tasks/__tests__/id-generator.test.ts` (new file)

## TypeScript Compile

- **Result**: PASS
- `npx tsc --noEmit` completed with zero errors

## Vitest Result

- **Result**: PASS
- **Tests**: 18 passed, 0 failed
- **Duration**: 156ms

## Test Coverage

All specified cases covered:
- Canonical passthrough (`T1234`)
- Leading zeros preserved (`T001`)
- Lowercase prefix uppercased (`t1234` -> `T1234`)
- Numeric-only prepend (`1234` -> `T1234`)
- Numeric with leading zeros (`001` -> `T001`)
- Underscore suffix stripped (`T1234_description` -> `T1234`)
- Whitespace trimmed (`  T1234  ` -> `T1234`)
- Empty string -> null
- null -> null
- undefined -> null
- Number type (123) -> null
- T with no digits -> null
- Non-digit body (TASKABC) -> null
- Dash separator (T-123) -> null
- Whitespace-only string -> null
- Very long digit strings -> preserved
- Mixed case prefix (tT1234) -> null
- Numeric zero (0) -> T0

## Issues

None encountered.

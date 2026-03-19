# forge-ts Enforcer Rules

## Error Rules

### E001 — Missing TSDoc Summary

Every exported symbol must have a `/** ... */` comment with a summary line.

```typescript
/** Adds two numbers together. */
export function add(a: number, b: number): number { ... }
```

### E002 — Missing @param Tag

Every parameter of an exported function must have `@param name - Description`.

```typescript
/**
 * Adds two numbers.
 * @param a - The first number.
 * @param b - The second number.
 */
```

### E003 — Missing @returns Tag

Non-void exported functions require `@returns Description`.

### E004 — Missing @example Block

Every exported function needs at least one `@example` with a fenced code block:

```typescript
/**
 * @example
 * ```typescript
 * const result = add(1, 2);
 * // => 3
 * ```
 */
```

### E005 — Missing @packageDocumentation

Entry point files (`index.ts`) should have `@packageDocumentation`.
Default severity: warn.

### E006 — Class Member Missing Documentation

Every public/protected member of an exported class needs TSDoc.

### E007 — Interface/Type Member Missing Documentation

Every property of an exported interface or type needs TSDoc.

### E008 — Dead {@link} Reference

All `{@link SymbolName}` tags must reference symbols in the project's symbol graph.
Supports qualified names: `{@link Class.method}`.

## Warning Rules

### W004 — Cross-Package Deprecated Import

Fires when importing a `@deprecated` symbol from a sibling workspace package.

## Per-Rule Configuration

```typescript
// forge-ts.config.ts
enforce: {
  rules: {
    "require-summary": "error",           // E001
    "require-param": "error",             // E002
    "require-returns": "error",           // E003
    "require-example": "error",           // E004
    "require-package-doc": "warn",        // E005
    "require-class-member-doc": "error",  // E006
    "require-interface-member-doc": "error", // E007
  }
}
```

Each rule accepts: `"error"` | `"warn"` | `"off"`.
When `strict: true`, all warnings become errors.

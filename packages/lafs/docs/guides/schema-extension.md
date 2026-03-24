# Extending Validation for Custom Message Types

This guide explains how to add custom operation/message validation while keeping core LAFS envelope guarantees.

## What is built in

- `validateEnvelope` validates against `schemas/v1/envelope.schema.json`.
- The built-in schema validates envelope structure, meta fields, error contract, pagination rules, and strict-mode top-level behavior.
- It does not know your domain-specific `result` payload shapes.

## Extension model

Treat `_meta.operation` as your message type discriminator and apply operation-specific validators after base envelope validation.

```typescript
import Ajv from "ajv";
import {
  validateEnvelope,
  type LAFSEnvelope,
} from "@cleocode/lafs";

const ajv = new Ajv({ allErrors: true, strict: true });

const operationSchemas = {
  "inventory.search": {
    type: "object",
    required: ["items", "count"],
    properties: {
      items: { type: "array" },
      count: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  "billing.quote": {
    type: "object",
    required: ["quoteId", "amount"],
    properties: {
      quoteId: { type: "string" },
      amount: { type: "number" },
    },
    additionalProperties: false,
  },
} as const;

const validators = new Map(
  Object.entries(operationSchemas).map(([op, schema]) => [op, ajv.compile(schema)])
);

export function validateExtendedEnvelope(input: unknown): {
  valid: boolean;
  errors: string[];
} {
  const base = validateEnvelope(input);
  if (!base.valid) return base;

  const envelope = input as LAFSEnvelope;
  if (!envelope.success) return { valid: true, errors: [] };

  const validateResult = validators.get(envelope._meta.operation);
  if (!validateResult) {
    return {
      valid: false,
      errors: [`Unsupported operation: ${envelope._meta.operation}`],
    };
  }

  const ok = validateResult(envelope.result);
  if (ok) return { valid: true, errors: [] };

  const errors = (validateResult.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message || "validation error"}`
  );
  return { valid: false, errors };
}
```

## Custom fields: where they should live

- **Top-level custom fields**: allowed only when `_meta.strict` is `false`.
- **`_meta` custom fields**: not allowed (`_meta.additionalProperties` is `false`).
- **Vendor metadata**: use `_extensions` (`x-` prefix recommended).
- **Domain payload fields**: place inside `result` and validate per operation.

## Recommended pattern for teams

1. Keep base LAFS schema untouched.
2. Add an internal operation registry keyed by `_meta.operation`.
3. Run base validation first, then operation-specific validation.
4. Keep extension data optional and non-critical.

# CLEO Dispatch Adapter Specification

**Status**: APPROVED

---

## 1. Summary

The typed dispatch adapter is the compile-time boundary between the untyped
domain-handler interface (`Record<string, unknown>` params) and typed
per-operation functions. This specification documents the
`TypedDomainHandler<O>` interface, the `typedDispatch<O, K>` helper, the
`defineTypedHandler<O>` builder, the `OpsFromCore<C>` inference helper, the
envelope helpers, and the rules for moving a domain onto them.

The adapter lives in
[`packages/cleo/src/dispatch/adapters/typed.ts`](../../packages/cleo/src/dispatch/adapters/typed.ts).
11 of the 28 canonical domains dispatch through it today (section 5).

**Requirement levels** follow RFC 2119 (MUST, SHOULD, MAY).

---

## 2. Where the adapter sits

A CLI call flows through these layers:

1. **CLI adapter** —
   [`packages/cleo/src/dispatch/adapters/cli.ts`](../../packages/cleo/src/dispatch/adapters/cli.ts):
   `dispatchFromCli` builds the request; `createCliDispatcher` builds the
   `Dispatcher` (from `@cleocode/runtime/gateway`, re-exported by
   `packages/cleo/src/dispatch/dispatcher.ts`) with one lazy handler per domain
   and this middleware order: store write guard, session resolver, write
   actor, claim heartbeat, sanitizer, field filter, MVI record projection,
   minimal mutate envelope, budget enforcement, audit, idempotency, telemetry.
2. **Operation registry** — `OPERATIONS` and `resolve` /
   `validateRequiredParams`, from `@cleocode/runtime/gateway/dispatch`
   (re-exported by
   [`packages/cleo/src/dispatch/registry.ts`](../../packages/cleo/src/dispatch/registry.ts)).
   Operation definitions are in
   [`packages/contracts/src/dispatch/operations-registry.ts`](../../packages/contracts/src/dispatch/operations-registry.ts).
3. **Domain handler** — a class implementing `DomainHandler`
   (`packages/contracts/src/gateway/index.ts`, re-exported by
   [`packages/cleo/src/dispatch/types.ts`](../../packages/cleo/src/dispatch/types.ts)):
   `query(operation, params?)`, `mutate(operation, params?)` and
   `getSupportedOperations()`, with `params?: Record<string, unknown>`.
4. **Typed inner handler** (migrated domains) — the class delegates to a
   `TypedDomainHandler` through `typedDispatch`.

The domain set is `CANONICAL_DOMAINS` in
[`packages/contracts/src/dispatch/identity.ts`](../../packages/contracts/src/dispatch/identity.ts)
(28 domains). Every call returns one LAFS envelope
([ADR-086](../adr/adr-086-cli-output-contract-e9.md);
[LAFS envelope contract](./lafs-envelope-contract.md)).

---

## 3. Design

### 3.1 Core types

| Symbol | Location in `adapters/typed.ts` |
|---|---|
| `OpsFromCore<C>` | line 141 |
| `TypedOpRecord` | line 165 |
| `TypedDomainHandler<O>` | line 187 |
| `typedDispatch<O, K>` | line 238 |
| `defineTypedHandler<O>` | line 293 |
| `lafsSuccess<T>` | line 334 |
| `lafsError` | line 371 |
| `wrapCoreResult<T>` | line 419 |

```typescript
type TypedOpRecord = Record<string, readonly [unknown, unknown]>;

interface TypedDomainHandler<O extends TypedOpRecord> {
  readonly domain: string;
  readonly operations: {
    readonly [K in keyof O]: (params: O[K][0]) => Promise<LafsEnvelope<unknown>>;
  };
}

async function typedDispatch<O extends TypedOpRecord, K extends keyof O & string>(
  handler: TypedDomainHandler<O>,
  op: K,
  rawParams: unknown,
): Promise<LafsEnvelope<O[K][1]>>;

function defineTypedHandler<O extends TypedOpRecord>(
  domain: string,
  operations: TypedDomainHandler<O>['operations'],
): TypedDomainHandler<O>;
```

Per-op functions return `LafsEnvelope<unknown>`; the result type `O[K][1]` is
applied by `typedDispatch`'s return type at the boundary.

`OpsFromCore<C>` derives a `TypedOpRecord` from a record of core functions:
each entry becomes `[Parameters<C[K]>[0], Awaited<ReturnType<C[K]>>]`, with
`Record<string, never>` for a function that takes no params. A hand-written
`TypedOpRecord` satisfies the same contract.

### 3.2 The single-cast trust boundary

`rawParams as O[K][0]` inside `typedDispatch` (`typed.ts:266`) is the only cast
in the adapter, and it MUST remain the only one. The outer `DomainHandler`
checks that the operation is supported before dispatching, and the dispatcher
checks required params first with the registry's `validateRequiredParams`
(`packages/runtime/src/gateway/dispatcher.ts`).

Per-op functions MUST NOT add `as T` casts on their params; `params` is
already narrowed to `O[K][0]`.

### 3.3 Envelope helpers

The adapter exports envelope builders that match the LAFS types in
[`packages/contracts/src/lafs.ts`](../../packages/contracts/src/lafs.ts)
(`LafsEnvelope<T>`, `LafsSuccess<T>`, `LafsError`):

- `lafsSuccess<T>(data, _operation, extra?)` — the success envelope;
  `extra.page` adds a `page` field. `_operation` is accepted for parity with
  `lafsError` and not persisted.
- `lafsError(code, message, _operation, fix?, details?)` — the error
  variant, typed `LafsEnvelope<never>` so it composes with any
  `LafsEnvelope<T>`.
- `wrapCoreResult(result, opName, fallback?)` — converts a core
  `{ success, data?, error? }` result into an envelope, preserving `exitCode`,
  `details`, `fix`, `alternatives` and `problemDetails` on errors and using
  `fallback` when a success carries no data.

On the way back, `envelopeToEngineResult` and `wrapResult`
([`packages/cleo/src/dispatch/domains/_base.ts`](../../packages/cleo/src/dispatch/domains/_base.ts))
convert the envelope into the `DispatchResponse` the dispatcher returns.

Typed per-op functions MUST build envelopes with these helpers, not by hand.

---

## 4. Ops Record Pattern

Each typed domain declares its operations as a `TypedOpRecord`. Keys are the
**bare operation names** the domain handler receives (`status`, `list`,
`handoff.show`), not `<domain>.<op>`. Each value is a `readonly [Params, Result]`
tuple.

Two forms are in use:

- **Inferred from core** (session, tasks, nexus, pipeline, playbook, sentient,
  sticky, llm, admin): a local `coreOps` map of operation functions and
  `type XOps = OpsFromCore<typeof coreOps>`. Example,
  [`domains/session.ts`](../../packages/cleo/src/dispatch/domains/session.ts):

  ```typescript
  const coreOps = {
    status: sessionStatusOp,
    list: sessionListOp,
    // … one entry per op
  } as const;

  type SessionOps = OpsFromCore<typeof coreOps>;

  const _sessionTypedHandler = defineTypedHandler<SessionOps>('session', {
    status: async (_params: SessionOps['status'][0]) =>
      wrapCoreResult(await coreOps.status(), 'status', { /* empty-state fallback */ }),
    list: async (params: SessionOps['list'][0]) =>
      wrapCoreResult(await coreOps.list(params), 'list'),
    // …
  });
  ```

- **Declared from contracts** (check, docs): tuples of `*Params` / `*Result`
  types imported from `@cleocode/contracts` (`CheckOps` in
  [`packages/contracts/src/operations/validate.ts`](../../packages/contracts/src/operations/validate.ts);
  `DocsTypedOps` in `domains/docs.ts`).

### 4.1 Rules

- Keys MUST match the operation names the domain's `getSupportedOperations()`
  returns.
- Tuples MUST be `readonly [Params, Result]`.
- Hand-written Params and Result types MUST come from `@cleocode/contracts`
  (`packages/contracts/src/operations/*.ts`), never inline in the handler.
- Ops with no params use `Record<string, never>`, not `{}` or `undefined`
  (`OpsFromCore` does this automatically).

### 4.2 Wiring the outer handler

The outer class keeps the `DomainHandler` shape and delegates. From
`domains/session.ts`:

```typescript
if (!QUERY_OPS.has(operation)) {
  return unsupportedOp('query', 'session', operation, startTime);
}
const envelope = await typedDispatch(
  _sessionTypedHandler,
  operation as keyof SessionOps & string,
  params ?? {},
);
return wrapResult(envelopeToEngineResult(envelope), 'query', 'session', operation, startTime);
```

---

## 5. Migration Status

### 5.1 Domains on the typed adapter

These domains define a typed inner handler with `defineTypedHandler` and route
through `typedDispatch`: `admin`, `check`, `docs`, `llm`, `nexus`, `pipeline`,
`playbook`, `sentient`, `session`, `sticky`, `tasks`.

### 5.2 Domains still on untyped `DomainHandler` switches

`memory`, `orchestrate`, `tools`, `intelligence`, `diagnostics`, `release`,
`provenance`, `upgrade`, `worktree`, `focus`, `attention`, `selfimprove`,
`service`, and the entity domains `account`, `provider`, `model`, `profile`
(`domains/entities.ts`).

### 5.3 Remaining param casts

`params?.<field> as <Type>` casts remaining under
`packages/cleo/src/dispatch/domains/` (non-test files): `tools.ts` 27,
`orchestrate.ts` 15, `intelligence.ts` 5, `nexus.ts` 1, `sticky.ts` 1,
`_base.ts` 1. Check the current count with:

```bash
grep -rE "params\?\.\w+ as " packages/cleo/src/dispatch/domains --exclude-dir=__tests__
```

No lint or CI gate enforces this count.

### 5.4 Migrating a domain

A domain migration MUST:

1. Build the ops record (section 4), authoring any missing contract in
   `packages/contracts/src/operations/` first when not using `OpsFromCore`.
2. Move per-op logic into a `defineTypedHandler` inner handler.
3. Route the outer `DomainHandler` through `typedDispatch` (section 4.2).
4. Remove every `params?.x as Y` cast in the domain file.
5. Keep the wire shape unchanged, or update the contract and parity tests in
   the same change.
6. Follow the repository code rules in [`AGENTS.md`](../../AGENTS.md): no `any`
   or `unknown` shortcuts, no `as unknown as X` chains, contract types instead
   of inline types, TSDoc on exports.

---

## 6. Runtime Validation

The adapter narrows params at compile time only. `typedDispatch` does not
parse `rawParams` at runtime; a wrongly shaped value reaches the per-op
function. The `// Future` comment in `typedDispatch` (`typed.ts:253-264`)
sketches where per-op zod parsing would go:

```typescript
const schema = OpSchemas[handler.domain][op];
const parsed = schema.safeParse(rawParams);
if (!parsed.success) {
  return lafsError('E_VALIDATION', parsed.error.message, `${handler.domain}.${op}`);
}
return handler.operations[op](parsed.data);
```

The gateway contract does define zod schemas for the request envelope
(`dispatchRequestSchema` in `packages/contracts/src/gateway/index.ts`, where
`params` is `z.record(z.string(), z.unknown())`); it does not validate
per-operation params.

---

## 7. Testing

- **Adapter suite** —
  [`packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts):
  compile-time narrowing (`@ts-expect-error` fixtures), runtime success path,
  `defineTypedHandler` shape, `lafsSuccess`, `lafsError`, the `TypedOpRecord`
  constraint, and `OpsFromCore` inference. The `@ts-expect-error` lines are
  the compile-time gate: if generic inference loosens, the build fails. This
  suite MUST NOT be deleted.
- **Per-domain `OpsFromCore` tests** —
  `packages/cleo/src/dispatch/domains/__tests__/{session,tasks,nexus,pipeline}-opsfromcore.test.ts`.
- **Registry parity** —
  [`packages/cleo/src/dispatch/__tests__/parity.test.ts`](../../packages/cleo/src/dispatch/__tests__/parity.test.ts)
  and `parity.int.test.ts`. A migration MUST NOT reduce parity coverage.

---

## 8. Open Questions

1. **Runtime param validation.** Generate per-op zod schemas from contracts,
   or hand-author them; and whether to apply them in `typedDispatch` only or
   also at other transports.
2. **`DomainHandler` after full migration.** Remove the untyped interface,
   keep it as a shim, or mark it `@deprecated`.
3. **`DispatchRequest.params` generic.** Whether `DispatchRequest` should
   carry a params type parameter once every domain is typed; this affects the
   middleware under
   [`packages/cleo/src/dispatch/middleware/`](../../packages/cleo/src/dispatch/middleware/).
4. **`OpsFromCore` vs contracts.** `OpsFromCore` ties a domain's types to core
   function signatures rather than to `@cleocode/contracts`; whether contract
   types should stay the target.

---

## 9. References

### 9.1 Code

- Adapter: [`packages/cleo/src/dispatch/adapters/typed.ts`](../../packages/cleo/src/dispatch/adapters/typed.ts)
- Adapter tests: [`packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts)
- CLI adapter: [`packages/cleo/src/dispatch/adapters/cli.ts`](../../packages/cleo/src/dispatch/adapters/cli.ts)
- Domain helpers: [`packages/cleo/src/dispatch/domains/_base.ts`](../../packages/cleo/src/dispatch/domains/_base.ts)
- Registry shim: [`packages/cleo/src/dispatch/registry.ts`](../../packages/cleo/src/dispatch/registry.ts)
- Dispatch types shim: [`packages/cleo/src/dispatch/types.ts`](../../packages/cleo/src/dispatch/types.ts)
- Canonical domains: [`packages/contracts/src/dispatch/identity.ts`](../../packages/contracts/src/dispatch/identity.ts)
- Operation contracts: [`packages/contracts/src/operations/`](../../packages/contracts/src/operations/)
- LAFS types: [`packages/contracts/src/lafs.ts`](../../packages/contracts/src/lafs.ts)

### 9.2 Documents

- [CLEO Operation Constitution](./cleo-operation-constitution.md) — operation catalogue
- [LAFS envelope contract](./lafs-envelope-contract.md)
- [ADR-086: CLI output contract](../adr/adr-086-cli-output-contract-e9.md)
- [ADR-057: contracts and core SSoT](../adr/adr-057-contracts-core-ssot.md)
- [CORE SDK reference](../reference/core-sdk.md) — the `@cleocode/core` API the dispatch layer consumes
- Original cast audit: [`.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md`](../../.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md)

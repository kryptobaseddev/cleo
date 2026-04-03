# @cleocode/lafs — API Reference

## Table of Contents

- [Functions](#functions)
- [Types](#types)
- [Classes](#classes)
- [Constants](#constants)

## Functions

### `estimateTokens`

Convenience function to estimate tokens for a value.

```typescript
(value: unknown, options?: TokenEstimatorOptions) => number
```

**Parameters:**

- `value` — Any JavaScript value to estimate
- `options` — Optional estimator configuration overrides

**Returns:** Estimated token count

```typescript
const tokens = estimateTokens({ data: [1, 2, 3] });
```

### `estimateTokensJSON`

Convenience function to estimate tokens from a JSON string.

```typescript
(json: string, options?: TokenEstimatorOptions) => number
```

**Parameters:**

- `json` — Pre-serialized JSON string
- `options` — Optional estimator configuration overrides

**Returns:** Estimated token count

```typescript
const tokens = estimateTokensJSON('{"key": "value"}');
```

### `isMVILevel`

Type guard that checks whether an unknown value is a valid `MVILevel`.

```typescript
(value: unknown) => value is MVILevel
```

**Parameters:**

- `value` — The value to test.

**Returns:** `true` if `value` is one of the recognised MVI level strings.

```ts
const level: unknown = 'minimal';
if (isMVILevel(level)) {
  // level is narrowed to MVILevel
}
```

### `isAgentAction`

Type guard that checks whether an unknown value is a valid `LAFSAgentAction`.

```typescript
(value: unknown) => value is LAFSAgentAction
```

**Parameters:**

- `value` — The value to test.

**Returns:** `true` if `value` is one of the recognised agent action strings.

```ts
const action: unknown = 'retry';
if (isAgentAction(action)) {
  // action is narrowed to LAFSAgentAction
}
```

### `applyBudgetEnforcement`

Apply budget enforcement to an envelope.

```typescript
(envelope: LAFSEnvelope, budget: number, options?: BudgetEnforcementOptions) => BudgetEnforcementResult
```

**Parameters:**

- `envelope` — The LAFS envelope to check
- `budget` — Maximum allowed token count
- `options` — Budget enforcement options (truncation, callbacks)

**Returns:** Enforcement result with the (possibly modified) envelope, budget status, and token estimates

```typescript
const result = applyBudgetEnforcement(envelope, 1000, { truncateOnExceed: true });
if (!result.withinBudget) {
  console.warn("Budget exceeded:", result.estimatedTokens);
}
```

### `withBudget`

Create a budget enforcement middleware function.

```typescript
(budget: number, options?: BudgetEnforcementOptions) => EnvelopeMiddleware
```

**Parameters:**

- `budget` — Maximum allowed token count for the response
- `options` — Budget enforcement options (truncation, callbacks)

**Returns:** Async middleware function that enforces the token budget

```typescript
const middleware = withBudget(1000, { truncateOnExceed: true });
const result = await middleware(envelope, async () => nextEnvelope);
```

### `checkBudget`

Check if an envelope has exceeded its budget without modifying it.

```typescript
(envelope: LAFSEnvelope, budget: number) => { exceeded: boolean; estimated: number; remaining: number; }
```

**Parameters:**

- `envelope` — The LAFS envelope to check
- `budget` — Maximum allowed token count

**Returns:** Object with `exceeded` flag, `estimated` token count, and `remaining` budget

```typescript
const { exceeded, estimated, remaining } = checkBudget(envelope, 500);
if (exceeded) {
  console.warn(`Over budget by ${estimated - 500} tokens`);
}
```

### `withBudgetSync`

Synchronous version of withBudget for non-async contexts.

```typescript
(budget: number, options?: BudgetEnforcementOptions) => (envelope: LAFSEnvelope, next: () => LAFSEnvelope) => LAFSEnvelope
```

**Parameters:**

- `budget` — Maximum allowed token count for the response
- `options` — Budget enforcement options (truncation, callbacks)

**Returns:** Synchronous middleware function that enforces the token budget

```typescript
const middleware = withBudgetSync(500);
const result = middleware(envelope, () => nextEnvelope);
```

### `wrapWithBudget`

Higher-order function that wraps a handler with budget enforcement.

```typescript
<TArgs extends unknown[], TResult extends LAFSEnvelope>(handler: (...args: TArgs) => TResult | Promise<TResult>, budget: number, options?: BudgetEnforcementOptions) => (...args: TArgs) => Promise<LAFSEnvelope>
```

**Parameters:**

- `handler` — The handler function to wrap
- `handler` — The handler function to wrap with budget enforcement
- `budget` — Maximum allowed tokens
- `options` — Budget enforcement options

**Returns:** Wrapped handler with budget enforcement

```typescript
const myHandler = async (request: Request) => ({ success: true, result: { data } });
const budgetedHandler = wrapWithBudget(myHandler, 1000, { truncateOnExceed: true });
const result = await budgetedHandler(request);
```

### `composeMiddleware`

Compose multiple middleware functions into a single middleware.

```typescript
(...middlewares: EnvelopeMiddleware[]) => EnvelopeMiddleware
```

**Parameters:**

- `middlewares` — Middleware functions to compose (executed left to right)

**Returns:** A single middleware function that chains all provided middlewares

```typescript
const pipeline = composeMiddleware(
  withBudget(1000),
  loggingMiddleware,
);
const result = await pipeline(envelope, () => finalEnvelope);
```

### `getConformanceProfiles`

Loads the conformance profiles from the bundled JSON schema.

```typescript
() => ConformanceProfiles
```

**Returns:** The full `ConformanceProfiles` object.

```ts
const profiles = getConformanceProfiles();
console.log(profiles.tiers.core);
```

### `getChecksForTier`

Returns the list of check names that belong to the given conformance tier.

```typescript
(tier: ConformanceTier) => string[]
```

**Parameters:**

- `tier` — The conformance tier to retrieve checks for.

**Returns:** An array of check name strings for the specified tier.

```ts
const coreChecks = getChecksForTier('core');
```

### `validateConformanceProfiles`

Validates that the conformance profiles are internally consistent and reference only known checks.

```typescript
(availableChecks: string[]) => { valid: boolean; errors: string[]; }
```

**Parameters:**

- `availableChecks` — The full list of check names implemented by the conformance runner.

**Returns:** An object with `valid` (true when no errors) and an `errors` array of diagnostic strings.

```ts
const result = validateConformanceProfiles(['envelope_schema_valid', 'envelope_invariants']);
if (!result.valid) {
  console.error(result.errors);
}
```

### `getErrorRegistry`

Loads the full LAFS error registry from the bundled JSON.

```typescript
() => ErrorRegistry
```

**Returns:** The complete error registry with version and all registered codes.

```ts
const registry = getErrorRegistry();
console.log(registry.version, registry.codes.length);
```

### `isRegisteredErrorCode`

Checks whether a given error code exists in the LAFS error registry.

```typescript
(code: string) => boolean
```

**Parameters:**

- `code` — The error code string to look up (e.g., `"E_FORMAT_CONFLICT"`).

**Returns:** `true` if the code is registered, `false` otherwise.

```ts
isRegisteredErrorCode('E_FORMAT_CONFLICT'); // true
isRegisteredErrorCode('E_UNKNOWN');         // false
```

### `getRegistryCode`

Retrieves the full registry entry for a given error code.

```typescript
(code: string) => RegistryCode | undefined
```

**Parameters:**

- `code` — The error code string to look up.

**Returns:** The matching `RegistryCode` or `undefined` if not found.

```ts
const entry = getRegistryCode('E_FORMAT_CONFLICT');
if (entry) {
  console.log(entry.httpStatus); // 409
}
```

### `getAgentAction`

Returns the default agent action for a given error code.

```typescript
(code: string) => LAFSAgentAction | undefined
```

**Parameters:**

- `code` — The error code string to look up.

**Returns:** The `LAFSAgentAction` or `undefined` if unavailable.

```ts
const action = getAgentAction('E_RATE_LIMIT');
console.log(action); // "retry"
```

### `getTypeUri`

Returns the RFC 9457 type URI for a given error code.

```typescript
(code: string) => string | undefined
```

**Parameters:**

- `code` — The error code string to look up.

**Returns:** The type URI string or `undefined` if unavailable.

```ts
const uri = getTypeUri('E_VALIDATION');
// "https://lafs.dev/errors/E_VALIDATION"
```

### `getDocUrl`

Returns the documentation URL for a given error code.

```typescript
(code: string) => string | undefined
```

**Parameters:**

- `code` — The error code string to look up.

**Returns:** The documentation URL string or `undefined` if unavailable.

```ts
const url = getDocUrl('E_VALIDATION');
// "https://lafs.dev/docs/errors/E_VALIDATION"
```

### `getTransportMapping`

Resolves the transport-specific status value for a given error code and transport.

```typescript
(code: string, transport: "http" | "grpc" | "cli") => TransportMapping | null
```

**Parameters:**

- `code` — The error code string to look up.
- `transport` — The transport protocol to resolve a mapping for.

**Returns:** A `TransportMapping` or `null` if the code is unregistered.

```ts
const mapping = getTransportMapping('E_NOT_FOUND', 'http');
console.log(mapping); // { transport: 'http', value: 404 }
```

### `resolveOutputFormat`

Resolve the output format from flag inputs using the LAFS precedence chain.

```typescript
(input: FlagInput) => FlagResolution
```

**Parameters:**

- `input` — The flag inputs including explicit flags, project/user defaults, and TTY state

**Returns:** The resolved format, its source layer, and quiet mode status

```ts
const resolution = resolveOutputFormat({ humanFlag: true });
// => { format: 'human', source: 'flag', quiet: false }
```

### `validateEnvelope`

Validates an unknown input against the LAFS envelope JSON Schema (Draft-07).

```typescript
(input: unknown) => EnvelopeValidationResult
```

**Parameters:**

- `input` — The raw value to validate.

**Returns:** An `EnvelopeValidationResult` with validity status and any errors.

```ts
const result = validateEnvelope(JSON.parse(rawJson));
if (!result.valid) {
  console.error(result.errors);
}
```

### `assertEnvelope`

Validates input and throws on schema failure, returning a typed envelope on success.

```typescript
(input: unknown) => LAFSEnvelope
```

**Parameters:**

- `input` — The raw value to validate as a LAFS envelope.

**Returns:** The input cast to `LAFSEnvelope` when schema validation passes.

```ts
const envelope = assertEnvelope(parsed);
console.log(envelope.success);
```

### `runEnvelopeConformance`

Runs the full suite of LAFS envelope conformance checks.

```typescript
(envelope: unknown, options?: EnvelopeConformanceOptions) => ConformanceReport
```

**Parameters:**

- `envelope` — The raw value to validate as a LAFS envelope.
- `options` — Optional tier filter for the conformance checks.

**Returns:** A `ConformanceReport` with individual check results and an overall pass/fail.

```ts
const report = runEnvelopeConformance(parsedJson, { tier: 'core' });
if (!report.ok) {
  console.error(report.checks.filter(c => !c.pass));
}
```

### `runFlagConformance`

Runs LAFS flag-semantics conformance checks against a set of flag inputs.

```typescript
(flags: FlagInput) => ConformanceReport
```

**Parameters:**

- `flags` — The flag input to validate.

**Returns:** A `ConformanceReport` with individual check results and an overall pass/fail.

```ts
const report = runFlagConformance({ humanFlag: true, jsonFlag: false });
console.log(report.ok); // true
```

### `enforceCompliance`

Runs the full LAFS compliance pipeline against an unknown input value.

```typescript
(input: unknown, options?: EnforceComplianceOptions) => ComplianceResult
```

**Parameters:**

- `input` — The raw value to validate as a LAFS envelope.
- `options` — Controls which optional stages execute.

**Returns:** A `ComplianceResult` with the aggregate pass/fail status and per-stage reports.

```ts
const result = enforceCompliance(rawJson, { checkFlags: true, flags: { jsonFlag: true } });
if (!result.ok) {
  console.error(result.issues);
}
```

### `assertCompliance`

Validates input and throws `ComplianceError` on any failure.

```typescript
(input: unknown, options?: EnforceComplianceOptions) => LAFSEnvelope
```

**Parameters:**

- `input` — The raw value to validate as a LAFS envelope.
- `options` — Controls which optional stages execute.

**Returns:** The validated `LAFSEnvelope` when all stages pass.

```ts
const envelope = assertCompliance(rawJson);
```

### `withCompliance`

Wraps an envelope-producing function with automatic compliance enforcement.

```typescript
<TArgs extends unknown[], TResult extends LAFSEnvelope>(producer: (...args: TArgs) => TResult | Promise<TResult>, options?: EnforceComplianceOptions) => (...args: TArgs) => Promise<LAFSEnvelope>
```

**Parameters:**

- `producer` — A sync or async function that produces a LAFS envelope.
- `options` — Compliance options forwarded to `assertCompliance`.

**Returns:** An async function with the same signature that enforces compliance on every call.

```ts
const safeFetch = withCompliance(fetchEnvelope, { checkConformance: true });
const envelope = await safeFetch('/api/data');
```

### `createComplianceMiddleware`

Creates a `ComplianceMiddleware` that enforces LAFS compliance on the next handler's output.

```typescript
(options?: EnforceComplianceOptions) => ComplianceMiddleware
```

**Parameters:**

- `options` — Compliance options forwarded to `assertCompliance`.

**Returns:** A middleware function that validates the downstream envelope.

```ts
const mw = createComplianceMiddleware({ checkConformance: true });
const result = await mw(currentEnvelope, () => produceEnvelope());
```

### `getDeprecationRegistry`

Retrieve all registered deprecation entries.

```typescript
() => DeprecationEntry[]
```

**Returns:** Array of all `DeprecationEntry` rules in the registry

```typescript
const entries = getDeprecationRegistry();
console.log(entries.length); // number of registered deprecations
```

### `detectDeprecatedEnvelopeFields`

Detect deprecated field usage in a LAFS envelope.

```typescript
(envelope: LAFSEnvelope) => Warning[]
```

**Parameters:**

- `envelope` — The LAFS envelope to inspect

**Returns:** Array of `Warning` objects for each detected deprecation

```typescript
const warnings = detectDeprecatedEnvelopeFields(envelope);
for (const w of warnings) {
  console.warn(`${w.code}: ${w.message}`);
}
```

### `emitDeprecationWarnings`

Emit deprecation warnings by attaching them to the envelope metadata.

```typescript
(envelope: LAFSEnvelope) => LAFSEnvelope
```

**Parameters:**

- `envelope` — The LAFS envelope to augment

**Returns:** A new envelope with deprecation warnings appended to `_meta.warnings`

```typescript
const enriched = emitDeprecationWarnings(envelope);
console.log(enriched._meta.warnings); // includes any deprecation warnings
```

### `parseExtensionsHeader`

Parse A2A-Extensions header value into URI array.

```typescript
(headerValue: string | undefined) => string[]
```

**Parameters:**

- `headerValue` — Raw header value string, or undefined if absent

**Returns:** Array of trimmed extension URI strings

```typescript
const uris = parseExtensionsHeader('https://lafs.dev/ext/v1, https://example.com/ext');
// => ['https://lafs.dev/ext/v1', 'https://example.com/ext']
```

### `negotiateExtensions`

Negotiate extensions between client-requested and agent-declared sets.

```typescript
(requestedUris: string[], agentExtensions: AgentExtension[]) => ExtensionNegotiationResult
```

**Parameters:**

- `requestedUris` — Extension URIs requested by the client
- `agentExtensions` — Extensions declared in the agent's Agent Card

**Returns:** Negotiation result with activated, unsupported, and missing required sets

```typescript
const result = negotiateExtensions(
  ['https://lafs.dev/extensions/envelope/v1'],
  agentCard.capabilities.extensions,
);
if (result.missingRequired.length > 0) {
  throw new ExtensionSupportRequiredError(result.missingRequired);
}
```

### `formatExtensionsHeader`

Format activated extension URIs into header value.

```typescript
(activatedUris: string[]) => string
```

**Parameters:**

- `activatedUris` — Extension URIs that were successfully negotiated

**Returns:** Comma-separated header value string

```typescript
res.setHeader('A2A-Extensions', formatExtensionsHeader(result.activated));
```

### `buildLafsExtension`

Build an A2A AgentExtension object declaring LAFS support.

```typescript
(options?: BuildLafsExtensionOptions) => AgentExtension
```

**Parameters:**

- `options` — Configuration options for the LAFS extension declaration

**Returns:** A2A AgentExtension object ready for inclusion in an Agent Card

```typescript
const ext = buildLafsExtension({ required: true, supportsTokenBudgets: true });
agentCard.capabilities.extensions.push(ext);
```

### `buildExtension`

Build a generic A2A AgentExtension object.

```typescript
(options: BuildExtensionOptions) => AgentExtension
```

**Parameters:**

- `options` — Configuration for the extension declaration

**Returns:** A2A AgentExtension object

```typescript
const ext = buildExtension({
  uri: 'https://example.com/ext/v1',
  description: 'Custom extension',
  kind: 'data-only',
});
```

### `isValidExtensionKind`

Check whether a string is a valid extension kind.

```typescript
(kind: string) => kind is ExtensionKind
```

**Parameters:**

- `kind` — String value to validate

**Returns:** True if the value is a recognized ExtensionKind

```typescript
if (isValidExtensionKind(userInput)) {
  // userInput is now typed as ExtensionKind
}
```

### `validateExtensionDeclaration`

Validate an A2A extension declaration for correctness.

```typescript
(extension: AgentExtension) => { valid: boolean; error?: string; }
```

**Parameters:**

- `extension` — The AgentExtension to validate

**Returns:** Object with `valid` boolean and optional `error` message

```typescript
const { valid, error } = validateExtensionDeclaration(ext);
if (!valid) {
  console.error('Invalid extension:', error);
}
```

### `extensionNegotiationMiddleware`

Express middleware for A2A extension negotiation.

```typescript
(options: ExtensionNegotiationMiddlewareOptions) => RequestHandler
```

**Parameters:**

- `options` — Middleware configuration with extensions and enforcement settings

**Returns:** Express RequestHandler that performs extension negotiation

```typescript
app.use(extensionNegotiationMiddleware({
  extensions: agentCard.capabilities.extensions,
  enforceRequired: true,
}));
```

### `discoveryMiddleware`

Create Express middleware for serving A2A Agent Card.

```typescript
(config: DiscoveryConfig, options?: DiscoveryMiddlewareOptions) => RequestHandler
```

**Parameters:**

- `config` — Discovery configuration (A2A v1.0 format)
- `options` — Middleware options for path routing and caching

**Returns:** Express RequestHandler that serves the Agent Card

```typescript
import express from "express";
import { discoveryMiddleware } from "@cleocode/lafs/discovery";

const app = express();

app.use(discoveryMiddleware({
  agent: {
    name: "my-lafs-agent",
    description: "A LAFS-compliant agent with A2A support",
    version: "1.0.0",
    url: "https://api.example.com",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: []
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "envelope-processor",
        name: "Envelope Processor",
        description: "Process LAFS envelopes",
        tags: ["lafs", "envelope", "validation"],
        examples: ["Validate this envelope", "Process envelope data"]
      }
    ]
  }
}));
```

### `discoveryFastifyPlugin`

Fastify plugin for A2A Agent Card discovery.

```typescript
(fastify: unknown, options: { config: DiscoveryConfig; path?: string; }) => Promise<void>
```

**Parameters:**

- `fastify` — Fastify instance
- `options` — Plugin options containing `config` and optional `path`

**Returns:** Promise that resolves when the plugin is registered

```typescript
import Fastify from "fastify";
import { discoveryFastifyPlugin } from "@cleocode/lafs/discovery";

const app = Fastify();
app.register(discoveryFastifyPlugin, {
  config: { agent: { name: "my-agent", ... } },
});
```

### `createEnvelope`

Create a fully validated LAFS envelope from a success or error input.

```typescript
(input: CreateEnvelopeInput) => LAFSEnvelope
```

**Parameters:**

- `input` — Discriminated union of success or error input data.

**Returns:** A complete `LAFSEnvelope` ready for serialization.

```ts
import { createEnvelope } from '@cleocode/lafs';

const envelope = createEnvelope({
  success: true,
  result: { items: [] },
  meta: { operation: 'tasks.list', requestId: 'req-1' },
});
```

### `parseLafsResponse`

Parse and unwrap a raw LAFS envelope, returning the result or throwing on error.

```typescript
<T = unknown>(input: unknown, options?: ParseLafsResponseOptions) => T
```

**Parameters:**

- `input` — Raw value expected to be a valid `LAFSEnvelope`.
- `options` — Parsing options controlling error-code validation.

**Returns:** The `result` field of the envelope cast to `T`.

```ts
import { parseLafsResponse } from '@cleocode/lafs';

interface TaskList { items: Task[] }
const tasks = parseLafsResponse<TaskList>(rawEnvelope);
```

### `resolveFieldExtraction`

Resolve field extraction flags into a validated configuration.

```typescript
(input: FieldExtractionInput) => FieldExtractionResolution
```

**Parameters:**

- `input` — The field extraction flag inputs

**Returns:** The resolved extraction configuration with mvi level and source

```ts
const resolution = resolveFieldExtraction({ fieldsFlag: 'id,title' });
// => { fields: ['id', 'title'], mvi: 'minimal', mviSource: 'default', expectsCustomMvi: true }
```

### `extractFieldFromResult`

Extract a named field from a LAFS result object.

```typescript
(result: LAFSEnvelope["result"], field: string) => unknown
```

**Parameters:**

- `result` — The envelope result value (object, array, or null)
- `field` — The field name to extract

**Returns:** The extracted value, or `undefined` if not found at any level

```ts
const result = { task: { id: 'T1', title: 'Fix bug' } };
extractFieldFromResult(result, 'title'); // => 'Fix bug'
```

### `extractFieldFromEnvelope`

Extract a named field from an envelope's result.

```typescript
(envelope: LAFSEnvelope, field: string) => unknown
```

**Parameters:**

- `envelope` — The LAFS envelope to extract from
- `field` — The field name to extract

**Returns:** The extracted value, or `undefined` if not found

```ts
const value = extractFieldFromEnvelope(envelope, 'title');
```

### `applyFieldFilter`

Filter result fields in a LAFS envelope to the requested subset.

```typescript
(envelope: LAFSEnvelope, fields: string[]) => LAFSEnvelope
```

**Parameters:**

- `envelope` — The LAFS envelope whose result will be filtered
- `fields` — Array of field names to retain in the result

**Returns:** A new envelope with the filtered result and `_meta.mvi` set to `'custom'`

```ts
const filtered = applyFieldFilter(envelope, ['id', 'title']);
// filtered.result contains only 'id' and 'title' fields
// filtered._meta.mvi === 'custom'
```

### `resolveFlags`

Resolve all flags across both layers and validate cross-layer semantics.

```typescript
(input: UnifiedFlagInput) => UnifiedFlagResolution
```

**Parameters:**

- `input` — Combined format and field extraction flags

**Returns:** The unified resolution containing format, fields, and any cross-layer warnings

```ts
const result = resolveFlags({ human: true, field: 'title' });
// result.format => { format: 'human', source: 'flag', quiet: false }
// result.fields => { field: 'title', mvi: 'minimal', ... }
// result.warnings => ['Cross-layer: --human + --field "title". ...']
```

### `createLafsArtifact`

Create a LAFS envelope artifact for A2A.

```typescript
(envelope: LAFSEnvelope) => Artifact
```

**Parameters:**

- `envelope` — LAFS envelope to wrap as an artifact

**Returns:** A2A Artifact containing the envelope as a DataPart

```typescript
const envelope = createEnvelope({
  success: true,
  result: { data: '...' },
  meta: { operation: 'analysis.run' }
});

const artifact = createLafsArtifact(envelope);
task.artifacts.push(artifact);
```

### `createTextArtifact`

Create a text artifact.

```typescript
(text: string, name?: string) => Artifact
```

**Parameters:**

- `text` — Text content for the artifact
- `name` — Display name for the artifact

**Returns:** A2A Artifact containing the text as a TextPart

```typescript
const artifact = createTextArtifact('Hello, world!', 'greeting');
```

### `createFileArtifact`

Create a file artifact.

```typescript
(fileUrl: string, mediaType: string, filename?: string) => Artifact
```

**Parameters:**

- `fileUrl` — URI pointing to the file resource
- `mediaType` — MIME type of the file (e.g., `application/pdf`)
- `filename` — Optional display filename for the artifact

**Returns:** A2A Artifact containing the file reference as a FilePart

```typescript
const artifact = createFileArtifact(
  'https://example.com/report.pdf',
  'application/pdf',
  'report.pdf',
);
```

### `isExtensionRequired`

Check if an extension is required in an Agent Card.

```typescript
(agentCard: AgentCard, extensionUri: string) => boolean
```

**Parameters:**

- `agentCard` — Agent Card to inspect
- `extensionUri` — URI of the extension to check

**Returns:** True if the extension is declared as required

```typescript
if (isExtensionRequired(agentCard, LAFS_EXTENSION_URI)) {
  console.log('LAFS extension is mandatory for this agent');
}
```

### `getExtensionParams`

Get extension parameters from an Agent Card.

```typescript
(agentCard: AgentCard, extensionUri: string) => Record<string, unknown> | undefined
```

**Parameters:**

- `agentCard` — Agent Card to inspect
- `extensionUri` — URI of the extension to look up

**Returns:** The extension's params object, or undefined if not found

```typescript
const params = getExtensionParams(agentCard, LAFS_EXTENSION_URI);
if (params?.supportsTokenBudgets) {
  // Enable budget tracking
}
```

### `isValidTransition`

Check if a transition from one state to another is valid.

```typescript
(from: TaskState, to: TaskState) => boolean
```

**Parameters:**

- `from` — Current task state
- `to` — Desired target state

**Returns:** True if the transition is allowed by the state machine

```typescript
if (!isValidTransition('submitted', 'completed')) {
  throw new Error('Cannot go directly from submitted to completed');
}
```

### `isTerminalState`

Check if a state is terminal (no further transitions allowed).

```typescript
(state: TaskState) => boolean
```

**Parameters:**

- `state` — Task state to check

**Returns:** True if the state is terminal

```typescript
if (isTerminalState(task.status.state)) {
  console.log('Task has reached a final state');
}
```

### `isInterruptedState`

Check if a state is interrupted (paused awaiting input).

```typescript
(state: TaskState) => boolean
```

**Parameters:**

- `state` — Task state to check

**Returns:** True if the state indicates the task is waiting for external input

```typescript
if (isInterruptedState(task.status.state)) {
  promptUserForInput(task);
}
```

### `attachLafsEnvelope`

Attach a LAFS envelope as an artifact to an A2A task.

```typescript
(manager: TaskManager, taskId: string, envelope: LAFSEnvelope) => Task
```

**Parameters:**

- `manager` — TaskManager instance managing the task
- `taskId` — ID of the task to attach the envelope to
- `envelope` — LAFS envelope to attach as an artifact

**Returns:** Deep clone of the updated task with the new artifact

```typescript
const envelope: LAFSEnvelope = { success: true, result: { data: 'ok' }, error: null, _meta: meta };
const updated = attachLafsEnvelope(manager, 'task-1', envelope);
```

### `streamTaskEvents`

Build an async iterator for real-time task stream events.

```typescript
(bus: TaskEventBus, taskId: string, options?: StreamIteratorOptions) => AsyncGenerator<TaskStreamEvent>
```

**Parameters:**

- `bus` — TaskEventBus to subscribe to
- `taskId` — ID of the task to stream events for
- `options` — Iterator options including timeout

**Returns:** Async generator yielding task stream events

```typescript
for await (const event of streamTaskEvents(bus, 'task-1', { timeoutMs: 5000 })) {
  console.log('Received:', event);
}
```

### `createJsonRpcRequest`

Create a JSON-RPC 2.0 request object.

```typescript
(id: string | number, method: string, params?: Record<string, unknown>) => JsonRpcRequest
```

**Parameters:**

- `id` — Client-assigned request identifier
- `method` — The RPC method name to invoke
- `params` — Optional named parameters for the method call

**Returns:** A fully formed `JsonRpcRequest` object

```ts
const req = createJsonRpcRequest(1, 'tasks/get', { id: 'abc' });
// { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'abc' } }
```

### `createJsonRpcResponse`

Create a JSON-RPC 2.0 success response.

```typescript
(id: string | number | null, result: unknown) => JsonRpcResponse
```

**Parameters:**

- `id` — Identifier matching the originating request, or `null` for notifications
- `result` — The return value of the invoked method

**Returns:** A fully formed `JsonRpcResponse` object

```ts
const res = createJsonRpcResponse(1, { status: 'ok' });
// { jsonrpc: '2.0', id: 1, result: { status: 'ok' } }
```

### `createJsonRpcErrorResponse`

Create a JSON-RPC 2.0 error response.

```typescript
(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) => JsonRpcErrorResponse
```

**Parameters:**

- `id` — Identifier matching the originating request, or `null` for notifications
- `code` — Numeric error code (standard or A2A-specific)
- `message` — Short human-readable description of the error
- `data` — Optional additional structured error data

**Returns:** A fully formed `JsonRpcErrorResponse` object

```ts
const err = createJsonRpcErrorResponse(1, -32001, 'Task not found');
// { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Task not found' } }
```

### `createA2AErrorResponse`

Create an A2A-specific JSON-RPC error response by error type name.

```typescript
(id: string | number | null, errorType: A2AErrorType, message: string, data?: Record<string, unknown>) => JsonRpcErrorResponse
```

**Parameters:**

- `id` — Identifier matching the originating request, or `null` for notifications
- `errorType` — The A2A error type name (e.g. `"TaskNotFound"`)
- `message` — Short human-readable description of the error
- `data` — Optional additional structured error data

**Returns:** A fully formed `JsonRpcErrorResponse` with the resolved A2A error code

```ts
const err = createA2AErrorResponse(1, 'TaskNotFound', 'No task with id xyz');
// error.code === -32001
```

### `validateJsonRpcRequest`

Validate the structure of a JSON-RPC request.

```typescript
(input: unknown) => { valid: boolean; errors: string[]; }
```

**Parameters:**

- `input` — The unknown value to validate

**Returns:** An object with `valid` indicating success and `errors` listing any violations

```ts
const { valid, errors } = validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get' });
// valid === true, errors === []
```

### `isA2AError`

Check if a numeric error code is an A2A-specific error.

```typescript
(code: number) => boolean
```

**Parameters:**

- `code` — The numeric JSON-RPC error code to check

**Returns:** `true` if the code falls within the A2A error range

```ts
isA2AError(-32001); // true  (TaskNotFound)
isA2AError(-32700); // false (standard ParseError)
```

### `createGrpcStatus`

Create a gRPC Status object for an A2A error type.

```typescript
(errorType: A2AErrorType, message: string, metadata?: Record<string, string>) => GrpcStatus
```

**Parameters:**

- `errorType` — The A2A error type name (e.g. `"TaskNotFound"`)
- `message` — Human-readable error message
- `metadata` — Optional key-value metadata to include in the ErrorInfo detail

**Returns:** A fully formed `GrpcStatus` object with ErrorInfo details

```ts
const status = createGrpcStatus('TaskNotFound', 'No task with id xyz');
// { code: 5, message: '...', details: [{ reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' }] }
```

### `createProblemDetails`

Create an RFC 9457 Problem Details object for an A2A error.

```typescript
(errorType: A2AErrorType, detail: string, extensions?: Record<string, unknown>) => ProblemDetails
```

**Parameters:**

- `errorType` — The A2A error type name (e.g. `"TaskNotFound"`)
- `detail` — Human-readable explanation specific to this occurrence
- `extensions` — Optional additional members to include in the response

**Returns:** A fully formed `ProblemDetails` object

```ts
const problem = createProblemDetails('TaskNotFound', 'No task with id xyz');
// { type: 'https://a2a-protocol.org/errors/task-not-found', title: 'Task Not Found', status: 404, detail: '...' }
```

### `createLafsProblemDetails`

Create an RFC 9457 Problem Details object bridging A2A error types with LAFS error data.

```typescript
(errorType: A2AErrorType, lafsError: LAFSError, requestId?: string) => ProblemDetails
```

**Parameters:**

- `errorType` — The A2A error type name (e.g. `"InvalidAgentResponse"`)
- `lafsError` — The LAFS error object to extract extension fields from
- `requestId` — Optional request identifier used as the `instance` field

**Returns:** A `ProblemDetails` object with LAFS extension fields

```ts
const problem = createLafsProblemDetails('InvalidAgentResponse', {
  code: 'E_AGENT_RESPONSE',
  message: 'Upstream agent returned invalid JSON',
  retryable: true,
  retryAfterMs: 5000,
}, 'req-123');
```

### `buildUrl`

Build a URL by substituting path parameters.

```typescript
(endpoint: HttpEndpoint, params?: Record<string, string>) => string
```

**Parameters:**

- `endpoint` — HTTP endpoint definition from `HTTP_ENDPOINTS`
- `params` — Path parameter values keyed by name (without leading colon)

**Returns:** The resolved URL path string with parameters substituted

```ts
const url = buildUrl(HTTP_ENDPOINTS.GetTask, { id: 'task-42' });
// '/tasks/task-42'
```

### `parseListTasksQuery`

Parse camelCase query parameters for the ListTasks endpoint.

```typescript
(query: Record<string, string | undefined>) => ListTasksQueryParams
```

**Parameters:**

- `query` — Raw query parameter map from the HTTP request

**Returns:** A typed `ListTasksQueryParams` object with coerced values

```ts
const params = parseListTasksQuery({ contextId: 'ctx-1', limit: '10' });
// { contextId: 'ctx-1', limit: 10 }
```

### `getErrorCodeMapping`

Get the complete error code mapping for a given A2A error type.

```typescript
(errorType: A2AErrorType) => ErrorCodeMapping
```

**Parameters:**

- `errorType` — The A2A error type name (e.g. `"TaskNotFound"`)

**Returns:** The `ErrorCodeMapping` with JSON-RPC, HTTP, and gRPC codes

```ts
const mapping = getErrorCodeMapping('TaskNotFound');
// { jsonRpcCode: -32001, httpStatus: 404, httpTypeUri: '...', grpcStatus: 'NOT_FOUND', grpcCode: 5 }
```

### `parseA2AVersionHeader`

Parse the `a2a-version` header into an array of version strings.

```typescript
(headerValue: string | undefined) => string[]
```

**Parameters:**

- `headerValue` — The raw `a2a-version` header value, or `undefined` if absent

**Returns:** An array of version strings extracted from the header

```ts
parseA2AVersionHeader('1.0, 2.0'); // ['1.0', '2.0']
parseA2AVersionHeader(undefined);   // []
```

### `negotiateA2AVersion`

Negotiate an A2A protocol version from the client's requested versions.

```typescript
(requestedVersions: string[]) => string | null
```

**Parameters:**

- `requestedVersions` — Array of version strings requested by the client

**Returns:** The negotiated version string, or `null` if no common version exists

```ts
negotiateA2AVersion(['1.0', '2.0']); // '1.0'
negotiateA2AVersion([]);              // '1.0' (default)
negotiateA2AVersion(['3.0']);          // null
```

### `circuitBreakerMiddleware`

Create an Express middleware that wraps downstream handlers with a circuit breaker.

```typescript
(config: CircuitBreakerConfig) => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void; }; }, next: () => void) => Promise<void>
```

**Parameters:**

- `config` — Circuit breaker configuration for the middleware instance

**Returns:** An Express-compatible middleware function

```typescript
app.use('/external-api', circuitBreakerMiddleware({
  name: 'external-api',
  failureThreshold: 5
}));
```

### `healthCheck`

Health check middleware for Express applications.

```typescript
(config?: HealthCheckConfig) => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void; }; }) => Promise<void>
```

**Parameters:**

- `config` — Optional health check configuration

**Returns:** An Express-compatible middleware function that serves the health endpoint

```typescript
import express from 'express';
import { healthCheck } from '@cleocode/lafs/health';

const app = express();

// Basic health check
app.use('/health', healthCheck());

// Custom health checks
app.use('/health', healthCheck({
  checks: [
    async () => ({
      name: 'database',
      status: await checkDatabase() ? 'ok' : 'error'
    })
  ]
}));
```

### `createDatabaseHealthCheck`

Create a health check function that verifies database connectivity.

```typescript
(config: { checkConnection: () => Promise<boolean>; name?: string; }) => HealthCheckFunction
```

**Parameters:**

- `config` — Database check configuration
- `` — config.checkConnection - Async function returning `true` if the database is reachable
- `` — config.name - Display name for this check in health output

**Returns:** A `HealthCheckFunction` suitable for use in `HealthCheckConfig.checks`

```typescript
const dbCheck = createDatabaseHealthCheck({
  checkConnection: async () => await db.ping()
});

app.use('/health', healthCheck({
  checks: [dbCheck]
}));
```

### `createExternalServiceHealthCheck`

Create a health check function that probes an external HTTP service.

```typescript
(config: { name: string; url: string; timeout?: number; }) => HealthCheckFunction
```

**Parameters:**

- `config` — External service check configuration
- `` — config.name - Display name for this check in health output
- `` — config.url - URL to probe for health status
- `` — config.timeout - Request timeout in milliseconds

**Returns:** A `HealthCheckFunction` suitable for use in `HealthCheckConfig.checks`

```typescript
const apiCheck = createExternalServiceHealthCheck({
  name: 'payment-api',
  url: 'https://api.payment.com/health',
  timeout: 5000
});
```

### `livenessProbe`

Liveness probe -- a minimal check confirming the process is running.

```typescript
() => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void; }; }) => void
```

**Returns:** An Express-compatible middleware function

```typescript
app.get('/health/live', livenessProbe());
```

### `readinessProbe`

Readiness probe -- verifies the service can accept traffic.

```typescript
(config?: { checks?: HealthCheckFunction[]; }) => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void; }; }) => Promise<void>
```

**Parameters:**

- `config` — Optional configuration with custom health check functions

**Returns:** An Express-compatible async middleware function

```typescript
app.get('/health/ready', readinessProbe({
  checks: [dbCheck, cacheCheck]
}));
```

### `wrapMCPResult`

Wrap an MCP tool result in a LAFS envelope.

```typescript
(mcpResult: CallToolResult, operation: string, budget?: number) => LAFSEnvelope
```

**Parameters:**

- `mcpResult` — The raw MCP CallToolResult
- `operation` — The operation name (tool name)
- `budget` — Optional token budget for response truncation

**Returns:** LAFS-compliant envelope with `success`, `result`, and `error` fields

```typescript
import { wrapMCPResult } from "@cleocode/lafs";

const envelope = wrapMCPResult(mcpToolResult, "tasks.list", 500);
if (envelope.success) {
  console.log(envelope.result);
}
```

### `createAdapterErrorEnvelope`

Create a LAFS error envelope for MCP adapter errors.

```typescript
(message: string, operation: string, category?: LAFSError["category"]) => LAFSEnvelope
```

**Parameters:**

- `message` — Human-readable error message
- `operation` — The operation being performed when the error occurred
- `category` — Error category (defaults to `"INTERNAL"`)

**Returns:** LAFS envelope with `success: false` and the error payload

```typescript
import { createAdapterErrorEnvelope } from "@cleocode/lafs";

const errorEnvelope = createAdapterErrorEnvelope(
  "MCP server unreachable",
  "tasks.list",
  "TRANSIENT",
);
```

### `isTextContent`

Type guard to check if content is MCP TextContent.

```typescript
(content: unknown) => content is TextContent
```

**Parameters:**

- `content` — Unknown value to check

**Returns:** `true` if the value is a valid MCP TextContent object

```typescript
if (isTextContent(item)) {
  console.log(item.text);
}
```

### `parseMCPTextContent`

Parse MCP text content as JSON if possible.

```typescript
(content: TextContent) => unknown
```

**Parameters:**

- `content` — MCP TextContent to parse

**Returns:** Parsed JSON value, or the raw text string if JSON parsing fails

```typescript
const data = parseMCPTextContent(textContent);
```

### `projectEnvelope`

Project an envelope to the declared MVI verbosity level.

```typescript
(envelope: LAFSEnvelope, mviLevel?: MVILevel) => Record<string, unknown>
```

**Parameters:**

- `envelope` — The full LAFS envelope to project
- `mviLevel` — Override MVI level; falls back to `envelope._meta.mvi`, then `'standard'`

**Returns:** A plain object containing only the fields appropriate for the resolved MVI level

```ts
const minimal = projectEnvelope(envelope, 'minimal');
// minimal contains only: success, _meta (requestId, contextVersion), result/error
```

### `estimateProjectedTokens`

Estimate token count for a projected envelope.

```typescript
(projected: Record<string, unknown>) => number
```

**Parameters:**

- `projected` — The projected envelope object to estimate

**Returns:** The estimated token count based on JSON serialization length

```ts
const tokens = estimateProjectedTokens(projectEnvelope(envelope, 'minimal'));
// tokens ~= Math.ceil(JSON.stringify(projected).length / 4)
```

### `lafsErrorToProblemDetails`

Convert a LAFSError to an RFC 9457 Problem Details object.

```typescript
(error: LAFSError, requestId?: string) => LafsProblemDetails
```

**Parameters:**

- `error` — The LAFS error to convert
- `requestId` — Optional request ID to set as the `instance` field

**Returns:** An RFC 9457-compliant `LafsProblemDetails` object

```typescript
import { lafsErrorToProblemDetails } from "@cleocode/lafs";

const pd = lafsErrorToProblemDetails(envelope.error!, envelope._meta.requestId);
// pd.status === 400, pd.type === "https://lafs.dev/errors/v1/E_VALIDATION"
```

### `gracefulShutdown`

Enable graceful shutdown for an HTTP server.

```typescript
(server: Server, config?: GracefulShutdownConfig) => void
```

**Parameters:**

- `server` — The Node.js HTTP server to manage
- `config` — Optional shutdown configuration

```typescript
import express from 'express';
import { gracefulShutdown } from '@cleocode/lafs/shutdown';

const app = express();
const server = app.listen(3000);

gracefulShutdown(server, {
  timeout: 30000,
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async () => {
    console.log('Shutting down...');
    await db.close();
  }
});
```

### `isShuttingDown`

Check whether a shutdown sequence is currently in progress.

```typescript
() => boolean
```

**Returns:** `true` if the server is shutting down, `false` otherwise

```typescript
if (isShuttingDown()) {
  return; // skip expensive work
}
```

### `getShutdownState`

Get a snapshot of the current shutdown state.

```typescript
() => ShutdownState
```

**Returns:** A copy of the current `ShutdownState`

```typescript
const state = getShutdownState();
console.log(`Connections: ${state.activeConnections}`);
```

### `forceShutdown`

Terminate the process immediately without waiting for connections to drain.

```typescript
(exitCode?: number) => void
```

**Parameters:**

- `exitCode` — Process exit code

```typescript
forceShutdown(1);
```

### `shutdownMiddleware`

Express middleware that rejects requests with 503 while the server is shutting down.

```typescript
() => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void; }; }, next: () => void) => void
```

**Returns:** An Express-compatible middleware function

```typescript
app.use(shutdownMiddleware());
```

### `waitForShutdown`

Wait until a shutdown sequence begins.

```typescript
() => Promise<void>
```

**Returns:** A promise that resolves when shutdown has started

```typescript
await waitForShutdown();
```

## Types

### `TokenEstimatorOptions`

Configuration options for the token estimator.

```typescript
TokenEstimatorOptions
```

**Members:**

- `charsPerToken` — Characters per token ratio.
- `maxDepth` — Maximum depth to traverse for circular reference detection.
- `maxStringLength` — Maximum string length to process for Unicode grapheme counting.

```typescript
const opts: TokenEstimatorOptions = {
  charsPerToken: 3.5,
  maxDepth: 50,
};
```

### `LAFSTransport`

Transport protocol used to deliver a LAFS envelope.

```typescript
LAFSTransport
```

### `LAFSErrorCategory`

Classification category for a LAFS error.

```typescript
LAFSErrorCategory
```

### `Warning`

A non-fatal warning attached to a LAFS envelope's `_meta.warnings` array.

```typescript
Warning
```

**Members:**

- `code` — Machine-readable warning code (e.g. `"W_DEPRECATED_FIELD"`).
- `message` — Human-readable description of the warning.
- `deprecated` — Name of the deprecated field, parameter, or feature.
- `replacement` — Recommended replacement for the deprecated item.
- `removeBy` — Semver version or ISO date after which the deprecated item will be removed.

### `MVILevel`

Minimum Viable Information level controlling envelope verbosity.

```typescript
MVILevel
```

### `LAFSMeta`

Metadata block (`_meta`) embedded in every LAFS envelope.

```typescript
LAFSMeta
```

**Members:**

- `specVersion` — Semantic version of the LAFS protocol specification (e.g. `"1.0.0"`).
- `schemaVersion` — Semantic version of the JSON Schema used for this envelope (e.g. `"1.0.0"`).
- `timestamp` — ISO 8601 timestamp of when the envelope was created.
- `operation` — Dot-delimited operation identifier (e.g. `"tasks.list"`).
- `requestId` — Unique identifier for correlating this request/response pair.
- `transport` — Transport protocol through which this envelope is delivered.
- `strict` — When `true`, schema validation rejects unknown properties.
- `mvi` — Minimum Viable Information level controlling field inclusion.
- `contextVersion` — Monotonically increasing version of the agent's context ledger.
- `sessionId` — Session identifier for correlating multi-step agent workflows.
- `warnings` — Non-fatal warnings to surface to the consuming agent.

### `LAFSAgentAction`

Recommended action an LLM agent should take in response to an error.

```typescript
LAFSAgentAction
```

### `LAFSError`

Structured error payload returned in a failing LAFS envelope.

```typescript
LAFSError
```

**Members:**

- `code` — Stable, machine-readable error code (e.g. `"E_NOT_FOUND"`).
- `message` — Human-readable description of the error.
- `category` — High-level classification of the error.
- `retryable` — Whether the operation can be retried without modification.
- `retryAfterMs` — Suggested delay in milliseconds before retrying, or `null` if not applicable.
- `details` — Arbitrary key-value pairs with additional context about the error.
- `agentAction` — Recommended action for the consuming agent to take.
- `escalationRequired` — When `true`, the error requires human intervention or a higher-privilege agent.
- `suggestedAction` — Free-text description of a suggested recovery action for the agent.
- `docUrl` — URL pointing to documentation about this error code.

### `LAFSPageCursor`

Cursor-based pagination metadata.

```typescript
LAFSPageCursor
```

**Members:**

- `mode` — Discriminant identifying cursor-based pagination.
- `nextCursor` — Opaque cursor for fetching the next page, or `null` when at the end.
- `hasMore` — Whether additional pages exist beyond the current one.
- `limit` — Maximum number of items per page.
- `total` — Total number of items across all pages, or `null` if unknown.

### `LAFSPageOffset`

Offset-based pagination metadata.

```typescript
LAFSPageOffset
```

**Members:**

- `mode` — Discriminant identifying offset-based pagination.
- `limit` — Maximum number of items per page.
- `offset` — Zero-based index of the first item in this page.
- `hasMore` — Whether additional pages exist beyond the current one.
- `total` — Total number of items across all pages, or `null` if unknown.

### `LAFSPageNone`

Sentinel pagination mode indicating no pagination is applied.

```typescript
LAFSPageNone
```

**Members:**

- `mode` — Discriminant indicating no pagination.

### `LAFSPage`

Discriminated union of all supported pagination modes.

```typescript
LAFSPage
```

### `ContextLedgerEntry`

A single entry in the context ledger recording one state mutation.

```typescript
ContextLedgerEntry
```

**Members:**

- `entryId` — Unique identifier for this ledger entry.
- `timestamp` — ISO 8601 timestamp of when the mutation occurred.
- `operation` — Operation that produced this context change.
- `contextDelta` — Key-value delta describing the context fields that changed.
- `requestId` — Request identifier that triggered this entry, for tracing.

### `ContextLedger`

Append-only ledger tracking context mutations across agent interactions.

```typescript
ContextLedger
```

**Members:**

- `ledgerId` — Unique identifier for this ledger instance.
- `version` — Monotonically increasing version incremented on each mutation.
- `createdAt` — ISO 8601 timestamp of when the ledger was created.
- `updatedAt` — ISO 8601 timestamp of the most recent mutation.
- `entries` — Ordered list of context mutations from oldest to newest.
- `checksum` — Integrity checksum of the current ledger state.
- `maxEntries` — Maximum number of entries retained before oldest entries are pruned.

### `LAFSEnvelope`

Top-level LAFS response envelope wrapping every operation result.

```typescript
LAFSEnvelope
```

**Members:**

- `$schema` — JSON Schema URL identifying the envelope schema version.
- `_meta` — Protocol and request metadata.
- `success` — Whether the operation completed successfully.
- `result` — Operation result payload, or `null` on failure.
- `error` — Structured error payload, or `null` on success.
- `page` — Pagination metadata when the result is a paginated collection.
- `_extensions` — Vendor or protocol extension data keyed by extension identifier.

### `FlagInput`

Input parameters for resolving the output format via flag semantics.

```typescript
FlagInput
```

**Members:**

- `requestedFormat` — Explicitly requested output format string.
- `jsonFlag` — Whether the `--json` CLI flag was provided.
- `humanFlag` — Whether the `--human` CLI flag was provided.
- `projectDefault` — Project-level default output format from configuration.
- `userDefault` — User-level default output format from configuration.
- `tty` — When true, indicates the output is connected to an interactive terminal. If no explicit format flag or project/user default is set, TTY terminals default to `"human"` format while non-TTY (piped, CI, agents) defaults to `"json"` per the LAFS protocol.  CLI tools should pass `process.stdout.isTTY ?? false` here.
- `quiet` — Suppress non-essential output for scripting. When true, only essential data is returned.

### `ConformanceReport`

Result of a LAFS conformance test run.

```typescript
ConformanceReport
```

**Members:**

- `ok` — `true` if all checks passed; `false` if any check failed.
- `checks` — Individual conformance check results.

### `BudgetEnforcementOptions`

Options controlling token-budget enforcement behaviour.

```typescript
BudgetEnforcementOptions
```

### `TokenEstimate`

Token-count estimate attached to a budget-aware envelope.

```typescript
TokenEstimate
```

**Members:**

- `estimated` — Estimated token count of the envelope after any truncation.
- `truncated` — Whether the result was truncated to fit within the budget.
- `originalEstimate` — Original estimated token count before truncation, if truncation occurred.

### `LAFSMetaWithBudget`

Extended metadata block that includes an optional token-budget estimate.

```typescript
LAFSMetaWithBudget
```

**Members:**

- `_tokenEstimate` — Token-count estimate for budget tracking.

### `LAFSEnvelopeWithBudget`

LAFS envelope variant whose metadata includes token-budget estimates.

```typescript
LAFSEnvelopeWithBudget
```

**Members:**

- `_meta` — Metadata block extended with token-budget estimation.

### `MiddlewareFunction`

Middleware function that transforms a LAFS envelope.

```typescript
MiddlewareFunction
```

**Parameters:**

- `envelope` — The envelope to transform.

**Returns:** The transformed envelope, optionally as a `Promise`.

### `NextFunction`

Continuation function passed to `BudgetMiddleware` to invoke the next middleware in the chain.

```typescript
NextFunction
```

**Returns:** The envelope produced by the downstream handler.

### `BudgetMiddleware`

Middleware function for token-budget enforcement with chain delegation.

```typescript
BudgetMiddleware
```

**Parameters:**

- `envelope` — The envelope entering this middleware stage.
- `next` — Continuation to invoke the next middleware in the chain.

**Returns:** The (possibly transformed) envelope.

### `BudgetEnforcementResult`

Outcome of running budget enforcement on a LAFS envelope.

```typescript
BudgetEnforcementResult
```

**Members:**

- `envelope` — The envelope after budget enforcement (possibly truncated).
- `withinBudget` — `true` if the estimated token count is within the allowed budget.
- `estimatedTokens` — Estimated token count of the final envelope.
- `budget` — Maximum allowed token count that was enforced.
- `truncated` — Whether the envelope's result was truncated to fit the budget.

### `ConformanceTier`

Named conformance tier indicating the breadth of checks applied.

```typescript
ConformanceTier
```

### `ConformanceProfiles`

Schema for the conformance-profiles JSON file.

```typescript
ConformanceProfiles
```

**Members:**

- `version` — Semantic version of the conformance-profiles schema.
- `tiers` — Mapping from tier name to the ordered list of check names in that tier.

### `RegistryCode`

A single entry in the LAFS error-code registry.

```typescript
RegistryCode
```

**Members:**

- `code` — The canonical LAFS error code (e.g., `"E_FORMAT_CONFLICT"`).
- `category` — Broad error category (e.g., `"client"`, `"server"`, `"auth"`).
- `description` — Human-readable description of when this error occurs.
- `retryable` — Whether the operation that produced this error is safe to retry.
- `httpStatus` — HTTP status code mapped to this error.
- `grpcStatus` — gRPC status string mapped to this error.
- `cliExit` — CLI exit code mapped to this error.
- `agentAction` — Suggested agent action from the registry (e.g., `"retry"`, `"abort"`).
- `typeUri` — RFC 9457 type URI for this error, used in Problem Details responses.
- `docUrl` — URL pointing to human-readable documentation for this error.

### `ErrorRegistry`

Top-level shape of the LAFS error-registry JSON file.

```typescript
ErrorRegistry
```

**Members:**

- `version` — Semantic version of the error-registry schema.
- `codes` — All registered LAFS error codes.

### `TransportMapping`

A transport-specific status value resolved from the error registry.

```typescript
TransportMapping
```

### `FlagResolution`

Result of resolving output format flags.

```typescript
FlagResolution
```

**Members:**

- `format` — The resolved output format: `'json'` for machine-readable or `'human'` for human-readable.
- `source` — Which configuration layer determined the format value.
- `quiet` — When true, suppress non-essential output for scripting.

### `StructuredValidationError`

Structured representation of a single validation error from AJV.

```typescript
StructuredValidationError
```

**Members:**

- `path` — JSON Pointer path to the property that failed validation (e.g., `"/_meta/mvi"`).
- `keyword` — The AJV validation keyword that triggered the error (e.g., `"required"`, `"type"`).
- `message` — Human-readable description of the validation failure.
- `params` — Keyword-specific parameters from AJV (e.g., `{ missingProperty: "success" }`).

### `EnvelopeValidationResult`

Result of validating a value against the LAFS envelope JSON Schema.

```typescript
EnvelopeValidationResult
```

**Members:**

- `valid` — True when the input fully conforms to the envelope schema.
- `errors` — Flattened human-readable error messages (empty when valid).
- `structuredErrors` — Structured error objects with path, keyword, and params (empty when valid).

### `EnvelopeConformanceOptions`

Options for configuring envelope conformance checking.

```typescript
EnvelopeConformanceOptions
```

**Members:**

- `tier` — The conformance tier to filter checks by.

### `ComplianceStage`

Identifies which stage of the compliance pipeline produced an issue.

```typescript
ComplianceStage
```

### `ComplianceIssue`

Describes a single compliance failure detected during enforcement.

```typescript
ComplianceIssue
```

**Members:**

- `stage` — The pipeline stage that produced this issue.
- `message` — A short, human-readable description of the failure.
- `detail` — Additional diagnostic information about the failure.

### `EnforceComplianceOptions`

Options controlling which compliance stages are executed.

```typescript
EnforceComplianceOptions
```

**Members:**

- `checkConformance` — Whether to run envelope conformance checks after schema validation.
- `checkFlags` — Whether to run flag conformance checks.
- `flags` — Flag input to validate when `checkFlags` is enabled.
- `requireJsonOutput` — When true, asserts that the resolved output format is JSON.

### `ComplianceResult`

Aggregated result of a full LAFS compliance run.

```typescript
ComplianceResult
```

**Members:**

- `ok` — True when every executed stage passes with zero issues.
- `envelope` — The parsed envelope, present only when schema validation succeeds.
- `validation` — Schema validation result from AJV.
- `envelopeConformance` — Envelope conformance report, present when `EnforceComplianceOptions.checkConformance` is true.
- `flagConformance` — Flag conformance report, present when `EnforceComplianceOptions.checkFlags` is true.
- `issues` — All issues collected across every executed stage.

### `ComplianceMiddleware`

Middleware signature for intercepting LAFS envelopes in a pipeline.

```typescript
ComplianceMiddleware
```

**Parameters:**

- `envelope` — The envelope entering this middleware.
- `next` — Callback that invokes the next middleware or terminal handler.

**Returns:** The (possibly transformed) envelope to pass upstream.

### `DeprecationEntry`

A single deprecation rule in the registry.

```typescript
DeprecationEntry
```

**Members:**

- `id` — Unique identifier for this deprecation rule
- `code` — Warning code emitted when detected
- `message` — Human-readable deprecation message
- `deprecated` — Version where the feature was deprecated
- `replacement` — Suggested replacement or migration path.
- `removeBy` — Version where the deprecated feature will be removed
- `detector` — Predicate that returns `true` when the envelope uses the deprecated feature

```typescript
const entry: DeprecationEntry = {
  id: "meta-mvi-boolean",
  code: "W_DEPRECATED_META_MVI_BOOLEAN",
  message: "_meta.mvi boolean values are deprecated",
  deprecated: "1.0.0",
  replacement: "Use _meta.mvi as one of: minimal|standard|full|custom",
  removeBy: "2.0.0",
  detector: (env) => typeof env._meta.mvi === "boolean",
};
```

### `LafsExtensionParams`

LAFS extension parameters declared in Agent Card

```typescript
LafsExtensionParams
```

**Members:**

- `supportsContextLedger` — Whether the agent supports context ledger tracking
- `supportsTokenBudgets` — Whether the agent supports token budget enforcement
- `envelopeSchema` — URL of the JSON Schema for the LAFS envelope
- `kind` — Classification of the extension's behavior.

### `ExtensionKind`

Classification of an A2A extension's behavior.

```typescript
ExtensionKind
```

### `ExtensionNegotiationResult`

Result of extension negotiation between client and agent

```typescript
ExtensionNegotiationResult
```

**Members:**

- `requested` — URIs requested by the client
- `activated` — URIs that matched agent-declared extensions
- `unsupported` — Requested URIs not declared by the agent (ignored per spec)
- `missingRequired` — Agent-required URIs not present in client request
- `activatedByKind` — Activated extensions grouped by declared kind (when provided)

### `BuildLafsExtensionOptions`

Options for building the LAFS extension declaration

```typescript
BuildLafsExtensionOptions
```

**Members:**

- `required` — Whether the LAFS extension is required for all requests.
- `supportsContextLedger` — Whether the agent supports context ledger tracking.
- `supportsTokenBudgets` — Whether the agent supports token budget enforcement.
- `envelopeSchema` — URL of the JSON Schema for the LAFS envelope.

### `BuildExtensionOptions`

Options for building a generic A2A extension declaration

```typescript
BuildExtensionOptions
```

**Members:**

- `uri` — Canonical URI identifying the extension
- `description` — Human-readable description of what the extension provides
- `required` — Whether the extension is required for all requests.
- `kind` — Classification of the extension's behavior
- `params` — Additional parameters to include in the extension declaration.

### `ExtensionNegotiationMiddlewareOptions`

Options for the extension negotiation middleware

```typescript
ExtensionNegotiationMiddlewareOptions
```

**Members:**

- `extensions` — Agent-declared extensions to negotiate against
- `enforceRequired` — Return 400 if required extensions are missing.

### `AgentProvider`

A2A Agent Provider information.

```typescript
AgentProvider
```

**Members:**

- `url` — Organization URL (must be a valid HTTPS URL)
- `organization` — Organization name (human-readable label)

```typescript
const provider: AgentProvider = {
  url: "https://example.com",
  organization: "Acme Corp"
};
```

### `AgentCapabilities`

A2A Agent Capabilities.

```typescript
AgentCapabilities
```

**Members:**

- `streaming` — Supports streaming responses.
- `pushNotifications` — Supports push notifications.
- `extendedAgentCard` — Supports extended agent card.
- `extensions` — Supported extensions declared by this agent.

```typescript
const caps: AgentCapabilities = {
  streaming: true,
  pushNotifications: false,
  extendedAgentCard: false,
  extensions: []
};
```

### `AgentExtension`

A2A Agent Extension declaration.

```typescript
AgentExtension
```

**Members:**

- `uri` — Extension URI (globally-unique identifier)
- `description` — Human-readable description of what the extension provides
- `required` — Whether the extension is required for interoperability
- `params` — Extension-specific parameters.

```typescript
const ext: AgentExtension = {
  uri: "https://lafs.dev/extensions/v1/lafs",
  description: "LAFS envelope protocol",
  required: false,
  params: { supportsContextLedger: true }
};
```

### `AgentSkill`

A2A Agent Skill.

```typescript
AgentSkill
```

**Members:**

- `id` — Skill unique identifier (kebab-case recommended)
- `name` — Human-readable display name
- `description` — Detailed description of what the skill does
- `tags` — Keywords/tags for discovery and categorization
- `examples` — Example prompts that demonstrate typical usage.
- `inputModes` — Supported input modes (overrides agent-level `AgentCard.defaultInputModes`).
- `outputModes` — Supported output modes (overrides agent-level `AgentCard.defaultOutputModes`).

```typescript
const skill: AgentSkill = {
  id: "envelope-processor",
  name: "Envelope Processor",
  description: "Validates and processes LAFS envelopes",
  tags: ["lafs", "envelope"],
  examples: ["Validate this envelope"],
};
```

### `SecurityScheme`

Security scheme for authentication (OpenAPI 3.0 style).

```typescript
SecurityScheme
```

**Members:**

- `type` — Authentication type per OpenAPI 3.0
- `description` — Human-readable description of the scheme.
- `scheme` — HTTP auth scheme name (e.g., `"bearer"`).
- `bearerFormat` — Bearer token format hint (e.g., `"JWT"`).

```typescript
const scheme: SecurityScheme = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
};
```

### `AgentCard`

A2A v1.0 Agent Card - Standard format for agent discovery.

```typescript
AgentCard
```

**Members:**

- `$schema` — JSON Schema URL for validation.
- `name` — Human-readable agent name
- `description` — Detailed description of agent capabilities
- `version` — Agent version (SemVer)
- `url` — Base URL for A2A endpoints
- `provider` — Service provider information.
- `capabilities` — Agent capabilities declaration
- `defaultInputModes` — Supported input content types (MIME types)
- `defaultOutputModes` — Supported output content types (MIME types)
- `skills` — Agent skills/capabilities for discovery
- `securitySchemes` — Security authentication schemes (keyed by scheme name).
- `security` — Required security scheme references (OpenAPI 3.0 format).
- `documentationUrl` — Documentation URL for the agent.
- `iconUrl` — Icon URL for the agent.

```typescript
const card: AgentCard = {
  name: "my-agent",
  description: "A LAFS-compliant agent",
  version: "1.0.0",
  url: "https://api.example.com",
  capabilities: { streaming: false },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [],
};
```

### `Capability`

Legacy capability descriptor.

```typescript
Capability
```

**Members:**

- `name` — Capability name
- `version` — Capability version
- `description` — Human-readable description.
- `operations` — Supported operations
- `optional` — Whether this capability is optional.

### `ServiceConfig`

Legacy service configuration.

```typescript
ServiceConfig
```

**Members:**

- `name` — Service name
- `version` — Service version
- `description` — Human-readable description.

### `EndpointConfig`

Legacy endpoint configuration.

```typescript
EndpointConfig
```

**Members:**

- `envelope` — Envelope endpoint URL
- `context` — Context endpoint URL.
- `discovery` — Discovery endpoint URL

### `DiscoveryDocument`

Legacy discovery document format.

```typescript
DiscoveryDocument
```

**Members:**

- `$schema` — JSON Schema URL
- `lafs_version` — LAFS specification version
- `service` — Service configuration
- `capabilities` — Declared capabilities
- `endpoints` — Endpoint configuration

### `DiscoveryConfig`

Configuration for the discovery middleware (A2A v1.0 format).

```typescript
DiscoveryConfig
```

**Members:**

- `agent` — Agent information (required for A2A v1.0; omit only with legacy `service`).
- `baseUrl` — Base URL for constructing absolute URLs.
- `cacheMaxAge` — Cache duration in seconds.
- `schemaUrl` — Schema URL override.
- `headers` — Optional custom response headers.
- `autoIncludeLafsExtension` — Automatically include LAFS as an A2A extension in Agent Card. Pass `true` for defaults, or an object to customize parameters.
- `service` — Legacy service configuration.
- `capabilities` — Legacy capabilities list.
- `endpoints` — Legacy endpoint URLs.
- `lafsVersion` — Legacy LAFS version override.

```typescript
const config: DiscoveryConfig = {
  agent: {
    name: "my-agent",
    description: "Example",
    version: "1.0.0",
    url: "https://api.example.com",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [],
  },
  cacheMaxAge: 3600,
};
```

### `DiscoveryMiddlewareOptions`

Discovery middleware options.

```typescript
DiscoveryMiddlewareOptions
```

**Members:**

- `path` — Primary path to serve Agent Card.
- `legacyPath` — Legacy path for backward compatibility.
- `enableLegacyPath` — Enable legacy path support.
- `enableHead` — Enable HEAD requests.
- `enableEtag` — Enable ETag caching.

```typescript
const options: DiscoveryMiddlewareOptions = {
  path: "/.well-known/agent-card.json",
  enableEtag: true,
};
```

### `CreateEnvelopeMetaInput`

Input for constructing the `_meta` block of a LAFS envelope.

```typescript
CreateEnvelopeMetaInput
```

**Members:**

- `operation` — Dot-delimited operation identifier (e.g. `"tasks.list"`).
- `requestId` — Unique identifier for correlating this request/response pair.
- `transport` — Transport protocol for this envelope.
- `specVersion` — LAFS spec version to stamp on the envelope.
- `schemaVersion` — JSON Schema version to stamp on the envelope.
- `timestamp` — ISO 8601 timestamp; auto-generated when omitted.
- `strict` — Whether strict schema validation should be applied.
- `mvi` — MVI level as a string, or `true` for `'minimal'` / `false` for `'standard'`.
- `contextVersion` — Context ledger version the caller is operating against.
- `sessionId` — Session identifier for multi-step workflow correlation.
- `warnings` — Non-fatal warnings to attach to the envelope metadata.

### `CreateEnvelopeSuccessInput`

Input for creating a successful LAFS envelope.

```typescript
CreateEnvelopeSuccessInput
```

**Members:**

- `success` — Discriminant marking this as a success input.
- `result` — Operation result payload (object, array, or `null`).
- `page` — Pagination metadata for collection results.
- `error` — Must be `null` for success inputs; exists for type uniformity with error inputs.
- `_extensions` — Vendor or protocol extension data.
- `meta` — Metadata input for constructing the envelope's `_meta` block.

### `CreateEnvelopeErrorInput`

Input for creating a failing LAFS envelope.

```typescript
CreateEnvelopeErrorInput
```

**Members:**

- `success` — Discriminant marking this as an error input.
- `error` — Partial error object; at minimum `code` and `message` are required.
- `result` — Optional result payload to include alongside the error. For validation tools (linters, type checkers), the actionable data (what to fix, suggested fixes) IS the result even when the operation "fails". Setting this allows agents to access both the error metadata and the detailed result in a single response.  When omitted or null, the envelope emits `result: null` (default behavior).
- `page` — Pagination metadata, if applicable even in error scenarios.
- `_extensions` — Vendor or protocol extension data.
- `meta` — Metadata input for constructing the envelope's `_meta` block.

### `CreateEnvelopeInput`

Discriminated union of success and error inputs for `createEnvelope`.

```typescript
CreateEnvelopeInput
```

### `ParseLafsResponseOptions`

Options for `parseLafsResponse`.

```typescript
ParseLafsResponseOptions
```

**Members:**

- `requireRegisteredErrorCode` — When `true`, unregistered error codes cause an additional `Error` to be thrown instead of the normal `LafsError`.

### `FieldExtractionInput`

Input flags for the field extraction layer.

```typescript
FieldExtractionInput
```

**Members:**

- `fieldFlag` — `--field <name>`: extract a single field as plain text, discarding the envelope.
- `fieldsFlag` — `--fields <a,b,c>`: filter result to these fields while preserving the envelope. Accepts a comma-separated string or an array of field names.
- `mviFlag` — `--mvi <level>`: requested envelope verbosity level (client-requestable levels only). The `'custom'` level is server-set and not valid here.

### `FieldExtractionResolution`

Resolved field extraction configuration.

```typescript
FieldExtractionResolution
```

**Members:**

- `field` — When set, extract this field as plain text, discarding the envelope.
- `fields` — When set, filter the result to these fields (envelope is preserved).
- `mvi` — Resolved MVI level. Falls back to `'minimal'` when no valid flag is provided.
- `mviSource` — Which input determined the mvi value: `'flag'` when mviFlag was valid, `'default'` otherwise.
- `expectsCustomMvi` — True when `fields` are requested, indicating the server SHOULD set `_meta.mvi = 'custom'` in the response per section 9.1. Separate from the client-resolved mvi level.

### `UnifiedFlagInput`

Combined input for both format and field extraction layers.

```typescript
UnifiedFlagInput
```

**Members:**

- `human` — Request human-readable output (`--human` flag).
- `json` — Request JSON output (`--json` flag).
- `quiet` — Suppress non-essential output for scripting (`--quiet` flag).
- `requestedFormat` — Explicit format override, taking highest precedence in the format layer.
- `projectDefault` — Project-level default format from configuration.
- `userDefault` — User-level default format from configuration.
- `tty` — TTY detection hint. When true, defaults to human format if no explicit format flag or project/user default is set. CLI tools should pass `process.stdout.isTTY ?? false`.
- `field` — Extract a single field as plain text, discarding the envelope (`--field` flag).
- `fields` — Filter result to these fields while preserving the envelope (`--fields` flag). Accepts a comma-separated string or an array of field names.
- `mvi` — Requested MVI verbosity level (`--mvi` flag).

### `UnifiedFlagResolution`

Combined resolution result with cross-layer warnings.

```typescript
UnifiedFlagResolution
```

**Members:**

- `format` — Resolved format layer from the format precedence chain.
- `fields` — Resolved field extraction layer from field/fields/mvi flags.
- `warnings` — Warnings for cross-layer interactions (non-fatal, informational only).

### `LafsA2AConfig`

Configuration for LAFS A2A integration.

```typescript
LafsA2AConfig
```

**Members:**

- `defaultBudget` — Default token budget for all operations.
- `envelopeResponses` — Whether to automatically wrap responses in LAFS envelopes.
- `protocolVersion` — A2A protocol version to use.
- `defaultExtensions` — Extension URIs to activate for all requests.

### `LafsSendMessageParams`

Request parameters for sending messages.

```typescript
LafsSendMessageParams
```

**Members:**

- `message` — Message content including role, parts, and optional metadata
- `configuration` — A2A configuration for this request.
- `budget` — Token budget override for this request.
- `extensions` — Extensions to activate for this request.
- `contextId` — Context ID for multi-turn conversations.
- `taskId` — Task ID for continuing existing task.

### `CreateTaskOptions`

Options for creating a new task

```typescript
CreateTaskOptions
```

**Members:**

- `contextId` — Context ID for grouping related tasks.
- `metadata` — Arbitrary metadata to attach to the task.
- `referenceTaskIds` — IDs of parent tasks this task refines or follows up on.
- `parallelFollowUp` — Whether this follow-up can run in parallel with its references.

### `ListTasksOptions`

Options for listing tasks

```typescript
ListTasksOptions
```

**Members:**

- `contextId` — Filter tasks by context ID.
- `state` — Filter tasks by current state.
- `limit` — Maximum number of tasks to return.
- `pageToken` — Cursor token for pagination (last seen task ID).

### `ListTasksResult`

Paginated result from listTasks

```typescript
ListTasksResult
```

**Members:**

- `tasks` — Array of tasks matching the query
- `nextPageToken` — Token for fetching the next page of results.

### `TaskStreamEvent`

Union type of task stream events emitted by the event bus.

```typescript
TaskStreamEvent
```

### `StreamIteratorOptions`

Options for the stream task events async iterator

```typescript
StreamIteratorOptions
```

**Members:**

- `timeoutMs` — Timeout in milliseconds before the iterator yields control.

### `PushNotificationDeliveryResult`

Result of delivering a push notification to a single webhook

```typescript
PushNotificationDeliveryResult
```

**Members:**

- `configId` — Identifier of the config that was dispatched to
- `ok` — Whether the delivery succeeded
- `status` — HTTP status code from the webhook response.
- `error` — Error message if delivery failed.

### `PushTransport`

Transport function for sending HTTP requests to push-notification webhooks.

```typescript
PushTransport
```

### `JsonRpcMethod`

Union of all valid JSON-RPC method string values from `JSONRPC_METHODS`

```typescript
JsonRpcMethod
```

### `A2AErrorType`

Union of A2A error type key names from `JSONRPC_A2A_ERROR_CODES`

```typescript
"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported"
```

### `JsonRpcRequest`

A JSON-RPC 2.0 request object.

```typescript
JsonRpcRequest
```

**Members:**

- `jsonrpc` — JSON-RPC protocol version, always `"2.0"`
- `id` — Client-assigned request identifier
- `method` — The RPC method name to invoke
- `params` — Named parameters for the method call.

### `JsonRpcResponse`

A JSON-RPC 2.0 success response object.

```typescript
JsonRpcResponse
```

**Members:**

- `jsonrpc` — JSON-RPC protocol version, always `"2.0"`
- `id` — Identifier matching the originating request, or `null` for notifications
- `result` — The return value of the invoked method

### `JsonRpcErrorResponse`

A JSON-RPC 2.0 error response object.

```typescript
JsonRpcErrorResponse
```

**Members:**

- `jsonrpc` — JSON-RPC protocol version, always `"2.0"`
- `id` — Identifier matching the originating request, or `null` for notifications
- `error` — Error descriptor containing code, message, and optional data

### `GrpcStatusCode`

Numeric gRPC status code value (0-16)

```typescript
GrpcStatusCode
```

### `GrpcStatusName`

String name of a gRPC status code (e.g. `"OK"`, `"NOT_FOUND"`)

```typescript
"NOT_FOUND" | "INTERNAL" | "INVALID_ARGUMENT" | "ABORTED" | "RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "FAILED_PRECONDITION" | "OK" | "CANCELLED" | "UNKNOWN" | "DEADLINE_EXCEEDED" | "ALREADY_EXISTS" | "PERMISSION_DENIED" | "OUT_OF_RANGE" | "UNIMPLEMENTED" | "DATA_LOSS" | "UNAUTHENTICATED"
```

### `GrpcServiceMethod`

Descriptor for a single gRPC service method.

```typescript
GrpcServiceMethod
```

**Members:**

- `request` — Protobuf request message type name
- `response` — Protobuf response message type name
- `streaming` — Whether the method uses server-side streaming

### `GrpcStatus`

gRPC Status object for A2A errors.

```typescript
GrpcStatus
```

**Members:**

- `code` — Numeric gRPC status code
- `message` — Human-readable error message
- `details` — Structured error details (typically `google.rpc.ErrorInfo` entries).

### `GrpcErrorInfo`

Equivalent of `google.rpc.ErrorInfo` for structured gRPC error details.

```typescript
GrpcErrorInfo
```

**Members:**

- `reason` — UPPER_SNAKE_CASE reason string identifying the error
- `domain` — Error domain (e.g. `"a2a-protocol.org"`)
- `metadata` — Additional key-value metadata for the error.

### `HttpEndpoint`

Union of all HTTP endpoint descriptor objects from `HTTP_ENDPOINTS`

```typescript
HttpEndpoint
```

### `ProblemDetails`

RFC 9457 Problem Details object.

```typescript
ProblemDetails
```

**Members:**

- `type` — URI reference identifying the problem type
- `title` — Short human-readable summary of the problem
- `status` — HTTP status code for this occurrence
- `detail` — Human-readable explanation specific to this occurrence

### `ListTasksQueryParams`

Parsed query parameters for the ListTasks endpoint.

```typescript
ListTasksQueryParams
```

**Members:**

- `contextId` — Filter tasks by context identifier.
- `state` — Filter tasks by state (e.g. `"submitted"`, `"working"`).
- `limit` — Maximum number of tasks to return.
- `pageToken` — Pagination token from a previous response.

### `ErrorCodeMapping`

Complete error code mapping across all three transports.

```typescript
ErrorCodeMapping
```

**Members:**

- `jsonRpcCode` — JSON-RPC numeric error code (e.g. `-32001`)
- `httpStatus` — HTTP response status code (e.g. `404`)
- `httpTypeUri` — RFC 9457 Problem Details type URI
- `grpcStatus` — gRPC status name (e.g. `"NOT_FOUND"`)
- `grpcCode` — gRPC numeric status code (e.g. `5`)

### `CircuitState`

Represents the three possible states of a circuit breaker.

```typescript
CircuitState
```

### `CircuitBreakerConfig`

Configuration options for a `CircuitBreaker` instance.

```typescript
CircuitBreakerConfig
```

**Members:**

- `name` — Unique identifier for this circuit breaker, used in log messages and metrics.
- `failureThreshold` — Number of failures required to trip the circuit from CLOSED to OPEN.
- `resetTimeout` — Milliseconds to wait before transitioning from OPEN to HALF_OPEN.
- `halfOpenMaxCalls` — Maximum number of trial calls allowed while in the HALF_OPEN state.
- `successThreshold` — Consecutive successes required in HALF_OPEN to close the circuit.

### `CircuitBreakerMetrics`

Snapshot of runtime metrics for a `CircuitBreaker`.

```typescript
CircuitBreakerMetrics
```

**Members:**

- `state` — Current state of the circuit breaker.
- `failures` — Total number of recorded failures since the last reset.
- `successes` — Total number of recorded successes since the last reset.
- `lastFailureTime` — Timestamp of the most recent failure, if any.
- `consecutiveSuccesses` — Number of consecutive successes since the last failure.
- `totalCalls` — Total number of calls made through this circuit breaker.

### `HealthCheckConfig`

Configuration for the `healthCheck` middleware.

```typescript
HealthCheckConfig
```

**Members:**

- `path` — URL path at which the health endpoint is mounted.
- `checks` — Array of custom health check functions to run on each request.

### `HealthCheckFunction`

A function that performs a single health check.

```typescript
HealthCheckFunction
```

### `HealthCheckResult`

Result of an individual health check.

```typescript
HealthCheckResult
```

**Members:**

- `name` — Human-readable name identifying this check.
- `status` — Outcome status of the check.
- `message` — Optional descriptive message providing additional detail.
- `duration` — Execution duration of the check in milliseconds.

### `HealthStatus`

Aggregated health status returned by the health endpoint.

```typescript
HealthStatus
```

**Members:**

- `status` — Overall service health derived from individual check results.
- `timestamp` — ISO-8601 timestamp of when the health check was performed.
- `version` — LAFS package version.
- `uptime` — Server uptime in seconds since the middleware was initialised.
- `checks` — Individual check results.

### `LafsProblemDetails`

RFC 9457 Problem Details with LAFS extensions.

```typescript
LafsProblemDetails
```

**Members:**

- `type` — URI reference identifying the problem type
- `title` — Short human-readable summary (typically the error code)
- `status` — HTTP status code for this error
- `detail` — Human-readable explanation of the specific occurrence
- `instance` — URI reference identifying the specific occurrence (typically the request ID).
- `retryable` — Whether the operation that caused this error can be retried
- `agentAction` — Recommended agent action (e.g., `"retry"`, `"escalate"`).
- `retryAfterMs` — Suggested delay in milliseconds before retrying.
- `escalationRequired` — Whether the error requires human escalation.
- `suggestedAction` — Human-readable suggestion for resolving the error.
- `docUrl` — Documentation URL for more information.

```typescript
const pd: LafsProblemDetails = {
  type: "https://lafs.dev/errors/v1/E_VALIDATION",
  title: "E_VALIDATION",
  status: 400,
  detail: "Invalid input",
  retryable: false,
};
```

### `GracefulShutdownConfig`

Configuration for the `gracefulShutdown` handler.

```typescript
GracefulShutdownConfig
```

**Members:**

- `timeout` — Maximum time in milliseconds to wait for in-flight requests before forcing exit.
- `signals` — POSIX signals that trigger a graceful shutdown.
- `onShutdown` — Callback invoked at the start of shutdown, before the server stops accepting connections.
- `onClose` — Callback invoked after all connections have closed (or the timeout elapsed).

### `ShutdownState`

Snapshot of the current shutdown state.

```typescript
ShutdownState
```

**Members:**

- `isShuttingDown` — Whether a shutdown sequence is currently in progress.
- `activeConnections` — Number of TCP connections still open.
- `shutdownStartTime` — Timestamp when the shutdown sequence began.

## Classes

### `TokenEstimator`

Character-based token estimator for JSON payloads.

```typescript
typeof TokenEstimator
```

**Members:**

- `options` — Resolved configuration with defaults applied
- `estimate` — Estimate tokens for any JavaScript value. Handles circular references, nested objects, arrays, and Unicode.
- `estimateJSON` — Estimate tokens from a JSON string. More efficient if you already have the JSON string.
- `estimateWithTracking` — Internal recursive estimation with circular reference tracking.
- `estimateArray` — Estimate tokens for an array.
- `estimateObject` — Estimate tokens for a plain object.
- `canSerialize` — Check if a value can be safely serialized (no circular refs).
- `safeStringify` — Serialize a value to JSON with circular reference handling.
- `safeCopy` — Create a deep copy of a value with circular refs replaced by `"[Circular]"`.

```typescript
const estimator = new TokenEstimator({ charsPerToken: 4 });
const tokens = estimator.estimate({ name: "hello", items: [1, 2, 3] });
```

### `LAFSFlagError`

Error thrown when LAFS flag validation fails.

```typescript
typeof LAFSFlagError
```

**Members:**

- `code` — The LAFS error code (e.g. `'E_FORMAT_CONFLICT'`).
- `category` — The error category resolved from the error registry.
- `retryable` — Whether the operation that produced this error can be retried.
- `retryAfterMs` — Milliseconds to wait before retrying, or `null` if not applicable.
- `details` — Additional structured details about the error.

### `ComplianceError`

Error thrown when `assertCompliance` or `withCompliance` detects failures.

```typescript
typeof ComplianceError
```

**Members:**

- `issues` — The structured list of compliance issues that caused this error.

```ts
try {
  assertCompliance(envelope);
} catch (err) {
  if (err instanceof ComplianceError) {
    console.log(err.issues);
  }
}
```

### `ExtensionSupportRequiredError`

Error thrown when required A2A extensions are not supported by the client.

```typescript
typeof ExtensionSupportRequiredError
```

**Members:**

- `code` — JSON-RPC error code for extension support required
- `httpStatus` — HTTP status code returned for this error
- `grpcStatus` — gRPC status code equivalent
- `missingExtensions` — URIs of the required extensions that the client did not provide
- `toJSONRPCError` — Convert to JSON-RPC error object.
- `toProblemDetails` — Convert to RFC 9457 Problem Details object with agent-actionable fields.
- `toLafsError` — Convert to a LAFSError-compatible object.

### `LafsError`

Error subclass that carries the full `LAFSError` payload.

```typescript
typeof LafsError
```

**Members:**

- `code` — Stable, machine-readable error code.
- `category` — High-level classification of the error.
- `retryable` — Whether the operation can be retried without modification.
- `retryAfterMs` — Suggested delay in milliseconds before retrying, or `null` if not applicable.
- `details` — Arbitrary key-value pairs with additional context about the error.
- `registered` — Whether this error code exists in the canonical error registry.
- `agentAction` — Recommended action for the consuming agent.
- `escalationRequired` — Whether the error requires human or higher-privilege intervention.
- `suggestedAction` — Free-text description of a suggested recovery action.
- `docUrl` — URL pointing to documentation about this error code.

```ts
try {
  parseLafsResponse(envelope);
} catch (err) {
  if (err instanceof LafsError) {
    console.log(err.code, err.agentAction);
  }
}
```

### `LafsA2AResult`

Wrapper for A2A responses with LAFS envelope support.

```typescript
typeof LafsA2AResult
```

**Members:**

- `getA2AResult` — Get the raw A2A response.
- `isError` — Check if the result is an error response.
- `getError` — Get error details if the result is an error.
- `getSuccess` — Get the success result.
- `getTask` — Extract a Task from the response (if present).
- `getMessage` — Extract a Message from the response (if present).
- `hasLafsEnvelope` — Check if the response contains a LAFS envelope.
- `getLafsEnvelope` — Extract a LAFS envelope from A2A artifact.
- `getTokenEstimate` — Get token estimate from LAFS envelope.
- `getTaskStatus` — Get the task status.
- `getTaskState` — Get the task state.
- `isTerminal` — Check if the task is in a terminal state.
- `isInputRequired` — Check if the task requires user input.
- `isAuthRequired` — Check if the task requires authentication.
- `getArtifacts` — Get all artifacts from the task.
- `isDataPart` — Type guard: checks whether a Part is a DataPart by inspecting its `kind` field.
- `isLafsEnvelope` — Heuristic check: returns true if the data object looks like a LAFS envelope (has `$schema`, `_meta`, `success`).

### `InvalidStateTransitionError`

Thrown when attempting an invalid state transition.

```typescript
typeof InvalidStateTransitionError
```

**Members:**

- `taskId` — ID of the task that failed the transition
- `fromState` — State the task was in when the transition was attempted
- `toState` — State the task was being transitioned to

### `TaskImmutabilityError`

Thrown when attempting to modify a task in a terminal state.

```typescript
typeof TaskImmutabilityError
```

**Members:**

- `taskId` — ID of the task that cannot be modified
- `terminalState` — Terminal state the task is in

### `TaskNotFoundError`

Thrown when a task is not found.

```typescript
typeof TaskNotFoundError
```

**Members:**

- `taskId` — ID of the task that was not found

### `TaskRefinementError`

Thrown when a refinement/follow-up task references invalid parent tasks.

```typescript
typeof TaskRefinementError
```

**Members:**

- `referenceTaskIds` — IDs of the referenced tasks that caused the error

### `TaskManager`

In-memory task manager implementing A2A task lifecycle.

```typescript
typeof TaskManager
```

**Members:**

- `tasks` — Map of task ID to Task object
- `contextIndex` — Index mapping context ID to set of task IDs
- `createTask` — Create a new task in the submitted state.
- `createRefinedTask` — Create a refinement/follow-up task referencing existing task(s).
- `getTask` — Get a task by ID.
- `listTasks` — List tasks with optional filtering and pagination.
- `updateTaskStatus` — Update task status. Enforces valid transitions and terminal state immutability.
- `addArtifact` — Add an artifact to a task.
- `addHistory` — Add a message to task history.
- `cancelTask` — Cancel a task by transitioning to canceled state.
- `getTasksByContext` — Get all tasks in a given context.
- `isTerminal` — Check if a task is in a terminal state.
- `resolveContextForReferenceTasks` — Derive a contextId from the first referenced task, if any reference tasks are provided.
- `validateReferenceTasks` — Validate that all referenced tasks exist and share the same contextId.

### `TaskEventBus`

In-memory event bus for task lifecycle streaming events.

```typescript
typeof TaskEventBus
```

**Members:**

- `history` — Map of task ID to ordered event history
- `listeners` — Map of task ID to active listener callbacks
- `publishStatusUpdate` — Publish a task status update event.
- `publishArtifactUpdate` — Publish a task artifact update event.
- `publish` — Publish a task stream event to all listeners and history.
- `subscribe` — Subscribe to events for a specific task.
- `getHistory` — Get the full event history for a task.

### `PushNotificationConfigStore`

In-memory manager for async push-notification configs.

```typescript
typeof PushNotificationConfigStore
```

**Members:**

- `configs` — Nested map of task ID to config ID to push notification config
- `set` — Store a push-notification config for a task.
- `get` — Retrieve a push-notification config by task and config ID.
- `list` — List all push-notification configs for a task.
- `delete` — Delete a push-notification config.

### `PushNotificationDispatcher`

Deliver task updates to registered push-notification webhooks.

```typescript
typeof PushNotificationDispatcher
```

**Members:**

- `dispatch` — Dispatch a task event to all registered webhooks for the task.
- `buildHeaders` — Build HTTP headers for push notification delivery including auth tokens.

### `TaskArtifactAssembler`

Applies append/lastChunk artifact deltas into task-local snapshots.

```typescript
typeof TaskArtifactAssembler
```

**Members:**

- `artifacts` — Map of task ID to map of artifact ID to assembled artifact snapshot
- `applyUpdate` — Apply an artifact update event to the assembled snapshot.
- `get` — Get a specific assembled artifact by task and artifact ID.
- `list` — List all assembled artifacts for a task.
- `mergeArtifact` — Merge a new artifact update event into an existing artifact snapshot, handling append semantics.
- `withLastChunk` — Inject the `a2a:last_chunk` marker into artifact metadata.

### `CircuitBreakerError`

Error thrown when a circuit breaker rejects a call.

```typescript
typeof CircuitBreakerError
```

```typescript
try {
  await breaker.execute(() => fetch('/api'));
} catch (err) {
  if (err instanceof CircuitBreakerError) {
    console.log('Circuit open, using fallback');
  }
}
```

### `CircuitBreaker`

Circuit breaker for protecting against cascading failures.

```typescript
typeof CircuitBreaker
```

**Members:**

- `state` — Current circuit state.
- `failures` — Total failure count since last reset.
- `successes` — Total success count since last reset.
- `lastFailureTime` — Timestamp of the most recent failure.
- `consecutiveSuccesses` — Consecutive successes since the last failure.
- `totalCalls` — Lifetime call count.
- `halfOpenCalls` — Number of calls made while in the HALF_OPEN state.
- `resetTimer` — Timer handle for the scheduled OPEN-to-HALF_OPEN transition.
- `execute` — Execute a function with circuit breaker protection.
- `getState` — Get the current circuit breaker state.
- `getMetrics` — Get a snapshot of the circuit breaker's runtime metrics.
- `forceOpen` — Manually open the circuit breaker, rejecting all subsequent calls.
- `forceClose` — Manually close the circuit breaker and reset all counters.
- `onSuccess` — Records a successful call and may transition from HALF_OPEN to CLOSED.
- `onFailure` — Records a failed call and may trip the circuit to OPEN.
- `transitionTo` — Transitions the circuit to the given state, resetting HALF_OPEN call count when entering HALF_OPEN.
- `shouldAttemptReset` — Returns `true` if enough time has elapsed since the last failure to attempt a reset.
- `scheduleReset` — Schedules a timer to transition from OPEN to HALF_OPEN after the configured reset timeout.
- `reset` — Resets all failure/success counters and clears the pending reset timer.

```typescript
import { CircuitBreaker } from '@cleocode/lafs/circuit-breaker';

const breaker = new CircuitBreaker({
  name: 'external-api',
  failureThreshold: 5,
  resetTimeout: 30000
});

try {
  const result = await breaker.execute(async () => {
    return await externalApi.call();
  });
} catch (error) {
  if (error instanceof CircuitBreakerError) {
    console.log('Circuit breaker is open');
  }
}
```

### `CircuitBreakerRegistry`

Registry for managing multiple named circuit breakers.

```typescript
typeof CircuitBreakerRegistry
```

**Members:**

- `breakers` — Internal map of circuit breaker name to instance.
- `add` — Register a new circuit breaker with the given name and configuration.
- `get` — Retrieve a circuit breaker by name.
- `getOrCreate` — Retrieve an existing circuit breaker or create one if it does not exist.
- `getAllMetrics` — Collect metrics from all registered circuit breakers.
- `resetAll` — Force-close all registered circuit breakers, resetting their counters.

```typescript
const registry = new CircuitBreakerRegistry();

registry.add('payment-api', {
  failureThreshold: 3,
  resetTimeout: 60000
});

const paymentBreaker = registry.get('payment-api');
```

## Constants

### `defaultEstimator`

Global token estimator instance with default settings.

```typescript
TokenEstimator
```

### `MVI_LEVELS`

Immutable set of all valid `MVILevel` values.

```typescript
ReadonlySet<MVILevel>
```

```ts
if (MVI_LEVELS.has(input)) {
  // input is a valid MVILevel
}
```

### `AGENT_ACTIONS`

Immutable set of all valid `LAFSAgentAction` values.

```typescript
ReadonlySet<LAFSAgentAction>
```

```ts
if (AGENT_ACTIONS.has(action)) {
  // action is a valid LAFSAgentAction
}
```

### `LAFS_EXTENSION_URI`

Canonical LAFS extension URI

```typescript
"https://lafs.dev/extensions/envelope/v1"
```

### `A2A_EXTENSIONS_HEADER`

Canonical A2A Extensions header per spec Section 3.2.6

```typescript
"A2A-Extensions"
```

### `LAFS_SCHEMA_URL`

Canonical JSON Schema URL for the LAFS v1 envelope.

```typescript
"https://lafs.dev/schemas/v1/envelope.schema.json"
```

```ts
import { LAFS_SCHEMA_URL } from '@cleocode/lafs';
console.log(LAFS_SCHEMA_URL);
// => 'https://lafs.dev/schemas/v1/envelope.schema.json'
```

### `CATEGORY_ACTION_MAP`

Default agent action for each error category.

```typescript
Record<LAFSErrorCategory, LAFSAgentAction>
```

```ts
import { CATEGORY_ACTION_MAP } from '@cleocode/lafs';
const action = CATEGORY_ACTION_MAP['RATE_LIMIT']; // => 'wait'
```

### `TERMINAL_STATES`

States from which no further transitions are possible

```typescript
ReadonlySet<TaskState>
```

### `INTERRUPTED_STATES`

States where the task is paused awaiting external input

```typescript
ReadonlySet<TaskState>
```

### `VALID_TRANSITIONS`

Valid state transitions (adjacency map). Terminal states have empty outgoing sets.

```typescript
ReadonlyMap<TaskState, ReadonlySet<TaskState>>
```

### `JSONRPC_METHODS`

All JSON-RPC method names defined by the A2A protocol.

```typescript
{ readonly SendMessage: "message/send"; readonly SendStreamingMessage: "message/stream"; readonly GetTask: "tasks/get"; readonly ListTasks: "tasks/list"; readonly CancelTask: "tasks/cancel"; readonly SubscribeToTask: "tasks/resubscribe"; readonly SetTaskPushNotificationConfig: "tasks/pushNotificationConfig/set"; readonly GetTaskPushNotificationConfig: "tasks/pushNotificationConfig/get"; readonly ListTaskPushNotificationConfig: "tasks/pushNotificationConfig/list"; readonly DeleteTaskPushNotificationConfig: "tasks/pushNotificationConfig/delete"; readonly GetExtendedAgentCard: "agent/getAuthenticatedExtendedCard"; }
```

### `JSONRPC_STANDARD_ERROR_CODES`

Standard JSON-RPC 2.0 error codes.

```typescript
{ readonly ParseError: -32700; readonly InvalidRequest: -32600; readonly MethodNotFound: -32601; readonly InvalidParams: -32602; readonly InternalError: -32603; }
```

### `JSONRPC_A2A_ERROR_CODES`

A2A-specific error codes (-32001 through -32009).

```typescript
{ readonly TaskNotFound: -32001; readonly TaskNotCancelable: -32002; readonly PushNotificationNotSupported: -32003; readonly UnsupportedOperation: -32004; readonly ContentTypeNotSupported: -32005; readonly InvalidAgentResponse: -32006; readonly AuthenticatedExtendedCardNotConfigured: -32007; readonly ExtensionSupportRequired: -32008; readonly VersionNotSupported: -32009; }
```

### `GRPC_STATUS_CODE`

Standard gRPC status codes (numeric values 0-16).

```typescript
{ readonly OK: 0; readonly CANCELLED: 1; readonly UNKNOWN: 2; readonly INVALID_ARGUMENT: 3; readonly DEADLINE_EXCEEDED: 4; readonly NOT_FOUND: 5; readonly ALREADY_EXISTS: 6; readonly PERMISSION_DENIED: 7; readonly RESOURCE_EXHAUSTED: 8; readonly FAILED_PRECONDITION: 9; readonly ABORTED: 10; readonly OUT_OF_RANGE: 11; readonly UNIMPLEMENTED: 12; readonly INTERNAL: 13; readonly UNAVAILABLE: 14; readonly DATA_LOSS: 15; readonly UNAUTHENTICATED: 16; }
```

### `A2A_GRPC_STATUS_CODES`

Maps A2A error types to gRPC status names.

```typescript
Record<"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported", "NOT_FOUND" | "INTERNAL" | "INVALID_ARGUMENT" | "ABORTED" | "RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "FAILED_PRECONDITION" | "OK" | "CANCELLED" | "UNKNOWN" | "DEADLINE_EXCEEDED" | "ALREADY_EXISTS" | "PERMISSION_DENIED" | "OUT_OF_RANGE" | "UNIMPLEMENTED" | "DATA_LOSS" | "UNAUTHENTICATED">
```

### `A2A_GRPC_ERROR_REASONS`

UPPER_SNAKE_CASE error reasons without "Error" suffix.

```typescript
Record<"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported", string>
```

### `A2A_GRPC_ERROR_DOMAIN`

Error domain for A2A gRPC errors.

```typescript
"a2a-protocol.org"
```

### `GRPC_SERVICE_METHODS`

gRPC service method definitions for the A2A protocol.

```typescript
Record<string, GrpcServiceMethod>
```

### `GRPC_METADATA_VERSION_KEY`

gRPC metadata key for A2A protocol version.

```typescript
"a2a-version"
```

### `GRPC_METADATA_EXTENSIONS_KEY`

gRPC metadata key for activated A2A extensions.

```typescript
"a2a-extensions"
```

### `HTTP_ENDPOINTS`

HTTP+JSON endpoint definitions for each A2A operation.

```typescript
{ readonly SendMessage: { readonly method: "POST"; readonly path: "/message:send"; }; readonly SendStreamingMessage: { readonly method: "POST"; readonly path: "/message:stream"; }; readonly GetTask: { readonly method: "GET"; readonly path: "/tasks/:id"; }; readonly ListTasks: { readonly method: "GET"; readonly path: "/tasks"; }; readonly CancelTask: { readonly method: "POST"; readonly path: "/tasks/:id:cancel"; }; readonly SubscribeToTask: { readonly method: "GET"; readonly path: "/tasks/:id:subscribe"; }; readonly SetTaskPushNotificationConfig: { readonly method: "POST"; readonly path: "/tasks/:id/pushNotificationConfig"; }; readonly GetTaskPushNotificationConfig: { readonly method: "GET"; readonly path: "/tasks/:id/pushNotificationConfig"; }; readonly ListTaskPushNotificationConfig: { readonly method: "GET"; readonly path: "/tasks/:id/pushNotificationConfig:list"; }; readonly DeleteTaskPushNotificationConfig: { readonly method: "DELETE"; readonly path: "/tasks/:id/pushNotificationConfig/:configId"; }; readonly GetExtendedAgentCard: { readonly method: "GET"; readonly path: "/agent/authenticatedExtendedCard"; }; }
```

### `A2A_HTTP_STATUS_CODES`

Maps A2A error types to HTTP status codes.

```typescript
Record<"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported", number>
```

### `A2A_ERROR_TYPE_URIS`

RFC 9457 Problem Details type URIs for A2A errors.

```typescript
Record<"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported", string>
```

### `A2A_ERROR_MAPPINGS`

Precomputed cross-binding error mapping for all 9 A2A error types.

```typescript
ReadonlyMap<"TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "AuthenticatedExtendedCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported", ErrorCodeMapping>
```

### `SUPPORTED_A2A_VERSIONS`

Supported A2A protocol versions.

```typescript
readonly ["1.0"]
```

### `DEFAULT_A2A_VERSION`

Default A2A protocol version used when none is requested.

```typescript
"1.0"
```

### `PROBLEM_DETAILS_CONTENT_TYPE`

Content-Type for RFC 9457 Problem Details responses.

```typescript
"application/problem+json"
```

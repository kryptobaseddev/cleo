# Changelog

All notable changes to the LAFS Protocol will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2026.4.0] - 2026-04-03

### Changed

- **CalVer adoption**: Package version switched from SemVer (1.x) to CalVer (YYYY.M.P) to align with the `@cleocode` monorepo versioning convention. The protocol spec version inside envelopes (`_meta.specVersion`) remains `1.0.0` per the LAFS versioning policy.
- **Repository consolidation**: LAFS now lives at `packages/lafs` inside the `kryptobaseddev/cleo` monorepo (previously standalone at `kryptobaseddev/lafs`).

## [1.8.0] - 2026-03-19

### Changed

- **Error envelopes may now include `result`**: When `success: false`, the `result` field is no longer forced to `null`. Validation tools (linters, type checkers) can return actionable data (e.g., `suggestedFix`, per-file error breakdowns) alongside error metadata. The `error` field is still required on failure. This change updates `CreateEnvelopeErrorInput`, `createEnvelope()`, the JSON schema, and the `envelope_invariants` conformance check.

### Added

- **TTY-aware format default**: New `tty` field on `FlagInput` and `UnifiedFlagInput`. When `true` and no explicit format flag or project/user default is set, the resolved format defaults to `"human"` instead of `"json"`. CLI tools should pass `process.stdout.isTTY ?? false`. Non-TTY environments (piped, CI, agents) continue to default to JSON per the LAFS protocol.

## [1.7.0] - 2026-03-15

### Added

- **MVI projection engine** (`src/mviProjection.ts`): `projectEnvelope()` strips envelope fields based on MVI level, achieving 73-75% token reduction at `minimal`. `estimateProjectedTokens()` provides token cost estimates for projected envelopes.
- **`agentAction` field** on `LAFSError`: machine-readable instruction for agent control flow with 7 values (`retry`, `retry_modified`, `escalate`, `stop`, `wait`, `refresh_context`, `authenticate`). Auto-populated from error registry or category fallback via `CATEGORY_ACTION_MAP`.
- **`escalationRequired` field** on `LAFSError`: boolean signal for whether human/owner intervention is required (inspired by Cloudflare's `owner_action_required`).
- **`suggestedAction` field** on `LAFSError`: brief actionable recovery instruction for agents.
- **`docUrl` field** on `LAFSError`: documentation URL for self-learning agents (Stripe/GitHub pattern).
- **Core RFC 9457 Problem Details bridge** (`src/problemDetails.ts`): `lafsErrorToProblemDetails()` converts any `LAFSError` to RFC 9457-compliant `LafsProblemDetails` with LAFS extension members. `PROBLEM_DETAILS_CONTENT_TYPE` constant. Available for all transports, not just A2A HTTP.
- **`createLafsProblemDetails()`** (`src/a2a/bindings/http.ts`): bridges A2A error types with `LAFSError` data including `instance`, `retryable`, `agentAction`, `escalationRequired`, `docUrl`.
- **Structured validation errors** (`src/validateEnvelope.ts`): `StructuredValidationError` interface with `path`, `keyword`, `message`, `params` from AJV. `structuredErrors` field on `EnvelopeValidationResult` replaces flat string parsing.
- **Error registry enrichment** (`schemas/v1/error-registry.json`): all 13 error codes now include `agentAction`, `typeUri` (RFC 9457-style stable URI), and `docUrl` fields.
- **Registry accessor functions** (`src/errorRegistry.ts`): `getAgentAction()`, `getTypeUri()`, `getDocUrl()`.
- **Conformance checks**: `agent_action_valid` (validates agentAction enum) and `error_registry_agent_action` (advisory check against registry default) added to standard and complete tiers.
- **`toLafsError()`** on `ExtensionSupportRequiredError` (`src/a2a/extensions.ts`): returns proper `LAFSError` for envelope integration.
- **New fixtures**: `valid-error-minimal.json` (MVI minimal projection output), `valid-error-actionable.json` (rate limit with agentAction), `valid-error-escalation.json` (internal error with escalation).
- **Architecture Decision Record**: `docs/architecture/ADR-001-RFC9457-ERROR-OPTIMIZATION.md` documenting the design rationale, gap analysis, and verified token savings.
- **RFC design document**: `docs/architecture/RFC-ERROR-OPTIMIZATION.md` with full technical specification.
- **60 new tests** across 4 test files: `mviProjection.test.ts` (28), `problemDetails.test.ts` (16), `agentAction.test.ts` (13), `structuredValidation.test.ts` (7), plus 1 assertion in `extensions.test.ts`.

### Changed

- **`normalizeError()`** (`src/envelope.ts`): now registry-driven. Auto-populates `category`, `retryable`, `agentAction`, and `docUrl` from error registry when callers provide only `code` and `message`. Exported `CATEGORY_ACTION_MAP` maps all 10 error categories to default agent actions.
- **`LafsError` class** (`src/envelope.ts`): carries new optional fields (`agentAction`, `escalationRequired`, `suggestedAction`, `docUrl`).
- **`toProblemDetails()`** on `ExtensionSupportRequiredError`: now returns typed output with `agentAction: 'retry_modified'`.
- **`Content-Type` header**: extension negotiation middleware now sets `application/problem+json` on error responses (was defaulting to `application/json`).
- **Envelope schema** (`schemas/v1/envelope.schema.json`): error object `additionalProperties` changed from `false` to `true` per RFC 9457 extension member philosophy. Added `agentAction` (enum), `escalationRequired` (boolean), `suggestedAction` (string, maxLength 512), `docUrl` (URI) as optional properties.

### Specification

- **§7.3 Agent action semantics** (`lafs.md`): new section defining `agentAction` field with RFC 2119 language, including subsections for `escalationRequired` (§7.3.1), `suggestedAction` (§7.3.2), and `docUrl` (§7.3.3).
- **§9.1 MVI default** (`lafs.md`): amended to extend MVI governance beyond `result` to `_meta` and `error` fields. Added §9.1.1 (MVI field inclusion for `_meta`), §9.1.2 (MVI field inclusion for `error`), §9.1.3 (MVI field inclusion for envelope structure).

### Statistics

- 416 total tests passing (60 new)
- 13 error codes in registry (all enriched with agentAction, typeUri, docUrl)
- Verified token savings: 73-75% reduction at MVI minimal

## [1.6.0] - 2026-02-27

### Added

- **Unified flag resolver** (`src/flagResolver.ts`): `resolveFlags()` composes format resolution (§5.1-5.3) with field extraction resolution (§9.2) and validates cross-layer interactions per §5.4.
  - `UnifiedFlagInput` — combined input for format and field extraction layers
  - `UnifiedFlagResolution` — combined result with cross-layer warnings
  - Cross-layer validation: `--human + --field` and `--human + --fields` combinations produce warnings per §5.4.1 (filter-then-render semantics)
- **15 new tests** in `tests/flag-resolver.test.ts` covering all flag combinations, conflicts, and MVI interaction

### Specification

- **§5.4 Cross-layer flag semantics** (`lafs.md`): new section defining filter-then-render semantics for cross-layer flag combinations (`--human + --field`, `--human + --fields`)

### Statistics

- 352 total tests passing (15 new)

## [1.5.0] - 2026-02-26

### Added

- **Field extraction utilities** (`src/fieldExtraction.ts`): runtime SDK support for spec-defined `_fields` (§9.2) and `_mvi` (§9.1) features:
  - `resolveFieldExtraction()` — resolves `--field`, `--fields`, and `--mvi` CLI flags with conflict detection
  - `extractFieldFromResult()` / `extractFieldFromEnvelope()` — single-field extraction across four result shapes (flat, wrapper-entity, wrapper-array, direct array)
  - `applyFieldFilter()` — multi-field projection that preserves envelope structure and sets `_meta.mvi = 'custom'` per §9.1
  - `FieldExtractionInput`, `FieldExtractionResolution` — supporting types
- **`MVI_LEVELS` constant** (`src/types.ts`): `ReadonlySet<MVILevel>` for CLI completion generators, validation schemas, and docs tools
- **`isMVILevel()` type guard** (`src/types.ts`): runtime type narrowing for `MVILevel` values
- **`E_FIELD_CONFLICT` error code** (`schemas/v1/error-registry.json`): for mutually exclusive `--field` + `--fields` flag combinations (category: `CONTRACT`, HTTP 400, gRPC `INVALID_ARGUMENT`, CLI exit 2)
- **Test fixtures**: `fixtures/field-extraction-success.json` (flat result) and `fixtures/field-extraction-array.json` (direct array result)
- **44 new tests** in `tests/fieldExtraction.test.ts` covering all functions, edge cases, and integration flow
- **Migration note** (`migrations/1.4.1-to-1.5.0.md`): documents `_meta` always-present clarification and new exports

### Changed

- **`LAFSFlagError`** (`src/flagSemantics.ts`): now implements `LAFSError` interface with `category`, `retryable`, `retryAfterMs`, and `details` properties resolved from the error registry. Constructor accepts optional third `details` parameter (backwards compatible)
- **Conformance MVI check** (`src/conformance.ts`): replaced hardcoded `validMviLevels` array with `isMVILevel()` type guard (check name `meta_mvi_present` unchanged)

### Specification

- **§9.1 MVI default** (`lafs.md`): added behavioral definitions for each MVI level (`minimal`, `standard`, `full`, `custom`), clarified that `_meta` is a structural envelope field that MUST always be present regardless of MVI level, and that `custom` is server-set only (not client-requestable)
- **§9.2 Field selection** (`lafs.md`): expanded to document wrapper-entity and wrapper-array result shapes, path notation exclusion, array-element projection, and automatic `_meta.mvi = 'custom'` when `_fields` is present

### Statistics

- 337 total tests passing (44 new)
- 13 error codes in registry (1 new)

## [1.4.1] - 2026-02-25

### Added

- A2A bridge alignment test coverage in `tests/a2aBridge.test.ts` for upstream constants, LAFS artifact envelope extraction, extension requirement checks, and text artifact generation
- A2A streaming completion APIs in `src/a2a/streaming.ts`:
  - `PushNotificationDispatcher` for async webhook fan-out from `PushNotificationConfigStore`
  - `TaskArtifactAssembler` for artifact delta merge semantics (`append` + `lastChunk`)

### Changed

- Updated `src/a2a/bridge.ts` to import `AGENT_CARD_PATH` and `HTTP_EXTENSION_HEADER` as runtime values from `@a2a-js/sdk`
- Expanded streaming exports through `src/a2a/index.ts` and `src/index.ts` for dispatcher/assembler APIs
- Expanded `tests/streamingAsync.test.ts` to cover webhook dispatch delivery and artifact append/final-chunk behavior

### Documentation

- Rewrote `docs/programmatic-construction.md` with comprehensive from-scratch construction guidance: factory parameter breakdown, field constraint tables from the JSON schema, success and error envelope patterns, paginated results (cursor and offset modes), session-correlated messages, versioning fields, MVI levels, construction error handling, and schema import patterns for external validators

## [1.4.0] - 2026-02-24

### Added

- First-class compliance pipeline APIs in core SDK (`src/compliance.ts`): `enforceCompliance`, `assertCompliance`, `withCompliance`, `createComplianceMiddleware`, and `ComplianceError`
- Envelope-first APIs in core SDK (`src/envelope.ts`): `createEnvelope`, `parseLafsResponse`, `LafsError`, and `LAFS_SCHEMA_URL`
- Package schema subpath exports in `package.json` for machine tooling and LLM agent workflows:
  - `@cleocode/lafs/schemas/v1/envelope.schema.json`
  - `@cleocode/lafs/schemas/v1/error-registry.json`
  - `@cleocode/lafs/schemas/v1/context-ledger.schema.json`
  - `@cleocode/lafs/schemas/v1/discovery.schema.json`
- New SDK tests:
  - `tests/envelopeApi.test.ts`
  - `tests/compliance.test.ts`

### Changed

- Python envelope semantics aligned closer to canonical schema and TypeScript behavior (`python/lafs/envelope.py`):
  - `mvi` now uses enum strings (`minimal|standard|full|custom`) with legacy bool normalization
  - `_meta` validation now enforces required schema fields and value constraints
  - error object validation now enforces required shape
  - strict mode now rejects unknown top-level fields
  - pagination validation now enforces mode-conditional required fields
  - envelope serialization always includes `result`
- Python package version now derives from root `package.json` (single source of truth) via `python/setup.py`
- Python classifier matrix updated to include Python `3.13` and `3.14`

### Documentation

- Added and/or updated LLM-agent-first docs with code-true examples:
  - `docs/guides/compliance-pipeline.md`
  - `docs/guides/schema-extension.md`
  - `docs/guides/llm-agent-guide.md`
  - `docs/sdk/typescript.md`
  - `docs/getting-started/quickstart.md`
  - `docs/CONFORMANCE.md`
  - `docs/integrations/mcp.md`
  - `docs/integrations/a2a.md`
  - `docs/integrations/rest.md`
  - `docs/programmatic-construction.md`
  - `docs/troubleshooting.md`
  - `docs/ARCHITECTURE.md`
  - `docs/llms.txt`
- Removed stale examples and signatures to reduce doc drift (legacy CLI commands, legacy package paths, outdated conformance signatures).

### Provenance

- Task provenance tracked in CLEO:
  - `T105` Envelope API hardening and docs provenance
  - `T106` Implement first-class compliance middleware API
  - `T107` Align Python envelope semantics with schema
  - `T108` Eliminate stale examples across docs

## [1.3.2] - 2026-02-24

### Added

- Exported `MVILevel` type alias (`'minimal' | 'standard' | 'full' | 'custom'`) from `types.ts` so consumers can import it directly instead of redeclaring the mvi disclosure level union

## [1.3.1] - 2026-02-20

### Fixed

- Legacy discovery config validation: reject empty `service.name`, empty `service.version`, missing `capabilities`, and missing `endpoints.envelope`
- ETag mismatch between HEAD and GET requests on legacy discovery endpoint (HEAD used compact JSON, GET used pretty-printed)
- Relative URLs in legacy discovery documents not resolved against `baseUrl`
- Custom discovery path not disabling legacy `/.well-known/lafs.json` fallback
- Content-Length test comparing re-serialized compact JSON against pretty-printed response body

All 243 tests now pass (0 failures).

## [1.3.0] - 2026-02-20

### Added

A2A v1.0+ compliance implementation (Wave 1):

- **Extension negotiation** (`src/a2a/extensions.ts`): `parseExtensionsHeader()`, `negotiateExtensions()`, `buildLafsExtension()`, Express middleware, `ExtensionSupportRequiredError` (code -32008)
- **Task lifecycle** (`src/a2a/task-lifecycle.ts`): `TaskManager` with CRUD/pagination, state machine enforcement (valid transitions, terminal state immutability), `attachLafsEnvelope()` integration helper
- **Protocol bindings** (`src/a2a/bindings/`): JSON-RPC method/error constants, HTTP endpoints with RFC 9457 Problem Details, gRPC status codes and service definitions (types only, no runtime dependency), cross-binding `getErrorCodeMapping()` for all 9 A2A error types
- **Discovery integration**: `autoIncludeLafsExtension` option in `DiscoveryConfig` to auto-declare LAFS in Agent Card
- **Subpath export**: `@cleocode/lafs/a2a/bindings` for standalone binding imports
- 130 new tests across extensions (32), task lifecycle (44), and bindings (54)

### Fixed

- Resolved type name conflicts between `discovery.ts` and `@a2a-js/sdk` re-exports in root `index.ts` (pre-existing from Wave 0)
- Made `DiscoveryConfig.agent` optional for backward compatibility with legacy `service` configs
- Fixed `examples/discovery-server.ts` references to optional `service` field

## [1.2.3] - 2026-02-18

### CI/CD Fixes

Fixed npm publish failures due to version conflicts:
- Bumped version to 1.2.3 (1.2.0, 1.2.1, 1.2.2 already published)
- Updated all version references (package.json, README, lafs.md)
- Fixed GitHub release workflow to create releases automatically

## [1.2.2] - 2026-02-18

### Documentation Fixes

Fixed documentation inaccuracies discovered after 1.2.0 release:
- Fixed CLI format option documentation (table → json/human)
- Synced specification.md with lafs.md (added format documentation and extensions examples)
- Added sessionId and warnings to envelope-basics.md field table

### Documentation Fixes

Fixed documentation inaccuracies discovered after 1.2.0 release:
- Fixed CLI format option documentation (table → json/human)
- Synced specification.md with lafs.md (added format documentation and extensions examples)
- Added sessionId and warnings to envelope-basics.md field table

## [1.2.0] - 2026-02-18

### Protocol Enhancement - Session Management & Format Documentation

This release adds session correlation support, quiet mode for scripting, and comprehensive documentation on format types and extension patterns.

### Added

#### Session Management
- **sessionId field** (`src/types.ts`) - Added to LAFSMeta for correlating multi-step agent workflows
- **Session tracking** - Enables context preservation across distributed operations
- **JSON Schema update** (`schemas/v1/envelope.schema.json`) - Added sessionId validation

#### Quiet Mode
- **quiet flag** (`src/types.ts`, `src/flagSemantics.ts`) - Suppresses non-essential output for scripting
- **Flag resolution** - Updated resolveOutputFormat() to handle quiet mode throughout all code paths
- **MVI compliance** - Aligns with Minimal Viable Information principle

#### Format Documentation
- **Section 5.3** (`lafs.md`) - Comprehensive format type documentation
- **Supported formats** - Explicitly documents json and human as only supported formats
- **Rejected formats table** - Documents why text, markdown, table, and jsonl were rejected
- **Human format definition** - Clear specification of human-readable output behavior
- **Tooling guidance** - Examples using jq and column commands for presentation needs

#### Extensions Documentation
- **Section 6.2** (`lafs.md`) - Expanded with comprehensive _extensions examples
- **4 complete examples** - Timing, source metadata, filters, and summaries
- **TypeScript interfaces** - Full type definitions for each extension pattern
- **Best practices** - 6 guidelines for extension usage including x- prefix convention
- **Decision matrix** - Clear guidance on Core Protocol vs Extensions

#### LLM Agent Guide
- **New guide** (`docs/guides/llm-agent-guide.md`) - Complete quick reference for AI agents
- **Envelope structure** - Full documentation with TypeScript interfaces
- **Format selection** - Guidance on choosing between json and human
- **Context preservation** - Session management and ledger usage patterns
- **Error handling** - Retry logic patterns for all error categories
- **Integration examples** - MCP, A2A, and HTTP API integration patterns
- **Best practices checklist** - 5 key patterns for robust agent implementation

### Design Principles Validated

- **MVI** - Rejected format bloat, kept only json|human
- **Progressive Disclosure** - Clear documentation on _fields, _expand, _budget
- **Transport Agnosticism** - No TTY-specific logic in protocol
- **Schema-First** - All changes reflected in JSON Schema and TypeScript types
- **Self-Documenting** - All code has JSDoc, comprehensive examples provided

## [1.1.0] - 2026-02-16

### Operations & Reliability Release

This release adds production operations features including health checks, graceful shutdown, circuit breakers, and comprehensive documentation.

### Added

#### Health Check Module
- **Health check endpoints** (`src/health/index.ts`)
- **Liveness probe** (`/health/live`)
- **Readiness probe** (`/health/ready`)
- **Custom health checks** for databases and external services
- **Kubernetes-compatible** health endpoints
- **Prometheus metrics** support

#### Graceful Shutdown
- **Graceful shutdown handler** (`src/shutdown/index.ts`)
- **SIGTERM/SIGINT signal handling**
- **Connection draining** - waits for active requests
- **Custom shutdown hooks** for cleanup
- **Force shutdown** option for emergencies
- **Shutdown state tracking**

#### Circuit Breaker Pattern
- **Circuit breaker implementation** (`src/circuit-breaker/index.ts`)
- **Three states**: CLOSED, OPEN, HALF_OPEN
- **Configurable thresholds** for failure detection
- **Auto-reset** after timeout
- **Circuit breaker registry** for multiple services
- **Express middleware** for easy integration

#### Documentation
- **Deployment Guide** (`docs/deployment.md`) - Complete deployment instructions
- **Operational Runbook** (`docs/runbook.md`) - Day-to-day operations
- **Troubleshooting Guide** (`docs/troubleshooting.md`) - Common issues and solutions
- **Architecture Document** (`docs/ARCHITECTURE.md`) - System design
- **Programmatic Construction Guide** (`docs/programmatic-construction.md`) - Code examples with type safety
- **Error Handling Implementation Guide** (`docs/error-handling-implementation.md`) - E_FORMAT_CONFLICT and error patterns
- **Roadmap** (`ROADMAP.md`) - Future improvements

### Changed

- **Removed competing "unified toolkit"** - Now uses official `@a2a-js/sdk`
- **Refactored A2A integration** - Proper bridge pattern using official SDK
- **Updated exports** - Added health, shutdown, circuit-breaker, a2a modules

---

## [1.0.0] - 2026-02-16

### Major Release - Agent-First Implementation

This release represents the completion of core LAFS protocol implementation with full agent-focused features, comprehensive documentation, and production-ready SDKs.

### Added

#### Token Budget Signaling
- **Token budget enforcement** (`_budget` parameter) with `maxTokens`, `maxBytes`, `maxItems` constraints
- **Normative token estimation algorithm** with 94-95% accuracy
- **E_MVI_BUDGET_EXCEEDED** error code with detailed retry guidance
- **Response truncation strategies** (depth-first, field priority, hybrid)
- **TypeScript implementation** in `src/budgetEnforcement.ts` with 42 tests
- **Python implementation** in `python/lafs/budget.py` with 21 tests

#### Agent Discovery Protocol
- **Well-known endpoint** `/.well-known/lafs.json` for automatic capability discovery
- **Discovery middleware** for Express/Fastify (`src/discovery.ts`)
- **JSON Schema** for discovery document validation (`schemas/v1/discovery.schema.json`)
- **ETag caching support** for efficient capability checks
- **26 integration tests** for discovery functionality

#### Context Ledger Query API
- **Projection modes** (full, delta, summary) for efficient context retrieval
- **Delta synchronization** with `sinceVersion` parameter
- **Query interface** at `GET /_lafs/context/{ledgerId}`
- **Checksum validation** for integrity verification
- **Complete API design** documented in `designs/context-query-v1.md`

#### MCP Integration
- **MCP adapter** (`src/mcpAdapter.ts`) for wrapping MCP tool results in LAFS envelopes
- **Example MCP server** (`examples/mcp-lafs-server.ts`) with 3 tools (weather, calculator, database_query)
- **Example MCP client** (`examples/mcp-lafs-client.ts`) demonstrating consumption
- **14 integration tests** proving LAFS complements MCP
- **Budget enforcement** within MCP tool context

#### Python SDK
- **Complete Python package** (`lafs`) pip-installable
- **Envelope module** with validation and creation functions
- **Budget module** with `TokenEstimator` and `BudgetEnforcer` classes
- **Client module** with `LAFSClient` for HTTP API calls
- **55 comprehensive tests** covering all functionality
- **Working examples** in `python/examples/basic_usage.py`

#### Documentation System
- **GitBook-compliant** documentation structure (24 markdown files, ~5,500 lines)
- **Agent-focused guides** in `docs/getting-started/` (4 guides)
- **Integration guides** for MCP, A2A, and REST (`docs/integrations/`)
- **SDK reference** documentation (`docs/sdk/`)
- **llms.txt** index for LLM agent consumption
- **Complete specification** merged into `lafs.md` Sections 8.1 and 9.5

#### Specifications
- **Token Budget Signaling Specification** (Section 9.5) with normative algorithm
- **Context Projection Modes Specification** (Section 8.1) with delta format
- **Agent Discovery Protocol** design document
- **Context Query API** design document

#### Testing & Conformance
- **113 TypeScript tests** (vitest) covering all new features
- **55 Python tests** (pytest) covering SDK functionality
- **14 MCP integration tests**
- **26 discovery middleware tests**
- **42 budget enforcement tests**
- **Total: 168 tests passing**

#### Prototypes & Design
- **Budget enforcement prototype** proving 94-95% accuracy with <1.3ms overhead
- **Agent reasoning chain fixtures** (3 workflow scenarios)
- **Complete decomposition** of pending work with agent-first lens

### Changed

#### Documentation Organization
- **Reorganized docs/** into structured GitBook format
- **Created SUMMARY.md** for navigation (11 sections, 18 entries)
- **Created .gitbook.yaml** configuration
- **Rewrote docs/README.md** as agent-focused landing page
- **Enhanced existing docs** with before/after examples

#### Specification Updates
- **lafs.md Section 8.1** - Added Context Retrieval with projection modes
- **lafs.md Section 9.5** - Added Token Budget Signaling (normative)
- **Error registry** - Added E_MVI_BUDGET_EXCEEDED and E_MVI_BUDGET_TRUNCATED

### Technical Details

#### TypeScript SDK
```typescript
// Token estimation
const estimator = new TokenEstimator();
const tokens = estimator.estimate({ data: "value" });

// Budget enforcement
app.use(withBudget({ budget: 1000, truncateOnExceed: true }));

// Discovery
app.use(discoveryMiddleware(config));
```

#### Python SDK
```python
# Client with discovery
client = LAFSClient("https://api.example.com")
discovery = client.discover()

# Budget enforcement
response = client.call(
    operation="data.query",
    budget={"maxTokens": 1000, "maxItems": 50}
)
```

### Migration Notes

This is a major release (1.0.0) marking production readiness. All previously deprecated features have been removed. The protocol is now stable for production use.

**For implementers:**
- Token budget signaling is optional but recommended for LLM-facing APIs
- Agent discovery is optional but enables auto-configuration
- All new features are backward compatible with v0.5.0 Core tier

### Statistics

- **24 new documentation files**
- **~5,500 lines of documentation**
- **~175 code examples**
- **168 passing tests**
- **4 integration guides**
- **3 SDK references**
- **100% LAFS compliant**

## [0.5.0] - 2026-02-12

### Phase 2B — Pagination & MVI Schema

### Added
- Conditional pagination (cursor, offset, none modes)
- MVI field selection (`_fields`) and expansion (`_expand`)
- Context ledger schema for state tracking
- Error registry with transport mappings
- Conformance runner with 8 checks

## [0.4.0] - 2026-02-11

### Phase 2A — Envelope Rationalization

### Added
- Optional page/error fields (can be omitted vs null)
- `_extensions` field for vendor metadata
- Strict/lenient mode toggle
- Schema validation for pagination modes
- CLI diagnostic tool

## [0.3.0] - 2026-02-10

### Phase 1 — Strategic Positioning

### Added
- Vision document with agent-first focus
- Positioning relative to MCP/A2A
- Adoption tiers (Core, Standard, Complete)
- Boundary model documentation

## [0.2.0] - 2026-02-09

### Phase 0 — Protocol Foundations

### Added
- Envelope schema (Draft-07)
- Error registry (12 codes)
- Fixtures for testing
- Governance documentation
- Security considerations

## [0.1.0] - 2026-02-08

### Initial Release

### Added
- Initial protocol specification
- Basic envelope structure
- TypeScript types
- Basic validation

---

## Release Checklist Template

### Pre-Release
- [ ] All tests passing
- [ ] Version bumped in package.json
- [ ] Version bumped in Python setup.py
- [ ] CHANGELOG.md updated
- [ ] GitBook docs synced
- [ ] Schema files validated

### Release
- [ ] Git tag created (`git tag -a vX.Y.Z -m "Release X.Y.Z"`)
- [ ] Tag pushed to GitHub (`git push origin vX.Y.Z`)
- [ ] npm package published (`npm publish`)
- [ ] Python package published (`twine upload dist/*`)
- [ ] GitHub release created

### Post-Release
- [ ] Documentation site updated
- [ ] Migration guides published
- [ ] Announcement shared

---

[Unreleased]: https://github.com/kryptobaseddev/cleo/compare/v2026.4.0...HEAD
[2026.4.0]: https://github.com/kryptobaseddev/cleo/compare/v1.8.0...v2026.4.0
[1.8.0]: https://github.com/kryptobaseddev/cleo/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/kryptobaseddev/cleo/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/kryptobaseddev/cleo/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/kryptobaseddev/cleo/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/kryptobaseddev/cleo/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/kryptobaseddev/cleo/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/kryptobaseddev/cleo/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/kryptobaseddev/cleo/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/kryptobaseddev/cleo/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/kryptobaseddev/cleo/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/kryptobaseddev/cleo/compare/v1.2.0...v1.2.2
[1.2.0]: https://github.com/kryptobaseddev/cleo/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kryptobaseddev/cleo/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v1.0.0
[0.5.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v0.5.0
[0.4.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v0.4.0
[0.3.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v0.3.0
[0.2.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v0.2.0
[0.1.0]: https://github.com/kryptobaseddev/cleo/releases/tag/v0.1.0

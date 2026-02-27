# Protocol Enforcement Middleware

**Task**: T2918
**Epic**: T2908 - CLEO MCP Server Implementation

## Overview

The protocol enforcement middleware validates RCASD-IVTR+C lifecycle compliance with exit codes 60-70. It intercepts domain operations to enforce protocol requirements before completion.

## Architecture

```
DomainRequest → DomainRouter → ProtocolEnforcer.enforceProtocol() → DomainHandler
                                        ↓
                                ProtocolRules.validate()
                                        ↓
                          Success: Continue | Failure: Block (strict mode)
```

## Protocol Types

| Protocol | Exit Code | Stage |
|----------|-----------|-------|
| Research | 60 | RCASD Setup |
| Consensus | 61 | RCASD Setup |
| Specification | 62 | RCASD Setup |
| Decomposition | 63 | RCASD Setup |
| Implementation | 64 | IVTR Execution |
| Contribution | 65 | IVTR Execution (cross-cutting) |
| Release | 66 | IVTR Execution |
| Validation | 68 | IVTR Execution |
| Testing | 69/70 | IVTR Execution |

## Lifecycle Gates

```
research ──GATE──► consensus ──GATE──► architecture_decision ──GATE──► specification ──GATE──► decomposition
   ↓                 ↓                     ↓                           ↓                         ↓
  []               [research]      [research, consensus]  [research, consensus, architecture_decision]  [research, specification, architecture_decision]

                              │
                              ▼

implementation ──GATE──► validation ──GATE──► testing ──GATE──► release
     ↓                      ↓                   ↓                  ↓
 [RCASD complete]      [implementation]  [implementation,      [implementation,
                                          validation]           validation, testing]
```

## Usage

### Enabling/Disabling

```typescript
// Enable enforcement (default)
const router = new DomainRouter(executor, true);

// Disable enforcement
const router = new DomainRouter(executor, false);
```

### Strict Mode

```typescript
import { protocolEnforcer } from './lib/protocol-enforcement.js';

// Enable strict mode (blocks on violations)
protocolEnforcer.setStrictMode(true);

// Disable strict mode (warns only)
protocolEnforcer.setStrictMode(false);
```

### Checking Lifecycle Gates

```typescript
const gateCheck = await protocolEnforcer.checkLifecycleGate(
  'T2918',
  'implementation',
  lifecycleManifest
);

if (!gateCheck.passed) {
  console.error(gateCheck.message);
  console.error('Missing:', gateCheck.missingPrerequisites);
}
```

### Recording Violations

```typescript
// Violations are automatically recorded by middleware
const violations = protocolEnforcer.getViolations(10); // Last 10
```

## Protocol Rules

### Research (RSCH-*)

| ID | Level | Requirement |
|----|-------|-------------|
| RSCH-001 | MUST | NOT implement code |
| RSCH-004 | MUST | Append to MANIFEST.jsonl |
| RSCH-006 | MUST | Include 3-7 key findings |
| RSCH-007 | MUST | Set agent_type: research |

### Specification (SPEC-*)

| ID | Level | Requirement |
|----|-------|-------------|
| SPEC-001 | MUST | Include RFC 2119 keywords |
| SPEC-002 | MUST | Have version field |
| SPEC-007 | MUST | Set agent_type: specification |

### Implementation (IMPL-*)

| ID | Level | Requirement |
|----|-------|-------------|
| IMPL-003 | MUST | Include @task provenance tags |
| IMPL-007 | MUST | Set agent_type: implementation |

### Release (RLSE-*)

| ID | Level | Requirement |
|----|-------|-------------|
| RLSE-001 | MUST | Follow semver (major.minor.patch) |
| RLSE-002 | MUST | Have changelog entry |
| RLSE-007 | MUST | Set agent_type: documentation or release |

## Validation Flow

1. **Intercept**: Middleware intercepts mutate operations
2. **Execute**: Operation runs normally
3. **Extract**: Extract manifest entry from response
4. **Validate**: Run protocol-specific rules
5. **Score**: Calculate compliance score (0-100)
6. **Block/Warn**: Block in strict mode or warn only
7. **Record**: Log violation for auditing

## Error Response Format

```json
{
  "_meta": { ... },
  "success": false,
  "error": {
    "code": "E_PROTOCOL_RESEARCH",
    "exitCode": 60,
    "message": "Protocol violation: research",
    "details": {
      "violations": [
        {
          "requirement": "RSCH-006",
          "severity": "error",
          "message": "Must include 3-7 key findings",
          "fix": "Add/remove findings in manifest entry"
        }
      ],
      "score": 80
    },
    "fix": "Add/remove findings in manifest entry",
    "alternatives": [
      {
        "action": "RSCH-006",
        "command": "Add/remove findings in manifest entry"
      }
    ]
  }
}
```

## Operations Validated

The middleware validates these operations:

- `research.inject`
- `research.manifest.append`
- `orchestrate.spawn`
- `tasks.complete`
- `release.prepare`
- `release.commit`
- `validate.compliance.record`

## Testing

```bash
# Run protocol enforcement tests
npm test -- protocol-enforcement.test.ts

# Run all lib tests
npm test -- lib/
```

## Configuration

In `.cleo/config.json`:

```json
{
  "mcp": {
    "protocolEnforcement": {
      "enabled": true,
      "strictMode": true,
      "logViolations": true
    }
  }
}
```

## References

- **Bash Implementation**: `lib/protocol-validation.sh`
- **MCP Spec**: `docs/specs/MCP-SERVER-SPECIFICATION.md`
- **Protocol Specs**: `protocols/*.md`
- **Lifecycle Spec**: `docs/specs/PROJECT-LIFECYCLE-SPEC.md`

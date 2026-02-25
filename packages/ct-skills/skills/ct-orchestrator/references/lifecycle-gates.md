# Lifecycle Gate Enforcement

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on RCSD gate checks, enforcement modes, handling gate failures, or emergency bypass

## Overview

Before spawning ANY implementation task, the system automatically checks RCSD prerequisites. This ensures the Research → Consensus → Specification → Decomposition pipeline is followed.

## Decision Tree

```
Before spawn:
│
├─ Is task under an epic (has parentId)?
│   ├─ NO → Skip gate check, proceed
│   └─ YES → Continue to gate check
│
├─ What is enforcement mode?
│   ├─ off → Skip gate check, proceed
│   ├─ advisory → Check gates, warn on failure, proceed
│   └─ strict (default) → Check gates, BLOCK on failure
│
├─ Map protocol to RCSD stage:
│   ├─ research → research stage
│   ├─ consensus → consensus stage
│   ├─ specification → specification stage
│   ├─ decomposition → decomposition stage
│   ├─ implementation/contribution → implementation stage
│   └─ release → release stage
│
├─ Check prerequisites for target stage:
│   ├─ All prior stages completed/skipped → GATE PASSES → Proceed with spawn
│   └─ Missing prerequisite stages → GATE FAILS
│
└─ On GATE FAILURE (strict mode):
    ├─ Exit code: 75 (EXIT_LIFECYCLE_GATE_FAILED)
    ├─ Error includes: missing stages, fix commands
    └─ Action: Complete prerequisite stages first
```

## Enforcement Modes

| Mode | Behavior | When to Use |
|------|----------|-------------|
| **strict** (default) | Blocks spawn if prerequisites missing | Production, regulated work |
| **advisory** | Warns but allows spawn | Rapid prototyping, debugging |
| **off** | Disables all gate checks | Legacy compatibility, emergencies |

## Setting Enforcement Mode

```bash
# Check current mode
jq '.lifecycleEnforcement.mode' .cleo/config.json

# Set to advisory (temporary)
jq '.lifecycleEnforcement.mode = "advisory"' .cleo/config.json > tmp && mv tmp .cleo/config.json

# Set back to strict
jq '.lifecycleEnforcement.mode = "strict"' .cleo/config.json > tmp && mv tmp .cleo/config.json
```

## Handling Gate Failures

When a gate fails in strict mode:

1. **Check what's missing**: Error JSON shows `missingPrerequisites`
2. **Complete prerequisites**: Spawn subagents for missing stages
3. **Record completion**: System auto-records via manifest entries
4. **Retry spawn**: Original task should now pass gate

**Example failure response:**
```json
{
  "error": {
    "code": "E_LIFECYCLE_GATE_FAILED",
    "message": "SPAWN BLOCKED: Lifecycle prerequisites not met for implementation stage",
    "context": {
      "targetStage": "implementation",
      "missingPrerequisites": "research consensus"
    }
  }
}
```

## Emergency Bypass

**Only for emergencies** — set mode to advisory or off:

```bash
# Temporary bypass for single session
export LIFECYCLE_ENFORCEMENT_MODE=off

# Or update config
jq '.lifecycleEnforcement.mode = "off"' .cleo/config.json > tmp && mv tmp .cleo/config.json
```

**Remember to restore strict mode after emergency.**

# verify Command

Manage verification gates for tasks to track quality checkpoints.

## Usage

```bash
cleo verify TASK_ID [OPTIONS]
```

## Description

The `verify` command manages verification gates for tasks. Verification gates track quality checkpoints such as implementation, testing, QA review, security scans, and documentation. Tasks must pass all required gates before parent auto-completion is triggered.

When `ct complete` is run, the `implemented` gate is automatically set to `true`. Other gates must be set manually using `ct verify`.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `TASK_ID` | Task ID to manage verification for (e.g., T001) | Yes |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--gate NAME` | Set specific gate to true (implemented, testsPassed, qaPassed, cleanupDone, securityPassed, documented) | |
| `--value BOOL` | Value to set for gate (true/false) | `true` |
| `--agent NAME` | Agent name setting the gate (planner, coder, testing, qa, cleanup, security, docs) | |
| `--all` | Set all required gates to true | |
| `--reset` | Reset verification to initial state | |
| `--help` | Show help message | |

## Examples

### Show Verification Status

```bash
# Show current verification status
cleo verify T001

# Output includes:
# - Overall verification status (pending/in-progress/passed/failed)
# - Current round number
# - Each gate status (true/false/null)
# - Required gates and which are missing
```

### Set Individual Gates

```bash
# Set testsPassed gate
cleo verify T001 --gate testsPassed

# Set gate with agent attribution
cleo verify T001 --gate qaPassed --agent qa

# Set gate to false (failure)
cleo verify T001 --gate testsPassed --value false
```

### Set All Required Gates

```bash
# Mark all required gates as passed
cleo verify T001 --all
```

### Reset Verification

```bash
# Reset verification to start over
cleo verify T001 --reset
```

## Verification Status

Tasks can be in one of four verification states:

| Status | Description |
|--------|-------------|
| `pending` | No verification data (null) |
| `in-progress` | Some gates set, but not all required gates passed |
| `passed` | All required gates are true |
| `failed` | Has entries in failureLog |

## Default Required Gates

The following gates are required by default (configurable in config.json):

1. `implemented` - Code complete (auto-set by `ct complete`)
2. `testsPassed` - Tests pass
3. `qaPassed` - QA review done
4. `securityPassed` - Security scan clear
5. `documented` - Documentation complete

Note: `cleanupDone` is optional (not in default required gates).

## Gate Dependency Chain

Gates have a dependency order. When a gate fails, all downstream gates are reset:

```
implemented → testsPassed → qaPassed → cleanupDone → securityPassed → documented
```

For example, if `testsPassed` fails, gates `qaPassed`, `cleanupDone`, `securityPassed`, and `documented` are reset to null.

## Integration with Other Commands

### Filtering by Verification Status

```bash
# List tasks by verification status
cleo list --verification-status pending
cleo list --verification-status in-progress
cleo list --verification-status passed
cleo list --verification-status failed

# Show detailed verification in task view
cleo show T001 --verification
```

### Parent Auto-Complete

When `config.verification.requireForParentAutoComplete` is true (default), parent tasks only auto-complete when all children have `verification.passed = true`.

### Epic Lifecycle

When all children of an epic have `verification.passed = true`, the epic's `epicLifecycle` automatically transitions from `active` to `review`.

## Exit Codes

| Code | Constant | Description |
|------|----------|-------------|
| 0 | SUCCESS | Gate operation successful |
| 40 | E_VERIFICATION_INIT_FAILED | Failed to initialize verification |
| 41 | E_GATE_UPDATE_FAILED | Failed to update gate |
| 42 | E_INVALID_GATE | Invalid gate name |
| 43 | E_INVALID_AGENT | Invalid agent name |
| 44 | E_MAX_ROUNDS_EXCEEDED | Maximum verification rounds exceeded |
| 45 | E_GATE_DEPENDENCY | Gate dependency violation |

## Configuration

Verification behavior is controlled in `config.json`:

```json
{
  "verification": {
    "enabled": true,
    "requiredGates": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"],
    "autoSetImplementedOnComplete": true,
    "requireForParentAutoComplete": true,
    "allowManualOverride": true,
    "maxRounds": 5
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Enable verification system | `true` |
| `requiredGates` | Gates that must pass for verification.passed | 5 gates |
| `autoSetImplementedOnComplete` | Auto-set implemented gate on complete | `true` |
| `requireForParentAutoComplete` | Require verification for parent auto-complete | `true` |
| `allowManualOverride` | Allow --skip-verification flag | `true` |
| `maxRounds` | Maximum verification rounds before escalation | `5` |

## See Also

- [complete](complete.md) - Complete tasks (auto-sets implemented gate)
- [list](list.md) - Filter tasks by verification status
- [show](show.md) - View task verification details

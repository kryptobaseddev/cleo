# Documentation Maintenance Schedule

**Version**: 1.0.0
**Purpose**: Establish periodic documentation audits to prevent drift accumulation

---

## Overview

Documentation drift occurs when code changes aren't reflected in documentation. Regular audits catch drift early when fixes are small.

---

## Audit Schedule

### Weekly Audit (Recommended)

**When**: Every Monday or at start of sprint
**Duration**: ~5 minutes
**Owner**: Developer on rotation or maintainer

**Quick check:**
```bash
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --quick
```

**Actions if drift detected:**
1. Create task in current sprint: `cleo add "Fix documentation drift" --priority medium --labels documentation`
2. Address before end of sprint

### Monthly Audit (Required)

**When**: First Monday of each month
**Duration**: ~15 minutes
**Owner**: Project maintainer

**Full check:**
```bash
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend
```

**Review areas:**
- [ ] All COMMANDS-INDEX entries current
- [ ] Command docs match implementations
- [ ] Version strings consistent
- [ ] README reflects current capabilities
- [ ] Agent injection docs accurate
- [ ] Vision documents not stale (>30 days)

**Actions:**
1. Create epic for accumulated drift: `cleo add "Monthly docs audit" --type epic --priority medium`
2. Break down into tasks per section
3. Complete before next release

### Pre-Release Audit (Mandatory)

**When**: Before any version release
**Duration**: ~30 minutes
**Owner**: Release manager

**Process**: See [PRE-RELEASE-CHECKLIST.md](./PRE-RELEASE-CHECKLIST.md)

---

## Automation

### CI Integration

Documentation drift detection runs automatically on every PR:

```yaml
# .github/workflows/ci.yml
docs-drift:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --strict
```

PRs with drift will fail CI, preventing merge.

### Scheduled GitHub Action (Optional)

For proactive notifications, add a scheduled workflow:

```yaml
# .github/workflows/docs-audit.yml
name: Weekly Documentation Audit

on:
  schedule:
    # Every Monday at 9 AM UTC
    - cron: '0 9 * * 1'
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install jq
        run: sudo apt-get install -y jq
      - name: Run audit
        id: audit
        run: |
          chmod +x dev/skills/ct-docs-sync/scripts/detect-drift.sh
          ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend 2>&1 | tee audit-report.txt
          echo "has_drift=\$([[ \$? -ne 0 ]] && echo true || echo false)" >> \$GITHUB_OUTPUT
        continue-on-error: true
      - name: Create issue if drift
        if: steps.audit.outputs.has_drift == 'true'
        uses: peter-evans/create-issue-from-file@v4
        with:
          title: 'Weekly Documentation Audit: Drift Detected'
          content-filepath: ./audit-report.txt
          labels: documentation,maintenance
```

---

## Metrics Tracking

### Drift Indicators

Track these metrics over time to assess documentation health:

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| Missing docs | 0 | 1-3 | 4+ |
| Orphaned index entries | 0 | 1-2 | 3+ |
| Version mismatches | 0 | 1 | 2+ |
| Days since vision update | <30 | 30-60 | >60 |

### Audit Log

Maintain a simple audit log in project notes:

```
## Documentation Audit Log

### 2026-01-23 (Weekly)
- Status: Clean
- Drift: None detected
- Actions: None needed

### 2026-01-15 (Monthly)
- Status: Minor drift
- Drift: 2 missing command docs
- Actions: Created T1977, completed same day
```

---

## Best Practices

### 1. Document While Coding

When adding a new command:
1. Add script to `scripts/`
2. **Immediately** add entry to `COMMANDS-INDEX.json`
3. **Immediately** create `docs/commands/<name>.md`

### 2. PR Documentation Requirement

Include documentation updates in the same PR as code changes:
- Update COMMANDS-INDEX for new/modified commands
- Update relevant docs for behavior changes
- CI will catch if you forget

### 3. Version Bump Protocol

When bumping version:
1. Update `VERSION` file
2. Run `./dev/bump-version.sh <version>`
3. Update CHANGELOG.md
4. Regenerate derived docs

### 4. Stale Document Review

For documents >30 days old:
- Review for accuracy
- Update examples if needed
- Refresh dates/versions

---

## Responsibilities

| Role | Weekly | Monthly | Pre-Release |
|------|--------|---------|-------------|
| Developer | Run quick check | Contribute fixes | Review area |
| Maintainer | Review results | Run full audit | Approve checklist |
| Release Manager | - | - | Sign off |

---

## See Also

- [PRE-RELEASE-CHECKLIST.md](./PRE-RELEASE-CHECKLIST.md) - Release workflow
- `dev/skills/ct-docs-sync/SKILL.md` - Drift detection tool
- `docs/commands/COMMANDS-INDEX.json` - Commands registry

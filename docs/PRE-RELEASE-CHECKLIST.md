# Pre-Release Documentation Checklist

**Version**: 1.0.0
**Purpose**: Ensure documentation is synchronized before CLEO releases

---

## Quick Reference

```bash
# Run full drift detection with recommendations
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend

# CI-mode (strict, fails on any drift)
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --strict
```

---

## Checklist

### 1. Commands Index Sync

- [ ] All scripts in `scripts/` are registered in `docs/commands/COMMANDS-INDEX.json`
- [ ] No orphaned entries in index (scripts that don't exist)
- [ ] `totalCommands` count matches actual command count
- [ ] All commands have correct category assignment

**Verification:**
```bash
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --quick
```

### 2. Command Documentation

- [ ] Every command in the index has a corresponding `docs/commands/<name>.md`
- [ ] Documentation format follows standard template (Synopsis, Description, Options, Examples, Exit Codes, See Also)
- [ ] Exit codes are accurate and match implementation

**Check for missing docs:**
```bash
jq -r '.commands[].name' docs/commands/COMMANDS-INDEX.json | while read cmd; do
  [[ -f "docs/commands/$cmd.md" ]] || echo "Missing: $cmd.md"
done
```

### 3. Version Consistency

- [ ] `VERSION` file matches README badge version
- [ ] `VERSION` file matches CLEO-UNIFIED-VISION.md version
- [ ] CHANGELOG.md has entry for new version
- [ ] Schema versions are correct in `schemas/*.schema.json`

**Sync versions:**
```bash
./dev/bump-version.sh <version>
```

### 4. README Completeness

- [ ] Critical commands documented: `list`, `add`, `complete`, `find`, `show`, `analyze`, `session`, `focus`, `dash`
- [ ] Installation instructions current
- [ ] Quick start examples work

### 5. Agent Injection Content

- [ ] `~/.cleo/docs/TODO_Task_Management.md` is current
- [ ] Command Reference section updated
- [ ] Session Protocol documented
- [ ] Error handling section accurate

**Update agent docs:**
```bash
cleo upgrade
```

### 6. Vision Documents

- [ ] `docs/CLEO-UNIFIED-VISION.md` updated within last 30 days
- [ ] Command System Architecture section present
- [ ] No stale feature descriptions

---

## Pre-Release Workflow

### Step 1: Run Drift Detection
```bash
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend
```

Review output and address all errors and warnings.

### Step 2: Update COMMANDS-INDEX.json
If new scripts were added:
```bash
# Example entry structure
{
  "name": "new-command",
  "script": "new-command.sh",
  "category": "write|read|sync|maintenance",
  "doc": "new-command.md",
  "synopsis": "Brief description",
  "flags": ["--flag1", "--flag2"],
  "exitCodes": [0, 1, 2],
  "jsonOutput": true,
  "agentRelevance": "critical|high|medium|low"
}
```

### Step 3: Create Missing Documentation
For each missing doc:
```bash
# Use existing doc as template
cp docs/commands/existing.md docs/commands/new-command.md
# Edit with correct content
```

### Step 4: Update Version
```bash
./dev/bump-version.sh <new-version>
```

### Step 5: Update CHANGELOG
Add release entry to `CHANGELOG.md` with:
- New features
- Bug fixes
- Breaking changes
- Deprecations

### Step 6: Final Verification
```bash
# Should exit 0 with no warnings
./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --strict
```

### Step 7: Regenerate Derived Docs
```bash
./scripts/generate-features.sh
./scripts/generate-changelog.sh
```

---

## CI Integration

The CI pipeline runs drift detection on every push and PR:

```yaml
# .github/workflows/ci.yml
docs-drift:
  name: Documentation Drift Check
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --strict
```

**Exit codes:**
- `0`: No drift
- `1`: Warnings (strict mode fail)
- `2`: Critical errors (always fail)

---

## Troubleshooting

### "Scripts NOT in COMMANDS-INDEX.json"
Add entries for the listed scripts to the index.

### "Index entries WITHOUT actual scripts"
Remove orphaned entries or verify script exists.

### "Commands without individual docs"
Create documentation files following the standard template.

### "VERSION file != README"
Run `./dev/bump-version.sh <version>` to sync.

---

## See Also

- `dev/skills/ct-docs-sync/SKILL.md` - Full skill documentation
- `docs/commands/COMMANDS-INDEX.json` - Commands registry
- `docs/CLEO-UNIFIED-VISION.md` - Architecture overview

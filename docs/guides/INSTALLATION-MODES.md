# CLEO Agent Installation Modes

CLEO supports two modes for installing agent definitions to `~/.claude/agents/`: **symlink** (default) and **copy** (opt-in).

## Quick Reference

```bash
# Default: Symlink mode (recommended)
cleo init
./install.sh

# Copy mode: Project isolation
cleo init --copy-agents
./install.sh --copy-agents

# Update agents only (refreshes symlinks)
cleo init --update-docs
```

---

## Default: Symlink Mode

**Recommended for most users**

Agent files are installed as symbolic links pointing to `~/.cleo/templates/agents/`.

### Benefits

✅ **Auto-updating**: Agents automatically reflect CLEO updates
✅ **Centralized**: Single source of truth for all projects
✅ **Low disk usage**: No file duplication
✅ **Transparent**: Works seamlessly with Claude Code

### When to Use

- Standard development workflows
- You want agents to stay current with CLEO releases
- You don't need project-specific agent customizations
- Your editor supports symlinks (most modern editors do)

### Example

```bash
$ cleo init
[INFO] Installing agent definitions...
[INFO] Installed agents via symlinks (auto-updating)

$ ls -la ~/.claude/agents/
lrwxr-xr-x  1 user  staff  cleo-subagent.md -> ~/.cleo/templates/agents/cleo-subagent.md
```

---

## Copy Mode: `--copy-agents`

**Use for project isolation or editor compatibility**

Agent files are installed as independent copies.

### Benefits

✅ **Project isolation**: Updates don't affect installed agents
✅ **Customization**: Safe to modify without affecting other projects
✅ **Editor compatibility**: Works with all editors (including those with poor symlink support)
✅ **Portable**: Agent files exist independently

### Trade-offs

⚠️ **Manual updates**: Agents won't auto-update with CLEO
⚠️ **Disk usage**: Duplicate files for each project
⚠️ **Maintenance**: Requires manual refresh to get updates

### When to Use

- You need project-specific agent customizations
- Your editor doesn't handle symlinks well
- You want to freeze agents at a specific version
- You're working with strict filesystem requirements

### Example

```bash
$ cleo init --copy-agents
[INFO] Installing agent definitions...
[INFO] Installed agents as files

$ ls -la ~/.claude/agents/
-rw-r--r--  1 user  staff  cleo-subagent.md
```

---

## File Preservation Behavior

CLEO intelligently preserves user customizations:

| Existing State | Install Mode | Action |
|----------------|--------------|--------|
| No file exists | `symlink` | Create symlink |
| No file exists | `copy` | Create copy |
| Symlink (correct target) | Any | **Skip** (already correct) |
| Symlink (wrong target) | `symlink` | Update symlink |
| Symlink | `copy` | Remove symlink, create copy |
| **Regular file** | **Any** | **Preserve** (user customization) |

**Key principle**: Existing regular files are **never overwritten**. CLEO assumes they represent user customizations.

---

## Refreshing Agent Installations

### Symlink Mode (Auto-Refresh)

Symlinks automatically reflect updates when CLEO is updated. No action needed.

### Copy Mode (Manual Refresh)

To get updates after a CLEO upgrade:

```bash
# Option 1: Update docs and refresh symlinks
cleo init --update-docs

# Option 2: Full re-initialization
cleo init --copy-agents

# Option 3: Manual update
cd ~/.cleo
git pull  # or re-run installer
cp templates/agents/*.md ~/.claude/agents/
```

---

## Troubleshooting

### "Agent not found" Errors

```bash
# Check if agent files exist
ls -la ~/.claude/agents/

# Verify symlinks (if using symlink mode)
readlink ~/.claude/agents/cleo-subagent.md

# Re-install agents
cleo init --update-docs
```

### Symlinks Not Working

**Symptoms**: Editor shows broken links or can't access agents

**Solution**: Use copy mode

```bash
# Remove existing symlinks
rm ~/.claude/agents/*.md

# Re-install as copies
cleo init --copy-agents
```

### Agent Changes Not Appearing

**Symlink mode**: Verify symlink target
```bash
readlink -f ~/.claude/agents/cleo-subagent.md
# Should point to ~/.cleo/templates/agents/cleo-subagent.md
```

**Copy mode**: Manually refresh
```bash
cleo init --copy-agents  # Re-copy files
```

### Switching Modes

From **symlink** to **copy**:
```bash
rm ~/.claude/agents/*.md
cleo init --copy-agents
```

From **copy** to **symlink**:
```bash
rm ~/.claude/agents/*.md
cleo init  # Default is symlink
```

---

## Agent Files Installed

CLEO installs all `.md` files from `templates/agents/`:

- `cleo-subagent.md` - Universal task executor with protocol compliance

Additional agents are added as CLEO evolves.

---

## Technical Details

### Source Locations

- **Global**: `~/.cleo/templates/agents/`
- **Repo**: `$CLEO_REPO/templates/agents/`

### Target Location

- `~/.claude/agents/` (Claude Code agents directory)

### Implementation

- **Library**: `lib/agents-install.sh`
- **Functions**: `install_agents()`, `install_agent()`
- **Modes**: `symlink` (default), `copy`

### Behavior Matrix

```bash
# Default installation
install_agents "symlink"

# Copy mode installation
install_agents "copy"
```

---

## Related Commands

| Command | Purpose |
|---------|---------|
| `cleo init` | Initialize project (default: symlinks) |
| `cleo init --copy-agents` | Initialize with copy mode |
| `cleo init --update-docs` | Update agent docs + refresh symlinks |
| `./install.sh` | Global install (default: symlinks) |
| `./install.sh --copy-agents` | Global install with copy mode |

---

## Best Practices

### For Development

✅ Use **symlink mode** (default)
✅ Let agents auto-update with CLEO
✅ Customize in templates if needed

### For Production/Stable Environments

✅ Use **copy mode** if you need version stability
✅ Document which CLEO version agents are from
✅ Plan manual refresh cycles

### For Teams

✅ Document your mode choice in project README
✅ Consider symlink mode for consistency
✅ Use copy mode if team members have editor issues

---

## See Also

- [Features](../FEATURES.json) - Complete feature inventory
- [Installation](../README.md) - General installation guide
- [Agent Architecture](../../.cleo/templates/AGENT-INJECTION.md) - Agent system overview

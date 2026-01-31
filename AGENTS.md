<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
# Agent Documentation

For comprehensive repository guidelines, see @CLAUDE.md for:
- Project overview and core mission
- Project structure and architecture principles
- Build, test, and development commands
- Coding style and naming conventions
- Critical rules and constraints
- Testing guidelines
- Commit and PR guidelines
- Key files and entry points
- Validation and error handling
- Protocol enforcement
- Version management

## Backup System Operations

### Path Discovery
LLM agents MUST NOT hardcode backup paths. Use:
```bash
# Get backup directory from config
cleo config get backup.directory
# Default: .cleo/backups/
```

### Creating Backups
```bash
# Manual snapshot (recommended before major changes)
cleo backup

# System creates safety backups automatically before:
# - validate --fix
# - restore
# - archive
# - complete
```

### Listing Backups
```bash
cleo backup --list           # All backups
cleo backup --list --type snapshot  # Filter by type
```

### Restoring Backups
```bash
# ALWAYS verify what you're restoring first
cleo backup --list

# Restore specific backup
cleo restore <backup-id>

# System creates safety backup before restore
```

### Error Recovery
If backup operations fail:
1. Check disk space: `df -h .cleo/`
2. Check permissions: `ls -la .cleo/backups/`
3. Run validation: `cleo validate --fix`
4. Check audit log: `cleo log --operation backup`

### Best Practices
- Create snapshot before multi-task operations
- Never delete backups directly - use retention policies
- Verify restore target before executing
- Migration backups are NEVER deleted automatically

## Agent-Specific Notes

### When Using AI Agents
1. **Follow AGENTS.md** - It defines repository-specific workflow expectations
2. **Respect atomic operations** - Never bypass the temp→validate→backup→rename pattern
3. **Maintain data integrity** - Always validate before and after operations
4. **Use proper testing** - Add tests for new features and bug fixes
5. **Follow commit conventions** - Use proper types and scopes
6. **No time estimates** - Focus on scope and complexity instead

### Common Pitfalls to Avoid
- Don't edit JSON files directly - use CLI commands only
- Don't skip validation steps - they're critical for data integrity
- Don't add time estimates - they're explicitly prohibited
- Don't forget atomic operations - all writes must be atomic
- Don't skip testing - new features need tests

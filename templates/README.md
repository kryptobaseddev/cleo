# Template Files

Template files used by `init.sh` to initialize new projects with the CLEO task management system.

## Template Files

| File | Target File | Description |
|------|-------------|-------------|
| `todo.template.json` | `.cleo/todo.json` | Active tasks storage with focus management and metadata |
| `archive.template.json` | `.cleo/todo-archive.json` | Completed tasks archive (immutable after archival) |
| `log.template.json` | `.cleo/todo-log.json` | Append-only change log for audit trail |
| `config.template.json` | `.cleo/config.json` | Project configuration (archive, validation, display settings) |
| `CLEO.todo.md` | (documentation) | Agent markdown section template for task management integration |
| `AGENT-INJECTION.md` | CLAUDE.md | Default injection template for CLAUDE.md (works with any agent doc) |

## Placeholder Contract

Templates use placeholders that are replaced during initialization:

| Placeholder | Replaced With | Example | Used In |
|-------------|---------------|---------|---------|
| `{{PROJECT_NAME}}` | Current directory name | `my-project` | todo, archive, log |
| `{{TIMESTAMP}}` | Current ISO 8601 timestamp | `2025-12-12T14:30:00Z` | todo only |
| `{{CHECKSUM}}` | SHA-256 hash of tasks array (first 16 chars) | `e3b0c44298fc1c14` | todo only |

**Notes**:
- `config.template.json` uses no placeholders - it is copied as-is with only the schema path adjusted
- Version numbers are hardcoded in templates (currently `2.1.0`), not replaced via placeholder
- `init.sh` attempts to replace `{{VERSION}}` but templates don't use this placeholder

## Placeholder Processing

During `init.sh`, templates are processed as follows:

```bash
# 1. Copy template to target location
cp "$CLEO_HOME/templates/todo.template.json" "$TODO_DIR/todo.json"

# 2. Replace placeholders using sed
sed -i "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" "$TODO_DIR/todo.json"
sed -i "s/{{TIMESTAMP}}/$TIMESTAMP/g" "$TODO_DIR/todo.json"
sed -i "s/{{CHECKSUM}}/$CHECKSUM/g" "$TODO_DIR/todo.json"
sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/todo.json"

# 3. Fix schema path from repo-relative to project-local
sed -i 's|"$schema": "../schemas/todo.schema.json"|"$schema": "./schemas/todo.schema.json"|' "$TODO_DIR/todo.json"

# 4. Validate against schema
ajv validate -s "$TODO_DIR/schemas/todo.schema.json" -d "$TODO_DIR/todo.json"
```

## Template Structure Examples

### todo.template.json
- Contains: empty tasks array, focus management, phases, labels, version 2.1.0
- Placeholders: `{{PROJECT_NAME}}`, `{{TIMESTAMP}}`, `{{CHECKSUM}}`
- Schema: `../schemas/todo.schema.json` (rewritten to `./schemas/` during init)

### archive.template.json
- Contains: empty archivedTasks array, statistics structure, version 2.1.0
- Placeholders: `{{PROJECT_NAME}}`
- Schema: `../schemas/archive.schema.json`

### log.template.json
- Contains: empty entries array, metadata structure, version 2.1.0
- Placeholders: `{{PROJECT_NAME}}`
- Schema: `../schemas/log.schema.json`

### config.template.json
- Contains: all default settings (archive, validation, logging, display, CLI), version 2.1.0
- Placeholders: NONE
- Schema: `../schemas/config.schema.json`

### CLEO.todo.md
- Contains: markdown documentation for CLEO CLI integration with session protocol
- Placeholders: NONE
- Usage: Extended template for agent docs integration, shows CLI commands and anti-hallucination rules

### AGENT-INJECTION.md
- Contains: concise CLEO CLI instructions with session protocol
- Placeholders: NONE
- Usage: Default injection template for CLAUDE.md (or any agent doc via --target flag)

## Schema Path Rewriting

All templates use repo-relative schema paths (`../schemas/*.schema.json`) which are automatically rewritten during initialization to project-local paths (`./schemas/*.schema.json`). This allows:

1. Templates to validate in the repo context
2. Initialized files to validate in the project context
3. Schema files to be copied to `.cleo/schemas/` for portability

## Adding New Templates

1. Create file with `.template.json` extension
2. Use `{{PLACEHOLDER}}` syntax for dynamic values (must be in table above)
3. Reference appropriate schema: `"$schema": "../schemas/your-schema.json"`
4. Add processing logic to `scripts/init.sh`:
   - Copy template
   - Replace placeholders
   - Rewrite schema path
   - Validate
5. Document placeholder usage in this README
6. Update Template Files table above

## Validation

All templates must:
- Validate against their respective schemas BEFORE placeholder replacement
- Validate against schemas AFTER placeholder replacement
- Follow the JSON formatting style (2-space indent, trailing newline)
- Use only documented placeholders

Templates are validated during:
- Installation: `install.sh` checks template integrity
- Initialization: `init.sh` validates after placeholder replacement
- CI/CD: Test suite validates all templates

# Shell Escaping Reference

When passing text to CLEO commands via `--notes`, `--description`, or other text fields, certain characters require escaping to prevent shell interpretation.

---

## Quick Reference

| Character | Escape As | Example |
|-----------|-----------|---------|
| `$` | `\$` | `\$100`, `\$HOME` |
| Backtick | `\`` | Code blocks |
| `"` | `\"` | Nested quotes |
| Exclamation | `\!` | History expansion (bash) |

---

## Common Patterns

### Dollar Signs in Notes

```bash
# CORRECT - escaped dollar sign
cleo add "Task" --notes "Cost estimate: \$500 per user"
cleo add "Task" --description "Process \$DATA variable"

# WRONG - $500 and $DATA interpreted as shell variables
cleo add "Task" --notes "Cost estimate: $500 per user"
cleo add "Task" --description "Process $DATA variable"
```

### Quotes in Text

```bash
# CORRECT - escaped inner quotes
cleo add "Task" --notes "User said \"hello world\""

# Alternative - use single quotes for outer
cleo add 'Task with "quotes" inside'
```

### Backticks for Code

```bash
# CORRECT - escaped backticks
cleo add "Task" --notes "Run \`npm install\` first"

# Alternative - use $() syntax in description
cleo add "Task" --notes 'Run `npm install` first'
```

---

## Validation Errors

If you see validation exit code 6 (`E_VALIDATION_*`), check for unescaped special characters in your text fields. The shell may have interpolated variables before CLEO received the input.

### Debugging Tips

1. Echo your command first to see what the shell produces:
   ```bash
   echo "cleo add \"Task\" --notes \"Price: $500\""
   # Shows: cleo add "Task" --notes "Price: "
   # The $500 became empty (no $500 variable exists)
   ```

2. Use single quotes when escaping is complex:
   ```bash
   cleo add 'Task' --notes 'Price: $500 for "premium" tier'
   ```

---

## HEREDOC for Complex Text

For multi-line or heavily-quoted content, use a HEREDOC:

```bash
cleo update T001 --notes "$(cat <<'EOF'
Complex notes with $variables and "quotes"
that don't need escaping inside HEREDOC.
EOF
)"
```

Note: Use `<<'EOF'` (quoted) to prevent variable expansion, or `<<EOF` (unquoted) if you want variables expanded.

# CLI Reference

The package ships a diagnostic CLI binary: `lafs-conformance`.

It validates envelopes and flag inputs from JSON files and prints a JSON report.

## Run with npm script (repo)

```bash
npm run conformance -- --envelope fixtures/valid-success-envelope.json
```

## Run installed binary

```bash
lafs-conformance --envelope ./envelope.json
lafs-conformance --flags ./flags.json
lafs-conformance --envelope ./envelope.json --flags ./flags.json
```

## Options

| Option | Description |
|---|---|
| `--envelope <path>` | Path to envelope JSON input |
| `--flags <path>` | Path to flags JSON input |

At least one option is required.

## Output shape

Success output:

```json
{
  "success": true,
  "reports": [
    {
      "name": "envelope",
      "report": {
        "ok": true,
        "checks": []
      }
    }
  ]
}
```

Error output:

```json
{
  "success": false,
  "error": {
    "code": "E_INTERNAL_UNEXPECTED",
    "message": "..."
  }
}
```

## Notes

- This CLI is a diagnostic utility, not a LAFS envelope producer.
- Its stdout format is not itself a protocol envelope.
- Implementation source: `src/cli.ts`.

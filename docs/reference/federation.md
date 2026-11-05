# Skills federation guide

CLEO can install skills from multiple sources: the local filesystem, the
canonical CLEO marketplace, and any number of **federation peers** you
explicitly trust. This guide covers the federation model end-to-end:
adding peers, querying them, the trust ladder, install gates, and the
audit trail.

## Federation is OPT-IN

By default, CLEO never makes network requests at startup. The federation
index lives at `~/.cleo/federation.json` and is **empty** on a fresh
install. You explicitly add peers with `cleo federation add`, and
federated search only fans out when you pass `--federated`.

This means:

- No surprise outbound traffic on `cleo` startup.
- No background sync to "discover new skills".
- Your federation peer list is a hand-edited JSON file — you can
  inspect it, version it, or wipe it any time.

## Adding a federation peer

```bash
cleo federation add https://peer.example.org/ --trust unverified
```

The `--trust` flag selects the peer's initial trust tier:

| Trust       | Meaning                                                                                  |
|-------------|------------------------------------------------------------------------------------------|
| `verified`  | Pre-approved. First-install prompts are skipped. Use for repos you fully trust.          |
| `unverified`| Default. Triggers a y/N prompt on first install from this peer.                          |
| `blocked`   | Explicitly denied. Federated search skips this peer entirely.                            |

You can change trust later by re-running `cleo federation add` with a
different `--trust` value (idempotent — same URL upserts in place).

List all peers:

```bash
cleo federation list --human
```

Remove a peer:

```bash
cleo federation remove https://peer.example.org/
```

## Searching skills across sources

The new `cleo skills find` command queries multiple sources at once:

```bash
# default: local + canonical marketplace only — NO federation fan-out
cleo skills find memory

# opt-in to federation peers
cleo skills find memory --federated

# limit results
cleo skills find memory --federated --limit 10
```

Results are ranked by:

```
score = trustWeight × textMatch × (1 + log(1 + usage))
```

Where:

- `trustWeight`: `builtin=4`, `trusted=3`, `community=2`, `agent-created=1`
- `textMatch`: exact name=1.0, prefix=0.8, contains=0.6, description-only=0.4
- `usage`: count from your local `skill_usage` rollup (populated as you
  invoke skills over time — see T9688)

So a local builtin skill always outranks a community skill at the same
text match, but a heavily-used community skill can outrank a never-used
builtin one. The ranking is deterministic — same inputs always produce
the same order.

### Graceful degradation

If a federation peer is offline or returns malformed JSON, the search
**does not fail** — the peer is dropped, a warning is added to
`response.warnings`, and the other peers continue. Same posture for
canonical marketplace failures.

Inspect warnings in JSON mode:

```bash
cleo skills find memory --federated --json | jq '.result.warnings'
```

## Trust matrix (T9730 INSTALL_POLICY)

Every skill install runs through a 2-gate pipeline BEFORE any disk write:

```
resolve → fetch → federation-gate (T9732) → trust-gate (T9730) → fs.copy
```

The **trust gate** combines the skill's verdict (from the 120-pattern
scanner) with its origin tier:

| Tier            | safe  | caution | dangerous |
|-----------------|-------|---------|-----------|
| `builtin`       | allow | allow   | allow     |
| `trusted`       | allow | allow   | **block** |
| `community`     | allow | **block** | **block** |
| `agent-created` | allow | allow   | **ask**   |

A `block` decision refuses the install with `E_SKILL_TRUST_GATE_BLOCKED`
and includes the full `ScanResult` in the error envelope so you can see
exactly which patterns triggered.

### Bypassing block

```bash
cleo skills install owner/repo --force
```

`--force` flips `block` → `allow` AND appends a JSONL row to
`.cleo/audit/skill-trust-bypass.jsonl`:

```jsonc
{
  "timestamp": "2026-05-19T22:30:00Z",
  "skillName": "sketchy",
  "source": "https://random.example/skill",
  "trustLevel": "community",
  "verdict": "dangerous",
  "findingsCount": 3,
  "reason": "operator --force on caamp skills install"
}
```

`--force` never flips `ask` decisions — those require explicit operator
confirmation (or `--allow-new-source` for the first-install prompt
specifically).

## First-install gate (T9732)

When you install from a federation peer for the FIRST time, CLEO
double-checks with you:

```
About to install skill memory from https://peer.example.org/ (trust=unverified).
Proceed? [y/N]
```

If you say no, nothing is written. If you say yes, the install proceeds
through the trust gate.

**Non-TTY contexts** (CI, agents, scripts) can't show a prompt, so they
require an explicit `--allow-new-source` flag:

```bash
cleo skills install https://peer.example.org/skill/memory --allow-new-source
```

Without the flag, you get `E_FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED`
and no fs.copy happens.

`verified` peers (those you explicitly trusted with `cleo federation add
--trust verified`) skip the prompt entirely.

## Checksum validation

If a peer's manifest declares a `sha256` for a skill, CLEO verifies the
download matches before proceeding. Mismatch → `E_FEDERATION_CHECKSUM_MISMATCH`
and no fs.copy.

```bash
# JSON output includes the computed + expected hashes for forensics
cleo skills install https://peer.example.org/skill/foo --json
```

```jsonc
{
  "success": false,
  "error": {
    "code": "E_FEDERATION_CHECKSUM_MISMATCH",
    "details": {
      "expectedChecksum": "abc123…",
      "computedChecksum": "def456…"
    }
  }
}
```

## Quarantine state

Community-tier installs (via `--force`, or imported from unknown Hermes
URLs) enter a **quarantine** state by default. Quarantined skills are
imported into `skills.db` but their `lifecycle_state` requires manual
approval before they activate:

```bash
# review pending quarantined skills
cleo skills find --quarantined --human

# approve one
cleo skill approve <name>

# bulk approve all community-tier
cleo skill approve --all-community
```

Quarantined skills do NOT get loaded by the CLEO runtime, do NOT appear
in `cleo skills list` by default, and do NOT participate in `cleo skills
find` ranking.

## Audit trail

Every trust-related event is logged:

- `--force` bypasses → `.cleo/audit/skill-trust-bypass.jsonl`
- Federation index changes → `~/.cleo/federation.json` itself is the
  audit (every change is a diff in the file)
- Install operations → standard CLEO operation logs (`cleo logs`)

For SOC2 or similar audit requirements, archive the JSONL files as part
of your regular log shipping.

## Configuration

The federation index lives at `~/.cleo/federation.json` and is plain
JSON — operator-managed. Schema:

```jsonc
{
  "version": 1,
  "entries": [
    {
      "url": "https://peer.example.org/",
      "trust": "verified",
      "addedAt": "2026-05-19T22:00:00Z"
    }
  ]
}
```

You can hand-edit this file when needed, but CLEO will overwrite it on
the next `cleo federation add/remove` call. URL normalisation (lowercase
host, trailing slash) is enforced on write.

## Further reading

- [Migrating from Hermes Agent](../migration/hermes-to-cleo.md) — full
  migration walkthrough.
- [ADR-075](../../.cleo/adrs/ADR-075-skills-federation-trust-ladder.md) —
  trust-ladder design + the complete 120-pattern threat table by category.
- `skills-guard` source — `packages/core/src/skills/skills-guard.ts`
- `federated-search` source — `packages/core/src/skills/federated-search.ts`

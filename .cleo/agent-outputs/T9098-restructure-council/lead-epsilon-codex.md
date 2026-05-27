# LEAD EPSILON - Codex / Cross-Provider Proposal

Beta landed while I was drafting; I folded in its contract and DB-topology claims.

## 1. Cross-provider blindspot table

| Surface | Peer assumption | What fails outside Claude-grade agents | Epsilon adjustment |
|---|---|---|---|
| `meta.suggestedNext` | Delta wants literal copyable command strings; Beta adds machine scope. | Codex-style agents may execute shell-looking strings too literally; smaller models may follow risky hints without reading warnings; user-controlled symbols can become command-injection shaped text. | Make `suggestedNext` structured actions (`op`, typed `args`, `effect`, `scope`, `requiresConfirmation`, `reason`). Render shell text as display only. |
| Instruction loading | Gamma's chunk-loader and Delta's 281-token section assume the agent preserves protocol context across the turn. | Gemini / OSS agents with shorter context may drop "project vs cross-project" after reading unrelated code; Codex may privilege repo `AGENTS.md` over a later long help dump. | `cleo briefing inject --section nexus --format adapter:<claude|codex|gemini|compact-json>`; sections need version, 5 hard rules, and no prose-only invariants. |
| Help grouping | Delta keeps one `cleo nexus --help` grouped by five scopes; Alpha splits nouns; Gamma preserves aliases. | Small models scan first 20 lines and latch onto the first plausible verb. Five scopes in one help page still invites `list` vs `context` confusion. | First screen must expose only two buckets: "this repo graph" vs "cross-project registry". Living/hybrid/global are advanced rows under those buckets. |
| Rename vocabulary | Alpha chooses `graph`/`atlas`; Gamma assumes `graph`/`registry`/`brain`; Delta keeps `nexus`; Beta is CLI-neutral. | Non-Claude providers learn exact command strings from examples, not taxonomy. Mixed names across injection, help, and aliases cause persistent drift. | One release vocabulary: `cleo graph` = project-local, `cleo nexus` = cross-project/global. Add `meta.canonicalCommand` to every alias response. |
| DB/package split | Alpha and Beta split DBs; Gamma defers or keeps `nexus.db`; Delta assumes UX can land independently. | Parallel provider workers can run different installed CLEO versions. A file-level migration plus aliases creates hard-to-debug stale reads and lock behavior. | Release 1 should avoid package/DB relocation; ship scope map, metadata, CLI aliases, cleanup tooling, and identity fixes first. |

## 2. Convergence finding

Alpha, Gamma, Delta, and Beta converge on the real invariant: Nexus operations are not one semantic family. The joint recommendation should be: create a single scope-map SSoT mapping every operation to `scope`, binding, effect, stores, index sensitivity, and canonical command, then drive envelopes, help, aliases, and injection from that map. Alpha calls for structural boundaries; Gamma needs the table for aliasing; Delta needs it for help and instructions; Beta specifies the contract shape.

## 3. Divergence finding

The material disagreement is how much renaming and storage movement belongs in the first release. Alpha wants two new top-level nouns and two physical DBs; Beta also favors DB split; Gamma warns that package/DB/file renames are the expensive irreversible moves; Delta optimizes the existing `cleo nexus` surface.

My verdict: ship command and contract disambiguation first, defer package and DB topology. Alpha is right that the name is part of the bug, but Gamma is right about migration blast radius. Delta's grouped single-tree help is not enough for small-context agents. The first release should introduce `cleo graph` for project-local work and narrow `cleo nexus` to cross-project/global work, while keeping old aliases alive with explicit metadata. That buys most of the agent clarity without forcing every provider adapter, installed CLI, SQLite file, and saved prompt through a single flag day.

## 4. Non-obvious risk none flagged

The current project identity algorithm is path-derived: `base64url(args.path ?? process.cwd()).slice(0, 32)`. Cross-provider agents often see the same repo through different mount paths (`/mnt/projects/cleocode`, `/workspace/cleocode`, container bind mounts, symlinks, CI checkout paths). That means Codex, Gemini, and local Claude workers can create distinct project IDs for the same repo even after a DB split. The 80,969 polluted rows are not only a registry/file-boundary problem; they are also an identity-canonicalization problem. Release 1 needs a project identity fingerprint based on git root + normalized realpath + `.cleo/project-info.json:name` + remote URL when present, with path-derived IDs treated as legacy aliases.

## 5. Independent compact recommendation

Smallest one-release restructure: keep packages and DB files stable, add canonical scope contracts, introduce one new top-level project command, and make old `nexus` project verbs noisy aliases.

```text
# Project-local Nexus Graph
cleo graph status
cleo graph analyze [--embeddings]
cleo graph context <symbol>
cleo graph impact <symbol>
cleo graph query "<phrase>"
cleo graph hot-nodes
cleo graph living full-context|why|brain-anchors|task-footprint|conduit-scan

# Nexus cross-project system and global infra
cleo nexus list|scan|show|discover|search|deps|critical-path|blocking|orphans
cleo nexus transfer|transfer-preview|link-tasks <from> <to>
cleo nexus init|register|unregister|permission|share|export|resolve|clean

# Compatibility
cleo nexus context <symbol>  -> alias to `cleo graph context <symbol>`
cleo nexus impact <symbol>   -> alias to `cleo graph impact <symbol>`
```

```ts
meta: {
  _nexus: {
    scope: 'project' | 'living-brain' | 'cross-project' | 'hybrid' | 'global',
    projectId: string | null,
    projectName: string | null,
    bindingSource: 'arg-project-id' | 'arg-path' | 'cwd' | 'registry' | 'none',
    effect: 'read' | 'write' | 'admin',
    canonicalCommand: readonly string[],
    legacyAliasFor?: readonly string[],
    warnings: readonly string[]
  },
  suggestedNext: readonly {
    op: string,
    args: Record<string, string>,
    scope: string,
    effect: 'read' | 'write' | 'admin',
    requiresConfirmation: boolean,
    reason: string
  }[]
}
```

```markdown
## Nexus / Graph
Use `cleo graph` for this repo's code graph. Use `cleo nexus` for registry, cross-repo, transfer, sharing, and global setup.

Before editing a symbol, run `cleo graph impact <symbol> --json`. For symbol lookup use `cleo graph context <symbol>`; for concept search use `cleo graph query "<phrase>"`.

Use `cleo graph living ...` only when you need graph + tasks/brain/conduit for the current repo.

Project resolution for `graph`: `--project-id` > `--path` > cwd. Check JSON `meta._nexus.scope`, `projectId`, `effect`, and `warnings`.

Follow `meta.suggestedNext[]` only when `requiresConfirmation=false`; otherwise report the risk first.
```

Implementation acceptance for this release:

- `NEXUS_SCOPE_MAP` is exhaustive over every current op.
- New `cleo graph` commands are first-class, not docs-only.
- Old project-scoped `cleo nexus *` verbs return `legacyAliasFor`, `canonicalCommand`, and a deprecation warning.
- `cleo briefing inject --section nexus` emits the compact section above, with adapter-specific markdown/JSON modes.
- Project identity canonicalization prevents duplicate IDs for the same git root across provider workspaces.
- `cleo nexus clean --polluted --dry-run` reports the 80,969-row cleanup candidate set before deletion.

## 6. One concrete failure mode of my own proposal

Keeping `cleo nexus` as the cross-project noun while introducing `cleo graph` leaves "Nexus Graph" as a conceptual phrase but not a CLI phrase. Some docs and agents will still say "nexus graph" and try `cleo nexus graph context`. The mitigation is cheap: make `cleo nexus graph <op>` a hidden alias to `cleo graph <op>` for one release and emit the same `canonicalCommand` warning. The cost is that the old overloaded noun survives longer than Alpha would tolerate.

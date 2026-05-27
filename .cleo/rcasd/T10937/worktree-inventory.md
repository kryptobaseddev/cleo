# Worktree Inventory Report — T10937

Generated: 2026-05-27

Cross-references three sources: Git porcelain worktree list, XDG worktree root (`~/.local/share/cleo/worktrees/`), and CLEO sentinel index (`.cleo/worktrees.json`).

## AC1: Inventory Comparison

| Source | Count |
|--------|-------|
| Git worktrees (`git worktree list --porcelain`) | 96 |
| XDG project-hash directories | 31 |
| CLEO sentinel entries (`.cleo/worktrees.json`) | 1 |

## AC2: Non-Canonical Stale Entries

### Non-Canonical Git Worktrees (outside XDG root) — 5 total

| Path | Classification |
|------|---------------|
| `/mnt/projects/cleo-t9759` | Legacy project worktree (T9759) |
| `/mnt/projects/cleocode-t10079-t10089` | Legacy project worktree (T10079-T10089) |
| `/mnt/projects/cleocode-t10083-t10085` | Legacy project worktree (T10083-T10085) |
| `/mnt/projects/cleocode-t9492` | Legacy project worktree (T9492) |
| `/tmp/fix-branch-fix` | Stale temporary worktree (fix/worktree-napi-bundled-release) |

These 5 worktrees exist in git but are outside the canonical `~/.local/share/cleo/worktrees/` root. The `/tmp/fix-branch-fix` entry is a stale temporary worktree.

### Stale XDG Project-Hash Directories (no git worktree) — 29 total

These directories exist in the XDG root but contain no git worktrees (empty or residual):

`08bed9e0091641b8`, `0a940e1ae38807d6`, `0d8159ee2aabbce0`, `0fed111c5598ce8d`, `1000d079a154658c`, `11a8205e42805897`, `1a1af86da0d02dc2`, `1b131930d4c74c58`, `1f899137d3ace271`, `4f2a513f66dcb422`, `5576a58d067b1bd9`, `5eebb2def188df59`, `61b9dcc23608fa8b`, `7206dfbcb9af6406`, `7a68988a94bc2c20`, `89f8c98149869442`, `9c6d9e4b7e4e5f80`, `HjFGtzUronks1mZw98X-TA`, `L21udC9wcm9qZWN0cy9jbGVvY29kZQ`, `ae82415403d93bb7`, `b0c7d2dd5818a15f`, `bfebb4b82ab92b1e`, `cleocode`, `d0e3718a8a30520d`, `d87ed078948feaf9`, `dd99918ee7404504`, `fdf72a7a5ad31fa2`, `tmp`, `tmp-archive-20260525-080514`

## AC3: Unadopted Canonical Worktrees — 89 total

All 89 worktrees under `~/.local/share/cleo/worktrees/1e3146b7352ba279/` exist in both git and XDG but have NO sentinel entry in `.cleo/worktrees.json`. These are canonical CLEO-spawned worktrees that were never adopted into the sentinel.

Task IDs: T10549–T10557, T10560–T10567, T10569–T10599, T10600–T10622, T10625–T10631, T10633, T10635, T10637–T10638, T10640–T10642, T10645, T10647–T10648 (+ T10566-rc3-experiment branch)

One additional worktree under `HjFGtzUronks1mZw98X+TGtctMPNCHK1/T11019` IS adopted in the sentinel (source: manual).

## AC4: Child T10938 Complete

Read git worktree porcelain with `git worktree list --porcelain`. No prune, move, or delete operations were performed. Raw output saved at `.cleo/rcasd/T10937/git-worktree-porcelain.txt`.

## AC5: Child T10939 Complete

Listed XDG worktree root `~/.local/share/cleo/worktrees/` — 31 directories, all directories (no non-directory artifacts found). Raw output at `.cleo/rcasd/T10937/xdg-root-listing.txt`.

## AC6: Child T10940 Complete

Compared `.cleo/worktrees.json` sentinel against git worktree list. Found 1 sentinel entry (T11019, adopted), 0 stale sentinel entries (all sentinel paths exist in git), and 89 unadopted canonical worktrees (in git + XDG but not sentinel).

## Key Findings

- **89 unadopted worktrees**: The vast majority of CLEO-spawned worktrees were never registered in `.cleo/worktrees.json`. This means `cleo worktree list` and `cleo worktree prune` are blind to them.
- **29 stale XDG directories**: Many project-hash directories are empty/leftover from previous runs and no longer contain git worktrees.
- **5 non-canonical worktrees**: Legacy worktrees outside XDG root, including one stale `/tmp` entry.
- **Only 1 sentinel entry**: The sentinel has near-zero coverage of the actual worktree landscape, making it useless for lifecycle management until adoption coverage improves.

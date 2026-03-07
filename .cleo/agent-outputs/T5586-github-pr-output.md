# T5586 — github-pr.ts Implementation Report

**Agent**: B2 (impl-github-pr)
**Status**: COMPLETE

---

## File Written

**Path**: `/mnt/projects/claude-todo/src/core/release/github-pr.ts`

---

## Exported Symbols

### Interfaces
- `BranchProtectionResult` — `{ protected, detectionMethod, error? }`
- `PRCreateOptions` — `{ base, head, title, body, labels?, version, epicId?, projectRoot? }`
- `PRResult` — `{ mode, prUrl?, prNumber?, instructions?, error? }`
- `RepoIdentity` — `{ owner, repo }`

### Functions
- `isGhCliAvailable(): boolean`
- `extractRepoOwnerAndName(remote: string): RepoIdentity | null`
- `detectBranchProtection(branch, remote, projectRoot?): Promise<BranchProtectionResult>`
- `buildPRBody(opts: PRCreateOptions): string`
- `createPullRequest(opts: PRCreateOptions): Promise<PRResult>`
- `formatManualPRInstructions(opts: PRCreateOptions): string`

---

## Detection Strategy Summary

### `detectBranchProtection`

**Strategy 1 — gh API (preferred)**:
1. `git remote get-url <remote>` to get the remote URL
2. Parse owner/repo via `extractRepoOwnerAndName()`
3. `gh api /repos/{owner}/{repo}/branches/{branch}/protection`
4. Exit 0 → `protected: true, method: 'gh-api'`
5. 404/Not Found in stderr → `protected: false, method: 'gh-api'`
6. Any other error or parse failure → fall through to Strategy 2

**Strategy 2 — push dry-run (fallback)**:
1. `git push --dry-run <remote> HEAD:<branch>`
2. Inspect both success output and error stderr for: `protected branch`, `GH006`, `refusing to allow`
3. Match → `protected: true, method: 'push-dry-run'`
4. No match + success → `protected: false, method: 'push-dry-run'`
5. Other error → `protected: false, method: 'unknown', error: <message>`

---

## Edge Cases Handled

| Case | Handling |
|---|---|
| `gh` CLI not installed | `isGhCliAvailable()` returns false via try/catch on `gh --version`; `createPullRequest` returns `mode: 'manual'` with instructions |
| PR already exists | stderr check for `'already exists'`; returns `mode: 'skipped'` with URL extracted from stderr if present |
| Remote URL parse failure | Falls through from Strategy 1 to Strategy 2 in `detectBranchProtection` |
| `git remote get-url` failure | Caught; falls through to Strategy 2 |
| gh API non-404 error | Caught; falls through to Strategy 2 |
| SSH and HTTPS remote formats | Both handled by `extractRepoOwnerAndName` via separate regex patterns; `.git` suffix stripped |
| Labels array | Each label appended as separate `--label <value>` args (no shell injection risk) |
| epicId absent | `buildPRBody` and `formatManualPRInstructions` both omit the epic line cleanly |
| projectRoot not provided | `cwd` option is omitted entirely (not set to undefined) to use process cwd |

---

## Implementation Notes

- All subprocess calls use `execFileSync` with `stdio: 'pipe'` — no shell:true, no injection risk
- All local imports use `.js` extensions (ESM convention) — this file has no local imports
- `createPullRequest` and `detectBranchProtection` are `async` functions returning `Promise` (async keyword present, consistent with declared signatures)
- No TODO comments; fully implemented
- TypeScript strict mode compatible — all types explicit, no `any`
- stderr extraction from caught errors uses a safe cast pattern checking for `'stderr' in err` before accessing

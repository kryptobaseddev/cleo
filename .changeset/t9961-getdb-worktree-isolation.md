---
"@cleocode/core": patch
---

- Route `getDb()` through the T9806 worktree-isolation guard so all ~61 direct core callers are protected (not just the ~28 that route through `openCleoDb`).

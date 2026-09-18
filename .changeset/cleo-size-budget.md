---
id: cleo-size-budget
tasks: [T12244]
kind: fix
summary: The package users install finally has a size budget, and it has floors as well as a ceiling
---

**gh#1472, gh#1478.** `@cleocode/cleo` reached 80.6 MB unpacked across 1059
files and nothing in the repo could see it. The only size gate covers
`@cleocode/core` — not the package that gates `npm i -g`.

Its neighbour `scripts/assert-cleo-tarball.mjs` cannot help: every assertion is
an `existsSync`, so **re-adding the 48.5 MB that gh#1472 removed would make all
of them MORE true**. The two now run back to back and ask opposite questions.

**Floors, not just a ceiling.** A ceiling-only gate is green on an *empty*
package — which is not hypothetical, it is the exact T12011 defect where
`studio-dist` was never created, npm silently omitted the `files[]` entry, and a
Studio-less CLI shipped reporting success. `studio-dist` alone is ~27 MB, so
that tree reads ~5 MB: far *under* any ceiling.

**It refuses to measure a dev tree** rather than reporting a confident wrong
number. Local `dist/` is tsc output (320 `.js`, 320 `.d.ts`, 640 `.map`) while
CI publishes the 2-file esbuild bundle; `npm pack --dry-run` locally reports
**2006 files against the 728 that ship**. The check is a positive identity
assertion on build shape — no declarations, no `.js` outside `build.mjs`'s
single declared entry — not a heuristic about counts, and it fails `E_DEV_TREE`
naming the remedy. No `--ci` flag and no env bypass: an escape hatch is how a
gate becomes decorative.

**`dist/cli/index.js.map` is 1.62 MB nothing reads.** `--enable-source-maps`
appears exactly once in this repo, as a *comment* at `build.mjs:375`;
`bin/cleo.js` re-execs with only `--max-old-space-size` and
`--disable-warning`. Excluded via a `files[]` negation with `sourcemap:
'linked'` untouched — out of the package, never out of the build tree. Nothing
is lost: traces in bug reports are *already* bundled positions, because the map
is inert without a flag nobody sets. The exclusion is **asserted** by the gate,
not merely declared.

**The falsified mechanism is corrected where the next reader finds it.**
`copy-studio-dist.mjs`'s docblock asserted that "npm QUEUES packages that large
for asynchronous processing and returns exit 0 immediately" — the rationale
docblock of the script that performs the cut. Three measurements killed it: six
consecutive releases at a **byte-identical** 80.6 MB spanned 4m55s–55m11s;
v2026.9.7 cut to 32.1 MB and took **3.2× longer**; and in that same run
`@cleocode/core` (42.8 MB, 5319 files — larger, 7× the files) converged in
3m47s while `cleo` took 175m.

The docblock now **records the correction** rather than deleting the claim, so
the reasoning cannot be rebuilt from the same intuition. The exclusion itself is
untouched and correct — it was always a good install-time optimization, and only
ever mislabelled as a publish-latency fix.

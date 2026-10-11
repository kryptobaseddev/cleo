---
id: t13512-no-run-linked
tasks: [T13512]
kind: fix
summary: "cleo verify --no-run needs cached passes only for the typed gates the write links, and cleo verify --run reports per gate whether its pass was cached and under which HEAD"
---

- **`--no-run`:** a gate write with `--no-run` refused with `E_GATE_NOT_CACHED`
  when any typed gate on the task lacked a cached pass, even a gate whose
  criterion the write did not link. It now requires cached passes only for the
  typed gates whose criteria the write links (`satisfies:`). An unlinked gate
  is recorded as not run, an unmet result that `cleo complete` still requires.
  A tampered cache entry is still refused outright.
- **`--run`:** `persisted: false` means the run recorded no verification,
  which is by design. Passes are still cached, keyed on HEAD, the dirty-tree
  fingerprint, the cwd and the gate's inputs. The response now carries
  `cache: { head, entries }`, saying per gate whether its pass was cached and,
  if not, why: `evidence.allowCachedGates` is false, not a git checkout,
  inputs not captured, a non-cacheable kind, or not a pass. A later `--no-run`
  at another HEAD or working tree misses those passes, which is the case axiom
  hit.

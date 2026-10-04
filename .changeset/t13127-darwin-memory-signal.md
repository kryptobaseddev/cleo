---
id: t13127-darwin-memory-signal
tasks: [T13127]
kind: fix
summary: "macOS memory pressure is now visible to admission: the darwin backend grades a kernel warning by RAM squeeze and swap and scores running out of headroom in absolute bytes, so the existing budget narrowing and cleo run's pause at backoff finally act on a Mac whose swap is nearly full, without flagging laptops that merely carry old swap"
---
- **The signal macOS was missing.** The darwin backend used to score only the
  kernel pressure level, plus a free-memory term that almost never fired. The
  repo's own capture of a loaded Mac scored 15 (hold): a kernel warning, 41%
  of RAM neither wired nor compressed, and 11.4 GiB of swap. So did the
  2026-10-03 incident (13.6 of 15.4 GB swap used, 15 GB compressed).
  Admission never saw how full the machine was.
- **Graded by the kernel's own verdict.** A kernel warning (15) or critical
  (40) now grows with how squeezed RAM is. Each point of RAM wired or
  compressed above half adds one, and the swap that squeeze pushed out adds
  `50 × swap/RAM`. The incident shape now scores 38, which is backoff: the
  heavy budgets narrow to one run and `cleo run` pauses younger jobs.
- **Old swap is not pressure.** Swap counts only while the kernel says
  warning or critical, and only as the compressor is actually squeezed.
  Swapped pages linger for hours after pressure is gone. At a normal kernel
  level, a 16 GiB laptop with 6 GiB of old swap, an 8 GiB Air, and a big Mac
  with tens of GiB of wired local-model weights all score 0.
- **Headroom in bytes.** At any kernel level, memory scores once what is
  neither wired nor compressed falls below one heavy worker's footprint:
  6 GiB, or a quarter of RAM on a small machine.
- **One sysctl exec.** The compressor's occupancy (`vm.compressor_bytes_used`)
  is read in the same cached exec as the other signals, with no `vm_stat`
  spawn. The readings travel on the sample as `darwinMemory`.
- **A probe always gets one try.** Acquiring a tool slot with
  `timeoutMs: 0` (or a budget already spent) now tries once before giving up.
  Before, the clock was checked first, so such a probe never looked at a free
  slot.

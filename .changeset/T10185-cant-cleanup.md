---
'@cleocode/cleo': patch
---

chore(T10185): drop unused cleo-conduit-core dep from cant-core (saga T10180).
cant-core never referenced any conduit symbol across 60+ src files — pre-existing
bogus Cargo coupling. Removing makes cant-core a true leaf crate, ready for
crates.io publish in any order alongside lafs-core and cleo-conduit-core.

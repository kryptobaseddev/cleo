---
id: t13370-home-brain-stream
tasks: [T13370]
kind: feat
summary: The main brain syncs end to end on home:<user>, and cloud status reports the home stream's cut, unsent ops and pull position
---

The global store's brain tables now travel the account's `home:<user>` stream
end to end: one device cuts the stream's genesis, a second restores and joins
it, and `cleo cloud sync` carries each device's brain writes (observations,
decisions, patterns, learnings, page nodes and edges, sticky notes) to the
other with the same row uid and content hash. A concurrent edit to one row
resolves by the merge rules to the same value on both.

Fixed on the way: a bundle carried the store's `cleo.db.restoring` marker. The
genesis snapshot is taken while that marker is held, so a device that restored
the main brain found the first device's genesis marker beside its store and
refused every open (`E_STORE_GENESIS`) until it aged out; it could never join.
Restore and genesis markers are now excluded from every bundle section.

`cleo cloud status` names a store's stream from its own journal when no link
names it (the global store learns `home:<user>` from its genesis cut or pull
position), and reports the stream's genesis cut, whether its checkpoint is
still unconfirmed, the ops sealed but not yet stored by the server, the last
server sequence pushed, and how far the pull has staged.

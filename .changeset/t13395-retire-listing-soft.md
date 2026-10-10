---
id: t13395-retire-listing-soft
tasks: [T13395]
kind: fix
summary: a global pull survives a failed home replica listing; no retire is confirmed that round
---

A global-store pull reads `GET /v1/account/home/replicas` to confirm replica retires (T13366). A
failure of that read (network, a 5xx, a 404) used to fail the whole pull. It now confirms nothing
for that round and adds a `W_NEXUS_RETIREMENTS_UNAVAILABLE` warning. The pull still stages and
applies, and any retire it records stays unconfirmed (late segments keep their conflict records)
until a later pull reads the listing.

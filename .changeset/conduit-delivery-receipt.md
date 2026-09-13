---
id: conduit-delivery-receipt
tasks: [T12173]
kind: fix
summary: Conduit send reports when a message was ACCEPTED; deliveredAt is null until delivery is confirmed
---

**gh#1316.** `ConduitClient.send` and `publishToTopic` returned

```ts
{ messageId, deliveredAt: new Date().toISOString() }
```

for a row the transport had just written `status = 'pending'`. That is not an
approximation of a delivery time — the transport returns none, the row says the
message is undelivered, and the schema has a **separate** real `delivered_at`
that a different path fills in later. The system models the distinction
correctly everywhere except at the boundary where it is reported.

**The cause was the contract, not the call site.** `deliveredAt: string` was
**required**, so "accepted but not yet delivered" — the normal case, and the
state every message passes through — was *unrepresentable at the type level*.
The only way to satisfy the contract was to invent a value, and that is what the
code did. Fixing the two call sites without fixing the type would have left the
next producer with the same forced choice.

So the two facts are now separate:

```ts
acceptedAt: string         // what a send genuinely knows
deliveredAt: string | null // null until delivery is confirmed
```

**Widening the type first is what found the producers.** `tsc` named both
immediately (`TS2741` at `conduit-client.ts:73` and `:169`) rather than my
having to grep for them.

And re-deriving the affected surface **from the source rather than from the
fix** found a **third** test — `a2a-topic.test.ts` asserted
`deliveredAt: expect.any(String)`, which a search anchored on the files I had
already touched would have missed. Three tests were pinning the synthesized
receipt; a required-string assertion is precisely what made inventing the value
necessary.

The CLI reports both timestamps, so a caller does not simply get a `null` where
a real value used to be — it gets the fact that is actually true.

56/56 across the three conduit suites. Typecheck 0 in contracts, core and cleo.

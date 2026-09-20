---
epic: T12244
stage: research
task: T12244
related:
  - type: task
    id: T12244
created: 2026-09-18
updated: 2026-09-20
audience: maintainer
title: Axiom audit findings and verification limits
---
# Axiom audit findings and verification limits

## Question

What did the original Axiom audit establish, and what still needs a behavioral test?

This is a reconstruction dated 2026-09-20 from preserved evidence. It replaces an empty stage marker; it does not claim that this report existed during the original investigation.

## Findings

The untouched audit contains 26 command records captured at 2026-09-18T16:57Z with CLI 2026.9.7, project `/mnt/projects/axiom-analytics`, and app revision `a85e95f26057a5c4e19a639947620147d5217007`. It records commands, output, elapsed time, and exit status. Its scope excludes rebuilding the index, cleanup, decision corrections, and task mutations; reads may update access or citation metadata.

The accompanying provenance note identifies five failures requiring independent oracles: a decision-only filter returned observations; a structurally clean doctor result concealed unhealthy extraction; T448 reported NONE despite structured file/commit evidence; qualified symbols resolved inconsistently between full-context and impact; and stale checkouts appeared in the index. These are historical observations, not measurements of the current artifact. Preserve successful image-expiry retrieval as a control rather than deleting incident knowledge during cleanup.

The later validation report distinguishes its sanitized 26-scenario catalog from executable behavioral coverage. It also records replay commands exiting successfully while semantic residuals remained. Therefore each observation needs an expected result stated independently of process success. Parser precision, evidence preservation, authority eligibility, and missing coverage must be checked in the returned content.

New investigation must report source revision and inventory, requested versus completed capability, diagnostic failures, and UNKNOWN when the evidence cannot support impact assessment. Documentary recovery does not settle T136 scientific authority. Authentic recovery of a missing observation requires the actual payload; a nearby title or inferred summary is insufficient.

## Sources

Fetch `axiom-audit-command-evidence-20260918` for the unchanged 72,320-byte audit, SHA256 `b20358dd1617094a8f174268e53fb36f374fcf4ac2c4ace7d8e33ad03b32698a`. Fetch `axiom-knowledge-original-audit` for its 1,157-byte provenance note, SHA256 `a1f81b82684ef49fecbcef3a9868139ed4c627b91a741d795a43facc05357fde`.

Fetch `trustworthy-knowledge-implementation-validation-20260918` for historical validation, SHA256 `704f5f06601ba126830cb349ce74f5ae4f8dab073b62a62dc26f99b359329cec`. Current findings belong in `trustworthy-knowledge-closure-ledger-20260919`; historical counts are not fresh verification.

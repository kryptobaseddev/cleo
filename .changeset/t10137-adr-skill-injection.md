---
id: t10137-adr-skill-injection
tasks: [T10137]
kind: docs
summary: "B12 finalize ADR-077, update ct-cleo skill (Tier-0), add Human Render Contract to CLEO-INJECTION"
prs: [561]
---

Three coordinated deliverables that close Epic T10114:

1. ADR-077 promoted to Accepted/Implemented. Documents
   `BadgeIcon.ORPHAN='👻'` deviation (TypeScript string enum collision
   with `StatusIcon.BLOCKED='🚪'`). Documents the side-effect
   registration pattern used by B6/B7/B8 migrations.
2. `ct-cleo` skill (Tier-0) gains a Human Render Contract section
   documenting `cleo tree`, `cleo show --human`, and the
   `RenderableEnvelope` discriminator. Frontmatter
   `version: 2.1.0`, `lastReviewed: 2026-05-23`, `stability: stable`.
3. `CLEO-INJECTION.md` template adds a short Human Render Contract
   section pointing to ADR-077.

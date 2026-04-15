# llmtxt.my Multi-Agent Collaboration — SITREP

**Date**: 2026-04-11
**Test Document**: slug `9fZLOnf5` (7 versions, 18,853 tokens final)
**API Base**: `https://api.llmtxt.my`
**Auth Mode**: Anonymous session (24h TTL)
**Test Scenario**: 3 agents independently write consolidated spec versions, orchestrator compares and synthesizes final

---

## Executive Summary

llmtxt.my has strong **document primitives** (compression, versioning, progressive disclosure) but is **missing the multi-agent collaboration layer** needed for the ideal flow. The building blocks exist — versioning, diffs, contributor tracking, approvals — but they don't compose into a usable multi-agent workflow without significant manual orchestration.

**Verdict**: 6/10 for current multi-agent use. Strong foundation, needs 4 specific features to be excellent.

---

## The Ideal Flow (What We Wanted)

```
1. Main Agent uploads doc → gets slug
2. Hands slug + instructions to Agent A, B, C, D
3. Each agent reviews at own pace, uploads their version
4. Multi-diff compares up to 5 versions simultaneously
5. Cherry-pick merge: "Keep lines 1-20,180 from v2, lines 50-75,86 from v3"
6. Merged into new final version
```

## What Actually Works

### ✅ Document Upload & Versioning
- `POST /compress` creates doc, returns slug — **works perfectly**
- `PUT /documents/:slug` creates new version with full content — **works**
- `GET /documents/:slug/versions` lists all versions with token counts — **works**
- `GET /documents/:slug/versions/:num` returns full content for any version — **works**
- Versions persist indefinitely (anonymous = 24h, registered = permanent)

### ✅ Pairwise Diffs
- `GET /documents/:slug/diff?from=N&to=M` — **works**, returns line-level diff
- Can compare any two arbitrary versions (not just adjacent)
- Returns `lines` array with `type: added/removed/context`, `oldLine`, `newLine`

### ✅ Progressive Disclosure
- `GET /documents/:slug/overview` — section-level structure with token counts — **works well**
- `GET /documents/:slug/lines?start=N&end=M` — line-range extraction — **works**
- `GET /documents/:slug/sections/:name` — named section extraction — **works**
- `POST /documents/:slug/batch` — multi-section retrieval — **works**
- `POST /documents/:slug/plan-retrieval` — token-budgeted smart selection — **works, very useful**

### ✅ Contributor Tracking (Partial)
- `GET /documents/:slug/contributors` returns contributor stats
- Tracks `versionsAuthored`, `totalTokensAdded`, `totalTokensRemoved`, `netTokens`
- **BUT**: only tracks by session user ID, not per-agent identity (see issues)

### ✅ Graph Extraction
- `GET /documents/:slug/graph` extracts mentions and relationships — **works**
- Found `@xenova`, `@cleocode` references automatically

---

## What Doesn't Work / Is Missing

### ❌ ISSUE 1: Multi-Diff (CRITICAL — Does Not Exist)

**Expected**: Compare 3-5 versions simultaneously
**Actual**: Only pairwise diff (`from=N&to=M`). No multi-version comparison.

**Reproduction**:
```bash
# Both fail with "Invalid query parameters"
curl "https://api.llmtxt.my/documents/9fZLOnf5/diff?from=2&to=3&to=4"
curl "https://api.llmtxt.my/documents/9fZLOnf5/diff?versions=2,3,4"
```

**Impact**: Orchestrator must make N*(N-1)/2 pairwise diff calls to compare N versions. For 5 versions = 10 API calls. No unified view.

**Recommendation**: Add `GET /documents/:slug/multi-diff?versions=2,3,4,5` that returns a unified comparison matrix showing which lines differ across versions, with consensus detection (e.g., "3 of 4 agents kept this line").

---

### ❌ ISSUE 2: Cherry-Pick Merge (CRITICAL — Does Not Exist)

**Expected**: "Keep lines 1-20 from v2, lines 50-75 from v3, merge into new version"
**Actual**: No merge endpoint. Only full-content PUT or unified-diff PATCH.

**Reproduction**: No endpoint exists. The closest is `POST /documents/:slug/patch` which applies a unified diff, but that's a single-source patch, not a multi-source merge.

**Impact**: Orchestrator must manually reconstruct the merged content by reading each version's content, splicing lines, and uploading the result as a new PUT. This defeats the purpose of having the platform do the merge.

**Recommendation**: Add `POST /documents/:slug/merge` accepting:
```json
{
  "sources": [
    { "version": 2, "sections": ["Section 1", "Section 2"] },
    { "version": 3, "sections": ["Section 3", "Section 4"] },
    { "version": 4, "lineRanges": [[1, 20], [180, 200]] }
  ],
  "base": 2,
  "changelog": "Merged best of agents A, B, C"
}
```

---

### ❌ ISSUE 3: Agent Identity Per Version (BROKEN for Anonymous)

**Expected**: Each agent's version attributed to that agent
**Actual**: `createdBy` is `null` for all PUT-created versions. Only v1 (initial upload) has `createdBy` populated.

**Reproduction**:
```bash
# Upload with explicit agentId — ignored
curl -X PUT "https://api.llmtxt.my/documents/9fZLOnf5" \
  -d '{"content": "test", "agentId": "agent-b-engineer", "changelog": "Agent B version"}' \
  -b cookies.txt

# Check version — createdBy is null
curl "https://api.llmtxt.my/documents/9fZLOnf5/versions"
# v6: createdBy=null, changelog="Agent B version"
```

**Root Cause**: The `agentId` field in the PUT body is not used for attribution. The `createdBy` field is only populated from the session's user ID, and only for the initial compress (v1). Subsequent PUT operations don't set it.

**Impact**: All versions look like they came from the same anonymous user. The orchestrator has no way to attribute "this version was written by Agent A" vs "Agent B" without maintaining a side-channel mapping.

**Recommendation**:
1. Accept `agentId` in PUT body and store it in the version's `createdBy` field
2. Or: populate `createdBy` from session user ID for ALL versions, not just v1
3. Display agent identity in the contributor summary per-version, not just aggregate

---

### ❌ ISSUE 4: Lifecycle Features Gate on Registered Account

**Expected**: Transition to REVIEW state, collect approvals from agents
**Actual**: `POST /documents/:slug/transition` and `POST /documents/:slug/approve` return 403 for anonymous sessions.

**Reproduction**:
```bash
curl -X POST "https://api.llmtxt.my/documents/9fZLOnf5/transition" \
  -d '{"targetState": "REVIEW"}' -b cookies.txt
# {"error":"Forbidden","message":"This feature requires a registered account..."}

curl -X POST "https://api.llmtxt.my/documents/9fZLOnf5/approve" \
  -d '{"reason":"Looks good"}' -b cookies.txt
# {"error":"Forbidden","message":"This feature requires a registered account..."}
```

**Impact**: The entire consensus workflow (DRAFT→REVIEW→LOCKED) is inaccessible to agents using anonymous sessions. Since agents can't easily sign up with email, this blocks the approval-based collaboration model.

**Recommendation**: Either allow anonymous sessions to use lifecycle features (with the 24h TTL as natural expiry), or provide a token-based auth method that agents can use without email signup (API keys, bearer tokens).

---

### ⚠️ ISSUE 5: Cloudflare 1010 Blocking (Python urllib)

**Expected**: Any HTTP client can access the API
**Actual**: Python's `urllib` is blocked by Cloudflare error 1010 when no `User-Agent` header is set.

**Reproduction**:
```python
# FAILS — 403, error code 1010
import urllib.request
req = urllib.request.Request('https://api.llmtxt.my/auth/sign-in/anonymous',
    data=b'{}', headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req)  # HTTPError 403

# WORKS — add User-Agent
req = urllib.request.Request('https://api.llmtxt.my/auth/sign-in/anonymous',
    data=b'{}', headers={
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 llmtxt-sdk/1.0'
    })
urllib.request.urlopen(req)  # 200 OK
```

**Impact**: Python agents using stdlib will fail silently. The `requests` library works because it sets a default User-Agent.

**Recommendation**: Either relax Cloudflare rules for API endpoints, or document the User-Agent requirement prominently. Better yet, provide a `X-LLMtxt-Agent` header that bypasses the bot detection.

---

### ⚠️ ISSUE 6: Similarity Search Response — Inconsistent Field Names

**Expected**: Section title in similarity results
**Actual**: Field is called `sectionTitle` in similarity results but `title` in overview/plan-retrieval.

**Reproduction**:
```bash
# Similarity returns sectionTitle (not title)
curl ".../similar?q=invariants&method=ngram"
# {"results": [{"score": 0.078, "sectionTitle": "...", "sectionIndex": 5, "startLine": 641}]}

# Overview returns title
curl ".../overview"
# {"sections": [{"title": "Section 1: ...", "depth": 2, "tokenCount": 215}]}

# Plan-retrieval returns title
curl -X POST ".../plan-retrieval" -d '{"tokenBudget": 2000}'
# {"plan": {"sections": [{"title": "Section 1: ...", "tokenCount": 215}]}}
```

**Impact**: Agents parsing responses need to know 3 different field names for the same concept. Minor but annoying.

**Recommendation**: Normalize to `title` everywhere, or alias `sectionTitle` → `title` in similarity results.

---

### ⚠️ ISSUE 7: Signed URLs Require Registered Account

**Expected**: Signed URLs would enable per-agent access tokens for document collaboration
**Actual**: `POST /signed-urls` returns 403 for anonymous users.

**Reproduction**:
```bash
curl -X POST "https://api.llmtxt.my/signed-urls" \
  -d '{"slug":"9fZLOnf5","agentId":"agent-b","conversationId":"conv-001","expiresInMs":3600000}' \
  -b cookies.txt
# {"error":"Forbidden","message":"This feature requires a registered account..."}
```

**Impact**: The signed URL system is designed exactly for multi-agent handoff (owner creates scoped tokens per agent), but it's gated behind email registration. AI agents can't easily register with email.

---

## Feature Gap Analysis

| Ideal Flow Step | API Support | Status | Gap |
|----------------|-------------|--------|-----|
| Main agent uploads doc | `POST /compress` | ✅ Works | — |
| Get slug for handoff | Returns in response | ✅ Works | — |
| Agent reads doc | `GET /documents/:slug/overview` + `/raw` | ✅ Works | — |
| Agent adds their version | `PUT /documents/:slug` | ✅ Works | No agent attribution |
| Compare 2 versions | `GET .../diff?from=N&to=M` | ✅ Works | — |
| Compare 3-5 versions | — | ❌ Missing | Need multi-diff |
| Cherry-pick lines from versions | — | ❌ Missing | Need merge endpoint |
| Attribute version to agent | `createdBy` field | ⚠️ Broken | Null for PUT ops |
| Lifecycle (REVIEW→LOCKED) | `POST .../transition` | ⚠️ Auth-gated | Needs anonymous support |
| Approval voting | `POST .../approve` | ⚠️ Auth-gated | Needs anonymous support |
| Agent handoff tokens | `POST /signed-urls` | ⚠️ Auth-gated | Needs anonymous support |

---

## Proposed Improvements (Priority Order)

### P0 — Must Have for Multi-Agent Flow

1. **Multi-diff endpoint**: `GET /documents/:slug/multi-diff?versions=2,3,4,5`
   - Returns unified comparison showing per-line agreement/divergence across N versions
   - Include consensus indicator: "3/4 agents wrote the same line here"

2. **Cherry-pick merge endpoint**: `POST /documents/:slug/merge`
   - Accept section-level or line-range sources from different versions
   - Create new version from the merge result
   - Track which source version contributed each section

3. **Fix `createdBy` for PUT operations**: Populate from session or accept `agentId` in body
   - Essential for knowing who wrote what

### P1 — Should Have

4. **Anonymous lifecycle access**: Allow DRAFT→REVIEW→LOCKED for anonymous sessions
   - Or: provide API key auth that doesn't require email

5. **Agent-aware signed URLs for anonymous owners**: Let anonymous doc owners create scoped agent tokens
   - Each agent gets a unique identity when contributing

6. **Normalize field names**: `title` everywhere (not `sectionTitle` in similarity)

### P2 — Nice to Have

7. **SDK agent collaboration helpers**: High-level functions like:
   ```typescript
   const collab = await llmtxt.startCollaboration(slug, {
     agents: ['agent-a', 'agent-b', 'agent-c'],
     reviewPolicy: { requiredCount: 2 }
   });
   // Each agent gets a scoped token and contribution workflow
   ```

8. **Diff summary endpoint**: Return stats (lines added/removed/unchanged, sections modified) without the full patch
   - Current diff returns massive JSON with every line; no summary mode

9. **Version branching**: Allow parallel version branches (not just linear v1→v2→v3)
   - Agent A creates branch-a from v1, Agent B creates branch-b from v1
   - Merge branches later

---

## What Worked Well

- **Compression**: 3.45x ratio on markdown specs — excellent for token-constrained agents
- **Progressive disclosure**: `plan-retrieval` is genuinely smart — it prioritizes query-relevant sections within a token budget
- **Version history**: All 7 versions preserved with content hashes and token counts
- **Line-range extraction**: `GET .../lines?start=N&end=M` enables precise section reads
- **Batch section retrieval**: `POST .../batch` with section names works reliably
- **Graph extraction**: Automatically found `@xenova` and `@cleocode` mentions

## Workarounds Used

1. **No multi-diff**: Made 3 separate pairwise diff calls (v2↔v3, v2↔v4, v3↔v4)
2. **No cherry-pick merge**: Synthesis agent read all 3 versions locally, wrote merged version, uploaded via PUT
3. **No agent identity**: Maintained manual mapping: v2=Agent B, v3=Agent C, v4=Agent A
4. **Cloudflare blocking**: Used curl with User-Agent header instead of Python urllib
5. **No lifecycle/approvals**: Skipped consensus workflow entirely, orchestrator made the call

---

## Appendix: Test Document

- **Slug**: `9fZLOnf5`
- **URL**: `https://api.llmtxt.my/documents/9fZLOnf5`
- **Versions**: 7 (v1=base, v2=Agent B, v3=Agent C, v4=Agent A, v5=synthesis, v6=test, v7=restored)
- **Final tokens**: 18,853
- **Anonymous session expires**: ~2026-04-12T15:00Z

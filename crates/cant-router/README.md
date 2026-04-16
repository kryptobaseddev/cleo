# cant-router — CleoOS v2 Model Router

3-layer model router implementing [**ULTRAPLAN §11**](../../docs/plans/CLEO-ULTRAPLAN.md): classify a prompt by complexity, select a model tier, route with cost caps + latency budgets, and downgrade on cap overrun (fail-open).

Pure Rust library. Callable from Node/TS via [`cant-napi`](../cant-napi/README.md).

---

## Architecture

```
Prompt (string)
  │
  ▼ Layer 1 — Classifier (pure, weighted linear scorer)
PromptFeatures
  │   ├─ token_count          (weight 0.15)
  │   ├─ syntactic_complexity (weight 0.25)
  │   ├─ reasoning_depth      (weight 0.30)
  │   ├─ domain_specificity   (weight 0.20)
  │   └─ touches_files_count  (weight 0.10)
  │
  ▼
Classification { score, tier: Low | Mid | High }
  │
  ▼ Layer 2 — Router (rules engine → tier matrix)
ModelSelection { primary_model, fallback_models, cost_cap_usd, latency_budget_ms, reason }
  │
  ▼ Layer 3 — Pipeline (observation log)
ObservationLog (append-only, thread-safe, feeds future v2 reranker)
```

---

## Tier Matrix (v1 defaults)

| Tier | Score threshold | Primary | Fallback chain | Cost cap | Latency budget |
|------|----------------|---------|----------------|----------|---------------|
| **Low** | `< 0.35` | `claude-haiku-4-5` | `kimi-k2.5` | `$0.10` | `10 s` |
| **Mid** | `0.35 ≤ score < 0.75` | `claude-sonnet-4-6` | `kimi-k2.5`, `claude-haiku-4-5` | `$0.50` | `30 s` |
| **High** | `>= 0.75` | `claude-opus-4-6` | `claude-sonnet-4-6`, `kimi-k2.5` | `$2.00` | `60 s` |

---

## Use from Rust

```rust
use cant_router::{classify, extract_features, route, downgrade_for_cost, Tier};

let prompt = "Refactor the auth module to use JWT tokens.";
let features = extract_features(prompt);
let classification = classify(features);
let selection = route(classification);

// `selection.primary_model` now holds the chosen model id,
// `selection.fallback_models` the fallback chain, and the
// cost + latency caps are populated for downstream enforcement.
```

### Downgrade on cost-cap trip (fail-open)

```rust
use cant_router::{route, downgrade_for_cost};

// Suppose the upstream broker exceeds the cost cap. Walk down one tier.
let downgraded = downgrade_for_cost(selection);
match downgraded {
    Some(s) => /* retry with s.primary_model */,
    None    => /* already at Low — surface error to caller */,
}
```

### Observation logging (Layer 3)

```rust
use cant_router::{ObservationLog, types::RoutingObservation};

let log = ObservationLog::new();
log.record(RoutingObservation {
    features,
    classification,
    selection,
    timestamp: chrono::Utc::now().to_rfc3339(),
});

// Later — snapshot for the future v2 reranker training set.
let snap = log.snapshot();
```

---

## Use from TypeScript (via cant-napi)

The NAPI bridge exposes router functions alongside `cantParse`:

```ts
import {
  cantRouterExtractFeatures,
  cantRouterClassify,
  cantRouterRoute,
  cantRouterDowngrade,
} from '@cleocode/cant-napi'; // or the in-tree binary

const features = cantRouterExtractFeatures(prompt);
const classification = cantRouterClassify(features);
const selection = cantRouterRoute(classification);

if (selection.costCapUsd < observedCost) {
  const cheaper = cantRouterDowngrade(selection);
  if (cheaper) { /* retry */ }
}
```

Field names use JavaScript camelCase (`primaryModel`, `fallbackModels`, `costCapUsd`, `latencyBudgetMs`).

---

## Tests

- 32 unit tests (in-module, colocated with each layer)
- 4 end-to-end integration tests (`tests/integration.rs`)
- 2 doctests (in `lib.rs` and `features.rs`)

Run with:

```bash
cargo test -p cant-router
```

All 38 tests green as of `2026-04-15`.

---

## Roadmap

- **Wave 6 (shipped)** — This crate. Offline, pure-function classifier; fixed tier matrix constant.
- **Wave 7** — Wire into CleoOS provider-matrix so `cleo orchestrate spawn` consults the router before choosing a model for a new wave.
- **Wave 8** — Replace the constant tier matrix with a `.cant` config file loaded at startup (per-project model overrides).
- **v2 reranker** — Train on the observation log once we have enough labelled traffic; swap the linear scorer for a learned one.

---

## Related

- `crates/cant-core/` — grammar + AST (router consumes it indirectly via features like code-identifier detection)
- `crates/cant-napi/` — Node bindings (now exposes the router API)
- `docs/plans/CLEO-ULTRAPLAN.md` §11 — original design doc
- `crates/integration-tests/` — cross-crate smoke including end-to-end router flow

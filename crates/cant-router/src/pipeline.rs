//! Layer 3: observation logger stub.
//!
//! Records [`RoutingObservation`]s to an in-memory buffer for Wave 6.
//! A future wave will replace this with a BRAIN-backed store
//! (`brain.db:routing_observations`) so the v2 learned reranker can
//! train on real-traffic signals.
//!
//! The current implementation is deliberately simple: a `Mutex`-
//! guarded `Vec`. It is thread-safe and cheap to use from the
//! router's hot path. Callers that need durability should treat this
//! store as a best-effort transient log — the BRAIN-backed version
//! will handle persistence.

use std::sync::Mutex;

use crate::types::RoutingObservation;

/// In-memory observation log.
///
/// The log is guarded by a `Mutex` for thread-safe `record` and
/// `snapshot` access. On lock-poison errors (rare — only possible if
/// a caller panics while holding the lock), the log silently degrades
/// to a no-op rather than panicking itself, since losing an
/// observation is strictly preferable to taking down the router hot
/// path.
pub struct ObservationLog {
    observations: Mutex<Vec<RoutingObservation>>,
}

impl ObservationLog {
    /// Create an empty observation log.
    #[must_use]
    pub fn new() -> Self {
        Self {
            observations: Mutex::new(Vec::new()),
        }
    }

    /// Append an observation to the log.
    ///
    /// On lock-poison (indicates a prior panic while holding the
    /// mutex), the observation is dropped rather than propagating the
    /// panic to the router hot path.
    pub fn record(&self, obs: RoutingObservation) {
        if let Ok(mut guard) = self.observations.lock() {
            guard.push(obs);
        }
    }

    /// Return the number of observations currently logged.
    ///
    /// On lock-poison, returns 0 as a safe fallback.
    #[must_use]
    pub fn len(&self) -> usize {
        self.observations.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Return `true` if the log is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Return a cloned snapshot of all logged observations.
    ///
    /// On lock-poison, returns an empty vector as a safe fallback.
    #[must_use]
    pub fn snapshot(&self) -> Vec<RoutingObservation> {
        self.observations
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}

impl Default for ObservationLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;
    use crate::types::{Classification, ModelSelection, PromptFeatures, Tier};

    /// Helper — build a dummy `RoutingObservation` for tests.
    fn make_observation(seq: usize) -> RoutingObservation {
        let features = PromptFeatures {
            token_count: seq,
            syntactic_complexity: 0.0,
            reasoning_depth: 0,
            domain_specificity: 0.0,
            touches_files_count: 0,
        };
        let classification = Classification {
            score: 0.1,
            tier: Tier::Low,
            features: features.clone(),
        };
        let selection = ModelSelection {
            tier: Tier::Low,
            primary_model: "claude-haiku-4-5".to_string(),
            fallback_models: vec!["kimi-k2.5".to_string()],
            cost_cap_usd: 0.10,
            latency_budget_ms: 10_000,
            reason: "test".to_string(),
        };
        RoutingObservation {
            features,
            classification,
            selection,
            timestamp: format!("2026-04-07T00:00:{seq:02}Z"),
        }
    }

    #[test]
    fn observation_log_record_and_snapshot() {
        let log = ObservationLog::new();
        assert!(log.is_empty());
        log.record(make_observation(1));
        log.record(make_observation(2));
        assert_eq!(log.len(), 2);
        let snap = log.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].features.token_count, 1);
        assert_eq!(snap[1].features.token_count, 2);
    }

    #[test]
    fn observation_log_thread_safe() {
        let log = Arc::new(ObservationLog::new());
        let mut handles = Vec::new();
        for i in 0..8 {
            let log_clone = Arc::clone(&log);
            handles.push(thread::spawn(move || {
                for j in 0..10 {
                    log_clone.record(make_observation(i * 10 + j));
                }
            }));
        }
        for h in handles {
            #[allow(clippy::expect_used)]
            h.join().expect("thread join");
        }
        assert_eq!(log.len(), 80);
    }

    #[test]
    fn observation_log_default_is_empty() {
        let log = ObservationLog::default();
        assert!(log.is_empty());
        assert_eq!(log.len(), 0);
    }
}

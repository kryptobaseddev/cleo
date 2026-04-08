//! Prompt feature extraction — Layer 1 input stage.
//!
//! Converts a raw prompt string into a [`PromptFeatures`] vector using
//! pure heuristics (no ML runtime). Each function in this module is a
//! small, auditable signal that feeds the linear classifier in
//! [`crate::classifier`].
//!
//! The heuristics are deliberately naive for Wave 6. Future waves can
//! replace individual extractors with richer implementations (e.g., a
//! real tokenizer for `token_count`) without changing the classifier
//! contract.

use crate::types::PromptFeatures;

/// Extract a [`PromptFeatures`] vector from a raw prompt string.
///
/// # Example
///
/// ```
/// use cant_router::features::extract_features;
///
/// let f = extract_features("Refactor auth.rs to use JWT tokens.");
/// assert!(f.token_count > 0);
/// ```
#[must_use]
pub fn extract_features(prompt: &str) -> PromptFeatures {
    let token_count = prompt.split_whitespace().count();
    let syntactic_complexity = estimate_syntactic_complexity(prompt);
    let reasoning_depth = count_reasoning_keywords(prompt);
    let domain_specificity = estimate_domain_specificity(prompt);
    let touches_files_count = count_file_references(prompt);
    PromptFeatures {
        token_count,
        syntactic_complexity,
        reasoning_depth,
        domain_specificity,
        touches_files_count,
    }
}

/// Estimate syntactic complexity by counting nested bracket depth.
///
/// Walks the string once tracking the running depth of `(`, `{`, `[`
/// characters (and their matching closers). The maximum depth observed
/// is divided by 5 and clamped to `[0.0, 1.0]`, so a prompt with no
/// brackets scores 0 and one with 5+ nested brackets scores 1.
fn estimate_syntactic_complexity(s: &str) -> f64 {
    let mut depth: i32 = 0;
    let mut max_depth: i32 = 0;
    for c in s.chars() {
        match c {
            '(' | '{' | '[' => {
                depth += 1;
                if depth > max_depth {
                    max_depth = depth;
                }
            }
            ')' | '}' | ']' => {
                depth = (depth - 1).max(0);
            }
            _ => {}
        }
    }
    (f64::from(max_depth) / 5.0).min(1.0)
}

/// Count reasoning-signal keywords in the prompt.
///
/// The keyword list is intentionally short and biased toward terms
/// that correlate with multi-step reasoning: `why`, `should`,
/// `compare`, `decide`, `explain`, `analyze`, `evaluate`, `consider`,
/// `trade-off`, `tradeoff`.
fn count_reasoning_keywords(s: &str) -> usize {
    const KEYWORDS: &[&str] = &[
        "why",
        "should",
        "compare",
        "decide",
        "explain",
        "analyze",
        "evaluate",
        "consider",
        "trade-off",
        "tradeoff",
    ];
    let lower = s.to_lowercase();
    KEYWORDS.iter().map(|k| lower.matches(k).count()).sum()
}

/// Estimate domain specificity via CamelCase identifier density.
///
/// Counts whitespace-delimited tokens containing at least two
/// uppercase letters (a rough proxy for domain-specific identifiers
/// like `ModelSelection` or `XDGBaseDir`). The count is divided by 10
/// and clamped to `[0.0, 1.0]`.
fn estimate_domain_specificity(s: &str) -> f64 {
    let camel_case_count = s
        .split_whitespace()
        .filter(|w| w.chars().filter(|c| c.is_uppercase()).count() >= 2)
        .count();
    (camel_case_count as f64 / 10.0).min(1.0)
}

/// Count file references in the prompt.
///
/// A token is considered a file reference if it contains a `/` or
/// ends in a known source-file extension (`.rs`, `.ts`, `.md`,
/// `.json`). Punctuation on the token is left intact for v1 — callers
/// aware of this limitation can pre-clean their prompts if needed.
fn count_file_references(s: &str) -> usize {
    s.split_whitespace()
        .filter(|w| {
            w.contains('/')
                || w.ends_with(".rs")
                || w.ends_with(".ts")
                || w.ends_with(".md")
                || w.ends_with(".json")
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_token_count() {
        let f = extract_features("hello world this is a test");
        assert_eq!(f.token_count, 6);
    }

    #[test]
    fn extract_token_count_empty_string() {
        let f = extract_features("");
        assert_eq!(f.token_count, 0);
    }

    #[test]
    fn extract_reasoning_keywords() {
        let f = extract_features("Why should we compare these options and decide?");
        // why, should, compare, decide = 4
        assert_eq!(f.reasoning_depth, 4);
    }

    #[test]
    fn extract_reasoning_keywords_case_insensitive() {
        let f = extract_features("ANALYZE and EVALUATE the tradeoff");
        // analyze, evaluate, tradeoff = 3
        assert_eq!(f.reasoning_depth, 3);
    }

    #[test]
    fn extract_file_references() {
        let f = extract_features("Update src/main.rs and docs/README.md please");
        // src/main.rs has '/', docs/README.md has '/' — 2 refs
        assert_eq!(f.touches_files_count, 2);
    }

    #[test]
    fn extract_file_references_by_extension() {
        let f = extract_features("Edit foo.rs bar.ts baz.md config.json");
        assert_eq!(f.touches_files_count, 4);
    }

    #[test]
    fn extract_syntactic_complexity() {
        let f = extract_features("simple flat prompt");
        assert!((f.syntactic_complexity - 0.0).abs() < f64::EPSILON);

        let g = extract_features("nested ((( three )))");
        // max depth 3, 3/5 = 0.6
        assert!((g.syntactic_complexity - 0.6).abs() < f64::EPSILON);
    }

    #[test]
    fn extract_syntactic_complexity_clamps_to_one() {
        let f = extract_features("deeply (((((((( nested ))))))))");
        assert!((f.syntactic_complexity - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn extract_domain_specificity() {
        let f = extract_features("plain english prompt");
        assert!((f.domain_specificity - 0.0).abs() < f64::EPSILON);

        let g = extract_features("use ModelSelection and RoutingObservation");
        // 2 camel case tokens / 10 = 0.2
        assert!((g.domain_specificity - 0.2).abs() < f64::EPSILON);
    }
}

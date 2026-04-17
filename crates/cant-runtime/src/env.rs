//! Environment and variable resolution for CANT pipeline execution.
//!
//! [`StepEnv`] holds variable bindings accumulated across pipeline steps.
//! It supports resolving `{variable}` placeholders in step property strings
//! via pure string replacement — no shell expansion is ever performed.

use crate::error::RuntimeError;
use std::collections::HashMap;

/// Execution environment holding variable bindings from prior steps and
/// initial workflow parameters.
///
/// Variables are stored as string values. Step outputs (`stdout`, `stderr`,
/// `exitCode`) are automatically bound under `<step_name>.<field>` keys.
#[derive(Debug, Clone, Default)]
pub struct StepEnv {
    /// Variable name -> value bindings.
    bindings: HashMap<String, String>,
}

impl StepEnv {
    /// Creates a new empty environment.
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
        }
    }

    /// Creates an environment pre-populated with the given bindings.
    pub fn with_bindings(bindings: HashMap<String, String>) -> Self {
        Self { bindings }
    }

    /// Inserts or overwrites a variable binding.
    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.bindings.insert(name.into(), value.into());
    }

    /// Retrieves a variable value by name, returning `None` if not bound.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.bindings.get(name).map(|s| s.as_str())
    }

    /// Returns true if the environment contains a binding for the given name.
    pub fn contains(&self, name: &str) -> bool {
        self.bindings.contains_key(name)
    }

    /// Resolves `{variable}` placeholders in the input string.
    ///
    /// Performs a single pass of string replacement. Nested interpolation
    /// (`${}` within resolved values) is treated as literal text per the
    /// T07 security rule.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeError::VariableNotFound`] if a referenced variable
    /// is not present in the environment.
    pub fn resolve(&self, input: &str) -> Result<String, RuntimeError> {
        let mut result = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();

        while let Some(ch) = chars.next() {
            if ch == '{' {
                // Collect variable name until closing '}'
                let mut var_name = String::new();
                let mut found_close = false;
                for inner in chars.by_ref() {
                    if inner == '}' {
                        found_close = true;
                        break;
                    }
                    var_name.push(inner);
                }
                if !found_close || var_name.is_empty() {
                    // Malformed placeholder — emit as literal
                    result.push('{');
                    result.push_str(&var_name);
                    if !found_close {
                        // Reached end of string without closing brace
                    }
                } else {
                    // Resolve the variable
                    match self.bindings.get(&var_name) {
                        Some(value) => result.push_str(value),
                        None => {
                            return Err(RuntimeError::VariableNotFound { name: var_name });
                        }
                    }
                }
            } else {
                result.push(ch);
            }
        }

        Ok(result)
    }

    /// Resolves all elements of a string slice array, returning a new Vec.
    ///
    /// # Errors
    ///
    /// Returns the first [`RuntimeError::VariableNotFound`] encountered.
    pub fn resolve_args(&self, args: &[String]) -> Result<Vec<String>, RuntimeError> {
        args.iter().map(|a| self.resolve(a)).collect()
    }

    /// Records the outputs of a completed step into the environment.
    ///
    /// Binds `<step_name>.stdout`, `<step_name>.stderr`, and
    /// `<step_name>.exitCode` for use in subsequent step variable resolution.
    pub fn record_step_output(&mut self, step_name: &str, stdout: &str, stderr: &str, code: i32) {
        self.set(format!("{step_name}.stdout"), stdout.to_string());
        self.set(format!("{step_name}.stderr"), stderr.to_string());
        self.set(format!("{step_name}.exitCode"), code.to_string());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn new_env_is_empty() {
        let env = StepEnv::new();
        assert!(env.get("x").is_none());
        assert!(!env.contains("x"));
    }

    #[test]
    fn set_and_get() {
        let mut env = StepEnv::new();
        env.set("pr_url", "https://github.com/org/repo/pull/42");
        assert_eq!(
            env.get("pr_url"),
            Some("https://github.com/org/repo/pull/42")
        );
        assert!(env.contains("pr_url"));
    }

    #[test]
    fn with_bindings_initializes() {
        let mut map = HashMap::new();
        map.insert("a".into(), "1".into());
        map.insert("b".into(), "2".into());
        let env = StepEnv::with_bindings(map);
        assert_eq!(env.get("a"), Some("1"));
        assert_eq!(env.get("b"), Some("2"));
    }

    #[test]
    fn resolve_no_placeholders() {
        let env = StepEnv::new();
        let result = env.resolve("pnpm run build").unwrap();
        assert_eq!(result, "pnpm run build");
    }

    #[test]
    fn resolve_single_placeholder() {
        let mut env = StepEnv::new();
        env.set("pr_url", "https://github.com/pr/42");
        let result = env.resolve("gh pr diff {pr_url}").unwrap();
        assert_eq!(result, "gh pr diff https://github.com/pr/42");
    }

    #[test]
    fn resolve_multiple_placeholders() {
        let mut env = StepEnv::new();
        env.set("owner", "org");
        env.set("repo", "project");
        let result = env.resolve("{owner}/{repo}").unwrap();
        assert_eq!(result, "org/project");
    }

    #[test]
    fn resolve_missing_variable_error() {
        let env = StepEnv::new();
        let result = env.resolve("value is {missing}");
        assert!(result.is_err());
        match result.unwrap_err() {
            RuntimeError::VariableNotFound { name } => assert_eq!(name, "missing"),
            other => panic!("Expected VariableNotFound, got: {other:?}"),
        }
    }

    #[test]
    fn resolve_preserves_literal_braces_if_malformed() {
        let env = StepEnv::new();
        // Unclosed brace is emitted as literal
        let result = env.resolve("prefix {unclosed");
        // This should produce "prefix {unclosed" as literal since there's no closing brace
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "prefix {unclosed");
    }

    #[test]
    fn resolve_args_all_resolved() {
        let mut env = StepEnv::new();
        env.set("target", "main");
        let args = vec!["--branch".into(), "{target}".into(), "--verbose".into()];
        let resolved = env.resolve_args(&args).unwrap();
        assert_eq!(resolved, vec!["--branch", "main", "--verbose"]);
    }

    #[test]
    fn resolve_args_error_on_missing() {
        let env = StepEnv::new();
        let args = vec!["--url".into(), "{url}".into()];
        assert!(env.resolve_args(&args).is_err());
    }

    #[test]
    fn record_step_output_binds_fields() {
        let mut env = StepEnv::new();
        env.record_step_output("fetch", "diff content\n", "warning: something\n", 0);
        assert_eq!(env.get("fetch.stdout"), Some("diff content\n"));
        assert_eq!(env.get("fetch.stderr"), Some("warning: something\n"));
        assert_eq!(env.get("fetch.exitCode"), Some("0"));
    }

    #[test]
    fn overwrite_binding() {
        let mut env = StepEnv::new();
        env.set("x", "first");
        assert_eq!(env.get("x"), Some("first"));
        env.set("x", "second");
        assert_eq!(env.get("x"), Some("second"));
    }

    #[test]
    fn no_nested_interpolation_t07() {
        // T07 security: resolved values containing {x} are treated as literal
        let mut env = StepEnv::new();
        env.set("payload", "inner-{secret}");
        env.set("secret", "leaked");
        let result = env.resolve("data: {payload}").unwrap();
        // The resolved value must NOT re-expand {secret}
        assert_eq!(result, "data: inner-{secret}");
    }
}

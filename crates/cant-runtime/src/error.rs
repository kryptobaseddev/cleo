//! Runtime error types for the CANT pipeline executor.
//!
//! All errors produced during pipeline and step execution are represented
//! by the [`RuntimeError`] enum. Callers match on variants to distinguish
//! between step failures, timeouts, missing variables, and security rejections.

/// Errors that may occur during CANT pipeline execution.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    /// A pipeline step exited with a non-zero exit code.
    #[error("Step '{name}' failed with exit code {code}")]
    StepFailed {
        /// The name of the failed step.
        name: String,
        /// The non-zero exit code returned by the subprocess.
        code: i32,
    },

    /// A pipeline step exceeded its configured timeout.
    #[error("Step '{name}' timed out after {timeout_ms}ms")]
    StepTimeout {
        /// The name of the timed-out step.
        name: String,
        /// The timeout value in milliseconds.
        timeout_ms: u64,
    },

    /// A variable reference could not be resolved in the current environment.
    #[error("Variable '{name}' not found in environment")]
    VariableNotFound {
        /// The unresolved variable name.
        name: String,
    },

    /// The command binary is not present in the configured allowlist.
    #[error("Command not in allowlist: {command}")]
    CommandNotAllowed {
        /// The rejected command binary name.
        command: String,
    },

    /// The command string contains shell metacharacters or interpolation,
    /// violating the P06 security invariant.
    #[error("Command '{command}' contains shell metacharacters — use args array instead (P06)")]
    ShellMetacharacters {
        /// The rejected command string.
        command: String,
    },

    /// A `stdin` reference points to a step that does not exist or has not
    /// executed yet.
    #[error("Step '{name}' references unknown stdin source '{stdin_ref}'")]
    StdinSourceNotFound {
        /// The step that declared the stdin reference.
        name: String,
        /// The referenced source step name.
        stdin_ref: String,
    },

    /// An underlying I/O error from subprocess spawning or pipe operations.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_failed_display() {
        let err = RuntimeError::StepFailed {
            name: "build".into(),
            code: 1,
        };
        assert_eq!(err.to_string(), "Step 'build' failed with exit code 1");
    }

    #[test]
    fn step_timeout_display() {
        let err = RuntimeError::StepTimeout {
            name: "test".into(),
            timeout_ms: 30000,
        };
        assert_eq!(err.to_string(), "Step 'test' timed out after 30000ms");
    }

    #[test]
    fn variable_not_found_display() {
        let err = RuntimeError::VariableNotFound {
            name: "pr_url".into(),
        };
        assert_eq!(
            err.to_string(),
            "Variable 'pr_url' not found in environment"
        );
    }

    #[test]
    fn command_not_allowed_display() {
        let err = RuntimeError::CommandNotAllowed {
            command: "curl".into(),
        };
        assert_eq!(err.to_string(), "Command not in allowlist: curl");
    }

    #[test]
    fn shell_metacharacters_display() {
        let err = RuntimeError::ShellMetacharacters {
            command: "echo $(whoami)".into(),
        };
        assert!(err.to_string().contains("shell metacharacters"));
    }

    #[test]
    fn stdin_source_not_found_display() {
        let err = RuntimeError::StdinSourceNotFound {
            name: "lint".into(),
            stdin_ref: "fetch".into(),
        };
        assert!(err.to_string().contains("unknown stdin source 'fetch'"));
    }

    #[test]
    fn io_error_from_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "binary not found");
        let err = RuntimeError::from(io_err);
        assert!(err.to_string().contains("binary not found"));
    }
}

//! Validation context: symbol tables and scope stacks for name resolution.
//!
//! The [`ValidationContext`] tracks all defined names (agents, skills, workflows,
//! pipelines, bindings) and provides scope management for nested constructs like
//! for-loops and try/catch blocks.

use crate::dsl::span::Span;
use std::collections::HashMap;

/// Validation context carrying symbol tables and scope state.
///
/// Built during an AST walk and consulted by validation rules that need
/// to resolve names or check for duplicates.
pub struct ValidationContext {
    /// Agent names defined in the document, mapped to their definition span.
    pub defined_agents: HashMap<String, Span>,
    /// Skill names defined in the document, mapped to their definition span.
    pub defined_skills: HashMap<String, Span>,
    /// Workflow names defined in the document, mapped to their definition span.
    pub defined_workflows: HashMap<String, Span>,
    /// Pipeline names defined in the document, mapped to their definition span.
    pub defined_pipelines: HashMap<String, Span>,
    /// Team names defined in the document (CleoOS v2), mapped to their definition span.
    pub defined_teams: HashMap<String, Span>,
    /// Tool names defined in the document (CleoOS v2), mapped to their definition span.
    pub defined_tools: HashMap<String, Span>,
    /// Scope stack for variable bindings. Each entry is a scope level containing
    /// name -> definition span mappings. The outermost scope is at index 0.
    pub bindings: Vec<HashMap<String, Span>>,
    /// Import chain for cycle detection. Contains file paths in the current
    /// transitive import chain.
    pub import_chain: Vec<String>,
    /// Hook events seen at the top level (for H02 duplicate detection).
    pub top_level_hook_events: HashMap<String, Span>,
    /// Configurable limits for security rules.
    pub limits: ValidationLimits,
    /// Current nesting depth for W11.
    pub nesting_depth: u32,
    /// Command allowlist for P07. Empty means the check is disabled.
    pub command_allowlist: Vec<String>,
}

/// Configurable limits for security-related validation rules.
pub struct ValidationLimits {
    /// Maximum import chain depth (S11). Default: 64.
    pub max_import_depth: u32,
    /// Maximum timeout in seconds (W08). Default: 3600.
    pub max_timeout_seconds: u64,
    /// Maximum parallel arms (W09). Default: 32.
    pub max_parallel_arms: u32,
    /// Maximum repeat count (W10). Default: 10000.
    pub max_repeat_count: u64,
    /// Maximum nesting depth (W11). Default: 16.
    pub max_nesting_depth: u32,
}

impl Default for ValidationLimits {
    fn default() -> Self {
        Self {
            max_import_depth: 64,
            max_timeout_seconds: 3600,
            max_parallel_arms: 32,
            max_repeat_count: 10_000,
            max_nesting_depth: 16,
        }
    }
}

impl ValidationContext {
    /// Creates a new empty validation context with default limits.
    pub fn new() -> Self {
        Self {
            defined_agents: HashMap::new(),
            defined_skills: HashMap::new(),
            defined_workflows: HashMap::new(),
            defined_pipelines: HashMap::new(),
            defined_teams: HashMap::new(),
            defined_tools: HashMap::new(),
            bindings: vec![HashMap::new()], // start with global scope
            import_chain: Vec::new(),
            top_level_hook_events: HashMap::new(),
            limits: ValidationLimits::default(),
            nesting_depth: 0,
            command_allowlist: Vec::new(),
        }
    }

    /// Creates a new validation context with custom limits.
    pub fn with_limits(limits: ValidationLimits) -> Self {
        Self {
            limits,
            ..Self::new()
        }
    }

    /// Pushes a new scope level onto the binding stack.
    pub fn push_scope(&mut self) {
        self.bindings.push(HashMap::new());
    }

    /// Pops the innermost scope level from the binding stack.
    pub fn pop_scope(&mut self) {
        if self.bindings.len() > 1 {
            self.bindings.pop();
        }
    }

    /// Defines a binding in the current (innermost) scope.
    pub fn define_binding(&mut self, name: String, span: Span) {
        if let Some(scope) = self.bindings.last_mut() {
            scope.insert(name, span);
        }
    }

    /// Looks up a binding by name, searching from innermost scope outward.
    /// Returns the span of the definition if found.
    pub fn resolve_binding(&self, name: &str) -> Option<Span> {
        for scope in self.bindings.iter().rev() {
            if let Some(span) = scope.get(name) {
                return Some(*span);
            }
        }
        None
    }

    /// Checks if a binding with the given name exists in any enclosing scope
    /// (i.e., not the current innermost scope). Used for shadow detection (S02).
    pub fn find_shadow_target(&self, name: &str) -> Option<Span> {
        // Skip the innermost scope, search enclosing scopes
        if self.bindings.len() < 2 {
            return None;
        }
        for scope in self.bindings[..self.bindings.len() - 1].iter().rev() {
            if let Some(span) = scope.get(name) {
                return Some(*span);
            }
        }
        None
    }

    /// Checks if a name is defined as any top-level construct (agent, skill,
    /// workflow, pipeline, team, tool, or binding).
    pub fn is_name_defined(&self, name: &str) -> bool {
        self.defined_agents.contains_key(name)
            || self.defined_skills.contains_key(name)
            || self.defined_workflows.contains_key(name)
            || self.defined_pipelines.contains_key(name)
            || self.defined_teams.contains_key(name)
            || self.defined_tools.contains_key(name)
            || self.resolve_binding(name).is_some()
    }

    /// Increments nesting depth and returns the new depth.
    pub fn enter_nesting(&mut self) -> u32 {
        self.nesting_depth += 1;
        self.nesting_depth
    }

    /// Decrements nesting depth.
    pub fn exit_nesting(&mut self) {
        if self.nesting_depth > 0 {
            self.nesting_depth -= 1;
        }
    }
}

impl Default for ValidationContext {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_context_has_global_scope() {
        let ctx = ValidationContext::new();
        assert_eq!(ctx.bindings.len(), 1);
    }

    #[test]
    fn push_and_pop_scope() {
        let mut ctx = ValidationContext::new();
        ctx.push_scope();
        assert_eq!(ctx.bindings.len(), 2);
        ctx.pop_scope();
        assert_eq!(ctx.bindings.len(), 1);
    }

    #[test]
    fn pop_scope_never_removes_global() {
        let mut ctx = ValidationContext::new();
        ctx.pop_scope();
        assert_eq!(ctx.bindings.len(), 1);
    }

    #[test]
    fn define_and_resolve_binding() {
        let mut ctx = ValidationContext::new();
        let span = Span::new(0, 5, 1, 1);
        ctx.define_binding("x".to_string(), span);
        assert_eq!(ctx.resolve_binding("x"), Some(span));
        assert_eq!(ctx.resolve_binding("y"), None);
    }

    #[test]
    fn inner_scope_shadows_outer() {
        let mut ctx = ValidationContext::new();
        let outer_span = Span::new(0, 5, 1, 1);
        ctx.define_binding("x".to_string(), outer_span);
        ctx.push_scope();
        let inner_span = Span::new(10, 15, 2, 1);
        ctx.define_binding("x".to_string(), inner_span);
        // resolve finds inner scope first
        assert_eq!(ctx.resolve_binding("x"), Some(inner_span));
        ctx.pop_scope();
        // back to outer
        assert_eq!(ctx.resolve_binding("x"), Some(outer_span));
    }

    #[test]
    fn find_shadow_target() {
        let mut ctx = ValidationContext::new();
        let outer_span = Span::new(0, 5, 1, 1);
        ctx.define_binding("x".to_string(), outer_span);
        ctx.push_scope();
        // Before defining 'x' in inner scope, shadow target exists
        assert_eq!(ctx.find_shadow_target("x"), Some(outer_span));
        assert_eq!(ctx.find_shadow_target("y"), None);
    }

    #[test]
    fn is_name_defined_checks_all_tables() {
        let mut ctx = ValidationContext::new();
        ctx.defined_agents
            .insert("agent-a".to_string(), Span::dummy());
        ctx.defined_skills
            .insert("skill-b".to_string(), Span::dummy());
        ctx.defined_workflows
            .insert("wf-c".to_string(), Span::dummy());
        ctx.defined_pipelines
            .insert("pipe-d".to_string(), Span::dummy());
        ctx.define_binding("var-e".to_string(), Span::dummy());

        assert!(ctx.is_name_defined("agent-a"));
        assert!(ctx.is_name_defined("skill-b"));
        assert!(ctx.is_name_defined("wf-c"));
        assert!(ctx.is_name_defined("pipe-d"));
        assert!(ctx.is_name_defined("var-e"));
        assert!(!ctx.is_name_defined("unknown"));
    }

    #[test]
    fn nesting_depth_tracking() {
        let mut ctx = ValidationContext::new();
        assert_eq!(ctx.nesting_depth, 0);
        assert_eq!(ctx.enter_nesting(), 1);
        assert_eq!(ctx.enter_nesting(), 2);
        ctx.exit_nesting();
        assert_eq!(ctx.nesting_depth, 1);
    }

    #[test]
    fn default_limits() {
        let limits = ValidationLimits::default();
        assert_eq!(limits.max_import_depth, 64);
        assert_eq!(limits.max_timeout_seconds, 3600);
        assert_eq!(limits.max_parallel_arms, 32);
        assert_eq!(limits.max_repeat_count, 10_000);
        assert_eq!(limits.max_nesting_depth, 16);
    }
}

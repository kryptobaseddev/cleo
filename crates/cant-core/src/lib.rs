#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]
//! Canonical CANT grammar parser for the CLEO ecosystem.
//!
//! This crate parses CLEO Agent Notation Tongue (CANT) messages
//! into structured elements: directives, addresses, task references,
//! tags, header, and body text.
//!
//! CANT is the unified agent communication protocol in the CLEO ecosystem.
//! It formalizes the structured shorthand that agents use to communicate
//! intent, recipients, task references, and metadata.
//!
//! # Grammar (BNF)
//!
//! ```bnf
//! <message>     ::= <header> NEWLINE <body>
//! <header>      ::= <directive>? <element>*
//! <element>     ::= <address> | <task_ref> | <tag> | <text>
//! <directive>   ::= "/" VERB
//! <address>     ::= "@" IDENTIFIER
//! <task_ref>    ::= "T" DIGITS
//! <tag>         ::= "#" IDENTIFIER
//! <body>        ::= <any text, may contain addresses, task_refs, tags>
//!
//! VERB          ::= [a-z][a-z0-9-]*
//! IDENTIFIER    ::= [a-zA-Z][a-zA-Z0-9_-]*
//! DIGITS        ::= [0-9]+
//! ```
//!
//! # Usage
//!
//! ```
//! use cant_core::parse;
//!
//! let msg = parse("/done @all T1234 #shipped\n\n## Phase complete");
//! assert_eq!(msg.directive.as_deref(), Some("done"));
//! assert_eq!(msg.directive_type, cant_core::DirectiveType::Actionable);
//! assert_eq!(msg.addresses, vec!["all"]);
//! assert_eq!(msg.task_refs, vec!["T1234"]);
//! assert_eq!(msg.tags, vec!["shipped"]);
//! ```

use serde::{Deserialize, Serialize};

pub mod dsl;
/// Generated types and constants produced by the `cant-core` build script from `hook-mappings.json`.
pub mod generated;
pub mod parser;
pub mod render;
pub mod validate;

/// The classification of a directive extracted from a CANT message.
///
/// Directives fall into three categories based on their operational impact:
/// - **Actionable**: Maps to a CQRS operation that mutates state.
/// - **Routing**: Signals that someone should act but does not mutate state directly.
/// - **Informational**: Carries context but triggers no operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DirectiveType {
    /// Maps to a CQRS mutation (e.g., `/done`, `/claim`, `/blocked`, `/approve`,
    /// `/decision`, `/checkin`).
    Actionable,
    /// Signals routing without direct state mutation (e.g., `/action`, `/review`,
    /// `/proposal`).
    Routing,
    /// Carries context only; triggers no operation (e.g., `/ack`, `/response`,
    /// `/info`, `/status`, or no directive at all).
    Informational,
}

/// The structured result of parsing a CANT message.
///
/// Contains all extracted elements from both the header (first line) and
/// body (remaining lines) of the message. Addresses, task refs, and tags
/// found in the body are merged with those from the header.
#[non_exhaustive]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedCANTMessage {
    /// The directive verb if present (e.g., `"done"` from `/done`), or `None`
    /// for unstructured prose messages.
    pub directive: Option<String>,

    /// The classification of the directive. Defaults to [`DirectiveType::Informational`]
    /// when no directive is present.
    pub directive_type: DirectiveType,

    /// All `@`-addresses found in the message (header + body), without the `@` prefix.
    pub addresses: Vec<String>,

    /// All task references found in the message (header + body), including the `T` prefix
    /// (e.g., `"T1234"`).
    pub task_refs: Vec<String>,

    /// All `#`-tags found in the message (header + body), without the `#` prefix.
    pub tags: Vec<String>,

    /// The raw text of the first line (the header).
    pub header_raw: String,

    /// Everything after the first newline (the body). Empty string if there is no body.
    pub body: String,
}

/// Classifies a directive verb into its [`DirectiveType`].
///
/// The classification follows the CANT specification:
/// - **Actionable**: `claim`, `done`, `blocked`, `approve`, `decision`, `checkin`
/// - **Routing**: `action`, `review`, `proposal`
/// - **Informational**: `ack`, `response`, `info`, `status`
///
/// Unknown directives default to [`DirectiveType::Informational`].
pub fn classify_directive(verb: &str) -> DirectiveType {
    match verb {
        "claim" | "done" | "blocked" | "approve" | "decision" | "checkin" => {
            DirectiveType::Actionable
        }
        "action" | "review" | "proposal" => DirectiveType::Routing,
        // ack, response, info, status, and any unknown directive
        _ => DirectiveType::Informational,
    }
}

/// Parses raw message content into a structured [`ParsedCANTMessage`].
///
/// This is the main entry point for the CANT parser. It splits the message
/// into header (first line) and body (remaining lines), extracts structured
/// elements from both, classifies the directive, and returns a unified result.
///
/// # Arguments
///
/// * `content` - The raw CANT message text to parse.
///
/// # Returns
///
/// A [`ParsedCANTMessage`] containing all extracted elements. If no directive
/// is present, `directive` is `None` and `directive_type` is
/// [`DirectiveType::Informational`].
///
/// # Examples
///
/// ```
/// use cant_core::{parse, DirectiveType};
///
/// // Message with directive
/// let msg = parse("/done @all T1234 #shipped\n\nPhase complete");
/// assert_eq!(msg.directive.as_deref(), Some("done"));
/// assert_eq!(msg.directive_type, DirectiveType::Actionable);
///
/// // Plain text message (no directive)
/// let msg = parse("Just a status update");
/// assert!(msg.directive.is_none());
/// assert_eq!(msg.directive_type, DirectiveType::Informational);
/// ```
pub fn parse(content: &str) -> ParsedCANTMessage {
    let (header_raw, body_raw) = parser::split_header_body(content);

    // Parse header elements
    let header_elements = parser::parse_header(header_raw);

    let mut directive: Option<String> = None;
    let mut addresses: Vec<String> = Vec::new();
    let mut task_refs: Vec<String> = Vec::new();
    let mut tags: Vec<String> = Vec::new();

    for element in header_elements {
        match element {
            parser::HeaderElement::Directive(v) => {
                directive = Some(v);
            }
            parser::HeaderElement::Address(a) => {
                addresses.push(a);
            }
            parser::HeaderElement::TaskRef(t) => {
                task_refs.push(t);
            }
            parser::HeaderElement::Tag(t) => {
                tags.push(t);
            }
        }
    }

    // Parse body for additional references
    let (body_addresses, body_task_refs, body_tags) = parser::parse_body(body_raw);
    addresses.extend(body_addresses);
    task_refs.extend(body_task_refs);
    tags.extend(body_tags);

    // Classify the directive
    let directive_type = match &directive {
        Some(verb) => classify_directive(verb),
        None => DirectiveType::Informational,
    };

    ParsedCANTMessage {
        directive,
        directive_type,
        addresses,
        task_refs,
        tags,
        header_raw: header_raw.to_string(),
        body: body_raw.to_string(),
    }
}

/// Parses a complete `.cant` document into a structured AST.
///
/// This is the top-level entry point for CANT DSL Layer 2 parsing.
/// For Layer 1 message parsing, use [`parse`] instead.
///
/// # Arguments
///
/// * `content` - The raw `.cant` document text.
///
/// # Returns
///
/// `Ok(CantDocument)` on success, or `Err(Vec<ParseError>)` if parsing fails.
///
/// # Errors
///
/// Returns `Err(Vec<ParseError>)` when the input contains invalid CANT syntax.
pub fn parse_document(
    content: &str,
) -> Result<dsl::ast::CantDocument, Vec<dsl::error::ParseError>> {
    dsl::parse_document(content)
}

/// Convenience function that validates a parsed [`CantDocument`] and returns
/// all diagnostics.
///
/// This is the primary entry point for consumers who want to lint a `.cant` file.
/// It calls [`validate::validate`] internally, running all rule modules
/// (scope, pipeline purity, types, hooks, workflows).
///
/// # Arguments
///
/// * `doc` - A parsed CANT document (obtained from [`parse_document`]).
///
/// # Returns
///
/// A vector of [`validate::diagnostic::Diagnostic`] results. An empty vector
/// means the document passed all validation rules.
pub fn validate_document(doc: &dsl::ast::CantDocument) -> Vec<validate::diagnostic::Diagnostic> {
    validate::validate(doc)
}

/// Renders a parsed [`dsl::ast::CantDocument`] back into a `.cant` source string.
///
/// This is the top-level entry point for the `CleoOS` v2 Wave 1 render pipeline
/// (`docs/plans/CLEO-ULTRAPLAN.md` §17). The renderer is the forward half of
/// the byte-identical round-trip contract: any hand-authored fixture that
/// matches the canonical formatting rules documented on
/// [`render::render_document`] round-trips `parse → render → parse`
/// byte-for-byte.
///
/// # Arguments
///
/// * `doc` - A parsed CANT document (obtained from [`parse_document`]).
///
/// # Returns
///
/// The rendered source string. An empty document produces an empty string.
pub fn render_document(doc: &dsl::ast::CantDocument) -> String {
    render::render_document(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Basic message parsing ─────────────────────────────────────────

    #[test]
    fn parse_full_message_with_directive_addresses_taskref_tag() {
        let msg = parse("/done @all T1234 #shipped\n\n## Phase complete");
        assert_eq!(msg.directive.as_deref(), Some("done"));
        assert_eq!(msg.directive_type, DirectiveType::Actionable);
        assert_eq!(msg.addresses, vec!["all"]);
        assert_eq!(msg.task_refs, vec!["T1234"]);
        assert_eq!(msg.tags, vec!["shipped"]);
        assert_eq!(msg.header_raw, "/done @all T1234 #shipped");
        assert_eq!(msg.body, "\n## Phase complete");
    }

    #[test]
    fn parse_message_no_directive_is_informational() {
        let msg = parse("just a plain text message");
        assert!(msg.directive.is_none());
        assert_eq!(msg.directive_type, DirectiveType::Informational);
        assert!(msg.task_refs.is_empty());
        assert!(msg.addresses.is_empty());
        assert!(msg.tags.is_empty());
        assert_eq!(msg.header_raw, "just a plain text message");
        assert!(msg.body.is_empty());
    }

    // ── Multiple addresses ────────────────────────────────────────────

    #[test]
    fn parse_multiple_addresses() {
        let msg = parse("/action @cleo-core @signaldock-dev");
        assert_eq!(msg.directive.as_deref(), Some("action"));
        assert_eq!(msg.directive_type, DirectiveType::Routing);
        assert_eq!(msg.addresses, vec!["cleo-core", "signaldock-dev"]);
    }

    #[test]
    fn parse_three_addresses_with_all() {
        let msg = parse("/action @cleo-core @signaldock-core-agent @all");
        assert_eq!(
            msg.addresses,
            vec!["cleo-core", "signaldock-core-agent", "all"]
        );
    }

    // ── Body task refs ────────────────────────────────────────────────

    #[test]
    fn parse_body_task_refs() {
        let msg = parse("/info\nWorking on T5678 and T9999");
        assert_eq!(msg.directive.as_deref(), Some("info"));
        assert_eq!(msg.directive_type, DirectiveType::Informational);
        assert_eq!(msg.task_refs, vec!["T5678", "T9999"]);
    }

    #[test]
    fn parse_header_and_body_task_refs_merged() {
        let msg = parse("/blocked T1234\nAlso depends on T5678");
        assert_eq!(msg.task_refs, vec!["T1234", "T5678"]);
    }

    // ── Body addresses and tags ───────────────────────────────────────

    #[test]
    fn parse_body_addresses_and_tags() {
        let msg = parse("/done @all T1234 #shipped\n\n@versionguard check #follow-up");
        assert_eq!(msg.addresses, vec!["all", "versionguard"]);
        assert_eq!(msg.tags, vec!["shipped", "follow-up"]);
    }

    // ── Directive classification ──────────────────────────────────────

    #[test]
    fn classify_actionable_directives() {
        let actionable = ["claim", "done", "blocked", "approve", "decision", "checkin"];
        for verb in actionable {
            let msg = parse(&format!("/{verb}"));
            assert_eq!(
                msg.directive_type,
                DirectiveType::Actionable,
                "Expected '{verb}' to be Actionable"
            );
        }
    }

    #[test]
    fn classify_routing_directives() {
        let routing = ["action", "review", "proposal"];
        for verb in routing {
            let msg = parse(&format!("/{verb}"));
            assert_eq!(
                msg.directive_type,
                DirectiveType::Routing,
                "Expected '{verb}' to be Routing"
            );
        }
    }

    #[test]
    fn classify_informational_directives() {
        let informational = ["ack", "response", "info", "status"];
        for verb in informational {
            let msg = parse(&format!("/{verb}"));
            assert_eq!(
                msg.directive_type,
                DirectiveType::Informational,
                "Expected '{verb}' to be Informational"
            );
        }
    }

    #[test]
    fn classify_unknown_directive_as_informational() {
        let msg = parse("/foobar");
        assert_eq!(msg.directive.as_deref(), Some("foobar"));
        assert_eq!(msg.directive_type, DirectiveType::Informational);
    }

    #[test]
    fn no_directive_classified_as_informational() {
        let msg = parse("Hello world");
        assert!(msg.directive.is_none());
        assert_eq!(msg.directive_type, DirectiveType::Informational);
    }

    // ── Edge cases ────────────────────────────────────────────────────

    #[test]
    fn parse_empty_content() {
        let msg = parse("");
        assert!(msg.directive.is_none());
        assert_eq!(msg.directive_type, DirectiveType::Informational);
        assert!(msg.addresses.is_empty());
        assert!(msg.task_refs.is_empty());
        assert!(msg.tags.is_empty());
        assert!(msg.header_raw.is_empty());
        assert!(msg.body.is_empty());
    }

    #[test]
    fn parse_header_only_no_body() {
        let msg = parse("/claim T42");
        assert_eq!(msg.directive.as_deref(), Some("claim"));
        assert_eq!(msg.directive_type, DirectiveType::Actionable);
        assert_eq!(msg.task_refs, vec!["T42"]);
        assert!(msg.body.is_empty());
    }

    #[test]
    fn parse_multiple_task_refs_in_header() {
        let msg = parse("/blocked T1234 T5679");
        assert_eq!(msg.directive.as_deref(), Some("blocked"));
        assert_eq!(msg.task_refs, vec!["T1234", "T5679"]);
    }

    #[test]
    fn parse_body_only_newline_delimiter() {
        let msg = parse("/done\nBody starts here");
        assert_eq!(msg.directive.as_deref(), Some("done"));
        assert_eq!(msg.header_raw, "/done");
        assert_eq!(msg.body, "Body starts here");
    }

    #[test]
    fn parse_complex_real_world_message() {
        let content = "/done @cleoos-opus-orchestrator @all T1234 #shipped #phase-B\n\n\
            ## NEXUS Router Shipped\n\n\
            Added assignee field. @versionguard-opencode check T5678.";
        let msg = parse(content);
        assert_eq!(msg.directive.as_deref(), Some("done"));
        assert_eq!(msg.directive_type, DirectiveType::Actionable);
        assert_eq!(
            msg.addresses,
            vec!["cleoos-opus-orchestrator", "all", "versionguard-opencode"]
        );
        assert_eq!(msg.task_refs, vec!["T1234", "T5678"]);
        assert_eq!(msg.tags, vec!["shipped", "phase-B"]);
    }

    #[test]
    fn parse_directive_with_hyphenated_verb() {
        // Not a canonical directive but grammar allows it
        let msg = parse("/check-in @all");
        assert_eq!(msg.directive.as_deref(), Some("check-in"));
        assert_eq!(msg.directive_type, DirectiveType::Informational);
        assert_eq!(msg.addresses, vec!["all"]);
    }

    #[test]
    fn parse_tags_only_no_directive() {
        let msg = parse("#urgent #P0 some text");
        assert!(msg.directive.is_none());
        assert_eq!(msg.tags, vec!["urgent", "P0"]);
    }

    #[test]
    fn parse_whitespace_only_content() {
        let msg = parse("   ");
        assert!(msg.directive.is_none());
        assert_eq!(msg.directive_type, DirectiveType::Informational);
        assert!(msg.addresses.is_empty());
        assert!(msg.task_refs.is_empty());
        assert!(msg.tags.is_empty());
    }

    #[test]
    fn parse_newline_only() {
        let msg = parse("\n");
        assert!(msg.directive.is_none());
        assert!(msg.header_raw.is_empty());
        assert!(msg.body.is_empty());
    }

    #[test]
    fn task_ref_in_body_multiline() {
        let content = "/info\nLine one\nT100 is here\nand T200 there";
        let msg = parse(content);
        assert_eq!(msg.task_refs, vec!["T100", "T200"]);
    }

    #[test]
    fn addresses_deduplicated_not_required() {
        // The parser does not deduplicate — consumers handle that.
        // Verify both occurrences are captured.
        let msg = parse("/info @agent\n@agent again");
        assert_eq!(msg.addresses, vec!["agent", "agent"]);
    }

    // ── classify_directive unit tests ─────────────────────────────────

    #[test]
    fn classify_all_twelve_directives() {
        assert_eq!(classify_directive("claim"), DirectiveType::Actionable);
        assert_eq!(classify_directive("done"), DirectiveType::Actionable);
        assert_eq!(classify_directive("blocked"), DirectiveType::Actionable);
        assert_eq!(classify_directive("approve"), DirectiveType::Actionable);
        assert_eq!(classify_directive("decision"), DirectiveType::Actionable);
        assert_eq!(classify_directive("checkin"), DirectiveType::Actionable);
        assert_eq!(classify_directive("action"), DirectiveType::Routing);
        assert_eq!(classify_directive("review"), DirectiveType::Routing);
        assert_eq!(classify_directive("proposal"), DirectiveType::Routing);
        assert_eq!(classify_directive("ack"), DirectiveType::Informational);
        assert_eq!(classify_directive("response"), DirectiveType::Informational);
        assert_eq!(classify_directive("info"), DirectiveType::Informational);
        assert_eq!(classify_directive("status"), DirectiveType::Informational);
    }
}

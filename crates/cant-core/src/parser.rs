//! Nom-based combinators for CANT grammar parsing.
//!
//! This module provides the low-level parser combinators that extract
//! structured elements from CANT message content: directives, addresses,
//! task references, and tags.
//!
//! The BNF grammar implemented:
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

use nom::{
    IResult,
    bytes::complete::{take_while, take_while1},
    character::complete::char,
    combinator::recognize,
    sequence::pair,
};

/// Returns true if the character is valid as an identifier continuation.
///
/// Matches `[a-zA-Z0-9_-]`.
fn is_identifier_continuation(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Returns true if the character is a valid VERB continuation character.
///
/// Matches `[a-z0-9-]`.
fn is_verb_continuation(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'
}

/// Returns true if the character starts a VERB (`[a-z]`).
fn is_verb_start(c: char) -> bool {
    c.is_ascii_lowercase()
}

/// Returns true if the character starts an IDENTIFIER (`[a-zA-Z]`).
fn is_identifier_start(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// Parses a directive from the input.
///
/// A directive is `/` followed by a VERB (`[a-z][a-z0-9-]*`).
/// Returns the verb string without the leading `/`.
///
/// # Errors
///
/// Returns a nom error if the input does not start with `/` followed by a
/// valid verb character sequence.
///
/// # Examples
///
/// - `"/done rest"` parses to `("done", " rest")`
/// - `"/checkin"` parses to `("checkin", "")`
pub fn parse_directive(input: &str) -> IResult<&str, &str> {
    let (input, _) = char('/')(input)?;
    recognize(pair(
        nom::character::complete::satisfy(is_verb_start),
        take_while(is_verb_continuation),
    ))(input)
}

/// Parses an address from the input.
///
/// An address is `@` followed by an IDENTIFIER (`[a-zA-Z][a-zA-Z0-9_-]*`).
/// Returns the identifier string without the leading `@`.
///
/// # Errors
///
/// Returns a nom error if the input does not start with `@` followed by a
/// valid identifier character sequence.
///
/// # Examples
///
/// - `"@all"` parses to `("all", "")`
/// - `"@cleo-core rest"` parses to `("cleo-core", " rest")`
pub fn parse_address(input: &str) -> IResult<&str, &str> {
    let (input, _) = char('@')(input)?;
    recognize(pair(
        nom::character::complete::satisfy(is_identifier_start),
        take_while(is_identifier_continuation),
    ))(input)
}

/// Parses a task reference from the input.
///
/// A task reference is `T` followed by one or more digits.
/// Returns the full reference including the `T` prefix (e.g., `"T1234"`).
///
/// # Errors
///
/// Returns a nom error if the input does not start with `T` followed by one
/// or more ASCII digits.
///
/// # Examples
///
/// - `"T1234"` parses to `("T1234", "")`
/// - `"T5678 rest"` parses to `("T5678", " rest")`
pub fn parse_task_ref(input: &str) -> IResult<&str, &str> {
    recognize(pair(char('T'), take_while1(|c: char| c.is_ascii_digit())))(input)
}

/// Parses a tag from the input.
///
/// A tag is `#` followed by an IDENTIFIER (`[a-zA-Z][a-zA-Z0-9_-]*`).
/// Returns the identifier string without the leading `#`.
///
/// # Errors
///
/// Returns a nom error if the input does not start with `#` followed by a
/// valid identifier character sequence.
///
/// # Examples
///
/// - `"#shipped"` parses to `("shipped", "")`
/// - `"#phase-B rest"` parses to `("phase-B", " rest")`
pub fn parse_tag(input: &str) -> IResult<&str, &str> {
    let (input, _) = char('#')(input)?;
    recognize(pair(
        nom::character::complete::satisfy(is_identifier_start),
        take_while(is_identifier_continuation),
    ))(input)
}

/// Represents a structured element extracted from a CANT header line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderElement {
    /// A directive verb (e.g., `"done"` from `/done`).
    Directive(String),
    /// An address identifier (e.g., `"all"` from `@all`).
    Address(String),
    /// A task reference (e.g., `"T1234"`).
    TaskRef(String),
    /// A tag identifier (e.g., `"shipped"` from `#shipped`).
    Tag(String),
}

/// Returns true if the character immediately following a task ref means
/// the `T` + digits was part of a longer word (not a standalone task ref).
fn is_task_ref_boundary(rest: &str) -> bool {
    rest.chars()
        .next()
        .is_none_or(|c| !c.is_ascii_alphabetic() && c != '_' && c != '-')
}

/// Parses a complete header line, extracting all structured elements.
///
/// The header is the first line of a CANT message. It may contain:
/// - An optional directive at the start (e.g., `/done`)
/// - Zero or more addresses (e.g., `@all`)
/// - Zero or more task references (e.g., `T1234`)
/// - Zero or more tags (e.g., `#shipped`)
/// - Free-form text (ignored during extraction)
///
/// Returns a vector of extracted [`HeaderElement`] values.
pub fn parse_header(header: &str) -> Vec<HeaderElement> {
    let mut elements = Vec::new();
    let mut remaining = header.trim_start();

    // Try to parse directive at the very start
    if let Ok((rest, verb)) = parse_directive(remaining) {
        elements.push(HeaderElement::Directive(verb.to_string()));
        remaining = rest;
    }

    // Scan through the rest of the header for addresses, task_refs, and tags
    while !remaining.is_empty() {
        // Skip whitespace
        let trimmed = remaining.trim_start();
        if trimmed.is_empty() {
            break;
        }
        remaining = trimmed;

        if let Ok((rest, addr)) = parse_address(remaining) {
            elements.push(HeaderElement::Address(addr.to_string()));
            remaining = rest;
            continue;
        }

        if let Ok((rest, task)) = parse_task_ref(remaining) {
            if task.len() > 1 && is_task_ref_boundary(rest) {
                elements.push(HeaderElement::TaskRef(task.to_string()));
                remaining = rest;
                continue;
            }
        }

        if let Ok((rest, tag)) = parse_tag(remaining) {
            elements.push(HeaderElement::Tag(tag.to_string()));
            remaining = rest;
            continue;
        }

        // Skip one character of unrecognized text
        remaining = &remaining[remaining.chars().next().map_or(0, |c| c.len_utf8())..];
    }

    elements
}

/// Scans body text for addresses, task references, and tags.
///
/// Unlike header parsing, body parsing does not look for directives.
/// It extracts all structured references found anywhere in the body text.
///
/// Returns a tuple of `(addresses, task_refs, tags)`.
pub fn parse_body(body: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut addresses = Vec::new();
    let mut task_refs = Vec::new();
    let mut tags = Vec::new();

    let mut remaining = body;

    while !remaining.is_empty() {
        if let Ok((rest, addr)) = parse_address(remaining) {
            addresses.push(addr.to_string());
            remaining = rest;
            continue;
        }

        if let Ok((rest, task)) = parse_task_ref(remaining) {
            if task.len() > 1 && is_task_ref_boundary(rest) {
                task_refs.push(task.to_string());
                remaining = rest;
                continue;
            }
        }

        if let Ok((rest, tag)) = parse_tag(remaining) {
            tags.push(tag.to_string());
            remaining = rest;
            continue;
        }

        // Advance one character
        remaining = &remaining[remaining.chars().next().map_or(0, |c| c.len_utf8())..];
    }

    (addresses, task_refs, tags)
}

/// Splits raw message content into header (first line) and body (everything after).
///
/// The header is defined as the first line of the message. The body is everything
/// after the first newline. If there is no newline, the entire content is the header
/// and the body is empty.
pub fn split_header_body(content: &str) -> (&str, &str) {
    match content.find('\n') {
        Some(idx) => {
            let header = &content[..idx];
            let body = &content[idx + 1..];
            (header, body)
        }
        None => (content, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_directive() {
        let result = parse_directive("/done rest");
        assert!(result.is_ok());
        let (rest, verb) = result.ok().unwrap();
        assert_eq!(verb, "done");
        assert_eq!(rest, " rest");
    }

    #[test]
    fn test_parse_directive_with_dash() {
        let result = parse_directive("/check-in");
        assert!(result.is_ok());
        let (rest, verb) = result.ok().unwrap();
        assert_eq!(verb, "check-in");
        assert_eq!(rest, "");
    }

    #[test]
    fn test_parse_directive_single_char() {
        // Single lowercase letter is a valid verb
        let result = parse_directive("/a");
        assert!(result.is_ok());
        let (_, verb) = result.ok().unwrap();
        assert_eq!(verb, "a");
    }

    #[test]
    fn test_parse_directive_uppercase_fails() {
        // VERB must start with lowercase
        let result = parse_directive("/Done");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_address() {
        let result = parse_address("@cleo-core more");
        assert!(result.is_ok());
        let (rest, addr) = result.ok().unwrap();
        assert_eq!(addr, "cleo-core");
        assert_eq!(rest, " more");
    }

    #[test]
    fn test_parse_address_simple() {
        let result = parse_address("@all");
        assert!(result.is_ok());
        let (rest, addr) = result.ok().unwrap();
        assert_eq!(addr, "all");
        assert_eq!(rest, "");
    }

    #[test]
    fn test_parse_address_with_numbers() {
        let result = parse_address("@agent123");
        assert!(result.is_ok());
        let (_, addr) = result.ok().unwrap();
        assert_eq!(addr, "agent123");
    }

    #[test]
    fn test_parse_address_digit_start_fails() {
        // IDENTIFIER must start with a letter
        let result = parse_address("@123");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_task_ref() {
        let result = parse_task_ref("T1234 stuff");
        assert!(result.is_ok());
        let (rest, tr) = result.ok().unwrap();
        assert_eq!(tr, "T1234");
        assert_eq!(rest, " stuff");
    }

    #[test]
    fn test_parse_task_ref_no_digits_fails() {
        let result = parse_task_ref("Tabc");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_tag() {
        let result = parse_tag("#shipped end");
        assert!(result.is_ok());
        let (rest, tag) = result.ok().unwrap();
        assert_eq!(tag, "shipped");
        assert_eq!(rest, " end");
    }

    #[test]
    fn test_parse_tag_with_dash() {
        let result = parse_tag("#phase-B");
        assert!(result.is_ok());
        let (rest, tag) = result.ok().unwrap();
        assert_eq!(tag, "phase-B");
        assert_eq!(rest, "");
    }

    #[test]
    fn test_parse_tag_digit_start_fails() {
        let result = parse_tag("#123");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_header_full() {
        let elements = parse_header("/done @all T1234 #shipped");
        assert_eq!(
            elements,
            vec![
                HeaderElement::Directive("done".to_string()),
                HeaderElement::Address("all".to_string()),
                HeaderElement::TaskRef("T1234".to_string()),
                HeaderElement::Tag("shipped".to_string()),
            ]
        );
    }

    #[test]
    fn test_parse_header_no_directive() {
        let elements = parse_header("just some plain text @mention");
        assert_eq!(
            elements,
            vec![HeaderElement::Address("mention".to_string())]
        );
    }

    #[test]
    fn test_parse_header_multiple_addresses() {
        let elements = parse_header("/action @cleo-core @signaldock-dev");
        assert_eq!(
            elements,
            vec![
                HeaderElement::Directive("action".to_string()),
                HeaderElement::Address("cleo-core".to_string()),
                HeaderElement::Address("signaldock-dev".to_string()),
            ]
        );
    }

    #[test]
    fn test_parse_header_multiple_task_refs() {
        let elements = parse_header("/blocked T1234 T5679");
        assert_eq!(
            elements,
            vec![
                HeaderElement::Directive("blocked".to_string()),
                HeaderElement::TaskRef("T1234".to_string()),
                HeaderElement::TaskRef("T5679".to_string()),
            ]
        );
    }

    #[test]
    fn test_parse_body_extracts_refs() {
        let (addrs, tasks, tags) = parse_body("Working on T5678 with @agent #urgent");
        assert_eq!(addrs, vec!["agent"]);
        assert_eq!(tasks, vec!["T5678"]);
        assert_eq!(tags, vec!["urgent"]);
    }

    #[test]
    fn test_parse_body_empty() {
        let (addrs, tasks, tags) = parse_body("");
        assert!(addrs.is_empty());
        assert!(tasks.is_empty());
        assert!(tags.is_empty());
    }

    #[test]
    fn test_task_ref_not_matched_in_word() {
        // "The" should not be matched as a task ref "T" + "he"
        // because "he" are not digits
        let elements = parse_header("The quick brown fox");
        assert!(elements.is_empty());
    }

    #[test]
    fn test_split_header_body_basic() {
        let (header, body) = split_header_body("/done @all\n\nBody text here");
        assert_eq!(header, "/done @all");
        assert_eq!(body, "\nBody text here");
    }

    #[test]
    fn test_split_header_body_no_newline() {
        let (header, body) = split_header_body("/done @all");
        assert_eq!(header, "/done @all");
        assert_eq!(body, "");
    }

    #[test]
    fn test_split_header_body_empty() {
        let (header, body) = split_header_body("");
        assert_eq!(header, "");
        assert_eq!(body, "");
    }
}

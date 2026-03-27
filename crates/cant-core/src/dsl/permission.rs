//! Permission block parser for CANT DSL agent definitions.
//!
//! Parses `permissions:` blocks within agent definitions:
//! ```cant
//! permissions:
//!   tasks: read, write
//!   session: read
//! ```

use super::ast::Permission;
use super::error::ParseError;
use super::indent::IndentedLine;
use super::span::Span;

/// Parses a `permissions:` block's child lines into [`Permission`] entries.
///
/// Each child line should be in the format `domain: access1, access2`.
/// The `lines` parameter should be the indented block under `permissions:`.
pub fn parse_permissions(lines: &[IndentedLine<'_>]) -> Result<Vec<Permission>, ParseError> {
    let mut permissions = Vec::new();

    for line in lines {
        if line.is_blank() || line.is_comment() {
            continue;
        }

        let content = line.content;
        let base_offset = line.byte_offset + line.indent;
        let line_span = Span::new(
            base_offset,
            base_offset + content.len(),
            line.line_number,
            (line.indent as u32) + 1,
        );

        let colon_pos = content.find(':').ok_or_else(|| {
            ParseError::error(
                format!("expected `domain: access, ...` in permissions block, got: {content}"),
                line_span,
            )
        })?;

        let domain = content[..colon_pos].trim().to_string();
        let access_str = content[colon_pos + 1..].trim();

        if domain.is_empty() {
            return Err(ParseError::error(
                "empty domain in permissions block",
                line_span,
            ));
        }

        let access: Vec<String> = access_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if access.is_empty() {
            return Err(ParseError::error(
                format!("no access levels specified for domain '{domain}'"),
                line_span,
            ));
        }

        permissions.push(Permission {
            domain,
            access,
            span: line_span,
        });
    }

    Ok(permissions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_basic_permissions() {
        let input = "    tasks: read, write\n    session: read";
        let lines = split_lines(input).unwrap();
        let perms = parse_permissions(&lines).unwrap();
        assert_eq!(perms.len(), 2);
        assert_eq!(perms[0].domain, "tasks");
        assert_eq!(perms[0].access, vec!["read", "write"]);
        assert_eq!(perms[1].domain, "session");
        assert_eq!(perms[1].access, vec!["read"]);
    }

    #[test]
    fn parse_single_permission() {
        let input = "    memory: read, write, delete";
        let lines = split_lines(input).unwrap();
        let perms = parse_permissions(&lines).unwrap();
        assert_eq!(perms.len(), 1);
        assert_eq!(perms[0].domain, "memory");
        assert_eq!(perms[0].access, vec!["read", "write", "delete"]);
    }

    #[test]
    fn skip_blank_lines() {
        let input = "    tasks: read\n\n    session: write";
        let lines = split_lines(input).unwrap();
        let perms = parse_permissions(&lines).unwrap();
        assert_eq!(perms.len(), 2);
    }

    #[test]
    fn skip_comments() {
        let input = "    # Security permissions\n    tasks: read";
        let lines = split_lines(input).unwrap();
        let perms = parse_permissions(&lines).unwrap();
        assert_eq!(perms.len(), 1);
    }

    #[test]
    fn missing_colon_is_error() {
        let input = "    tasks read write";
        let lines = split_lines(input).unwrap();
        let err = parse_permissions(&lines).unwrap_err();
        assert!(err.message.contains("domain: access"));
    }

    #[test]
    fn empty_domain_is_error() {
        let input = "    : read, write";
        let lines = split_lines(input).unwrap();
        let err = parse_permissions(&lines).unwrap_err();
        assert!(err.message.contains("empty domain"));
    }

    #[test]
    fn no_access_levels_is_error() {
        let input = "    tasks:";
        let lines = split_lines(input).unwrap();
        let err = parse_permissions(&lines).unwrap_err();
        assert!(err.message.contains("no access levels"));
    }
}

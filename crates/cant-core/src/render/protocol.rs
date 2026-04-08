//! Protocol-document rendering for the CANT renderer.
//!
//! CleoOS v2 `kind: protocol` documents describe RCASD/IVTR protocol contracts
//! (see `docs/plans/CLEO-ULTRAPLAN.md` §8). At the grammar level they are
//! structurally identical to any other CANT document: frontmatter plus a
//! sequence of top-level sections. Wave 1 therefore delegates layout to the
//! shared [`super::render_generic_document`] helper and only exists so that
//! later waves have a single place to hang protocol-specific rendering rules
//! (prose bodies, RCASD stage headings, etc.) without having to split the
//! top-level [`super::render_document`] dispatcher again.
//!
//! # Wave 1 scope
//!
//! Only the frontmatter and any recognised top-level sections round-trip.
//! Prose bodies and structured protocol subsections ship in a later wave —
//! fixtures under `tests/fixtures/render-round-trip/` are authored to match
//! what Wave 1 can actually render today.

use crate::dsl::ast::CantDocument;

/// Renders a `kind: protocol` document.
///
/// For Wave 1 this defers to [`super::render_generic_document`]; protocol
/// documents are modelled as a frontmatter block followed by zero or more
/// supported top-level sections. The function exists as a stable extension
/// point so later waves can add protocol-specific layout rules without
/// touching the main dispatcher.
pub fn render_protocol(doc: &CantDocument) -> String {
    super::render_generic_document(doc)
}

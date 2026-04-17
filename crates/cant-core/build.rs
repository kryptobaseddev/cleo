//! Build script for cant-core: generates `src/generated/events.rs` from
//! `packages/caamp/providers/hook-mappings.json` (the canonical `SSoT` for all
//! event definitions).
//!
//! # Determinism
//!
//! The generator's output is piped through `rustfmt --edition 2024` before
//! being written to disk. This guarantees that re-running the generator on
//! an unchanged `hook-mappings.json` produces a byte-identical `events.rs`,
//! so `cargo build` on a fresh checkout never dirties the working tree.
//!
//! If `rustfmt` is not available on `PATH` the generator falls back to
//! writing the unformatted source and prints a `cargo:warning=` message —
//! the build still succeeds, but the resulting file will drift against the
//! committed copy. Every rustup toolchain ships with rustfmt, so this
//! fallback should essentially never fire in practice.
//!
//! # Regeneration
//!
//! From the workspace root:
//!
//! ```sh
//! cargo build -p cant-core
//! git diff --exit-code crates/cant-core/src/generated/events.rs
//! ```
//!
//! The second command must succeed (exit code 0) — a non-empty diff means
//! `hook-mappings.json` has changed and the committed `events.rs` is stale.
//! Stage the updated file and commit.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{self, Command, Stdio};

struct EventEntry {
    name: String,
    category: String,
    source: String,
    can_block: bool,
    description: String,
}

fn main() {
    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(v) => v,
        Err(e) => {
            eprintln!("cargo:error=cant-core build.rs: CARGO_MANIFEST_DIR not set: {e}");
            process::exit(1);
        }
    };
    let json_path =
        Path::new(&manifest_dir).join("../../packages/caamp/providers/hook-mappings.json");

    // Rerun if either the source of truth or the generator itself changes.
    println!("cargo:rerun-if-changed={}", json_path.display());
    println!("cargo:rerun-if-changed=build.rs");

    let (entries, categories, sources) = parse_mappings(&json_path);
    let raw = generate_code(&entries, &categories, &sources);
    let formatted = format_with_rustfmt(&raw);

    let out_dir = Path::new(&manifest_dir).join("src/generated");
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!(
            "cargo:error=cant-core build.rs: failed to create {}: {e}",
            out_dir.display()
        );
        process::exit(1);
    }
    write_if_changed(&out_dir.join("events.rs"), &formatted);
    write_if_changed(
        &out_dir.join("mod.rs"),
        "// @generated — DO NOT EDIT.\n\n/// Generated canonical event definitions from `hook-mappings.json`.\npub mod events;\n",
    );
}

/// Writes `contents` to `path` only if it differs from the current on-disk
/// contents. Avoids bumping mtimes (and triggering downstream rebuilds) when
/// the generator produces byte-identical output across runs.
fn write_if_changed(path: &Path, contents: &str) {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == contents {
            return;
        }
    }
    if let Err(e) = fs::write(path, contents) {
        eprintln!(
            "cargo:error=cant-core build.rs: failed to write {}: {e}",
            path.display()
        );
        process::exit(1);
    }
}

/// Pipes `source` through `rustfmt --edition 2024 --emit stdout` and returns
/// the formatted output. Falls back to the unformatted source (and emits a
/// `cargo:warning=`) if rustfmt is unavailable or exits non-zero. This keeps
/// fresh `cargo build` invocations deterministic by matching whatever a
/// `cargo fmt -p cant-core` pass would produce.
fn format_with_rustfmt(source: &str) -> String {
    let mut child = match Command::new("rustfmt")
        .args(["--edition", "2024", "--emit", "stdout"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            println!(
                "cargo:warning=cant-core build.rs: rustfmt not available ({e}); emitting unformatted events.rs"
            );
            return source.to_string();
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(source.as_bytes()) {
            println!(
                "cargo:warning=cant-core build.rs: failed to pipe source into rustfmt ({e}); emitting unformatted events.rs"
            );
            return source.to_string();
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(e) => {
            println!(
                "cargo:warning=cant-core build.rs: rustfmt did not complete ({e}); emitting unformatted events.rs"
            );
            return source.to_string();
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!(
            "cargo:warning=cant-core build.rs: rustfmt exited {} ({}); emitting unformatted events.rs",
            output.status,
            stderr.trim()
        );
        return source.to_string();
    }

    String::from_utf8(output.stdout).unwrap_or_else(|e| {
        println!(
            "cargo:warning=cant-core build.rs: rustfmt produced non-UTF-8 output ({e}); emitting unformatted events.rs"
        );
        source.to_string()
    })
}

fn parse_mappings(json_path: &Path) -> (Vec<EventEntry>, BTreeSet<String>, BTreeSet<String>) {
    let json_str = match fs::read_to_string(json_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "cargo:error=cant-core build.rs: failed to read {}: {e}",
                json_path.display()
            );
            process::exit(1);
        }
    };
    let mappings: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("cargo:error=cant-core build.rs: failed to parse hook-mappings.json: {e}");
            process::exit(1);
        }
    };

    let events = match mappings["canonicalEvents"].as_object() {
        Some(obj) => obj,
        None => {
            eprintln!(
                "cargo:error=cant-core build.rs: hook-mappings.json: canonicalEvents must be an object"
            );
            process::exit(1);
        }
    };

    let mut categories = BTreeSet::new();
    let mut sources = BTreeSet::new();
    let mut entries = Vec::new();

    for (name, meta) in events {
        let category = match meta["category"].as_str() {
            Some(s) => s.to_string(),
            None => {
                eprintln!("cargo:error=cant-core build.rs: event '{name}' missing category");
                process::exit(1);
            }
        };
        let source = match meta["source"].as_str() {
            Some(s) => s.to_string(),
            None => {
                eprintln!("cargo:error=cant-core build.rs: event '{name}' missing source");
                process::exit(1);
            }
        };
        let can_block = meta["canBlock"].as_bool().unwrap_or(false);
        let description = meta["description"].as_str().unwrap_or("").to_string();

        categories.insert(category.clone());
        sources.insert(source.clone());
        entries.push(EventEntry {
            name: name.clone(),
            category,
            source,
            can_block,
            description,
        });
    }

    // Sort: provider events first, then domain events; alphabetical within each group
    entries.sort_by(|a, b| {
        let source_order = |s: &str| -> u8 {
            match s {
                "provider" => 0,
                "domain" => 1,
                _ => 2,
            }
        };
        source_order(&a.source)
            .cmp(&source_order(&b.source))
            .then(a.name.cmp(&b.name))
    });

    (entries, categories, sources)
}

fn generate_code(
    entries: &[EventEntry],
    categories: &BTreeSet<String>,
    sources: &BTreeSet<String>,
) -> String {
    let mut c = String::with_capacity(8192);

    c.push_str(
        "// @generated — DO NOT EDIT. Source: packages/caamp/providers/hook-mappings.json\n",
    );
    c.push_str("// Generated by crates/cant-core/build.rs, formatted with rustfmt.\n");
    c.push_str("// Regenerate with: `cargo build -p cant-core`\n");
    c.push_str(
        "// Drift check:  `cargo build -p cant-core && git diff --exit-code crates/cant-core/src/generated/events.rs`\n\n",
    );
    c.push_str("use serde::{Deserialize, Serialize};\n\n");

    gen_category_enum(&mut c, categories);
    gen_source_enum(&mut c, sources);
    gen_event_enum(&mut c, entries);
    gen_event_impl(&mut c, entries);
    gen_helpers(&mut c, entries);

    c
}

fn gen_category_enum(c: &mut String, categories: &BTreeSet<String>) {
    c.push_str("/// Event categories derived from hook-mappings.json.\n");
    c.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\n");
    c.push_str("pub enum EventCategory {\n");
    for cat in categories {
        c.push_str(&format!(
            "    /// `{}` category.\n    {},\n",
            cat,
            pascal_case(cat)
        ));
    }
    c.push_str("}\n\n");
    c.push_str("impl EventCategory {\n");
    c.push_str("    /// Returns the lowercase string representation.\n");
    c.push_str("    pub const fn as_str(&self) -> &'static str {\n");
    c.push_str("        match self {\n");
    for cat in categories {
        c.push_str(&format!(
            "            Self::{} => \"{}\",\n",
            pascal_case(cat),
            cat
        ));
    }
    c.push_str("        }\n    }\n}\n\n");
}

fn gen_source_enum(c: &mut String, sources: &BTreeSet<String>) {
    c.push_str("/// Event source types derived from hook-mappings.json.\n");
    c.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\n");
    c.push_str("pub enum EventSource {\n");
    for src in sources {
        c.push_str(&format!(
            "    /// `{}` source.\n    {},\n",
            src,
            pascal_case(src)
        ));
    }
    c.push_str("}\n\n");
    c.push_str("impl EventSource {\n");
    c.push_str("    /// Returns the lowercase string representation.\n");
    c.push_str("    pub const fn as_str(&self) -> &'static str {\n");
    c.push_str("        match self {\n");
    for src in sources {
        c.push_str(&format!(
            "            Self::{} => \"{}\",\n",
            pascal_case(src),
            src
        ));
    }
    c.push_str("        }\n    }\n}\n\n");
}

fn gen_event_enum(c: &mut String, entries: &[EventEntry]) {
    c.push_str(
        "/// All canonical events (provider + domain) derived from hook-mappings.json.\n///\n",
    );
    c.push_str(&format!(
        "/// Total: {} events ({} provider, {} domain).\n",
        entries.len(),
        entries.iter().filter(|e| e.source == "provider").count(),
        entries.iter().filter(|e| e.source == "domain").count(),
    ));
    c.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\n");
    c.push_str("pub enum CanonicalEvent {\n");

    let mut current_source = String::new();
    for entry in entries {
        if entry.source != current_source {
            current_source.clone_from(&entry.source);
            c.push_str(&format!(
                "\n    // {} events\n",
                pascal_case(&current_source)
            ));
        }
        c.push_str(&format!(
            "    /// `{}` — `{}` category. {}.\n    {},\n",
            entry.name, entry.category, entry.description, entry.name
        ));
    }
    c.push_str("}\n\n");
}

fn gen_event_impl(c: &mut String, entries: &[EventEntry]) {
    c.push_str("impl CanonicalEvent {\n");

    // ALL const
    c.push_str("    /// All canonical events in registry order.\n");
    c.push_str("    pub const ALL: &[Self] = &[\n");
    for e in entries {
        c.push_str(&format!("        Self::{},\n", e.name));
    }
    c.push_str("    ];\n\n");

    // as_str
    gen_const_match(c, "as_str", "&'static str", entries, |e| {
        format!("\"{}\"", e.name)
    });

    // from_str
    c.push_str("    /// Parses a `PascalCase` event name. O(1) via compiler-optimized match.\n");
    c.push_str("    #[allow(clippy::should_implement_trait)]\n");
    c.push_str("    pub fn from_str(s: &str) -> Option<Self> {\n");
    c.push_str("        match s {\n");
    for e in entries {
        c.push_str(&format!(
            "            \"{}\" => Some(Self::{}),\n",
            e.name, e.name
        ));
    }
    c.push_str("            _ => None,\n        }\n    }\n\n");

    // category
    gen_const_match(c, "category", "EventCategory", entries, |e| {
        format!("EventCategory::{}", pascal_case(&e.category))
    });

    // source
    gen_const_match(c, "source", "EventSource", entries, |e| {
        format!("EventSource::{}", pascal_case(&e.source))
    });

    // can_block
    gen_const_match(c, "can_block", "bool", entries, |e| {
        format!("{}", e.can_block)
    });

    // description
    gen_const_match(c, "description", "&'static str", entries, |e| {
        format!("\"{}\"", e.description.replace('"', "\\\""))
    });

    // Iterator methods
    c.push_str("    /// Returns all events that can block execution.\n");
    c.push_str("    pub fn blocking_events() -> impl Iterator<Item = Self> {\n");
    c.push_str("        Self::ALL.iter().copied().filter(|e| e.can_block())\n    }\n\n");

    c.push_str("    /// Returns all provider-sourced events.\n");
    c.push_str("    pub fn provider_events() -> impl Iterator<Item = Self> {\n");
    c.push_str("        Self::ALL.iter().copied().filter(|e| matches!(e.source(), EventSource::Provider))\n    }\n\n");

    c.push_str("    /// Returns all domain-sourced events.\n");
    c.push_str("    pub fn domain_events() -> impl Iterator<Item = Self> {\n");
    c.push_str("        Self::ALL.iter().copied().filter(|e| matches!(e.source(), EventSource::Domain))\n    }\n");

    c.push_str("}\n\n");
}

fn gen_const_match(
    c: &mut String,
    name: &str,
    ret: &str,
    entries: &[EventEntry],
    value_fn: impl Fn(&EventEntry) -> String,
) {
    let doc = match name {
        "as_str" => "Returns the `PascalCase` string name.",
        "category" => "Returns the event category.",
        "source" => "Returns the event source (provider or domain).",
        "can_block" => "Whether a hook handler can block the associated action.",
        "description" => "Human-readable description for LSP hover and diagnostics.",
        _ => "",
    };
    c.push_str(&format!("    /// {doc}\n"));
    c.push_str(&format!("    pub const fn {name}(&self) -> {ret} {{\n"));
    c.push_str("        match self {\n");
    for e in entries {
        c.push_str(&format!(
            "            Self::{} => {},\n",
            e.name,
            value_fn(e)
        ));
    }
    c.push_str("        }\n    }\n\n");
}

fn gen_helpers(c: &mut String, entries: &[EventEntry]) {
    let all_names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    c.push_str("/// Comma-separated list of all canonical event names for diagnostic messages.\n");
    c.push_str(&format!(
        "pub const CANONICAL_EVENT_NAMES_CSV: &str = \"{}\";\n\n",
        all_names.join(", ")
    ));

    c.push_str("/// Returns true if the given string is a valid canonical event name.\n///\n");
    c.push_str("/// Backward-compatible wrapper around `CanonicalEvent::from_str`.\n");
    c.push_str("pub fn is_canonical_event(name: &str) -> bool {\n");
    c.push_str("    CanonicalEvent::from_str(name).is_some()\n}\n");
}

/// Converts a lowercase string to `PascalCase`.
fn pascal_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

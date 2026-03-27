# signaldock-storage

<!-- cargo-rdme start -->

Repository trait abstraction and database adapters for
`SignalDock`.

This crate defines storage-agnostic repository traits
([`traits`]) and concrete adapter implementations for
`SQLite` (`adapters::sqlite`) and `PostgreSQL`
(`adapters::postgres`).

## Feature flags

| Flag | Enables |
|------|---------|
| `sqlite` | [`SqliteStore`] adapter and `SQLite` migrations |
| `postgres` | `PostgresStore` adapter and `PostgreSQL` migrations |

## Modules

- [`types`] — Pagination, query filters, and stats deltas.
- [`traits`] — Repository trait definitions.
- [`adapters`] — Database-specific implementations.

## Design

Repository trait abstraction defined in
[ADR-002: Storage Abstraction](../../docs/dev/adr/002-storage-abstraction.md).
Dynamic query rationale in
[ADR-003: Dynamic sqlx Queries](../../docs/dev/adr/003-dynamic-sqlx-queries.md).

<!-- cargo-rdme end -->

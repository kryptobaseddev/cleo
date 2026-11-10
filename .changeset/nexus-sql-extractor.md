---
id: nexus-sql-extractor
tasks: [T14383]
kind: feat
summary: "NEXUS extracts SQL tables, views, indexes, triggers, constraints and migration statements into the code graph, and SQL files now request and complete exactly those SQL capabilities"
---

- **SQL extractor.** A bounded SQL DDL extractor reads every `.sql` file:
  `CREATE TABLE|VIRTUAL TABLE|VIEW|INDEX|TRIGGER` become graph nodes (`meta.sqlKind` holds
  the SQL kind), `PRIMARY KEY`, `UNIQUE`, `CHECK` and foreign keys are recorded
  on the table node, and foreign keys, indexes, views, trigger bodies and
  `ALTER TABLE` / `DROP` migration statements link to the tables they name,
  across files and through `RENAME TO`.
- **Coverage.** A SQL file requests and completes `sql-schema-objects`,
  `sql-migrations`, `sql-triggers` and `sql-constraints`, and knowledge
  coverage requires exactly those. A file with an unterminated quote or
  block, or a statement no SQL form matches, is reported as partially read
  and completes none of them. Literal SQL inside executable sources and
  dynamic SQL stay stated limitations.

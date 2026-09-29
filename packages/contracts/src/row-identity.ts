/**
 * Row identity contracts — the uid every syncing row carries as its merge key
 * (T12341).
 *
 * A table whose Gate A class syncs (`portable-*`) gets a `uid` column. The
 * local primary key stays the local key and local foreign keys keep pointing
 * at it; the uid is what a merge compares. The registry that declares, per
 * table, how its uid is made lives in core (`store/row-identity.ts`); this
 * module holds only the shapes.
 *
 * Spec: `cleo docs fetch t12341-uid-scheme`.
 *
 * Types only (arch gate 10): no runtime values are exported from here.
 *
 * @task T12341
 * @epic T12323
 * @module row-identity
 */

/**
 * How a table's uid is made.
 *
 * - `minted` — the local key was allocated on one device (`T####`, an
 *   autoincrement integer, a random id), so equal keys on two devices may be
 *   different rows. A new row gets a random UUIDv7; a row without a uid (an
 *   existing row, or one an older build wrote) gets a deterministic v7-layout
 *   uid over (table, key, birth, owner uids, content).
 * - `natural` — the key is content or a relationship (an edge, a label), so
 *   equal keys mean the same row everywhere. The uid is a UUIDv8 over the key
 *   with every reference replaced by the referenced row's uid.
 *
 * @task T12341
 */
export type RowIdentityKind = 'minted' | 'natural';

/**
 * A column that holds another row's local key.
 *
 * @task T12341
 */
export interface RowIdentityRef {
  /** Physical column in this table. */
  readonly column: string;
  /** Physical table the column points into (its single-column local key). */
  readonly table: string;
}

/**
 * A stored copy of a fact about a referenced row, taken when the row is
 * written: its uid (`ac_uid`, kept because an AC id is derived from the AC
 * text and changes on edit), or the hash of its text (`ac_text_hash`, the
 * text the evidence was recorded against).
 *
 * @task T12341
 */
export interface StoredRefUid {
  /** Physical column holding the copied fact (e.g. `ac_uid`). */
  readonly column: string;
  /** Column holding the referenced local key (e.g. `ac_id`). */
  readonly from: string;
  /** Referenced table. */
  readonly table: string;
  /** What is copied: the referenced row's uid (default) or the hash of its `text`. */
  readonly source?: 'uid' | 'text_hash';
}

/**
 * A relation table whose rows are symmetric for some values of a type column:
 * the endpoint uids are hashed in sorted order, so `A related B` and
 * `B related A` are one edge.
 *
 * @task T12341
 */
export interface SymmetricEdge {
  /** Column holding the relation type. */
  readonly column: string;
  /** Type values that are symmetric; every other value keeps direction. */
  readonly values: readonly string[];
}

/**
 * How one syncing table carries its uid.
 *
 * @task T12341
 */
export interface RowIdentitySpec {
  /** Physical table name. */
  readonly table: string;
  /** How the uid is made. */
  readonly kind: RowIdentityKind;
  /** Local key columns, in hash order. */
  readonly key: readonly string[];
  /** `minted`: the column recording when the row was created. */
  readonly birth?: string;
  /** `minted`: references whose target uid is part of the row's identity. */
  readonly owners?: readonly RowIdentityRef[];
  /**
   * `minted`, append-only tables only: columns hashed into the uid. Their
   * rows never change, and their keys collide across devices by construction.
   */
  readonly content?: readonly string[];
  /** `natural`: key columns that reference rows; their target uid is hashed. */
  readonly keyRefs?: readonly RowIdentityRef[];
  /**
   * `minted`: facts of the row's creation hashed into its birth fingerprint
   * (`birth_fp`), besides the raw birth. Each entry is a column name, or
   * `@owner:<column>` (the uid of the owner that column references), or
   * `@auditTitle` (the title of the task's earliest `task_created` audit
   * event, else its current title). Frozen per recipe version.
   */
  readonly birthFacts?: readonly string[];
  /** `natural` relation tables: the symmetric relation types. */
  readonly symmetric?: SymmetricEdge;
  /**
   * `minted`: every uid is random, never derived from content, including for
   * existing rows. Required for `portable-secret` tables.
   */
  readonly randomOnly?: boolean;
  /** Other references, translated to uids on the wire (not hashed). */
  readonly refs?: readonly RowIdentityRef[];
  /** JSON-array columns of referenced keys, translated element by element. */
  readonly jsonArrayRefs?: readonly RowIdentityRef[];
  /** Stored copies of referenced uids. */
  readonly storedRefUids?: readonly StoredRefUid[];
  /** The key is a user-facing display id that a collision re-mints. */
  readonly displayId?: boolean;
  /** Task that declared the table. */
  readonly task: string;
}

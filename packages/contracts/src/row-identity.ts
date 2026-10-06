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
   * (`birth_fp`), besides the canonical birth. Each entry is a column name,
   * `@ownerFp:<column>` (the birth fingerprint of the owner that column
   * references, so the children of two colliding owners fingerprint apart),
   * or `@refFp:<column>` (the fingerprint of the row a stored reference uid
   * column names, e.g. the AC behind `ac_uid`).
   * Read from the row as it is when its identity is first assigned; frozen
   * per recipe version.
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

/**
 * One signal behind a store's row-identity share state (T13231).
 *
 * - `synced-marker`: `row_identity_synced` is set (a receive or a send happened);
 * - `sync-flag`: `sync.seal`, `sync.push` or `sync.pull` is on;
 * - `journal-rows`: a change-journal table holds rows (every `_sync_*` table
 *   except `_sync_meta`, `_sync_replica` and `_sync_clock`; they key rows by uid);
 * - `journal-meta`: `_sync_meta` holds `suspect:` or `baseline:` keys;
 * - `identity-aliases`: an alias table holds rows (uids were re-keyed);
 * - `rebound`: the store was copied, moved or restored (`_sync_replica`);
 * - `vault-pushed`: a vault push or restore of this root is recorded locally;
 * - `nexus-linked-no-vault`: linked to Cleo Nexus with no local vault record;
 * - `nexus-checkpoint`: Cleo Nexus holds a checkpoint or journal segment of the project;
 * - `nexus-unreachable`: Cleo Nexus could not be asked;
 * - `unreadable`: a record needed for the verdict could not be read.
 */
export type RowIdentityShareSignalCode =
  | 'synced-marker'
  | 'sync-flag'
  | 'journal-rows'
  | 'journal-meta'
  | 'identity-aliases'
  | 'rebound'
  | 'vault-pushed'
  | 'nexus-linked-no-vault'
  | 'nexus-checkpoint'
  | 'nexus-unreachable'
  | 'unreadable';

/** One signal behind a share verdict (T13231). */
export interface RowIdentityShareSignal {
  readonly code: RowIdentityShareSignalCode;
  /** `shared`: the uids may have left the store; `unknown`: that cannot be ruled out. */
  readonly kind: 'shared' | 'unknown';
  readonly detail: string;
}

/**
 * Whether a store's row identity may have left it (T13231).
 *
 * - `shared`: its uids have, or may have, reached another store;
 * - `unknown`: that cannot be ruled out;
 * - `unshared`: provably local, so a from-scratch refill changes nothing any
 *   other store holds.
 */
export interface RowIdentityShareState {
  readonly state: 'shared' | 'unknown' | 'unshared';
  /** Every signal that decided it (empty when unshared). */
  readonly signals: readonly RowIdentityShareSignal[];
  /** The signals' details, one line each (empty when unshared). */
  readonly reasons: readonly string[];
}

/** What Cleo Nexus answered for one linked origin (`cleo doctor row-identity`, T13231). */
export interface RowIdentityNexusAnswer {
  readonly apiUrl: string;
  readonly remoteProjectId: string;
  readonly streamId: string;
  /** `none`: no checkpoint and no journal segment; `present`: some; `error`: not answered. */
  readonly answer: 'none' | 'present' | 'error';
  readonly checkpoints: number;
  readonly headSeq: number;
  /** Why it was not answered (`error` only). */
  readonly error?: string;
}

/** Rows whose identity a full refill re-derives, per table. */
export type RowIdentityRefillCounts = Readonly<Record<string, number>>;

/**
 * `cleo doctor row-identity --refill`: the verdict, its evidence and the plan
 * (T13231). `applied` is false on a dry run and on a refusal.
 */
export interface RowIdentityRefillReport {
  readonly projectRoot: string;
  /** Whether the store's recipe marker is current (no refill is due). */
  readonly recipeCurrent: boolean;
  /** Whether `CLEO_ROW_UID_FILL` is on in this process (`--apply` needs it). */
  readonly fillEnabled: boolean;
  /** The local verdict (link, vault state, journal state). */
  readonly local: RowIdentityShareState;
  /** Cleo Nexus, one answer per linked origin (empty when unlinked). */
  readonly nexus: readonly RowIdentityNexusAnswer[];
  /** The verdict with the Nexus answers folded in. */
  readonly verdict: RowIdentityShareState;
  /** Rows per declared table that carry an identity value the refill clears. */
  readonly planned: RowIdentityRefillCounts;
  /** `refill`: due and allowed; `none`: nothing to do; `refuse`: shared or unknown. */
  readonly action: 'refill' | 'none' | 'refuse';
  /** What to do next, one line each. */
  readonly remedy: readonly string[];
  readonly applied: boolean;
  /** `--apply`: the pre-refill snapshot. */
  readonly snapshot: string | null;
  /** `--apply`: how to undo the refill. */
  readonly undo: string | null;
}

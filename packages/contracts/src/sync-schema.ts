/**
 * The sync schema version: one numbering for the data on a Cleo Nexus journal
 * stream (`project:<id>`, `home:<userId>`), shared by both of its writers
 * (cleo-dev decision on T13034).
 *
 * - The change journal stamps it as each segment's `schemaVersion` (journal
 *   spec §2.9: `schemaVersion = SYNC_SCHEMA_VERSION`), and a receiver refuses
 *   a higher one (`E_SCHEMA_AHEAD`) until it upgrades.
 * - The cloud vault stamps it on its `cleo-vault-delta/v1` segments and its
 *   checkpoint manifests.
 *
 * Until the journal's sealer stamps segments, only the vault uses it. T13040
 * (`SYNC_SET_VERSION`, which feeds the segment `schemaVersion`) must import
 * this constant rather than define a second number, and test that a sealed
 * segment's `schemaVersion` equals it.
 *
 * One number for both, so a vault segment inside a journal window is never a
 * schema rise of its own: the server pins every rise in a checkpoint/v3
 * manifest (`replayPin.transitions`) and holds a v3 manifest's `schemaVersion`
 * at or above the parent's and the window's last rise. Bump it once, for both
 * writers, when the synced data changes shape. It is not the vault's manifest
 * computation format (`VAULT_MANIFEST_FORMAT_VERSION` in `@cleocode/core`),
 * which never reaches the wire.
 *
 * This file is const data only (arch gate 10). Not part of `./cloud`: the
 * server mirrors that directory and only bounds this number
 * (`MAX_SCHEMA_VERSION`); the numbering is the client's.
 *
 * @task T13034
 * @epic T12323
 */

/** The `schemaVersion` the change journal and the cloud vault stamp on what they write. */
export const SYNC_SCHEMA_VERSION = 2;

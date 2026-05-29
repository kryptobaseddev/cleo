-- T11262 — Heal blob attachments written with an empty storageKey ('').
--
-- Saga T11242 (E9 · Docs SSoT pre-cutover hardening). The historical attachment
-- write paths (docs-update.ts before ce2ae3149, and the attachment-store
-- placeholder) persisted `kind:'blob'` rows whose `storageKey` was the empty
-- string instead of the contract-required `<sha[:2]>/<sha[2:]><ext>` path.
-- `packages/contracts/src/attachment.ts` declares `storageKey: z.string().min(1)`,
-- so every empty-storageKey row FAILS `attachmentSchema.parse()` — which the
-- T11242 exodus round-trip (E5/E2) validates row-by-row. The read path is
-- unaffected (it recomputes the path from sha256+mime and ignores the stored
-- storageKey), so this is a forward-only contract-conformance heal, not a
-- content move.
--
-- ## Derivation (mirrors packages/core/src/store/attachment-store.ts)
--
--   storageKey = substr(sha256,1,2) || '/' || substr(sha256,3) || extFromMime(mime)
--
-- The CASE mirrors MIME_TO_EXT exactly (ELSE '.bin', matching extFromMime's
-- fallback). The heal was validated on the operator .cleo/tasks.db: all 2477
-- empty-storageKey blob rows carry a 64-hex sha256 AND the derived on-disk file
-- exists under .cleo/attachments/sha256/ (2477/2477), so every healed key points
-- at real content.
--
-- ## Idempotency
--
-- The WHERE clause matches only storageKey='' rows, so a second run touches 0
-- rows. A pure data UPDATE has no DDL target; if its journal entry is ever lost
-- and the migration re-runs (cf. T1158/063eda621), the re-run is a safe no-op.
UPDATE attachments
SET attachment_json = json_set(
  attachment_json,
  '$.storageKey',
  substr(sha256, 1, 2) || '/' || substr(sha256, 3) || (
    CASE json_extract(attachment_json, '$.mime')
      WHEN 'text/markdown' THEN '.md'
      WHEN 'text/plain' THEN '.txt'
      WHEN 'text/html' THEN '.html'
      WHEN 'text/css' THEN '.css'
      WHEN 'text/javascript' THEN '.js'
      WHEN 'application/json' THEN '.json'
      WHEN 'application/pdf' THEN '.pdf'
      WHEN 'application/zip' THEN '.zip'
      WHEN 'application/octet-stream' THEN '.bin'
      WHEN 'image/png' THEN '.png'
      WHEN 'image/jpeg' THEN '.jpg'
      WHEN 'image/gif' THEN '.gif'
      WHEN 'image/webp' THEN '.webp'
      WHEN 'image/svg+xml' THEN '.svg'
      WHEN 'audio/mpeg' THEN '.mp3'
      WHEN 'video/mp4' THEN '.mp4'
      ELSE '.bin'
    END
  )
)
WHERE json_extract(attachment_json, '$.kind') = 'blob'
  AND json_extract(attachment_json, '$.storageKey') = ''
  AND sha256 IS NOT NULL
  AND length(sha256) = 64;

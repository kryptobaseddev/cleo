/**
 * Digests of the packaged agent templates that ever shipped (T14655).
 *
 * Shared by `agent-doctor.ts` (proving a NULL-`seed_sha256` seed unedited) and
 * `agent-install.ts` (pruning only backups that hold packaged bytes), which
 * cannot import each other without a cycle.
 *
 * @module agent-seed-digests
 */

/**
 * SHA-256 digests of every version of each packaged agent template
 * (`packages/agents/templates/<agentId>.cant`) shipped before installs
 * recorded `seed_sha256`, keyed by agent id (T14655). A seed row whose
 * `seed_sha256` is NULL is unedited exactly when its file matches one of
 * these, so the D-007 refresh can replace it without losing an edit. The
 * list is closed: installs since T14654 record `seed_sha256` themselves.
 */
export const HISTORICAL_SEED_SHA256: Readonly<Record<string, readonly string[]>> = {
  'project-code-worker': [
    '9219ab1c04a28acb2f87070c935eedef39f10b976d5ced1e83f5756f24fd191d',
    '5c68938a89bba5b8bbe9efed0cc395d19f2b9ec9b2ad5c6f50395995b1672a1c',
  ],
  'project-dev-lead': [
    '4c8b8fb5d7de20221b21c9c3ce309226f70e0a847a75c1b95ec4a04691d5a13a',
    '249f85de047b1b14b0bfe455bda1dc96003d399b7590afb71295432c5333613f',
  ],
  'project-docs-worker': [
    '85083ecbf93b3ab5a1656c43aa155d57002fb1d0965e2d7d06a5686bd6a24ecb',
    'f13ac3e3350821d86b19e77fc91997e60e707ed05dca08c96e9c158862648ead',
    '52044fe98b5533a12986dcaf24d45b2a7b391f2cf44bddd7618c5a2a8282d11b',
  ],
  'project-orchestrator': [
    'e1a21a536ec32d4fd150ed8071e5f105823af71a9109c8e0e0e1d4304bfc94ac',
    'beb9e467c0b87e1842ed118a2bd8f3d3b4e30ca08e23923d460ff731d0f7b3fd',
  ],
  'project-security-worker': [
    '5f235b518c68f8173c0d42bbb0d59acd829c1a05381539b80b5a3add4c335d63',
    '31ed9b04bb9932c2505e221ba681027ce179cf3f892233163a5f9ef848a12c37',
    'ea5f1fabeece2193266f6ca9da6408d8fe20bc03e9ca7e6ab35cfa60e5d71c31',
  ],
};

/**
 * Whether `digest` is the SHA-256 of some packaged template version listed in
 * {@link HISTORICAL_SEED_SHA256}. Bytes that match none may hold user edits.
 *
 * @param digest - Lowercase hex SHA-256 of the bytes.
 * @returns `true` when the bytes are a shipped packaged template.
 */
export function isPackagedSeedDigest(digest: string): boolean {
  return Object.values(HISTORICAL_SEED_SHA256).some((digests) => digests.includes(digest));
}

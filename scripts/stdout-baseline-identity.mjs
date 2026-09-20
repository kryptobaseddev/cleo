/** Complete-call identities for the two existing stdout ratchets. */
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Return direct process.stdout.write calls with formatting-independent, literal-preserving identities. */
export function stdoutCallIdentities(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length > 0) throw new Error(`Cannot parse stdout gate input ${file}`);
  const calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'write' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'stdout' &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === 'process'
    ) {
      const tokens = [];
      function tokenise(child) {
        const children = child.getChildren(tree);
        if (children.length === 0) tokens.push([child.kind, child.getText(tree)]);
        else children.forEach(tokenise);
      }
      tokenise(node);
      calls.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        snippet: node.getText(tree),
        identity: createHash('sha256').update(JSON.stringify(tokens)).digest('hex'),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return calls;
}

/** Build a versioned multiset without increasing or merging individual call allowances. */
export function createStdoutBaseline(calls, provenance = {}) {
  return {
    schemaVersion: 2,
    total: calls.length,
    items: calls.map(({ file, line, snippet, identity }) => ({
      file,
      line,
      snippet,
      identity,
      ...provenance,
    })),
  };
}

/** Compare complete expression identities with occurrence multiplicity; locations remain diagnostics only. */
export function compareStdoutBaseline(calls, baseline) {
  if (
    baseline?.schemaVersion !== 2 ||
    !Array.isArray(baseline.items) ||
    !Number.isSafeInteger(baseline.total) ||
    baseline.total !== baseline.items.length ||
    baseline.items.some(
      (item) =>
        typeof item?.file !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.identity) ||
        !Number.isSafeInteger(item.line) ||
        item.line < 1 ||
        typeof item.snippet !== 'string',
    )
  ) {
    throw new Error(
      'Invalid stdout baseline schema; legacy locations require explicit lossless conversion',
    );
  }
  const remaining = new Map();
  for (const item of baseline.items) {
    const key = JSON.stringify([item.file, item.identity]);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added = [];
  for (const call of calls) {
    const key = JSON.stringify([call.file, call.identity]);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(call);
  }
  return { added, removed: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
}

/**
 * Convert legacy locations only through authenticated historical source supplied by the caller.
 * @remarks This offline conversion never runs as part of a normal gate; shallow CI needs no Git history.
 * @param {object} baseline - Original location-only baseline.
 * @param {string} revision - Exact historical source commit, not a moving branch name.
 * @param {Function} loadSource - Returns historical source and its Git blob identity, or throws.
 * @returns {object} One versioned entry for every original allowance, with source provenance.
 * @example convertLegacyStdoutBaseline(baseline, exactCommit, loadHistoricalBlob);
 */
export function convertLegacyStdoutBaseline(baseline, revision, loadSource) {
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !Array.isArray(baseline?.items) ||
    baseline.total !== baseline.items.length ||
    !Number.isSafeInteger(baseline.total)
  ) {
    throw new Error('Invalid historical stdout baseline or revision');
  }
  const sources = new Map();
  const items = baseline.items.map((location) => {
    const match = typeof location === 'string' && /^(.*):(\d+)$/.exec(location);
    if (!match) throw new Error('Invalid historical stdout location');
    const [, file, line] = match;
    if (!sources.has(file)) {
      const loaded = loadSource(file, revision);
      if (typeof loaded?.source !== 'string' || !/^[a-f0-9]{40}$/.test(loaded.blob)) {
        throw new Error(`Historical stdout source unavailable for ${file}`);
      }
      const header = Buffer.from(`blob ${Buffer.byteLength(loaded.source)}\0`);
      const actual = createHash('sha1').update(header).update(loaded.source).digest('hex');
      if (actual !== loaded.blob) throw new Error(`Historical stdout blob mismatch for ${file}`);
      sources.set(file, { ...loaded, calls: stdoutCallIdentities(loaded.source, file) });
    }
    const historical = sources.get(file);
    const matches = historical.calls.filter((call) => call.line === Number(line));
    if (matches.length !== 1)
      throw new Error(`Historical stdout location is missing or ambiguous: ${location}`);
    return {
      ...matches[0],
      originalLocation: location,
      sourceRevision: revision,
      sourceBlob: historical.blob,
    };
  });
  if (new Set(baseline.items).size !== items.length)
    throw new Error('Duplicate historical stdout locations');
  return { ...baseline, schemaVersion: 2, total: items.length, items };
}

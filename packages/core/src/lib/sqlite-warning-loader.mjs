/**
 * Node.js ESM loader hook for suppressing SQLite ExperimentalWarning.
 *
 * This loader is registered with --loader and patches process.emitWarning
 * before any user code runs, ensuring that the SQLite warning is suppressed
 * even for static imports.
 */

export async function initialize() {
  const _origEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, type, code, ctor) {
    const message = typeof warning === 'string' ? warning : (warning?.message || '');
    if (message?.includes?.('SQLite is an experimental feature')) {
      return;
    }
    return _origEmitWarning.call(process, warning, type, code, ctor);
  };
}

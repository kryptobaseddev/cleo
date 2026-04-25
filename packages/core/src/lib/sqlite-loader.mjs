/**
 * Node.js ESM loader hook to suppress SQLite ExperimentalWarning.
 *
 * @see https://nodejs.org/api/module.html#enable-the-loader-using-the-loader-flag
 */

// This runs at the very start, before ANY module loads
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, type, code, ctor) {
  const message = typeof warning === 'string' ? warning : (warning?.message || '');
  if (message?.includes?.('SQLite is an experimental feature')) {
    return;
  }
  return _origEmitWarning.call(process, warning, type, code, ctor);
};

// Loader hooks (these are optional, just for completeness)
export const initialize = async () => {};

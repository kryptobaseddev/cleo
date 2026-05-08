// Minimal napi-rs native addon loader for cant-napi.
const { join } = require('node:path');

function platformTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64-gnu' : 'linux-x64-gnu';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'win32-arm64-msvc' : 'win32-x64-msvc';
  }
  return `${process.platform}-${process.arch}`;
}

let nativeBinding;
try {
  nativeBinding = require(join(__dirname, `cant-napi.${platformTriple()}.node`));
} catch (e) {
  throw new Error(`Failed to load cant-napi native addon: ${e.message}`);
}

module.exports = nativeBinding;

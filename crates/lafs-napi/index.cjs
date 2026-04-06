// Minimal napi-rs native addon loader for lafs-napi.
const { join } = require('node:path');

let nativeBinding;
try {
  nativeBinding = require(join(__dirname, 'lafs-napi.linux-x64-gnu.node'));
} catch (e) {
  throw new Error(`Failed to load lafs-napi native addon: ${e.message}`);
}

module.exports = nativeBinding;

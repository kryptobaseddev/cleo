/**
 * CLEO V2 core module exports.
 * @epic T4454
 * @task T4458
 */

export { CleoError } from './errors.js';
export { formatOutput, formatSuccess, formatError } from './output.js';
export type { LafsSuccess, LafsError, LafsEnvelope } from './output.js';
export type {
  LafsAlternative,
  LafsErrorDetail,
  GatewayMeta,
  GatewaySuccess,
  GatewayError,
  GatewayEnvelope,
  CleoResponse,
} from '../types/lafs.js';
export { isLafsSuccess, isLafsError, isGatewayEnvelope } from '../types/lafs.js';
export {
  getCleoHome,
  getCleoDir,
  getCleoDirAbsolute,
  getProjectRoot,
  resolveProjectPath,
  getConfigPath,
  getSessionsPath,
  getArchivePath,
  getLogPath,
  getBackupDir,
  getGlobalConfigPath,
  isAbsolutePath,
} from './paths.js';
export { loadConfig, getConfigValue } from './config.js';
export { validateAgainstSchema, validateAgainstSchemaFile, checkSchema } from './schema.js';

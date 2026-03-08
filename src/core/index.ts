/**
 * CLEO V2 core module exports.
 * @epic T4454
 * @task T4458
 */

export type {
  CleoResponse,
  GatewayEnvelope,
  GatewayError,
  GatewayMeta,
  GatewaySuccess,
  LafsAlternative,
  LafsErrorDetail,
} from '../types/lafs.js';
export { isGatewayEnvelope, isLafsError, isLafsSuccess } from '../types/lafs.js';
export { getConfigValue, loadConfig } from './config.js';
export { CleoError } from './errors.js';
export {
  checkSchema,
  validateAgainstSchema,
  validateAgainstSchemaFile,
} from './json-schema-validator.js';
export type { LafsEnvelope, LafsError, LafsSuccess } from './output.js';
export { formatError, formatOutput, formatSuccess } from './output.js';
export {
  getArchivePath,
  getBackupDir,
  getCleoDir,
  getCleoDirAbsolute,
  getCleoHome,
  getConfigPath,
  getGlobalConfigPath,
  getLogPath,
  getProjectRoot,
  getSessionsPath,
  isAbsolutePath,
  resolveProjectPath,
} from './paths.js';

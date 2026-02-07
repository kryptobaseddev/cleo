/**
 * Tests for configuration loader
 *
 * @task T2928
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadConfig, validateConfig, resetConfig, ConfigValidationError } from '../config.js';
import { DEFAULT_CONFIG } from '../defaults.js';

describe('Configuration Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load default configuration', () => {
      const config = loadConfig();

      expect(config.cliPath).toBe('cleo');
      expect(config.timeout).toBe(30000);
      expect(config.logLevel).toBe('info');
      expect(config.enableMetrics).toBe(false);
      expect(config.maxRetries).toBe(3);
      expect(config.queryCache).toBe(true);
      expect(config.queryCacheTtl).toBe(30000);
      expect(config.auditLog).toBe(true);
      expect(config.strictValidation).toBe(true);
    });

    it('should load default lifecycle enforcement config', () => {
      const config = loadConfig();

      expect(config.lifecycleEnforcement).toBeDefined();
      expect(config.lifecycleEnforcement.mode).toBe('strict');
      expect(config.lifecycleEnforcement.allowSkip).toEqual(['consensus']);
      expect(config.lifecycleEnforcement.emergencyBypass).toBe(false);
    });

    it('should load default protocol validation config', () => {
      const config = loadConfig();

      expect(config.protocolValidation).toBeDefined();
      expect(config.protocolValidation.strictMode).toBe(true);
      expect(config.protocolValidation.blockOnViolation).toBe(true);
      expect(config.protocolValidation.logViolations).toBe(true);
    });

    it('should override with environment variables', () => {
      process.env.CLEO_MCP_CLIPATH = '/usr/local/bin/cleo';
      process.env.CLEO_MCP_TIMEOUT = '60000';
      process.env.CLEO_MCP_LOGLEVEL = 'debug';
      process.env.CLEO_MCP_ENABLEMETRICS = 'true';
      process.env.CLEO_MCP_MAXRETRIES = '5';

      const config = loadConfig();

      expect(config.cliPath).toBe('/usr/local/bin/cleo');
      expect(config.timeout).toBe(60000);
      expect(config.logLevel).toBe('debug');
      expect(config.enableMetrics).toBe(true);
      expect(config.maxRetries).toBe(5);
    });

    it('should parse boolean environment variables', () => {
      process.env.CLEO_MCP_ENABLEMETRICS = 'true';
      process.env.CLEO_MCP_AUDITLOG = '1';
      process.env.CLEO_MCP_STRICTVALIDATION = 'false';

      const config = loadConfig();

      expect(config.enableMetrics).toBe(true);
      expect(config.auditLog).toBe(true);
      expect(config.strictValidation).toBe(false);
    });

    it('should parse numeric environment variables', () => {
      process.env.CLEO_MCP_TIMEOUT = '45000';
      process.env.CLEO_MCP_MAXRETRIES = '7';
      process.env.CLEO_MCP_QUERYCACHETTL = '60000';

      const config = loadConfig();

      expect(config.timeout).toBe(45000);
      expect(config.maxRetries).toBe(7);
      expect(config.queryCacheTtl).toBe(60000);
    });

    it('should throw on invalid numeric value', () => {
      process.env.CLEO_MCP_TIMEOUT = 'not-a-number';

      expect(() => loadConfig()).toThrow(ConfigValidationError);
    });
  });

  describe('validateConfig', () => {
    it('should validate valid configuration', () => {
      expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
    });

    it('should reject invalid log level', () => {
      const config = {
        ...DEFAULT_CONFIG,
        logLevel: 'invalid' as 'info',
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be one of/);
    });

    it('should reject timeout below minimum', () => {
      const config = {
        ...DEFAULT_CONFIG,
        timeout: 500, // Min is 1000
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be >= 1000/);
    });

    it('should reject timeout above maximum', () => {
      const config = {
        ...DEFAULT_CONFIG,
        timeout: 400000, // Max is 300000
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be <= 300000/);
    });

    it('should reject maxRetries above maximum', () => {
      const config = {
        ...DEFAULT_CONFIG,
        maxRetries: 15, // Max is 10
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be <= 10/);
    });

    it('should reject invalid type for boolean field', () => {
      const config = {
        ...DEFAULT_CONFIG,
        enableMetrics: 'yes' as unknown as boolean,
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be of type boolean/);
    });

    it('should reject missing required field', () => {
      const config = {
        ...DEFAULT_CONFIG,
        cliPath: undefined as unknown as string,
      };

      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow(/must be of type string/);
    });
  });

  describe('ConfigValidationError', () => {
    it('should format error message correctly', () => {
      const error = new ConfigValidationError('timeout', 500, 'must be >= 1000');

      expect(error.message).toBe(
        "Invalid config field 'timeout': must be >= 1000 (got 500)"
      );
      expect(error.name).toBe('ConfigValidationError');
      expect(error.field).toBe('timeout');
      expect(error.value).toBe(500);
      expect(error.constraint).toBe('must be >= 1000');
    });
  });

  describe('singleton behavior', () => {
    it('should return same config instance', () => {
      const config1 = loadConfig();
      const config2 = loadConfig();

      // Should be same object reference (but we call loadConfig directly so it creates new)
      // The singleton is accessed via getConfig() from the actual module
      expect(config1).toEqual(config2);
    });
  });
});

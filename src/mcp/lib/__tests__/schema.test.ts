/**
 * Tests for schema constants and validation
 *
 * @task T2912
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEMA_URL_OUTPUT,
  SCHEMA_URL_TASK,
  SCHEMA_URL_SESSION,
  SCHEMA_URL_MANIFEST,
  SCHEMA_URL_CONFIG,
  SCHEMA_URLS,
  getSchemaUrl,
  hasValidSchema,
  SchemaValidationError,
} from '../schema.js';

describe('schema', () => {
  describe('constants', () => {
    it('defines output schema URL', () => {
      expect(SCHEMA_URL_OUTPUT).toBe('https://cleo-dev.com/schemas/v1/output.schema.json');
    });

    it('defines task schema URL', () => {
      expect(SCHEMA_URL_TASK).toBe('https://cleo-dev.com/schemas/v1/task.schema.json');
    });

    it('defines session schema URL', () => {
      expect(SCHEMA_URL_SESSION).toBe('https://cleo-dev.com/schemas/v1/session.schema.json');
    });

    it('defines manifest schema URL', () => {
      expect(SCHEMA_URL_MANIFEST).toBe('https://cleo-dev.com/schemas/v1/manifest.schema.json');
    });

    it('defines config schema URL', () => {
      expect(SCHEMA_URL_CONFIG).toBe('https://cleo-dev.com/schemas/v1/config.schema.json');
    });

    it('exports all URLs in SCHEMA_URLS object', () => {
      expect(SCHEMA_URLS.output).toBe(SCHEMA_URL_OUTPUT);
      expect(SCHEMA_URLS.task).toBe(SCHEMA_URL_TASK);
      expect(SCHEMA_URLS.session).toBe(SCHEMA_URL_SESSION);
      expect(SCHEMA_URLS.manifest).toBe(SCHEMA_URL_MANIFEST);
      expect(SCHEMA_URLS.config).toBe(SCHEMA_URL_CONFIG);
    });
  });

  describe('getSchemaUrl', () => {
    it('returns correct URL for each type', () => {
      expect(getSchemaUrl('output')).toBe(SCHEMA_URL_OUTPUT);
      expect(getSchemaUrl('task')).toBe(SCHEMA_URL_TASK);
      expect(getSchemaUrl('session')).toBe(SCHEMA_URL_SESSION);
      expect(getSchemaUrl('manifest')).toBe(SCHEMA_URL_MANIFEST);
      expect(getSchemaUrl('config')).toBe(SCHEMA_URL_CONFIG);
    });
  });

  describe('hasValidSchema', () => {
    it('returns true for object with correct schema', () => {
      const obj = {
        $schema: SCHEMA_URL_OUTPUT,
        data: 'test',
      };

      expect(hasValidSchema(obj, 'output')).toBe(true);
    });

    it('returns false for object with wrong schema', () => {
      const obj = {
        $schema: SCHEMA_URL_TASK,
        data: 'test',
      };

      expect(hasValidSchema(obj, 'output')).toBe(false);
    });

    it('returns false for object without $schema', () => {
      const obj = {
        data: 'test',
      };

      expect(hasValidSchema(obj, 'output')).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasValidSchema(null, 'output')).toBe(false);
    });

    it('returns false for non-object types', () => {
      expect(hasValidSchema('string', 'output')).toBe(false);
      expect(hasValidSchema(123, 'output')).toBe(false);
      expect(hasValidSchema(true, 'output')).toBe(false);
      expect(hasValidSchema(undefined, 'output')).toBe(false);
    });
  });

  describe('SchemaValidationError', () => {
    it('creates error with schema type, field, and constraint', () => {
      const error = new SchemaValidationError('task', 'title', 'must not be empty');

      expect(error.name).toBe('SchemaValidationError');
      expect(error.schemaType).toBe('task');
      expect(error.field).toBe('title');
      expect(error.constraint).toBe('must not be empty');
      expect(error.message).toBe('Schema validation failed for task.title: must not be empty');
    });

    it('is instanceof Error', () => {
      const error = new SchemaValidationError('test', 'field', 'constraint');
      expect(error instanceof Error).toBe(true);
    });
  });
});

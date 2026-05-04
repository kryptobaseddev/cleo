/**
 * Fixture file for the TypeScript/JavaScript extractor regression tests.
 *
 * This file exercises every node kind that the extractor must produce:
 * Function, Class (with constructor, method, property), Interface,
 * type alias (Type), Enum, plus explicit ES module imports.
 *
 * DO NOT EDIT without updating the snapshot in extractor-regression.test.ts.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import type { Readable } from 'stream';

// --- Enum ---

/** Status codes for the domain layer. */
export enum Status {
  Active = 'active',
  Inactive = 'inactive',
  Pending = 'pending',
}

// --- Type alias ---

/** Identifier string branded for type safety. */
export type EntityId = string & { readonly __brand: 'EntityId' };

// --- Interface ---

/** Contract for storable domain objects. */
export interface Storable {
  readonly id: EntityId;
  save(): Promise<void>;
  delete(): Promise<void>;
}

/** Secondary interface to exercise multiple interface nodes. */
export interface Serializable {
  toJSON(): Record<string, unknown>;
}

// --- Class with constructor, methods, and a field ---

/** Base repository that all domain repositories extend. */
export class BaseRepository<T extends Storable> extends EventEmitter implements Serializable {
  /** In-memory store used by the fixture (not a real DB). */
  protected items: Map<EntityId, T> = new Map();

  /** Construct with an optional initial dataset. */
  constructor(initial: T[] = []) {
    super();
    for (const item of initial) {
      this.items.set(item.id, item);
    }
  }

  /** Return all stored entities. */
  findAll(): T[] {
    return Array.from(this.items.values());
  }

  /** Persist a single entity. */
  save(entity: T): void {
    this.items.set(entity.id, entity);
    this.emit('save', entity);
  }

  /** Remove an entity by id. */
  delete(id: EntityId): boolean {
    const existed = this.items.has(id);
    this.items.delete(id);
    return existed;
  }

  toJSON(): Record<string, unknown> {
    return { count: this.items.size };
  }
}

/** Concrete repository for User entities. */
export class UserRepository extends BaseRepository<User> {
  /** Find a user by their email address. */
  findByEmail(email: string): User | undefined {
    return this.findAll().find((u) => u.email === email);
  }
}

// --- Standalone functions ---

/** Create a well-typed EntityId from a raw string. */
export function makeEntityId(raw: string): EntityId {
  return raw as EntityId;
}

/** Parse a JSON string and return the typed result, or null on error. */
export function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// --- Arrow function constant (const-arrow pattern) ---

/** Resolve a module-relative asset path using node:path. */
export const resolveAsset = (relative: string): string => path.resolve(__dirname, relative);

// --- A plain class (not extending anything) so we get a second class node ---

/** Lightweight wrapper around a Readable stream with backpressure tracking. */
export class StreamReader {
  private readonly source: Readable;
  private _paused = false;

  constructor(source: Readable) {
    this.source = source;
  }

  /** Pause the underlying stream. */
  pause(): void {
    this._paused = true;
    this.source.pause();
  }

  /** Resume the underlying stream. */
  resume(): void {
    this._paused = false;
    this.source.resume();
  }

  /** Whether the stream is currently paused. */
  get paused(): boolean {
    return this._paused;
  }
}

// --- User entity (used in UserRepository above) ---

/** A minimal User domain object. */
export class User implements Storable {
  readonly id: EntityId;
  readonly email: string;

  constructor(id: EntityId, email: string) {
    this.id = id;
    this.email = email;
  }

  async save(): Promise<void> {
    // no-op in fixture
  }

  async delete(): Promise<void> {
    // no-op in fixture
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, email: this.email };
  }
}

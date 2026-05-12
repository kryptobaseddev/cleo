/**
 * Nexus DB handle pool — LRU cache for per-project graph DB handles (T9150 ADR-072).
 *
 * Cross-project queries open multiple per-project nexus-graph/<id>.db files.
 * This module provides a soft-cap LRU pool of 32 Database handles to bound
 * file descriptor usage regardless of project count.
 *
 * When the 33rd handle is requested, the least-recently-used handle is closed
 * first. This provides O(1) amortized access with bounded resource usage.
 *
 * Usage:
 * ```ts
 * const pool = getNexusHandlePool();
 * const db = pool.acquire('/path/to/nexus-graph/projId.db');
 * // use db...
 * // pool.release() is a no-op — the pool manages lifecycle
 * ```
 *
 * @task T9150
 * @see ADR-072 docs/adr/ADR-072-nexus-db-split.md
 */

import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// LRU node
// ---------------------------------------------------------------------------

interface LruNode {
  key: string;
  db: DatabaseSync;
  prev: LruNode | null;
  next: LruNode | null;
}

// ---------------------------------------------------------------------------
// NexusHandlePool
// ---------------------------------------------------------------------------

const DEFAULT_SOFT_CAP = 32;

/**
 * LRU pool of `DatabaseSync` handles for per-project nexus-graph files.
 *
 * Thread-safety note: Node.js is single-threaded; concurrent `await` calls
 * do not interleave synchronous sections. The pool is safe for async workloads.
 */
export class NexusHandlePool {
  private readonly cap: number;
  private readonly map = new Map<string, LruNode>();
  private head: LruNode | null = null; // MRU end
  private tail: LruNode | null = null; // LRU end

  constructor(softCap = DEFAULT_SOFT_CAP) {
    this.cap = softCap;
  }

  /**
   * Acquire a `DatabaseSync` handle for the given path.
   *
   * If the handle is already in the pool, it is promoted to MRU position.
   * If the pool is full, the LRU handle is closed and evicted first.
   */
  acquire(dbPath: string): DatabaseSync {
    const existing = this.map.get(dbPath);
    if (existing) {
      this.promoteToHead(existing);
      return existing.db;
    }

    if (this.map.size >= this.cap) {
      this.evictLru();
    }

    const db = new DatabaseSync(dbPath, { open: true }); // db-open-allowed: nexus graph files are per-project read/write stores, not CLEO metadata DBs
    const node: LruNode = { key: dbPath, db, prev: null, next: null };
    this.insertHead(node);
    this.map.set(dbPath, node);
    return db;
  }

  /**
   * Explicitly close and evict a handle (e.g. after a project is unregistered).
   */
  evict(dbPath: string): void {
    const node = this.map.get(dbPath);
    if (!node) return;
    this.removeNode(node);
    this.map.delete(dbPath);
    try {
      node.db.close();
    } catch {
      // best-effort
    }
  }

  /** Close all handles and clear the pool. */
  closeAll(): void {
    for (const node of this.map.values()) {
      try {
        node.db.close();
      } catch {
        // best-effort
      }
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /** Number of open handles. */
  get size(): number {
    return this.map.size;
  }

  private evictLru(): void {
    if (!this.tail) return;
    const lru = this.tail;
    this.removeNode(lru);
    this.map.delete(lru.key);
    try {
      lru.db.close();
    } catch {
      // best-effort
    }
  }

  private insertHead(node: LruNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private promoteToHead(node: LruNode): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.insertHead(node);
  }

  private removeNode(node: LruNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _pool: NexusHandlePool | null = null;

/** Return the global singleton LRU handle pool. */
export function getNexusHandlePool(): NexusHandlePool {
  _pool ??= new NexusHandlePool(DEFAULT_SOFT_CAP);
  return _pool;
}

/** Reset the singleton (for testing). */
export function resetNexusHandlePool(): void {
  _pool?.closeAll();
  _pool = null;
}

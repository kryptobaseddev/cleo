/**
 * LAFS Circuit Breaker Module
 *
 * Provides circuit breaker pattern for resilient service calls.
 *
 * @packageDocumentation
 */

/**
 * Represents the three possible states of a circuit breaker.
 *
 * @remarks
 * - `CLOSED` means the circuit is operating normally and requests pass through.
 * - `OPEN` means the circuit has tripped due to failures and requests are rejected.
 * - `HALF_OPEN` means the circuit is testing whether the downstream service has recovered.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Configuration options for a {@link CircuitBreaker} instance. */
export interface CircuitBreakerConfig {
  /** Unique identifier for this circuit breaker, used in log messages and metrics. */
  name: string;

  /**
   * Number of failures required to trip the circuit from CLOSED to OPEN.
   * @defaultValue 5
   */
  failureThreshold?: number;

  /**
   * Milliseconds to wait before transitioning from OPEN to HALF_OPEN.
   * @defaultValue 30000
   */
  resetTimeout?: number;

  /**
   * Maximum number of trial calls allowed while in the HALF_OPEN state.
   * @defaultValue 3
   */
  halfOpenMaxCalls?: number;

  /**
   * Consecutive successes required in HALF_OPEN to close the circuit.
   * @defaultValue 2
   */
  successThreshold?: number;
}

/** Snapshot of runtime metrics for a {@link CircuitBreaker}. */
export interface CircuitBreakerMetrics {
  /** Current state of the circuit breaker. */
  state: CircuitState;

  /** Total number of recorded failures since the last reset. */
  failures: number;

  /** Total number of recorded successes since the last reset. */
  successes: number;

  /**
   * Timestamp of the most recent failure, if any.
   * @defaultValue undefined
   */
  lastFailureTime?: Date;

  /** Number of consecutive successes since the last failure. */
  consecutiveSuccesses: number;

  /** Total number of calls made through this circuit breaker. */
  totalCalls: number;
}

/**
 * Error thrown when a circuit breaker rejects a call.
 *
 * @remarks
 * This error is raised when the circuit is in the OPEN state or when the
 * HALF_OPEN call limit has been reached. Callers should catch this to
 * implement fallback logic or return a 503 response.
 *
 * @example
 * ```typescript
 * try {
 *   await breaker.execute(() => fetch('/api'));
 * } catch (err) {
 *   if (err instanceof CircuitBreakerError) {
 *     console.log('Circuit open, using fallback');
 *   }
 * }
 * ```
 */
export class CircuitBreakerError extends Error {
  /**
   * Creates a new CircuitBreakerError.
   *
   * @param message - Descriptive error message indicating why the call was rejected
   */
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Circuit breaker for protecting against cascading failures.
 *
 * @remarks
 * Implements the circuit breaker pattern with three states: CLOSED (normal),
 * OPEN (rejecting calls), and HALF_OPEN (testing recovery). The breaker
 * automatically transitions between states based on failure and success
 * thresholds, and schedules reset timers when the circuit opens.
 *
 * @example
 * ```typescript
 * import { CircuitBreaker } from '@cleocode/lafs/circuit-breaker';
 *
 * const breaker = new CircuitBreaker({
 *   name: 'external-api',
 *   failureThreshold: 5,
 *   resetTimeout: 30000
 * });
 *
 * try {
 *   const result = await breaker.execute(async () => {
 *     return await externalApi.call();
 *   });
 * } catch (error) {
 *   if (error instanceof CircuitBreakerError) {
 *     console.log('Circuit breaker is open');
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  /** Current circuit state. */
  private state: CircuitState = 'CLOSED';

  /** Total failure count since last reset. */
  private failures = 0;

  /** Total success count since last reset. */
  private successes = 0;

  /** Timestamp of the most recent failure. */
  private lastFailureTime?: Date;

  /** Consecutive successes since the last failure. */
  private consecutiveSuccesses = 0;

  /** Lifetime call count. */
  private totalCalls = 0;

  /** Number of calls made while in the HALF_OPEN state. */
  private halfOpenCalls = 0;

  /** Timer handle for the scheduled OPEN-to-HALF_OPEN transition. */
  private resetTimer?: NodeJS.Timeout;

  /**
   * Creates a new CircuitBreaker with the given configuration.
   *
   * @param config - Circuit breaker configuration with name, thresholds, and timeouts
   */
  constructor(private config: CircuitBreakerConfig) {
    this.config = {
      failureThreshold: 5,
      resetTimeout: 30000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
      ...config,
    };
  }

  /**
   * Execute a function with circuit breaker protection.
   *
   * @remarks
   * When the circuit is CLOSED, calls pass through normally. When OPEN, calls
   * are rejected with a {@link CircuitBreakerError} unless the reset timeout has
   * elapsed (triggering HALF_OPEN). In HALF_OPEN, a limited number of trial
   * calls are permitted; successes may close the circuit while failures re-open it.
   *
   * @typeParam T - Return type of the wrapped function
   * @param fn - Async function to execute under circuit breaker protection
   * @returns The result of invoking `fn`
   *
   * @example
   * ```typescript
   * const result = await breaker.execute(async () => {
   *   return await fetch('https://api.example.com/data');
   * });
   * ```
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitBreakerError(`Circuit breaker '${this.config.name}' is OPEN`);
      }
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= (this.config.halfOpenMaxCalls || 3)) {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is HALF_OPEN (max calls reached)`,
        );
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get the current circuit breaker state.
   *
   * @remarks
   * Returns one of `'CLOSED'`, `'OPEN'`, or `'HALF_OPEN'`. Useful for
   * dashboards or conditional logic that needs to know whether calls will
   * be accepted.
   *
   * @returns The current {@link CircuitState}
   *
   * @example
   * ```typescript
   * if (breaker.getState() === 'OPEN') {
   *   console.log('Circuit is open, requests will be rejected');
   * }
   * ```
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get a snapshot of the circuit breaker's runtime metrics.
   *
   * @remarks
   * Returns a copy of the internal counters including failure/success counts,
   * the current state, and the timestamp of the last failure. Useful for
   * monitoring and observability.
   *
   * @returns A {@link CircuitBreakerMetrics} snapshot
   *
   * @example
   * ```typescript
   * const metrics = breaker.getMetrics();
   * console.log(`State: ${metrics.state}, Failures: ${metrics.failures}`);
   * ```
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalCalls: this.totalCalls,
    };
  }

  /**
   * Manually open the circuit breaker, rejecting all subsequent calls.
   *
   * @remarks
   * Forces the circuit into the OPEN state regardless of the current failure
   * count. Useful for administrative controls or when an external signal
   * indicates the downstream service is unavailable.
   *
   * @example
   * ```typescript
   * breaker.forceOpen();
   * console.log(breaker.getState()); // 'OPEN'
   * ```
   */
  forceOpen(): void {
    this.transitionTo('OPEN');
  }

  /**
   * Manually close the circuit breaker and reset all counters.
   *
   * @remarks
   * Forces the circuit into the CLOSED state and clears failure/success
   * counters and any pending reset timer. Useful for administrative recovery
   * after a known issue has been resolved.
   *
   * @example
   * ```typescript
   * breaker.forceClose();
   * console.log(breaker.getState()); // 'CLOSED'
   * ```
   */
  forceClose(): void {
    this.transitionTo('CLOSED');
    this.reset();
  }

  /** Records a successful call and may transition from HALF_OPEN to CLOSED. */
  private onSuccess(): void {
    this.successes++;
    this.consecutiveSuccesses++;

    if (this.state === 'HALF_OPEN') {
      if (this.consecutiveSuccesses >= (this.config.successThreshold || 2)) {
        this.transitionTo('CLOSED');
        this.reset();
      }
    }
  }

  /** Records a failed call and may trip the circuit to OPEN. */
  private onFailure(): void {
    this.failures++;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = new Date();

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
      this.scheduleReset();
    } else if (this.state === 'CLOSED') {
      if (this.failures >= (this.config.failureThreshold || 5)) {
        this.transitionTo('OPEN');
        this.scheduleReset();
      }
    }
  }

  /** Transitions the circuit to the given state, resetting HALF_OPEN call count when entering HALF_OPEN. */
  private transitionTo(newState: CircuitState): void {
    console.log(`Circuit breaker '${this.config.name}': ${this.state} -> ${newState}`);
    this.state = newState;

    if (newState === 'HALF_OPEN') {
      this.halfOpenCalls = 0;
    }
  }

  /** Returns `true` if enough time has elapsed since the last failure to attempt a reset. */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;

    const elapsed = Date.now() - this.lastFailureTime.getTime();
    return elapsed >= (this.config.resetTimeout || 30000);
  }

  /** Schedules a timer to transition from OPEN to HALF_OPEN after the configured reset timeout. */
  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      if (this.state === 'OPEN') {
        this.transitionTo('HALF_OPEN');
      }
    }, this.config.resetTimeout || 30000);
  }

  /** Resets all failure/success counters and clears the pending reset timer. */
  private reset(): void {
    this.failures = 0;
    this.consecutiveSuccesses = 0;
    this.halfOpenCalls = 0;

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }
}

/**
 * Registry for managing multiple named circuit breakers.
 *
 * @remarks
 * Provides centralized creation, lookup, and metrics aggregation for
 * circuit breakers. Each breaker is stored by name and can be retrieved
 * or lazily created via {@link CircuitBreakerRegistry.getOrCreate}.
 *
 * @example
 * ```typescript
 * const registry = new CircuitBreakerRegistry();
 *
 * registry.add('payment-api', {
 *   failureThreshold: 3,
 *   resetTimeout: 60000
 * });
 *
 * const paymentBreaker = registry.get('payment-api');
 * ```
 */
export class CircuitBreakerRegistry {
  /** Internal map of circuit breaker name to instance. */
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Register a new circuit breaker with the given name and configuration.
   *
   * @remarks
   * Creates a new {@link CircuitBreaker}, stores it in the registry, and
   * returns it. If a breaker with the same name already exists, it is replaced.
   *
   * @param name - Unique name for the circuit breaker
   * @param config - Configuration options (name is set automatically)
   * @returns The newly created {@link CircuitBreaker}
   *
   * @example
   * ```typescript
   * const breaker = registry.add('user-service', { failureThreshold: 3 });
   * ```
   */
  add(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    const breaker = new CircuitBreaker({ ...config, name });
    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Retrieve a circuit breaker by name.
   *
   * @remarks
   * Returns `undefined` if no breaker with the given name has been registered.
   *
   * @param name - Name of the circuit breaker to look up
   * @returns The matching {@link CircuitBreaker}, or `undefined` if not found
   *
   * @example
   * ```typescript
   * const breaker = registry.get('payment-api');
   * if (breaker) {
   *   await breaker.execute(() => callPaymentApi());
   * }
   * ```
   */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Retrieve an existing circuit breaker or create one if it does not exist.
   *
   * @remarks
   * This is useful when callers want a breaker but do not know whether it
   * has already been registered, avoiding duplicate creation.
   *
   * @param name - Name of the circuit breaker
   * @param config - Configuration to use if a new breaker must be created
   * @returns The existing or newly created {@link CircuitBreaker}
   *
   * @example
   * ```typescript
   * const breaker = registry.getOrCreate('cache-api', { failureThreshold: 10 });
   * ```
   */
  getOrCreate(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = this.add(name, config);
    }
    return breaker;
  }

  /**
   * Collect metrics from all registered circuit breakers.
   *
   * @remarks
   * Returns a record keyed by breaker name with each value being the
   * corresponding {@link CircuitBreakerMetrics} snapshot.
   *
   * @returns A record mapping breaker names to their current metrics
   *
   * @example
   * ```typescript
   * const allMetrics = registry.getAllMetrics();
   * for (const [name, metrics] of Object.entries(allMetrics)) {
   *   console.log(`${name}: ${metrics.state}`);
   * }
   * ```
   */
  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};
    this.breakers.forEach((breaker, name) => {
      metrics[name] = breaker.getMetrics();
    });
    return metrics;
  }

  /**
   * Force-close all registered circuit breakers, resetting their counters.
   *
   * @remarks
   * Iterates over every registered breaker and calls {@link CircuitBreaker.forceClose}.
   * Useful for administrative recovery or test teardown.
   *
   * @example
   * ```typescript
   * registry.resetAll();
   * ```
   */
  resetAll(): void {
    this.breakers.forEach((breaker) => {
      breaker.forceClose();
    });
  }
}

/**
 * Create an Express middleware that wraps downstream handlers with a circuit breaker.
 *
 * @remarks
 * Instantiates a {@link CircuitBreaker} from the provided config and wraps the
 * `next()` call. When the circuit is open, the middleware responds with a 503
 * status and a JSON error body instead of forwarding the request.
 *
 * @param config - Circuit breaker configuration for the middleware instance
 * @returns An Express-compatible middleware function
 *
 * @example
 * ```typescript
 * app.use('/external-api', circuitBreakerMiddleware({
 *   name: 'external-api',
 *   failureThreshold: 5
 * }));
 * ```
 */
export function circuitBreakerMiddleware(config: CircuitBreakerConfig) {
  const breaker = new CircuitBreaker(config);

  return async (
    _req: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    try {
      await breaker.execute(async () => {
        next();
      });
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        res.status(503).json({
          error: 'Service temporarily unavailable',
          reason: 'Circuit breaker is open',
        });
      } else {
        throw error;
      }
    }
  };
}

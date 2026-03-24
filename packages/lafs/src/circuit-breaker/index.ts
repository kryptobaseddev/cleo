/**
 * LAFS Circuit Breaker Module
 * 
 * Provides circuit breaker pattern for resilient service calls
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenMaxCalls?: number;
  successThreshold?: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: Date;
  consecutiveSuccesses: number;
  totalCalls: number;
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Circuit breaker for protecting against cascading failures
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
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: Date;
  private consecutiveSuccesses = 0;
  private totalCalls = 0;
  private halfOpenCalls = 0;
  private resetTimer?: NodeJS.Timeout;

  constructor(private config: CircuitBreakerConfig) {
    this.config = {
      failureThreshold: 5,
      resetTimeout: 30000,
      halfOpenMaxCalls: 3,
      successThreshold: 2,
      ...config
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is OPEN`
        );
      }
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= (this.config.halfOpenMaxCalls || 3)) {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is HALF_OPEN (max calls reached)`
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
   * Get current circuit breaker state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalCalls: this.totalCalls
    };
  }

  /**
   * Manually open the circuit breaker
   */
  forceOpen(): void {
    this.transitionTo('OPEN');
  }

  /**
   * Manually close the circuit breaker
   */
  forceClose(): void {
    this.transitionTo('CLOSED');
    this.reset();
  }

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

  private transitionTo(newState: CircuitState): void {
    console.log(`Circuit breaker '${this.config.name}': ${this.state} -> ${newState}`);
    this.state = newState;
    
    if (newState === 'HALF_OPEN') {
      this.halfOpenCalls = 0;
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    
    const elapsed = Date.now() - this.lastFailureTime.getTime();
    return elapsed >= (this.config.resetTimeout || 30000);
  }

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
 * Circuit breaker registry for managing multiple breakers
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
  private breakers = new Map<string, CircuitBreaker>();

  add(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    const breaker = new CircuitBreaker({ ...config, name });
    this.breakers.set(name, breaker);
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getOrCreate(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = this.add(name, config);
    }
    return breaker;
  }

  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};
    this.breakers.forEach((breaker, name) => {
      metrics[name] = breaker.getMetrics();
    });
    return metrics;
  }

  resetAll(): void {
    this.breakers.forEach(breaker => breaker.forceClose());
  }
}

/**
 * Create a circuit breaker middleware for Express
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
  
  return async (req: any, res: any, next: any) => {
    try {
      await breaker.execute(async () => {
        next();
      });
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        res.status(503).json({
          error: 'Service temporarily unavailable',
          reason: 'Circuit breaker is open'
        });
      } else {
        throw error;
      }
    }
  };
}

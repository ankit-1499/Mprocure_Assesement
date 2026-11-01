/**
 * Common interface for rate limit state storage engines.
 */
export interface RateLimiterEngine {
  /**
   * Attempts to consume 1 request quota at time `now`.
   * @param now Current monotonic timestamp in milliseconds.
   * @returns Object indicating if allowed, remaining quota, and retryAfterMs.
   */
  checkAndAdmit(now: number): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  };

  /**
   * Updates rule parameters mid-flight without resetting counters.
   * Invariant: Never over-admit when limit is lowered or window is altered.
   */
  updateRule(newLimit: number, newWindowMs: number, now: number): void;

  /**
   * Checks whether all entries have expired at time `now`.
   * Used for amortized memory eviction of idle tenant states.
   */
  isExpired(now: number): boolean;

  /**
   * Current number of active requests in the window.
   */
  getCount(now: number): number;
}

/**
 * Tier 1: Exact Sliding-Window Log using a circular Float64Array ring buffer.
 *
 * Guarantees:
 * - EXACT adherence to rolling window: 0% over-admission, 0% under-admission.
 * - Rolling window is defined as (t - W, t]. Entries with timestamp <= t - W are expired.
 * - Denied requests do NOT consume quota and are never stored.
 * - Lazily allocated: starts small (capacity 8) and grows up to `limit` as needed.
 */
export class SlidingWindowLog implements RateLimiterEngine {
  private limit: number;
  private windowMs: number;
  private buffer: Float64Array;
  private capacity: number;
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;
  private lastTimestamp: number = 0;

  constructor(limit: number, windowMs: number, initialCapacity: number = 8) {
    this.limit = limit;
    this.windowMs = windowMs;
    // Cap initial capacity to limit
    this.capacity = Math.max(1, Math.min(initialCapacity, limit));
    this.buffer = new Float64Array(this.capacity);
  }

  /**
   * Prunes all entries with timestamp <= (now - windowMs).
   * Why: Window semantics count events in (t - W, t]; anything <= t - W is out of window.
   */
  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.count > 0) {
      const oldest = this.buffer[this.head]!;
      if (oldest <= cutoff) {
        this.head = (this.head + 1) % this.capacity;
        this.count--;
      } else {
        break;
      }
    }
  }

  /**
   * Dynamically resizes the ring buffer up to the configured limit.
   */
  private grow(): void {
    const newCapacity = Math.min(this.capacity * 2, this.limit);
    if (newCapacity <= this.capacity) return;

    const newBuffer = new Float64Array(newCapacity);
    for (let i = 0; i < this.count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity]!;
    }
    this.buffer = newBuffer;
    this.capacity = newCapacity;
    this.head = 0;
    this.tail = this.count;
  }

  checkAndAdmit(now: number): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  } {
    // Sanitize time: monotonic clocks shouldn't go backward, but clamp if time glitches
    const t = now >= this.lastTimestamp ? now : this.lastTimestamp;
    this.pruneExpired(t);

    if (this.count < this.limit) {
      // ADMIT: Add timestamp to ring buffer
      if (this.count === this.capacity && this.capacity < this.limit) {
        this.grow();
      }

      this.buffer[this.tail] = t;
      this.tail = (this.tail + 1) % this.capacity;
      this.count++;
      this.lastTimestamp = t;

      return {
        allowed: true,
        remaining: Math.max(0, this.limit - this.count),
        retryAfterMs: 0,
      };
    }

    // DENY: Window quota exhausted. Denied requests do not consume quota.
    const oldest = this.buffer[this.head]!;
    // Slot frees up at: oldest + windowMs
    const retryAfterMs = Math.max(1, Math.ceil(oldest + this.windowMs - t));

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }

  updateRule(newLimit: number, newWindowMs: number, now: number): void {
    this.limit = newLimit;
    this.windowMs = newWindowMs;
    this.pruneExpired(now);
    // If limit grew, buffer can grow on subsequent admits
  }

  isExpired(now: number): boolean {
    this.pruneExpired(now);
    return this.count === 0;
  }

  getCount(now: number): number {
    this.pruneExpired(now);
    return this.count;
  }
}


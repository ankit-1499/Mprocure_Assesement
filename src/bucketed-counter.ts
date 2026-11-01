import { RateLimiterEngine } from "./sliding-window-log";

/**
 * Tier 2: Conservative Bucketed Sliding-Window Counter.
 *
 * Designed for very large limits (e.g. 10,000 to 300,000+ req/day) where storing
 * individual timestamps in a ring buffer would blow the 64 MB heap budget.
 *
 * Memory: Fixed 60 sub-buckets (Float64Array(60) epochs + Uint32Array(60) counts = ~720 bytes).
 *
 * Invariant Guarantee:
 * - A sub-bucket is expired ONLY when its ENTIRE time range is outside the rolling window (t - W, t].
 * - As a result, retained sum is ALWAYS >= actual requests in the window.
 * - OVER-ADMISSION IS IMPOSSIBLE (0% over-admit).
 * - Under-admission is strictly bounded by at most 1 bucket-width: Delta = W / B.
 *   With B = 60, under-admission is bounded to <= 1/60 (~1.67%) of the window.
 */
export class BucketedCounter implements RateLimiterEngine {
  private limit: number;
  private windowMs: number;
  private readonly numBuckets: number;
  private readonly numSlots: number;
  private bucketWidth: number;
  private readonly bucketEpochs: Float64Array;
  private readonly bucketCounts: Uint32Array;

  constructor(limit: number, windowMs: number, numBuckets: number = 60) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.numBuckets = Math.max(10, numBuckets);
    // Why numSlots = numBuckets + 2:
    // A bucket is retained while (epoch + 1) * bucketWidth > t - windowMs.
    // The active time span covers (t - windowMs) to (t + bucketWidth), which is windowMs + bucketWidth.
    // In discrete epochs, this spans up to B + 1 active epochs simultaneously.
    // Using B + 2 slots guarantees two active epochs never hash to the same slot.
    this.numSlots = this.numBuckets + 2;
    this.bucketWidth = this.windowMs / this.numBuckets;
    this.bucketEpochs = new Float64Array(this.numSlots);
    this.bucketCounts = new Uint32Array(this.numSlots);

    // Initialize all epochs to -1 (empty)
    this.bucketEpochs.fill(-1);
  }

  /**
   * Calculates sum of all retained buckets and purges completely expired buckets.
   * A bucket with epoch k covers [k * Delta, (k + 1) * Delta).
   * It expires iff (k + 1) * Delta <= (t - W).
   */
  private scanBuckets(
    now: number,
    currentEpoch: number
  ): {
    retainedSum: number;
    oldestRetainedEnd: number | null;
  } {
    const cutoff = now - this.windowMs;
    let retainedSum = 0;
    let oldestRetainedEnd: number | null = null;

    for (let i = 0; i < this.numSlots; i++) {
      const epoch = this.bucketEpochs[i]!;
      if (epoch === -1) continue;

      const bucketEnd = (epoch + 1) * this.bucketWidth;

      // Conservative expiration: bucket must be entirely <= cutoff to be dropped
      if (bucketEnd <= cutoff) {
        // Expired
        this.bucketEpochs[i] = -1;
        this.bucketCounts[i] = 0;
      } else if (epoch <= currentEpoch) {
        // Retained and valid
        retainedSum += this.bucketCounts[i]!;
        if (oldestRetainedEnd === null || bucketEnd < oldestRetainedEnd) {
          oldestRetainedEnd = bucketEnd;
        }
      } else {
        // Epoch in the future (can happen if clock glitched backwards)
        // Reset to be safe
        this.bucketEpochs[i] = -1;
        this.bucketCounts[i] = 0;
      }
    }

    return { retainedSum, oldestRetainedEnd };
  }

  checkAndAdmit(now: number): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  } {
    const currentEpoch = Math.floor(now / this.bucketWidth);
    const currentSlot = ((currentEpoch % this.numSlots) + this.numSlots) % this.numSlots;

    // Scan and prune expired buckets first before checking current slot
    const { retainedSum, oldestRetainedEnd } = this.scanBuckets(now, currentEpoch);

    // If current slot holds an old epoch that just expired or wasn't cleaned, reset it
    if (this.bucketEpochs[currentSlot] !== currentEpoch) {
      this.bucketEpochs[currentSlot] = currentEpoch;
      this.bucketCounts[currentSlot] = 0;
    }

    if (retainedSum < this.limit) {
      // ADMIT
      this.bucketCounts[currentSlot] = (this.bucketCounts[currentSlot] || 0) + 1;
      const newTotal = retainedSum + 1;

      return {
        allowed: true,
        remaining: Math.max(0, this.limit - newTotal),
        retryAfterMs: 0,
      };
    }

    // DENY: Quota exhausted. Denied requests do not increment counts.
    let retryAfterMs = 1000;
    if (oldestRetainedEnd !== null) {
      // The oldest bucket expires when t' - windowMs >= oldestRetainedEnd
      // => t' >= oldestRetainedEnd + windowMs
      retryAfterMs = Math.max(1, Math.ceil(oldestRetainedEnd + this.windowMs - now));
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }

  updateRule(newLimit: number, newWindowMs: number, now: number): void {
    this.limit = newLimit;
    if (newWindowMs !== this.windowMs) {
      this.windowMs = newWindowMs;
      this.bucketWidth = this.windowMs / this.numBuckets;
      const currentEpoch = Math.floor(now / this.bucketWidth);
      this.scanBuckets(now, currentEpoch);
    }
  }

  isExpired(now: number): boolean {
    const currentEpoch = Math.floor(now / this.bucketWidth);
    const { retainedSum } = this.scanBuckets(now, currentEpoch);
    return retainedSum === 0;
  }

  getCount(now: number): number {
    const currentEpoch = Math.floor(now / this.bucketWidth);
    const { retainedSum } = this.scanBuckets(now, currentEpoch);
    return retainedSum;
  }
}

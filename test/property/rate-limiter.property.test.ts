import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { SlidingWindowLog } from "../../src/sliding-window-log";

/**
 * Brute-force reference oracle that stores all accepted timestamps
 * and does a linear scan to count events strictly in (t - W, t].
 */
class BruteForceOracle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly accepted: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  checkAndAdmit(now: number): boolean {
    const cutoff = now - this.windowMs;
    // Count accepted timestamps strictly in (now - windowMs, now]
    let countInWindow = 0;
    for (let i = 0; i < this.accepted.length; i++) {
      const ts = this.accepted[i]!;
      if (ts > cutoff && ts <= now) {
        countInWindow++;
      }
    }

    if (countInWindow < this.limit) {
      this.accepted.push(now);
      return true;
    }
    return false;
  }

  getAccepted(): readonly number[] {
    return this.accepted;
  }
}

describe("Property-Based Testing: SlidingWindowLog vs BruteForce Oracle", () => {
  it("matches BruteForce Oracle exactly and never exceeds limit in any window", () => {
    fc.assert(
      fc.property(
        // Random limit between 1 and 100
        fc.integer({ min: 1, max: 100 }),
        // Random window between 50ms and 5000ms
        fc.integer({ min: 50, max: 5000 }),
        // Sequence of delta times between successive requests (0ms to 200ms)
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 20, maxLength: 300 }),
        (limit, windowMs, deltas) => {
          const limiter = new SlidingWindowLog(limit, windowMs);
          const oracle = new BruteForceOracle(limit, windowMs);

          let currentTime = 1000;

          for (const delta of deltas) {
            currentTime += delta;

            const actualAllowed = limiter.checkAndAdmit(currentTime).allowed;
            const oracleAllowed = oracle.checkAndAdmit(currentTime);

            // 1. Must match oracle decision exactly
            assert.equal(
              actualAllowed,
              oracleAllowed,
              `Discrepancy at t=${currentTime}: actual=${actualAllowed}, oracle=${oracleAllowed} (limit=${limit}, window=${windowMs})`
            );
          }

          // 2. Invariant verification: In EVERY window (t - W, t], accepted <= limit
          const accepted = oracle.getAccepted();
          for (let i = 0; i < accepted.length; i++) {
            const t = accepted[i]!;
            const cutoff = t - windowMs;
            let windowCount = 0;
            for (let j = 0; j < accepted.length; j++) {
              const other = accepted[j]!;
              if (other > cutoff && other <= t) {
                windowCount++;
              }
            }

            assert.ok(
              windowCount <= limit,
              `Invariant violated: ${windowCount} requests accepted in window (${cutoff}, ${t}] with limit ${limit}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


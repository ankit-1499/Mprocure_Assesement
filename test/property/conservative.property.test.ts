import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { BucketedCounter } from "../../src/bucketed-counter";

describe("Property-Based Testing: BucketedCounter Invariant (Never Over-Admit)", () => {
  it("proves conservative large-limit path never over-admits in any rolling window", () => {
    fc.assert(
      fc.property(
        // Limit between 10 and 1000
        fc.integer({ min: 10, max: 1000 }),
        // Window between 500ms and 30000ms
        fc.integer({ min: 500, max: 30000 }),
        // Sub-buckets B between 10 and 60
        fc.integer({ min: 10, max: 60 }),
        // Random request delays
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 50, maxLength: 400 }),
        (limit, windowMs, numBuckets, deltas) => {
          const limiter = new BucketedCounter(limit, windowMs, numBuckets);
          const acceptedTimestamps: number[] = [];

          let currentTime = 1000;

          for (const delta of deltas) {
            currentTime += delta;

            const res = limiter.checkAndAdmit(currentTime);
            if (res.allowed) {
              acceptedTimestamps.push(currentTime);
            }
          }

          // HARD INVARIANT CHECK:
          // For every accepted request at time t, count all accepted requests in (t - windowMs, t].
          // That count MUST be <= limit under all conditions!
          for (let i = 0; i < acceptedTimestamps.length; i++) {
            const t = acceptedTimestamps[i]!;
            const cutoff = t - windowMs;
            let countInWindow = 0;

            for (let j = 0; j < acceptedTimestamps.length; j++) {
              const other = acceptedTimestamps[j]!;
              if (other > cutoff && other <= t) {
                countInWindow++;
              }
            }

            assert.ok(
              countInWindow <= limit,
              `Over-admitted! Window (${cutoff}, ${t}] contains ${countInWindow} accepted requests, exceeding limit ${limit}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


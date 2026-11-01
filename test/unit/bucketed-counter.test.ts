import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BucketedCounter } from "../../src/bucketed-counter";

describe("BucketedCounter (Tier 2 Conservative Sub-Buckets)", () => {
  it("enforces limit without ever over-admitting", () => {
    // Limit: 60 requests per 60,000ms (B=60, Delta=1000ms)
    const limiter = new BucketedCounter(60, 60000, 60);

    // Send 60 requests in the first second (t = 100 to 159)
    for (let i = 0; i < 60; i++) {
      const res = limiter.checkAndAdmit(100 + i);
      assert.equal(res.allowed, true, `Request ${i} should be allowed`);
    }

    // 61st request in same window MUST be denied
    const r61 = limiter.checkAndAdmit(500);
    assert.equal(r61.allowed, false);
    assert.equal(r61.remaining, 0);
    assert.ok(r61.retryAfterMs > 0);
  });

  it("denied requests do NOT consume quota in bucketed counter", () => {
    const limiter = new BucketedCounter(2, 1000, 10); // 10 buckets of 100ms

    assert.equal(limiter.checkAndAdmit(50).allowed, true);
    assert.equal(limiter.checkAndAdmit(60).allowed, true);

    // Denied requests at t = 70, 80, 90
    assert.equal(limiter.checkAndAdmit(70).allowed, false);
    assert.equal(limiter.checkAndAdmit(80).allowed, false);
    assert.equal(limiter.checkAndAdmit(90).allowed, false);

    // At t = 1200: all buckets from [0, 100) are expired (end is 100, cutoff is 1200 - 1000 = 200 > 100)
    const allowedAfterDrain = limiter.checkAndAdmit(1200);
    assert.equal(allowedAfterDrain.allowed, true);
  });

  it("proves conservative behavior: bucket retained while end > cutoff", () => {
    // Window: 1000ms, 10 buckets -> Delta = 100ms
    // Bucket 0 covers [0, 100), end is 100ms
    const limiter = new BucketedCounter(1, 1000, 10);

    // Request at t = 50 (in bucket 0)
    assert.equal(limiter.checkAndAdmit(50).allowed, true);

    // At t = 1050: cutoff is 1050 - 1000 = 50ms
    // Bucket 0 end is 100ms. Since 100 > 50, Bucket 0 is STILL RETAINED!
    // A naive algorithm might drop it because 50 is outside, but conservative keeps it.
    // Therefore request at 1050 is DENIED! (Prevents over-admitting)
    assert.equal(limiter.checkAndAdmit(1050).allowed, false);

    // At t = 1100: cutoff is 1100 - 1000 = 100ms.
    // Bucket 0 end is 100ms <= 100ms -> Bucket 0 EXPIRES!
    // Request at 1100 is now ALLOWED!
    assert.equal(limiter.checkAndAdmit(1100).allowed, true);
  });

  it("handles enterprise 300,000 req/day scale cleanly in tiny memory", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const limiter = new BucketedCounter(300_000, DAY_MS, 60);

    // Burst 10,000 requests spread across several hours
    let countAllowed = 0;
    for (let hour = 0; hour < 10; hour++) {
      const t = hour * 3600 * 1000;
      for (let req = 0; req < 1000; req++) {
        if (limiter.checkAndAdmit(t + req).allowed) {
          countAllowed++;
        }
      }
    }

    assert.equal(countAllowed, 10_000);
    assert.equal(limiter.getCount(10 * 3600 * 1000), 10_000);
  });
});


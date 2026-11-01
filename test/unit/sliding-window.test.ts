import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLog } from "../../src/sliding-window-log";

describe("SlidingWindowLog (Tier 1 Exact Ring Buffer)", () => {
  it("enforces rolling window boundary (t - W, t]", () => {
    // Limit: 2 requests per 1000ms
    const limiter = new SlidingWindowLog(2, 1000);

    // t = 100: req 1 allowed
    const r1 = limiter.checkAndAdmit(100);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 1);

    // t = 200: req 2 allowed
    const r2 = limiter.checkAndAdmit(200);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 0);

    // t = 500: req 3 DENIED (2 requests already in (500-1000, 500])
    const r3 = limiter.checkAndAdmit(500);
    assert.equal(r3.allowed, false);
    assert.equal(r3.remaining, 0);
    // Oldest is 100. It expires at 100 + 1000 = 1100. At t = 500, retryAfterMs should be 1100 - 500 = 600
    assert.equal(r3.retryAfterMs, 600);

    // t = 1099: still denied (100 is still inside (1099-1000, 1099] since 100 > 99)
    const r4 = limiter.checkAndAdmit(1099);
    assert.equal(r4.allowed, false);

    // t = 1100: EXACT boundary check!
    // 100 <= 1100 - 1000 (100 <= 100) -> Expired!
    // Only 200 is still in window (200 > 100). One slot open!
    const r5 = limiter.checkAndAdmit(1100);
    assert.equal(r5.allowed, true);
    assert.equal(r5.remaining, 0); // req at 200 and req at 1100 -> remaining 0
  });

  it("denied requests do NOT consume quota", () => {
    const limiter = new SlidingWindowLog(1, 1000);

    // t = 100: allowed
    assert.equal(limiter.checkAndAdmit(100).allowed, true);

    // t = 200, 300, 400: denied requests
    assert.equal(limiter.checkAndAdmit(200).allowed, false);
    assert.equal(limiter.checkAndAdmit(300).allowed, false);
    assert.equal(limiter.checkAndAdmit(400).allowed, false);

    // At t = 1100: slot from t = 100 has expired.
    // If denied requests consumed quota, this would be rejected!
    // But since denied requests do NOT consume quota, this must be ALLOWED!
    const res = limiter.checkAndAdmit(1100);
    assert.equal(res.allowed, true);
  });

  it("dynamically grows buffer from initial capacity to limit", () => {
    // Limit: 50 requests per window, initial capacity 8
    const limiter = new SlidingWindowLog(50, 10000, 8);

    for (let i = 0; i < 50; i++) {
      const res = limiter.checkAndAdmit(100 + i);
      assert.equal(res.allowed, true);
    }

    // 51st request is denied
    assert.equal(limiter.checkAndAdmit(200).allowed, false);
  });

  it("handles clock jitter / non-monotonic timestamps gracefully", () => {
    const limiter = new SlidingWindowLog(2, 1000);

    assert.equal(limiter.checkAndAdmit(500).allowed, true);
    // Backward timestamp glitch: 450 < 500
    assert.doesNotThrow(() => {
      limiter.checkAndAdmit(450);
    });
  });

  it("detects expiration accurately for memory cleanup", () => {
    const limiter = new SlidingWindowLog(5, 1000);

    assert.equal(limiter.isExpired(100), true);

    limiter.checkAndAdmit(100);
    assert.equal(limiter.isExpired(500), false);

    assert.equal(limiter.isExpired(1101), true);
  });
});


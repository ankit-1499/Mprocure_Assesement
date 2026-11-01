import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/limiter-core";
import { FakeClock } from "../../src/clock";
import { ConfigValidationError } from "../../src/errors";

describe("Rule Changes & Atomic Rejection", () => {
  it("atomically rejects invalid rules and keeps last-known-good configuration", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 5, windowMs: 1000 },
      ],
    });

    assert.equal(limiter.allowRequest("tenant_1", "/api/v1/rfqs/123"), true);

    // Attempt to update with a bad config (negative limit)
    assert.throws(() => {
      limiter.updateRules([
        { id: "bad_rule", pattern: "/api/v1/pos/*", limit: -10, windowMs: 1000 },
      ]);
    }, ConfigValidationError);

    // Last known good rule must still be operational!
    assert.equal(limiter.getRules().length, 1);
    assert.equal(limiter.getRules()[0]?.id, "rfqs");
    assert.equal(limiter.allowRequest("tenant_1", "/api/v1/rfqs/456"), true);
  });

  it("lowering limit mid-window denies immediately and never over-admits", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 10, windowMs: 5000 },
      ],
    });

    // Send 5 requests under limit of 10
    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.allowRequest("tenant_1", `/api/v1/rfqs/${i}`), true);
    }

    // Now update rule: lower limit from 10 to 3 for the same 5000ms window!
    limiter.updateRules([
      { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 3, windowMs: 5000 },
    ]);

    // Invariant: Counter is NOT reset! Tenant already used 5 requests, which is >= 3.
    // Tenant must immediately be denied!
    const res = limiter.check("tenant_1", "/api/v1/rfqs/extra");
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "RATE_LIMITED");
    assert.ok(res.retryAfterMs > 0);
  });

  it("reducing window duration purges entries outside new window but keeps active ones", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 2, windowMs: 10000 },
      ],
    });

    // Req 1 at t = 1000
    assert.equal(limiter.allowRequest("tenant_1", "/api/v1/rfqs/1"), true);

    // Advance clock to t = 8000
    clock.advanceBy(7000);

    // Req 2 at t = 8000
    assert.equal(limiter.allowRequest("tenant_1", "/api/v1/rfqs/2"), true);

    // Now reduce window to 2000ms! (t = 8000, new window is (6000, 8000])
    // Req 1 at 1000 is now outside the new window, while Req 2 at 8000 is inside.
    limiter.updateRules([
      { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 2, windowMs: 2000 },
    ]);

    // One slot should now be open!
    const res = limiter.check("tenant_1", "/api/v1/rfqs/3");
    assert.equal(res.allowed, true);

    // Next request denied (now at 2 active in (6000, 8000])
    assert.equal(limiter.allowRequest("tenant_1", "/api/v1/rfqs/4"), false);
  });
});


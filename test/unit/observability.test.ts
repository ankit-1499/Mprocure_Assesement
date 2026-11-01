import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/limiter-core";
import { FakeClock } from "../../src/clock";
import { DenyEvent } from "../../src/types";

describe("Observability & Metrics", () => {
  it("tracks per-rule counters and top-N denied tenants with bounded memory", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "r1", pattern: "/api/v1/rfqs/*", limit: 2, windowMs: 1000 },
      ],
    });

    // Tenant A: 2 allowed, 3 denied
    limiter.allowRequest("tenant_a", "/api/v1/rfqs/1");
    limiter.allowRequest("tenant_a", "/api/v1/rfqs/2");
    limiter.allowRequest("tenant_a", "/api/v1/rfqs/3");
    limiter.allowRequest("tenant_a", "/api/v1/rfqs/4");
    limiter.allowRequest("tenant_a", "/api/v1/rfqs/5");

    // Tenant B: 2 allowed, 1 denied
    limiter.allowRequest("tenant_b", "/api/v1/rfqs/1");
    limiter.allowRequest("tenant_b", "/api/v1/rfqs/2");
    limiter.allowRequest("tenant_b", "/api/v1/rfqs/3");

    const stats = limiter.getStats();
    assert.equal(stats.totalAllowed, 4); // Tenant A (2) + Tenant B (2)
    assert.equal(stats.totalDenied, 4);  // Tenant A (3) + Tenant B (1)

    const r1 = stats.rules.find((r) => r.ruleId === "r1");
    assert.equal(r1?.allowed, 4);
    assert.equal(r1?.denied, 4);

    // Top denied: tenant_a (3 denials), tenant_b (1 denial)
    assert.equal(stats.topDeniedTenants[0]?.tenantId, "tenant_a");
    assert.equal(stats.topDeniedTenants[0]?.deniedCount, 3);
    assert.equal(stats.topDeniedTenants[1]?.tenantId, "tenant_b");
    assert.equal(stats.topDeniedTenants[1]?.deniedCount, 1);
  });

  it("rate-limits onDeny callbacks to protect against log flooding", () => {
    const clock = new FakeClock(1000);
    const events: DenyEvent[] = [];

    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "r1", pattern: "/api/v1/rfqs/*", limit: 1, windowMs: 1000 },
      ],
      maxDenyCallbacksPerSecond: 3, // Throttled to 3 callbacks/sec
      onDeny: (event) => {
        events.push(event);
      },
    });

    // 1st request allowed
    limiter.allowRequest("t1", "/api/v1/rfqs/1");

    // Next 10 requests denied
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest("t1", "/api/v1/rfqs/denied");
    }

    // Only 3 callbacks dispatched due to throttling!
    assert.equal(events.length, 3);
    assert.equal(events[0]?.reason, "RATE_LIMITED");

    // Advance clock by 1 second to refill callback tokens
    clock.advanceBy(1000);

    // At t = 2000, 1st request consumes new quota
    limiter.allowRequest("t1", "/api/v1/rfqs/consumed");
    // 2nd request is denied, and dispatches throttled callback!
    limiter.allowRequest("t1", "/api/v1/rfqs/denied2");
    assert.equal(events.length, 4);
  });

  it("respects defaultPolicy for unmatched routes", () => {
    // Default: ALLOW with reason NO_MATCH
    const limiterAllow = new RateLimiter({
      defaultPolicy: "ALLOW",
      rules: [{ id: "r1", pattern: "/api/rfqs", limit: 1, windowMs: 1000 }],
    });
    const resAllow = limiterAllow.check("tenant_1", "/other/unmatched");
    assert.equal(resAllow.allowed, true);
    assert.equal(resAllow.reason, "NO_MATCH");

    // Configured: DENY with reason NO_MATCH
    const limiterDeny = new RateLimiter({
      defaultPolicy: "DENY",
      rules: [{ id: "r1", pattern: "/api/rfqs", limit: 1, windowMs: 1000 }],
    });
    const resDeny = limiterDeny.check("tenant_1", "/other/unmatched");
    assert.equal(resDeny.allowed, false);
    assert.equal(resDeny.reason, "NO_MATCH");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/limiter-core";
import { FakeClock } from "../../src/clock";

describe("Amortized Eviction & Memory Reclamation", () => {
  it("reclaims memory for idle tenants after window expiration", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "r1", pattern: "/api/v1/rfqs/*", limit: 5, windowMs: 1000 },
      ],
    });

    // Create 10 tenants
    for (let i = 0; i < 10; i++) {
      limiter.allowRequest(`idle_tenant_${i}`, "/api/v1/rfqs/test");
    }

    assert.equal(limiter.getStats().activeTenants, 10);

    // Advance clock past expiration (windowMs is 1000ms)
    clock.advanceBy(2000);

    // Trigger amortized eviction via check() calls for an active tenant
    // With EVICTION_BATCH_SIZE = 4, a few calls will sweep all 10 idle tenants
    for (let i = 0; i < 5; i++) {
      limiter.allowRequest("active_tenant", "/api/v1/rfqs/active");
    }

    // All 10 idle tenants must have been evicted, only active_tenant remains!
    assert.equal(limiter.getStats().activeTenants, 1);
  });
});


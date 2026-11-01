import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/limiter-core";
import { FakeClock } from "../../src/clock";
import { MAX_ROUTE_LENGTH } from "../../src/normalization";

describe("Security & Untrusted Input Defenses", () => {
  it("safely handles prototype pollution tenantId attempts (__proto__, constructor, toString)", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "test", pattern: "/api/*", limit: 2, windowMs: 1000 },
      ],
    });

    const dangerousTenants = ["__proto__", "constructor", "prototype", "toString", "valueOf"];

    for (const dangerousId of dangerousTenants) {
      assert.doesNotThrow(() => {
        const res1 = limiter.check(dangerousId, "/api/test");
        assert.equal(res1.allowed, true);
        const res2 = limiter.check(dangerousId, "/api/test");
        assert.equal(res2.allowed, true);
        const res3 = limiter.check(dangerousId, "/api/test");
        assert.equal(res3.allowed, false); // Limit 2 enforced per tenant!
      });
    }

    // Verify Object prototype has NOT been polluted
    assert.equal(Object.prototype.hasOwnProperty("test"), false);
    // @ts-expect-error verifying no pollution
    assert.equal({}.test, undefined);
  });

  it("keys memory strictly by rule ID, preventing route cardinality memory explosion", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "single_rule", pattern: "/api/v1/rfqs/*", limit: 1000, windowMs: 60000 },
      ],
    });

    // Send 500 distinct route URLs for the same tenant
    for (let i = 0; i < 500; i++) {
      limiter.allowRequest("tenant_fixed", `/api/v1/rfqs/random_unique_id_${i}`);
    }

    // Tenant count must be exactly 1
    assert.equal(limiter.getStats().activeTenants, 1);

    // Rule stat allowed count must be 500
    const ruleStat = limiter.getStats().rules.find((r) => r.ruleId === "single_rule");
    assert.equal(ruleStat?.allowed, 500);
  });

  it("rejects routes exceeding MAX_ROUTE_LENGTH with INVALID_INPUT", () => {
    const limiter = new RateLimiter();
    const hugeRoute = "/api/" + "x".repeat(MAX_ROUTE_LENGTH + 100);

    const res = limiter.check("tenant_1", hugeRoute);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "INVALID_INPUT");
    assert.equal(limiter.allowRequest("tenant_1", hugeRoute), false);
  });

  it("rejects invalid or empty tenantId with INVALID_INPUT", () => {
    const limiter = new RateLimiter();

    // Empty string
    const resEmpty = limiter.check("", "/api/test");
    assert.equal(resEmpty.allowed, false);
    assert.equal(resEmpty.reason, "INVALID_INPUT");

    // Non-string
    // @ts-expect-error testing invalid type
    const resNull = limiter.check(null, "/api/test");
    assert.equal(resNull.allowed, false);
    assert.equal(resNull.reason, "INVALID_INPUT");
  });

  it("strictly isolates tenants and routes from each other", () => {
    const clock = new FakeClock(1000);
    const limiter = new RateLimiter({
      clock,
      rules: [
        { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 1, windowMs: 1000 },
        { id: "pos", pattern: "/api/v1/pos/*", limit: 1, windowMs: 1000 },
      ],
    });

    // Tenant A consumes quota on /api/v1/rfqs/*
    assert.equal(limiter.allowRequest("tenant_a", "/api/v1/rfqs/1"), true);
    assert.equal(limiter.allowRequest("tenant_a", "/api/v1/rfqs/2"), false);

    // Tenant B on same route is NOT affected
    assert.equal(limiter.allowRequest("tenant_b", "/api/v1/rfqs/1"), true);
    assert.equal(limiter.allowRequest("tenant_b", "/api/v1/rfqs/2"), false);

    // Tenant A on different route /api/v1/pos/* is NOT affected
    assert.equal(limiter.allowRequest("tenant_a", "/api/v1/pos/1"), true);
    assert.equal(limiter.allowRequest("tenant_a", "/api/v1/pos/2"), false);
  });
});


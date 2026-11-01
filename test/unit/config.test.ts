import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileRules } from "../../src/config";
import { ConfigValidationError } from "../../src/errors";

describe("Config Validation & Atomic Compilation", () => {
  it("compiles valid configuration successfully", () => {
    const { rules, trie } = compileRules([
      { id: "r1", pattern: "/api/v1/rfqs/*", limit: 100, windowMs: 60000 },
      { id: "r2", pattern: "/api/v1/pos/*", limit: 10, windowMs: 1000 },
    ]);

    assert.equal(rules.length, 2);
    assert.ok(trie);
  });

  it("rejects non-array inputs", () => {
    assert.throws(() => {
      // @ts-expect-error test invalid type
      compileRules(null);
    }, ConfigValidationError);
  });

  it("rejects missing or empty id", () => {
    assert.throws(() => {
      compileRules([
        { id: "", pattern: "/api/v1/rfqs", limit: 10, windowMs: 1000 },
      ]);
    }, /missing or empty 'id'/);
  });

  it("rejects duplicate rule IDs", () => {
    assert.throws(() => {
      compileRules([
        { id: "duplicate_id", pattern: "/api/v1/rfqs", limit: 10, windowMs: 1000 },
        { id: "duplicate_id", pattern: "/api/v1/pos", limit: 20, windowMs: 1000 },
      ]);
    }, /Duplicate rule id 'duplicate_id'/);
  });

  it("rejects invalid limit values", () => {
    const testCases = [0, -5, 1.5, NaN, Infinity, 20_000_000];
    for (const badLimit of testCases) {
      assert.throws(() => {
        compileRules([
          { id: "test", pattern: "/api/v1/rfqs", limit: badLimit, windowMs: 1000 },
        ]);
      }, ConfigValidationError);
    }
  });

  it("rejects invalid windowMs values", () => {
    const testCases = [0, 5, -100, 10.5, NaN, Infinity, 40 * 24 * 60 * 60 * 1000];
    for (const badWindow of testCases) {
      assert.throws(() => {
        compileRules([
          { id: "test", pattern: "/api/v1/rfqs", limit: 100, windowMs: badWindow },
        ]);
      }, ConfigValidationError);
    }
  });

  it("rejects patterns not starting with '/'", () => {
    assert.throws(() => {
      compileRules([
        { id: "test", pattern: "api/v1/rfqs", limit: 100, windowMs: 1000 },
      ]);
    }, /must be a string starting with '\/'/);
  });

  it("rejects partial wildcards (e.g. /api/rfq*)", () => {
    assert.throws(() => {
      compileRules([
        { id: "test", pattern: "/api/rfq*", limit: 100, windowMs: 1000 },
      ]);
    }, /Partial wildcards like 'rfq\*' in pattern/);
  });

  it("rejects tail wildcard '**' not in the final segment", () => {
    assert.throws(() => {
      compileRules([
        { id: "test", pattern: "/api/**/rfqs", limit: 100, windowMs: 1000 },
      ]);
    }, /Tail wildcard '\*\*' must only appear at the end/);
  });

  it("rejects duplicate canonical patterns", () => {
    assert.throws(() => {
      compileRules([
        { id: "r1", pattern: "/api/v1/rfqs/*", limit: 100, windowMs: 1000 },
        { id: "r2", pattern: "///api///v1/rfqs/*", limit: 200, windowMs: 2000 },
      ]);
    }, /Duplicate or ambiguous pattern/);
  });
});


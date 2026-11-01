import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileRules } from "../../src/config";
import { normalizeRouteSegments } from "../../src/normalization";

describe("RouteTrie Matching & Specificity", () => {
  it("matches exact literal routes", () => {
    const { trie } = compileRules([
      { id: "health", pattern: "/health", limit: 10, windowMs: 1000 },
      { id: "rfqs", pattern: "/api/v1/rfqs", limit: 100, windowMs: 60000 },
    ]);

    const match1 = trie.match(normalizeRouteSegments("/health")!);
    assert.equal(match1?.id, "health");

    const match2 = trie.match(normalizeRouteSegments("/api/v1/rfqs")!);
    assert.equal(match2?.id, "rfqs");

    const match3 = trie.match(normalizeRouteSegments("/api/v1/other")!);
    assert.equal(match3, null);
  });

  it("matches single-segment wildcard (*)", () => {
    const { trie } = compileRules([
      { id: "rfq_item", pattern: "/api/v1/rfqs/*", limit: 50, windowMs: 1000 },
    ]);

    const match1 = trie.match(normalizeRouteSegments("/api/v1/rfqs/123")!);
    assert.equal(match1?.id, "rfq_item");

    // Single wildcard does not match nested child path
    const match2 = trie.match(normalizeRouteSegments("/api/v1/rfqs/123/items")!);
    assert.equal(match2, null);
  });

  it("matches tail wildcard (**)", () => {
    const { trie } = compileRules([
      { id: "api_all", pattern: "/api/**", limit: 500, windowMs: 60000 },
    ]);

    const match1 = trie.match(normalizeRouteSegments("/api/v1")!);
    assert.equal(match1?.id, "api_all");

    const match2 = trie.match(normalizeRouteSegments("/api/v1/rfqs/123/comments")!);
    assert.equal(match2?.id, "api_all");

    // Does not match outside /api
    const match3 = trie.match(normalizeRouteSegments("/health")!);
    assert.equal(match3, null);
  });

  it("prefers literal match over single-segment wildcard", () => {
    const { trie } = compileRules([
      { id: "wildcard", pattern: "/api/v1/rfqs/*", limit: 50, windowMs: 1000 },
      { id: "status_exact", pattern: "/api/v1/rfqs/status", limit: 10, windowMs: 1000 },
    ]);

    // Exact status matches status_exact
    const matchStatus = trie.match(normalizeRouteSegments("/api/v1/rfqs/status")!);
    assert.equal(matchStatus?.id, "status_exact");

    // Other IDs match wildcard
    const matchOther = trie.match(normalizeRouteSegments("/api/v1/rfqs/999")!);
    assert.equal(matchOther?.id, "wildcard");
  });

  it("prefers single-segment wildcard over tail wildcard", () => {
    const { trie } = compileRules([
      { id: "tail", pattern: "/api/**", limit: 100, windowMs: 1000 },
      { id: "single", pattern: "/api/*", limit: 20, windowMs: 1000 },
    ]);

    const matchSingle = trie.match(normalizeRouteSegments("/api/v1")!);
    assert.equal(matchSingle?.id, "single");

    const matchDeep = trie.match(normalizeRouteSegments("/api/v1/rfqs/detail")!);
    assert.equal(matchDeep?.id, "tail");
  });

  it("breaks ties deterministically using declaration order", () => {
    const { trie } = compileRules([
      { id: "first", pattern: "/api/v1/*", limit: 10, windowMs: 1000 },
      { id: "second", pattern: "/api/*/items", limit: 20, windowMs: 1000 },
    ]);

    // Path /api/v1/items could match both (each has 2 literals and 1 wildcard)
    const match = trie.match(normalizeRouteSegments("/api/v1/items")!);
    assert.equal(match?.id, "first"); // first rule in config takes precedence
  });
});


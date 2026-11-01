import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeRoute, normalizeRouteSegments, MAX_ROUTE_LENGTH } from "../../src/normalization";

describe("Route Normalization", () => {
  it("normalizes empty string to root", () => {
    assert.deepEqual(normalizeRouteSegments(""), []);
    assert.equal(canonicalizeRoute(""), "/");
  });

  it("handles basic clean routes", () => {
    assert.deepEqual(normalizeRouteSegments("/api/v1/rfqs"), ["api", "v1", "rfqs"]);
    assert.equal(canonicalizeRoute("/api/v1/rfqs"), "/api/v1/rfqs");
  });

  it("collapses duplicate and trailing slashes", () => {
    assert.deepEqual(normalizeRouteSegments("///api////v1///rfqs//"), ["api", "v1", "rfqs"]);
    assert.equal(canonicalizeRoute("///api////v1///rfqs//"), "/api/v1/rfqs");
  });

  it("strips query parameters and URL fragments", () => {
    assert.deepEqual(
      normalizeRouteSegments("/api/v1/rfqs?filter=active&sort=desc#section2"),
      ["api", "v1", "rfqs"]
    );
    assert.equal(
      canonicalizeRoute("/api/v1/rfqs?filter=active&sort=desc#section2"),
      "/api/v1/rfqs"
    );
  });

  it("normalizes case to lowercase", () => {
    assert.deepEqual(normalizeRouteSegments("/API/V1/RFQs"), ["api", "v1", "rfqs"]);
    assert.equal(canonicalizeRoute("/API/V1/RFQs"), "/api/v1/rfqs");
  });

  it("resolves single dot '.' segments safely", () => {
    assert.deepEqual(normalizeRouteSegments("/api/./v1/./rfqs"), ["api", "v1", "rfqs"]);
    assert.equal(canonicalizeRoute("/api/./v1/./rfqs"), "/api/v1/rfqs");
  });

  it("resolves double dot '..' parent path traversal safely", () => {
    assert.deepEqual(
      normalizeRouteSegments("/api/v1/fake/../rfqs"),
      ["api", "v1", "rfqs"]
    );
    assert.equal(canonicalizeRoute("/api/v1/fake/../rfqs"), "/api/v1/rfqs");
  });

  it("prevents traversing above the root directory with ..", () => {
    assert.deepEqual(normalizeRouteSegments("/../../api/v1"), ["api", "v1"]);
    assert.equal(canonicalizeRoute("/../../api/v1"), "/api/v1");
  });

  it("decodes percent-encoded characters including slashes and dots", () => {
    // %2f is '/', %2e%2e is '..'
    assert.deepEqual(
      normalizeRouteSegments("/api%2fv1%2ffake/%2e%2e/rfqs"),
      ["api", "v1", "rfqs"]
    );
  });

  it("survives malformed percent-encoding without throwing", () => {
    // %ZZ, incomplete %E0, etc.
    assert.doesNotThrow(() => {
      normalizeRouteSegments("/api/v1/%ZZ/%E0%A4/rfqs");
    });
    const segs = normalizeRouteSegments("/api/v1/%ZZ/rfqs");
    assert.ok(segs !== null);
  });

  it("handles unicode characters safely", () => {
    const route = "/api/v1/ünicöde/café";
    const segs = normalizeRouteSegments(route);
    assert.ok(segs !== null);
    assert.equal(segs[0], "api");
    assert.equal(segs[1], "v1");
  });

  it("rejects routes exceeding MAX_ROUTE_LENGTH", () => {
    const hugeRoute = "/api/" + "a".repeat(MAX_ROUTE_LENGTH + 10);
    assert.equal(normalizeRouteSegments(hugeRoute), null);
    assert.equal(canonicalizeRoute(hugeRoute), null);
  });

  it("rejects non-string inputs safely", () => {
    assert.equal(normalizeRouteSegments(null), null);
    assert.equal(normalizeRouteSegments(undefined), null);
    assert.equal(normalizeRouteSegments(123), null);
    assert.equal(normalizeRouteSegments({}), null);
  });
});


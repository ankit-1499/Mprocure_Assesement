# In-Process Rate Limiter Library

A high-performance, contractually strict in-memory rolling-window rate limiter in TypeScript (Node.js 18+) with **zero runtime dependencies**.

Designed for multi-tenant API gateways serving ~5,000 req/s peak per process across ~20,000 active tenants under a strict **64 MB heap budget**.

---

## Highlights

- **Contractual "Never Over-Admit" Guarantee**: No approximate fixed-window or sliding-window-counter algorithms. 
  - **Tier 1 (Exact Ring Buffer)**: For limits $\le 1,000$, uses a compact `Float64Array` circular ring buffer with 0% over-admission and 0% under-admission.
  - **Tier 2 (Conservative Sub-Buckets)**: For large limits $> 1,000$ (e.g. enterprise 300,000 req/day), uses a 60-bucket discrete sliding window ($248\text{ bytes}$) that expires buckets only when completely outside the window. Provably $0\%$ over-admission with bounded under-admission $\le 1.67\%$.
- **Adversarial & ReDoS Protection**: Pre-compiled Segment Trie with $O(\text{segments})$ matching. Zero regex on the hot path. State is strictly keyed by matched `ruleId`, never raw route strings, keeping memory flat (+0.06 MB) under 1,000,000 unique URLs.
- **Microsecond Latency**:
  - Paced 5,000 req/s: **p50 = 6.8 µs, p99 = 32.7 µs, p99.9 = 78.4 µs**.
  - Flat-out throughput: **173,493 ops/sec**.
- **Tiny Memory Footprint**: 20,000 active tenants + enterprise tenants consume **20.05 MB** total heap (well under 64 MB budget).
- **Atomic Dynamic Config Reloads**: Strict validation with automatic rollback to last-known-good rules if config fails. Counter continuity ensures lowering limits never allows burst exploits.
- **Amortized Eviction**: Bounded incremental cleanup ($k=4$ tenants checked per call) eliminates periodic background timers that stall the event loop.
- **Bounded Observability**: Per-rule counters, reason codes, bounded Top-50 denied tenants summary, and token-bucket rate-limited `onDeny` callback.

---

## Quickstart

### Installation

```bash
npm install
```

### Run Tests

Runs unit tests and fast-check property-based tests verifying the core mathematical invariants:

```bash
npm test
```

### Run Benchmarks

```bash
# 1. Throughput & Latency percentiles (flat-out and 5,000 req/s paced Zipf mix)
npm run bench

# 2. Heap memory under 20,000 active tenants + forced GC vs 64 MB budget
npm run bench:memory

# 3. Adversarial test: 1,000,000 unique URLs proving memory stays flat
npm run bench:adversarial

# 4. Amortized eviction pause & event-loop latency
npm run bench:eviction
```

---

## Usage

```typescript
import { RateLimiter } from "./src";

const limiter = new RateLimiter({
  rules: [
    { id: "health", pattern: "/health", limit: 1000, windowMs: 1000 },
    { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 100, windowMs: 60_000 },
    { id: "enterprise", pattern: "/api/v1/enterprise/**", limit: 300_000, windowMs: 86_400_000 },
  ],
});

// 1. Hot-path boolean API
if (limiter.allowRequest("tenant_123", "/api/v1/rfqs/456")) {
  // Process request
} else {
  // Reject with HTTP 429
}

// 2. Rich observability API
const decision = limiter.check("tenant_123", "/api/v1/rfqs/456");
console.log(decision);
// {
//   allowed: false,
//   reason: "RATE_LIMITED",
//   ruleId: "rfqs",
//   limit: 100,
//   remaining: 0,
//   retryAfterMs: 450
// }
```

---

## API Reference

### `allowRequest(tenantId: string, route: string): boolean`
Fast boolean check. Returns `true` if admitted, `false` if rate-limited or invalid.

### `check(tenantId: string, route: string): RateLimitResult`
Detailed check returning:
- `allowed: boolean`: Decision result.
- `reason: "ALLOWED" | "RATE_LIMITED" | "NO_MATCH" | "INVALID_INPUT"`: Structured decision code.
- `ruleId?: string`: Matched rule ID.
- `limit?: number`: Rule limit.
- `remaining: number`: Remaining requests in rolling window.
- `retryAfterMs: number`: Estimated milliseconds until next slot opens.

### `updateRules(rules: RateLimitRuleConfig[]): void`
Atomically updates configuration. If any rule is invalid, throws `ConfigValidationError` and leaves the active configuration untouched. Counters for active tenants are preserved according to rolling-window invariants.

### `getStats(): RateLimiterStats`
Returns operational metrics snapshot:
- `activeTenants`: Approximate count of tenants currently tracked in memory.
- `totalAllowed`: Total requests permitted.
- `totalDenied`: Total requests denied.
- `rules`: Per-rule allowed and denied counters.
- `topDeniedTenants`: Top-50 most frequently denied tenant IDs.

### `reset(): void`
Resets all internal in-memory tenant state (useful between tests).


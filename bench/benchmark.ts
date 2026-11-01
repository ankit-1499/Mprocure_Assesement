import { RateLimiter } from "../src/limiter-core";
import { SystemClock } from "../src/clock";

// Machine & environment info
console.log("===============================================================");
console.log("BENCHMARK: RateLimiter Throughput & Latency");
console.log(`Node.js Version: ${process.version}`);
console.log(`Architecture: ${process.arch} | Platform: ${process.platform}`);
console.log(`V8 Version: ${process.versions.v8}`);
console.log("===============================================================\n");

const TOTAL_TENANTS = 20_000;
const ENTERPRISE_TENANTS = ["enterprise_alpha", "enterprise_beta"];

// Pre-generate Zipf distribution for realistic traffic skew (s = 1.05)
function buildZipfLookup(numTenants: number, s: number = 1.05): string[] {
  console.log(`Generating Zipf lookup table for ${numTenants} tenants (skew s=${s})...`);
  const weights = new Float64Array(numTenants);
  let sum = 0;
  for (let i = 0; i < numTenants; i++) {
    weights[i] = 1 / Math.pow(i + 1, s);
    sum += weights[i]!;
  }

  // Pre-sample 100,000 draws to avoid random generation overhead during hot path
  const TABLE_SIZE = 100_000;
  const lookup = new Array<string>(TABLE_SIZE);

  // Cumulative distribution
  const cdf = new Float64Array(numTenants);
  let cum = 0;
  for (let i = 0; i < numTenants; i++) {
    cum += weights[i]! / sum;
    cdf[i] = cum;
  }

  for (let j = 0; j < TABLE_SIZE; j++) {
    const r = Math.random();
    // Binary search in CDF
    let low = 0;
    let high = numTenants - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cdf[mid]! < r) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    lookup[j] = `tenant_${low}`;
  }

  console.log("Zipf distribution table ready.\n");
  return lookup;
}

const zipfTenants = buildZipfLookup(TOTAL_TENANTS - 2);

const routes = [
  "/api/v1/rfqs/item_101",
  "/api/v1/rfqs/status",
  "/api/v1/pos/order_999",
  "/api/v1/users/profile",
  "/health",
  "/api/v1/enterprise/bulk_data",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const limiter = new RateLimiter({
  clock: new SystemClock(),
  rules: [
    { id: "health", pattern: "/health", limit: 50_000, windowMs: 1000 },
    { id: "rfq_status", pattern: "/api/v1/rfqs/status", limit: 500, windowMs: 1000 },
    { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 100, windowMs: 60_000 },
    { id: "pos", pattern: "/api/v1/pos/*", limit: 10, windowMs: 1000 },
    { id: "enterprise", pattern: "/api/v1/enterprise/**", limit: 300_000, windowMs: DAY_MS },
    { id: "default_api", pattern: "/api/**", limit: 200, windowMs: 60_000 },
  ],
});

// Warmup
console.log("Warming up JIT compiler (50,000 iterations)...");
for (let i = 0; i < 50_000; i++) {
  const tenant = i % 10 === 0 ? ENTERPRISE_TENANTS[i % 2]! : zipfTenants[i % zipfTenants.length]!;
  const route = routes[i % routes.length]!;
  limiter.allowRequest(tenant, route);
}
console.log("Warmup complete.\n");

function calculatePercentiles(latenciesNs: Float64Array, count: number): {
  p50: number;
  p90: number;
  p99: number;
  p99_9: number;
  max: number;
} {
  const sorted = latenciesNs.subarray(0, count).slice().sort();
  const getP = (p: number) => sorted[Math.min(count - 1, Math.floor(count * p))]! / 1000; // ns to us

  return {
    p50: getP(0.50),
    p90: getP(0.90),
    p99: getP(0.99),
    p99_9: getP(0.999),
    max: sorted[count - 1]! / 1000,
  };
}

// 1. Flat-out Throughput & Latency
const BENCH_OPS = 250_000;
const latenciesNs = new Float64Array(BENCH_OPS);

console.log(`Running Flat-Out Throughput Benchmark (${BENCH_OPS.toLocaleString()} requests)...`);
const startNs = process.hrtime.bigint();

for (let i = 0; i < BENCH_OPS; i++) {
  // 15% traffic is enterprise, 85% Zipf-distributed standard tenants
  const tenant = i % 7 === 0
    ? ENTERPRISE_TENANTS[i % 2]!
    : zipfTenants[i % zipfTenants.length]!;
  const route = routes[i % routes.length]!;

  const opStart = process.hrtime.bigint();
  limiter.allowRequest(tenant, route);
  const opEnd = process.hrtime.bigint();

  latenciesNs[i] = Number(opEnd - opStart);
}

const totalDurationNs = Number(process.hrtime.bigint() - startNs);
const totalSeconds = totalDurationNs / 1e9;
const opsPerSec = Math.round(BENCH_OPS / totalSeconds);
const flatOutStats = calculatePercentiles(latenciesNs, BENCH_OPS);

console.log("---------------------------------------------------------------");
console.log("FLAT-OUT RESULTS:");
console.log(`Throughput:       ${opsPerSec.toLocaleString()} ops/sec`);
console.log(`Total Time:       ${totalSeconds.toFixed(3)} s`);
console.log(`Latency p50:      ${flatOutStats.p50.toFixed(2)} µs`);
console.log(`Latency p90:      ${flatOutStats.p90.toFixed(2)} µs`);
console.log(`Latency p99:      ${flatOutStats.p99.toFixed(2)} µs`);
console.log(`Latency p99.9:    ${flatOutStats.p99_9.toFixed(2)} µs`);
console.log(`Latency Max:      ${flatOutStats.max.toFixed(2)} µs`);
console.log("---------------------------------------------------------------\n");

// 2. Paced 5,000 req/s-equivalent Benchmark
const PACED_OPS = 50_000;
const pacedLatenciesNs = new Float64Array(PACED_OPS);
console.log(`Running Paced 5,000 req/s-equivalent Benchmark (${PACED_OPS.toLocaleString()} requests)...`);

// Simulate 5,000 req/s target (target interval = 200 microseconds per request)
const TARGET_INTERVAL_NS = 200_000n; // 200 us
let nextScheduledNs = process.hrtime.bigint();

for (let i = 0; i < PACED_OPS; i++) {
  // Spin wait until next scheduled time
  while (process.hrtime.bigint() < nextScheduledNs) {
    // busy wait for sub-millisecond precision
  }

  const tenant = i % 7 === 0
    ? ENTERPRISE_TENANTS[i % 2]!
    : zipfTenants[i % zipfTenants.length]!;
  const route = routes[i % routes.length]!;

  const opStart = process.hrtime.bigint();
  limiter.allowRequest(tenant, route);
  const opEnd = process.hrtime.bigint();

  pacedLatenciesNs[i] = Number(opEnd - opStart);
  nextScheduledNs += TARGET_INTERVAL_NS;
}

const pacedStats = calculatePercentiles(pacedLatenciesNs, PACED_OPS);

console.log("---------------------------------------------------------------");
console.log("5,000 REQ/S PACED WORKLOAD RESULTS:");
console.log(`Latency p50:      ${pacedStats.p50.toFixed(2)} µs`);
console.log(`Latency p90:      ${pacedStats.p90.toFixed(2)} µs`);
console.log(`Latency p99:      ${pacedStats.p99.toFixed(2)} µs`);
console.log(`Latency p99.9:    ${pacedStats.p99_9.toFixed(2)} µs`);
console.log(`Latency Max:      ${pacedStats.max.toFixed(2)} µs`);
console.log("===============================================================");


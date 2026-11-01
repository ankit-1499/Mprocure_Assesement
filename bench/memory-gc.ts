import { RateLimiter } from "../src/limiter-core";
import { SystemClock } from "../src/clock";

console.log("===============================================================");
console.log("BENCHMARK: Heap Memory under 20,000 Tenants Workload");
console.log(`Node.js Version: ${process.version}`);
console.log(`Platform: ${process.platform} | Architecture: ${process.arch}`);
console.log("===============================================================\n");

declare const global: {
  gc?: () => void;
};

if (typeof global.gc !== "function") {
  console.error("ERROR: This benchmark requires --expose-gc flag.");
  console.error("Run with: node --expose-gc dist/bench/memory-gc.js");
  process.exit(1);
}

// Initial baseline memory
global.gc();
const baselineHeapMB = process.memoryUsage().heapUsed / (1024 * 1024);
console.log(`Baseline Heap (Node runtime): ${baselineHeapMB.toFixed(2)} MB\n`);

const DAY_MS = 24 * 60 * 60 * 1000;
const limiter = new RateLimiter({
  clock: new SystemClock(),
  rules: [
    { id: "health", pattern: "/health", limit: 50_000, windowMs: 1000 },
    { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 100, windowMs: 60_000 },
    { id: "pos", pattern: "/api/v1/pos/*", limit: 10, windowMs: 1000 },
    { id: "enterprise", pattern: "/api/v1/enterprise/**", limit: 300_000, windowMs: DAY_MS },
    { id: "default_api", pattern: "/api/**", limit: 200, windowMs: 60_000 },
  ],
});

const TOTAL_TENANTS = 20_000;
console.log(`Populating state for ${TOTAL_TENANTS.toLocaleString()} active tenants...`);

// 2 Enterprise tenants with heavy traffic
for (let i = 0; i < 5000; i++) {
  limiter.allowRequest("enterprise_alpha", `/api/v1/enterprise/report_${i % 20}`);
  limiter.allowRequest("enterprise_beta", `/api/v1/enterprise/export_${i % 20}`);
}

// 20,000 active tenants sending requests across multiple routes
for (let t = 0; t < TOTAL_TENANTS; t++) {
  const tenantId = `tenant_${t}`;
  limiter.allowRequest(tenantId, "/api/v1/rfqs/main");
  if (t % 3 === 0) {
    limiter.allowRequest(tenantId, "/api/v1/pos/order");
  }
  if (t % 10 === 0) {
    limiter.allowRequest(tenantId, "/api/v1/users/view");
  }
}

console.log(`State populated. Active tenants reported: ${limiter.getStats().activeTenants.toLocaleString()}`);

// Force Garbage Collection to measure true retained heap
global.gc();
global.gc();

const postWorkloadHeapMB = process.memoryUsage().heapUsed / (1024 * 1024);
const netLimiterMemoryMB = postWorkloadHeapMB - baselineHeapMB;
const HARD_BUDGET_MB = 64.0;

console.log("---------------------------------------------------------------");
console.log("MEMORY RESULTS:");
console.log(`Baseline Heap (Runtime):       ${baselineHeapMB.toFixed(2)} MB`);
console.log(`Total Retained Heap:           ${postWorkloadHeapMB.toFixed(2)} MB`);
console.log(`Net Limiter Data Structures:   ${netLimiterMemoryMB.toFixed(2)} MB`);
console.log(`Hard Budget Limit:             ${HARD_BUDGET_MB.toFixed(2)} MB`);
console.log(`Budget Headroom Remaining:     ${(HARD_BUDGET_MB - postWorkloadHeapMB).toFixed(2)} MB`);
console.log("---------------------------------------------------------------");

if (postWorkloadHeapMB < HARD_BUDGET_MB) {
  console.log(`\nPASSED: Total heap (${postWorkloadHeapMB.toFixed(2)} MB) is strictly within the 64 MB budget!`);
} else {
  console.error(`\nFAILED: Total heap (${postWorkloadHeapMB.toFixed(2)} MB) exceeded the 64 MB budget!`);
  process.exit(1);
}
console.log("===============================================================");


import { RateLimiter } from "../src/limiter-core";
import { SystemClock } from "../src/clock";

console.log("===============================================================");
console.log("BENCHMARK: Adversarial Route Cardinality Memory Defense");
console.log(`Node.js Version: ${process.version}`);
console.log(`Platform: ${process.platform} | Architecture: ${process.arch}`);
console.log("===============================================================\n");

declare const global: {
  gc?: () => void;
};

if (typeof global.gc !== "function") {
  console.error("ERROR: This benchmark requires --expose-gc flag.");
  console.error("Run with: node --expose-gc dist/bench/adversarial-memory.js");
  process.exit(1);
}

const limiter = new RateLimiter({
  clock: new SystemClock(),
  rules: [
    { id: "rfqs", pattern: "/api/v1/rfqs/*", limit: 2_000_000, windowMs: 60_000 },
  ],
});

// Warmup
limiter.allowRequest("attacker_tenant", "/api/v1/rfqs/warmup");

global.gc();
global.gc();
const initialHeapMB = process.memoryUsage().heapUsed / (1024 * 1024);
console.log(`Initial Heap before adversarial attack: ${initialHeapMB.toFixed(2)} MB`);

const ATTACK_ROUTES_COUNT = 1_000_000;
console.log(`\nLaunching adversarial attack: sending ${ATTACK_ROUTES_COUNT.toLocaleString()} UNIQUE garbage routes...`);

const startTime = Date.now();
for (let i = 0; i < ATTACK_ROUTES_COUNT; i++) {
  // Attacker generates distinct unique path strings with random query parameters and fragments
  const garbageRoute = `/api/v1/rfqs/adversarial_unique_hash_${i}?token=xyz_${i}&tag=${i}#frag_${i}`;
  limiter.allowRequest("attacker_tenant", garbageRoute);
}
const elapsedSec = (Date.now() - startTime) / 1000;

console.log(`Attack completed in ${elapsedSec.toFixed(2)}s (${Math.round(ATTACK_ROUTES_COUNT / elapsedSec).toLocaleString()} req/s).`);

// Force GC to measure retained heap
global.gc();
global.gc();

const postAttackHeapMB = process.memoryUsage().heapUsed / (1024 * 1024);
const heapDeltaMB = postAttackHeapMB - initialHeapMB;

console.log("---------------------------------------------------------------");
console.log("ADVERSARIAL ATTACK RESULTS:");
console.log(`Initial Heap:                  ${initialHeapMB.toFixed(2)} MB`);
console.log(`Post-Attack Retained Heap:     ${postAttackHeapMB.toFixed(2)} MB`);
console.log(`Net Heap Growth:               ${heapDeltaMB.toFixed(2)} MB`);
console.log("---------------------------------------------------------------");

// Invariant: Because state is keyed by Rule ID and never by raw route string,
// 1,000,000 distinct URLs must NOT allocate 1,000,000 state objects.
// Net heap growth should be virtually zero (less than 2 MB).
if (heapDeltaMB < 2.0) {
  console.log(`\nPASSED: Memory stayed completely flat (+${heapDeltaMB.toFixed(2)} MB) across 1,000,000 unique URLs!`);
} else {
  console.error(`\nFAILED: Heap grew by ${heapDeltaMB.toFixed(2)} MB, potential route cardinality leak!`);
  process.exit(1);
}
console.log("===============================================================");


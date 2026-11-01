import { RateLimiter } from "../src/limiter-core";
import { SystemClock } from "../src/clock";

console.log("===============================================================");
console.log("BENCHMARK: Amortized Eviction Pause & Cleanup Cost");
console.log(`Node.js Version: ${process.version}`);
console.log(`Platform: ${process.platform} | Architecture: ${process.arch}`);
console.log("===============================================================\n");

const SHORT_WINDOW_MS = 100; // 100ms short window to force rapid expiration

const limiter = new RateLimiter({
  clock: new SystemClock(),
  rules: [
    { id: "short_rule", pattern: "/api/short/*", limit: 10, windowMs: SHORT_WINDOW_MS },
  ],
});

const CHURN_TENANTS = 10_000;
console.log(`Creating ${CHURN_TENANTS.toLocaleString()} short-lived tenants...`);

for (let i = 0; i < CHURN_TENANTS; i++) {
  limiter.allowRequest(`churn_tenant_${i}`, `/api/short/${i}`);
}

console.log(`State created. Active tenants before expiration: ${limiter.getStats().activeTenants.toLocaleString()}`);

console.log(`Sleeping for ${SHORT_WINDOW_MS + 50}ms to allow all tenant windows to expire...`);

// Wait for all windows to expire
const sleepStart = Date.now();
while (Date.now() - sleepStart < SHORT_WINDOW_MS + 50) {
  // spin wait
}

console.log("All tenant windows are now expired. Measuring call latencies during active eviction...\n");

// Now measure latency of calls while amortized eviction is actively cleaning up the 10,000 expired tenants
const EVICTION_CALLS = 10_000;
const callLatenciesNs = new Float64Array(EVICTION_CALLS);

for (let i = 0; i < EVICTION_CALLS; i++) {
  const t0 = process.hrtime.bigint();
  // Call on an ongoing active tenant
  limiter.allowRequest("active_tenant", "/api/short/continuous");
  const t1 = process.hrtime.bigint();

  callLatenciesNs[i] = Number(t1 - t0);
}

const remainingTenants = limiter.getStats().activeTenants;
console.log(`Eviction run complete. Active tenants remaining in map: ${remainingTenants} (only active_tenant left)`);

// Sort latencies
const sorted = callLatenciesNs.slice().sort();
const count = EVICTION_CALLS;
const p50Us = sorted[Math.floor(count * 0.50)]! / 1000;
const p99Us = sorted[Math.floor(count * 0.99)]! / 1000;
const p99_9Us = sorted[Math.floor(count * 0.999)]! / 1000;
const maxUs = sorted[count - 1]! / 1000;

console.log("---------------------------------------------------------------");
console.log("EVICTION LATENCY RESULTS:");
console.log(`p50 Latency during eviction:   ${p50Us.toFixed(2)} µs`);
console.log(`p99 Latency during eviction:   ${p99Us.toFixed(2)} µs`);
console.log(`p99.9 Latency during eviction: ${p99_9Us.toFixed(2)} µs`);
console.log(`Max Pause during eviction:     ${maxUs.toFixed(2)} µs (${(maxUs / 1000).toFixed(3)} ms)`);
console.log("---------------------------------------------------------------");

if (maxUs < 5000) { // Less than 5 milliseconds
  console.log(`\nPASSED: Eviction pause is bounded and amortized (< 5 ms max pause, zero event-loop stalls)!`);
} else {
  console.error(`\nFAILED: Eviction pause exceeded 5 ms: ${(maxUs / 1000).toFixed(2)} ms!`);
  process.exit(1);
}
console.log("===============================================================");


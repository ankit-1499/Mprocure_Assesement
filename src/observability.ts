import {
  DenyEvent,
  DeniedTenantSummary,
  RateLimiterOptions,
  RateLimitReason,
  RuleStats,
} from "./types";
import { CompiledRule } from "./trie";

/**
 * Bounded tracker for top denied tenants using a bounded frequency table.
 * Why: Untrusted tenants could send millions of distinct random tenantIds.
 * Storing an unbounded frequency map would cause an Out-Of-Memory (OOM) incident.
 * This table is hard-capped at maxEntries (e.g. 100), keeping memory < 15 KB.
 */
export class BoundedTopDeniedTracker {
  private readonly maxEntries: number;
  private readonly counts: Map<string, number> = new Map();

  constructor(maxEntries: number = 100) {
    this.maxEntries = Math.max(10, maxEntries);
  }

  recordDeny(tenantId: string): void {
    const current = this.counts.get(tenantId);
    if (current !== undefined) {
      this.counts.set(tenantId, current + 1);
      return;
    }

    if (this.counts.size < this.maxEntries) {
      this.counts.set(tenantId, 1);
      return;
    }

    // Table is full: find minimum count entry and replace if appropriate
    let minKey: string | null = null;
    let minVal = Infinity;

    for (const [key, val] of this.counts.entries()) {
      if (val < minVal) {
        minVal = val;
        minKey = key;
      }
    }

    // Stream summary replacement: replace lowest frequency item
    if (minKey !== null) {
      this.counts.delete(minKey);
      this.counts.set(tenantId, minVal + 1);
    }
  }

  getTop(n: number): readonly DeniedTenantSummary[] {
    const entries: DeniedTenantSummary[] = [];
    for (const [tenantId, deniedCount] of this.counts.entries()) {
      entries.push({ tenantId, deniedCount });
    }
    entries.sort((a, b) => b.deniedCount - a.deniedCount);
    return entries.slice(0, n);
  }

  reset(): void {
    this.counts.clear();
  }
}

/**
 * Observability manager for the rate limiter.
 * Captures metrics with strictly bounded cardinality.
 */
export class ObservabilityManager {
  private totalAllowed: number = 0;
  private totalDenied: number = 0;
  private readonly ruleStats: Map<string, { allowed: number; denied: number }> = new Map();
  private readonly topDeniedTracker: BoundedTopDeniedTracker;
  private readonly onDenyCallback?: (event: DenyEvent) => void;
  private readonly maxDenyCallbacksPerSecond: number;

  // Token bucket for rate-limiting onDeny callbacks to prevent log floods
  private callbackTokens: number;
  private lastTokenRefillTime: number = 0;

  constructor(options?: RateLimiterOptions) {
    this.topDeniedTracker = new BoundedTopDeniedTracker(
      (options?.maxTrackedDeniedTenants ?? 50) * 2
    );
    this.onDenyCallback = options?.onDeny;
    this.maxDenyCallbacksPerSecond = options?.maxDenyCallbacksPerSecond ?? 20;
    this.callbackTokens = this.maxDenyCallbacksPerSecond;
  }

  registerRules(rules: readonly CompiledRule[]): void {
    for (const rule of rules) {
      if (!this.ruleStats.has(rule.id)) {
        this.ruleStats.set(rule.id, { allowed: 0, denied: 0 });
      }
    }
  }

  recordAllowed(ruleId?: string): void {
    this.totalAllowed++;
    if (ruleId) {
      const stat = this.ruleStats.get(ruleId);
      if (stat) stat.allowed++;
    }
  }

  recordDenied(
    tenantId: string,
    route: string,
    reason: RateLimitReason,
    retryAfterMs: number,
    now: number,
    ruleId?: string
  ): void {
    this.totalDenied++;
    if (ruleId) {
      const stat = this.ruleStats.get(ruleId);
      if (stat) stat.denied++;
    }

    if (tenantId) {
      this.topDeniedTracker.recordDeny(tenantId);
    }

    if (this.onDenyCallback) {
      this.dispatchCallbackThrottled({
        tenantId,
        route,
        ruleId,
        reason,
        retryAfterMs,
        timestamp: now,
      }, now);
    }
  }

  /**
   * Dispatches onDeny callback with token bucket throttling.
   * Why: An incident of 5,000 req/s all being denied must not trigger 5,000 log writes/s,
   * which would lock the event loop and crash logging infrastructure.
   */
  private dispatchCallbackThrottled(event: DenyEvent, now: number): void {
    if (now - this.lastTokenRefillTime >= 1000) {
      this.callbackTokens = this.maxDenyCallbacksPerSecond;
      this.lastTokenRefillTime = now;
    }

    if (this.callbackTokens > 0) {
      this.callbackTokens--;
      try {
        this.onDenyCallback!(event);
      } catch {
        // User callback threw: swallow to isolate rate limiter from user error
      }
    }
  }

  getSnapshot(
    activeTenantsCount: number,
    compiledRules: readonly CompiledRule[],
    topN: number = 50
  ): {
    activeTenants: number;
    totalAllowed: number;
    totalDenied: number;
    rules: readonly RuleStats[];
    topDeniedTenants: readonly DeniedTenantSummary[];
  } {
    const rulesSummary: RuleStats[] = [];

    for (const rule of compiledRules) {
      const counters = this.ruleStats.get(rule.id) ?? { allowed: 0, denied: 0 };
      rulesSummary.push({
        ruleId: rule.id,
        pattern: rule.pattern,
        limit: rule.limit,
        windowMs: rule.windowMs,
        allowed: counters.allowed,
        denied: counters.denied,
      });
    }

    return {
      activeTenants: activeTenantsCount,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
      rules: rulesSummary,
      topDeniedTenants: this.topDeniedTracker.getTop(topN),
    };
  }

  reset(): void {
    this.totalAllowed = 0;
    this.totalDenied = 0;
    this.ruleStats.clear();
    this.topDeniedTracker.reset();
  }
}


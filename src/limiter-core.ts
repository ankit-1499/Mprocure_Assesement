import { Clock, SystemClock } from "./clock";
import {
  RateLimiterOptions,
  RateLimitResult,
  RateLimitRuleConfig,
  RateLimiterStats,
} from "./types";
import { normalizeRouteSegments } from "./normalization";
import { CompiledRule, RouteTrie } from "./trie";
import { compileRules } from "./config";
import { RateLimiterEngine, SlidingWindowLog } from "./sliding-window-log";
import { BucketedCounter } from "./bucketed-counter";
import { ObservabilityManager } from "./observability";

/**
 * Number of idle tenants to inspect for eviction per check() call.
 * Why: Inspecting a bounded k=4 tenants per call amortizes cleanup over the hot path,
 * eliminating the need for periodic setInterval timers that stall the event loop.
 */
const EVICTION_BATCH_SIZE = 4;

export class RateLimiter {
  private readonly clock: Clock;
  private readonly defaultPolicy: "ALLOW" | "DENY";
  private readonly exactLimitThreshold: number;
  private readonly observability: ObservabilityManager;

  private trie: RouteTrie;
  private compiledRules: readonly CompiledRule[];
  private rulesMap: Map<string, CompiledRule> = new Map();

  // Storage: Map<tenantId, Map<ruleId, RateLimiterEngine>>
  // Why: Using Map avoids prototype pollution (__proto__, constructor safe)
  // and memory is keyed strictly by matched ruleId, preventing route cardinality explosion.
  private readonly tenantStates: Map<string, Map<string, RateLimiterEngine>> = new Map();

  // Circular iterator for amortized incremental cleanup
  private evictionIterator: Iterator<string> | null = null;

  constructor(options?: RateLimiterOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.defaultPolicy = options?.defaultPolicy ?? "ALLOW";
    this.exactLimitThreshold = options?.exactLimitThreshold ?? 1000;
    this.observability = new ObservabilityManager(options);

    const initialRules = options?.rules ?? [];
    const compiled = compileRules(initialRules);
    this.trie = compiled.trie;
    this.compiledRules = compiled.rules;
    this.rebuildRulesMap();
    this.observability.registerRules(this.compiledRules);
  }

  private rebuildRulesMap(): void {
    this.rulesMap.clear();
    for (const rule of this.compiledRules) {
      this.rulesMap.set(rule.id, rule);
    }
  }

  /**
   * Instantiates the appropriate engine tier for a given rule.
   * Tier 1 (SlidingWindowLog) for limit <= exactLimitThreshold: 0% over/under-admission.
   * Tier 2 (BucketedCounter) for limit > exactLimitThreshold: conservative, 0% over-admit, bounded RAM.
   */
  private createEngine(rule: CompiledRule): RateLimiterEngine {
    if (rule.limit <= this.exactLimitThreshold) {
      return new SlidingWindowLog(rule.limit, rule.windowMs);
    }
    return new BucketedCounter(rule.limit, rule.windowMs, 60);
  }

  /**
   * Amortized incremental eviction: inspects a small batch of tenants and evicts idle ones.
   */
  private amortizedEvict(now: number): void {
    if (this.tenantStates.size === 0) return;

    if (!this.evictionIterator) {
      this.evictionIterator = this.tenantStates.keys();
    }

    for (let i = 0; i < EVICTION_BATCH_SIZE; i++) {
      const next = this.evictionIterator.next();
      if (next.done) {
        this.evictionIterator = this.tenantStates.keys();
        break;
      }

      const tenantId = next.value;
      const ruleMap = this.tenantStates.get(tenantId);
      if (!ruleMap) continue;

      let allExpired = true;
      for (const [ruleId, engine] of ruleMap.entries()) {
        if (!this.rulesMap.has(ruleId) || engine.isExpired(now)) {
          ruleMap.delete(ruleId);
        } else {
          allExpired = false;
        }
      }

      if (allExpired || ruleMap.size === 0) {
        this.tenantStates.delete(tenantId);
      }
    }
  }

  /**
   * Public API: allowRequest(tenantId, route)
   * Thin wrapper over check().
   */
  allowRequest(tenantId: string, route: string): boolean {
    return this.check(tenantId, route).allowed;
  }

  /**
   * Richer sibling method returning detailed decision reasoning, remaining quota, and retry-after.
   */
  check(tenantId: string, route: string): RateLimitResult {
    const now = this.clock.now();

    // 1. Validate tenantId (untrusted input)
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      this.observability.recordDenied("", String(route), "INVALID_INPUT", 0, now);
      return {
        allowed: false,
        reason: "INVALID_INPUT",
        remaining: 0,
        retryAfterMs: 0,
      };
    }

    // 2. Normalize untrusted route
    const segments = normalizeRouteSegments(route);
    if (segments === null) {
      this.observability.recordDenied(tenantId, String(route), "INVALID_INPUT", 0, now);
      return {
        allowed: false,
        reason: "INVALID_INPUT",
        remaining: 0,
        retryAfterMs: 0,
      };
    }

    // Run amortized incremental cleanup
    this.amortizedEvict(now);

    // 3. Segment Trie Lookup - O(segments), zero regex, deterministic specificity
    const matchedRule = this.trie.match(segments);

    // 4. Handle routes that match no configured rule
    if (!matchedRule) {
      if (this.defaultPolicy === "ALLOW") {
        this.observability.recordAllowed(undefined);
        return {
          allowed: true,
          reason: "NO_MATCH",
          remaining: Infinity,
          retryAfterMs: 0,
        };
      } else {
        this.observability.recordDenied(tenantId, route, "NO_MATCH", 0, now);
        return {
          allowed: false,
          reason: "NO_MATCH",
          remaining: 0,
          retryAfterMs: 0,
        };
      }
    }

    // 5. Retrieve or allocate Tenant State keyed strictly by RULE ID (not raw route)
    let tenantRuleMap = this.tenantStates.get(tenantId);
    if (!tenantRuleMap) {
      tenantRuleMap = new Map();
      this.tenantStates.set(tenantId, tenantRuleMap);
    }

    let engine = tenantRuleMap.get(matchedRule.id);
    if (!engine) {
      engine = this.createEngine(matchedRule);
      tenantRuleMap.set(matchedRule.id, engine);
    }

    // 6. Execute rate limit check against chosen engine
    const decision = engine.checkAndAdmit(now);

    if (decision.allowed) {
      this.observability.recordAllowed(matchedRule.id);
      return {
        allowed: true,
        reason: "ALLOWED",
        ruleId: matchedRule.id,
        limit: matchedRule.limit,
        remaining: decision.remaining,
        retryAfterMs: 0,
      };
    } else {
      this.observability.recordDenied(
        tenantId,
        route,
        "RATE_LIMITED",
        decision.retryAfterMs,
        now,
        matchedRule.id
      );
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        ruleId: matchedRule.id,
        limit: matchedRule.limit,
        remaining: 0,
        retryAfterMs: decision.retryAfterMs,
      };
    }
  }

  /**
   * Atomically updates rules configuration.
   * If validation fails on any new rule, throws ConfigValidationError and keeps last known good rules.
   * Counters on rule change: Lowering a limit or changing a window never resets counters or allows over-admit.
   */
  updateRules(newRules: readonly RateLimitRuleConfig[]): void {
    const now = this.clock.now();

    // 1. Compile atomically - if invalid, throws and leaves current state untouched
    const compiled = compileRules(newRules);

    // 2. Atomic reference swap
    this.trie = compiled.trie;
    this.compiledRules = compiled.rules;
    this.rebuildRulesMap();
    this.observability.registerRules(this.compiledRules);

    // 3. Update existing active engines with new rule parameters without resetting counters
    for (const ruleMap of this.tenantStates.values()) {
      for (const [ruleId, engine] of ruleMap.entries()) {
        const newRule = this.rulesMap.get(ruleId);
        if (newRule) {
          engine.updateRule(newRule.limit, newRule.windowMs, now);
        } else {
          // Rule was removed from config: clean up if expired
          if (engine.isExpired(now)) {
            ruleMap.delete(ruleId);
          }
        }
      }
    }
  }

  /**
   * Returns current active compiled rules.
   */
  getRules(): readonly CompiledRule[] {
    return this.compiledRules;
  }

  /**
   * Returns bounded operational metrics snapshot.
   */
  getStats(): RateLimiterStats {
    return this.observability.getSnapshot(
      this.tenantStates.size,
      this.compiledRules,
      50
    );
  }

  /**
   * Clears all in-memory tenant state (useful between tests).
   */
  reset(): void {
    this.tenantStates.clear();
    this.evictionIterator = null;
    this.observability.reset();
    this.observability.registerRules(this.compiledRules);
  }
}


import { Clock } from "./clock";

/**
 * Reason codes for rate limiting decisions.
 * Bounded cardinality enum to prevent string allocation explosion.
 */
export type RateLimitReason =
  | "ALLOWED"        // Request permitted within quota
  | "RATE_LIMITED"   // Request denied: quota exhausted for current rolling window
  | "NO_MATCH"       // No rule matched route (default policy applied)
  | "INVALID_INPUT"; // Malformed route string or empty tenantId

/**
 * Rich result returned by check().
 */
export interface RateLimitResult {
  /** True if the request is permitted; false if rate-limited or rejected */
  readonly allowed: boolean;
  /** Structured explanation for the decision */
  readonly reason: RateLimitReason;
  /** The matched rule ID, if any rule matched */
  readonly ruleId?: string;
  /** Configured limit of the matched rule, if any */
  readonly limit?: number;
  /** Number of remaining requests permitted in the current window */
  readonly remaining: number;
  /** Estimated milliseconds until at least one slot opens (0 if allowed) */
  readonly retryAfterMs: number;
}

/**
 * Configuration for a single rate limiting rule.
 */
export interface RateLimitRuleConfig {
  /** Unique identifier for the rule (used to key memory counters) */
  readonly id: string;
  /** Route pattern to match, e.g. "/api/v1/rfqs/*" or "/health" */
  readonly pattern: string;
  /** Maximum requests allowed in the rolling window */
  readonly limit: number;
  /** Rolling window duration in milliseconds */
  readonly windowMs: number;
}

/**
 * Information passed to optional onDeny callback.
 */
export interface DenyEvent {
  readonly tenantId: string;
  readonly route: string;
  readonly ruleId?: string;
  readonly reason: RateLimitReason;
  readonly retryAfterMs: number;
  readonly timestamp: number;
}

/**
 * Options for configuring RateLimiter instance.
 */
export interface RateLimiterOptions {
  /** Injected clock for deterministic testing (defaults to SystemClock) */
  readonly clock?: Clock;
  /** Policy when no configured rule matches route: "ALLOW" (default) or "DENY" */
  readonly defaultPolicy?: "ALLOW" | "DENY";
  /** Initial rate limiting rules */
  readonly rules?: RateLimitRuleConfig[];
  /** Threshold limit up to which exact ring buffers are used (default 1000) */
  readonly exactLimitThreshold?: number;
  /** Maximum top denied tenants to track in memory (default 50) */
  readonly maxTrackedDeniedTenants?: number;
  /** Optional callback invoked when a request is denied (rate-limited by design) */
  readonly onDeny?: (event: DenyEvent) => void;
  /** Maximum onDeny callback calls permitted per second (default 20, protects against log floods) */
  readonly maxDenyCallbacksPerSecond?: number;
}

/**
 * Per-rule observability counters.
 */
export interface RuleStats {
  readonly ruleId: string;
  readonly pattern: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly allowed: number;
  readonly denied: number;
}

/**
 * Summary for a top-denied tenant.
 */
export interface DeniedTenantSummary {
  readonly tenantId: string;
  readonly deniedCount: number;
}

/**
 * Snapshot of rate limiter operational statistics.
 */
export interface RateLimiterStats {
  /** Approximate number of active tenants currently occupying memory */
  readonly activeTenants: number;
  /** Total requests permitted across all rules */
  readonly totalAllowed: number;
  /** Total requests denied across all rules */
  readonly totalDenied: number;
  /** Observability counters per rule */
  readonly rules: readonly RuleStats[];
  /** Bounded top-N most denied tenants */
  readonly topDeniedTenants: readonly DeniedTenantSummary[];
}


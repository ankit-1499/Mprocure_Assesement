import { RateLimitRuleConfig } from "./types";
import { ConfigValidationError } from "./errors";
import { normalizeRouteSegments } from "./normalization";
import { CompiledRule, RouteTrie } from "./trie";

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 10_000_000; // Sane ceiling: 10M req/window

export const MIN_WINDOW_MS = 10; // Minimum window: 10ms (respects event-loop granularity)
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // Maximum window: 30 days in ms

/**
 * Validates and compiles an array of rate limit rule configurations.
 * If validation fails on ANY rule, an error is thrown and no state is modified (atomic validation).
 */
export function compileRules(rawConfigs: readonly RateLimitRuleConfig[]): {
  trie: RouteTrie;
  rules: readonly CompiledRule[];
} {
  if (!Array.isArray(rawConfigs)) {
    throw new ConfigValidationError("Rules configuration must be an array");
  }

  const seenIds = new Set<string>();
  const seenPatterns = new Set<string>();
  const compiledList: CompiledRule[] = [];

  for (let index = 0; index < rawConfigs.length; index++) {
    const raw = rawConfigs[index];
    if (!raw || typeof raw !== "object") {
      throw new ConfigValidationError(`Rule at index ${index} must be an object`);
    }

    // 1. Validate ID
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new ConfigValidationError(
        `Rule at index ${index} has missing or empty 'id'`
      );
    }
    const id = raw.id.trim();
    if (seenIds.has(id)) {
      throw new ConfigValidationError(`Duplicate rule id '${id}'`, id);
    }
    seenIds.add(id);

    // 2. Validate Limit
    if (
      typeof raw.limit !== "number" ||
      !Number.isFinite(raw.limit) ||
      !Number.isInteger(raw.limit) ||
      raw.limit < MIN_LIMIT ||
      raw.limit > MAX_LIMIT
    ) {
      throw new ConfigValidationError(
        `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
        id
      );
    }

    // 3. Validate WindowMs
    if (
      typeof raw.windowMs !== "number" ||
      !Number.isFinite(raw.windowMs) ||
      !Number.isInteger(raw.windowMs) ||
      raw.windowMs < MIN_WINDOW_MS ||
      raw.windowMs > MAX_WINDOW_MS
    ) {
      throw new ConfigValidationError(
        `windowMs must be an integer between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS} ms`,
        id
      );
    }

    // 4. Validate Pattern
    if (typeof raw.pattern !== "string" || !raw.pattern.startsWith("/")) {
      throw new ConfigValidationError(
        `pattern must be a string starting with '/' (got '${raw.pattern}')`,
        id
      );
    }

    // Parse segments for pattern
    const segments = normalizeRouteSegments(raw.pattern);
    if (segments === null) {
      throw new ConfigValidationError(
        `pattern '${raw.pattern}' could not be normalized`,
        id
      );
    }

    let literalCount = 0;
    let singleWildcardCount = 0;
    let hasTailWildcard = false;

    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx]!;

      if (seg === "**") {
        if (sIdx !== segments.length - 1) {
          throw new ConfigValidationError(
            `Tail wildcard '**' must only appear at the end of pattern '${raw.pattern}'`,
            id
          );
        }
        hasTailWildcard = true;
      } else if (seg === "*") {
        singleWildcardCount++;
      } else if (seg.includes("*")) {
        // Partial wildcards like 'rfq*123' are ambiguous and prone to misconfiguration
        throw new ConfigValidationError(
          `Partial wildcards like '${seg}' in pattern '${raw.pattern}' are not supported. Use '*' or '**' as complete segments.`,
          id
        );
      } else {
        literalCount++;
      }
    }

    // Canonical pattern representation for duplicate detection
    const canonicalPattern = "/" + segments.join("/");
    if (seenPatterns.has(canonicalPattern)) {
      throw new ConfigValidationError(
        `Duplicate or ambiguous pattern '${raw.pattern}' (canonical: '${canonicalPattern}')`,
        id
      );
    }
    seenPatterns.add(canonicalPattern);

    compiledList.push({
      id,
      pattern: raw.pattern,
      limit: raw.limit,
      windowMs: raw.windowMs,
      index,
      segments,
      literalCount,
      singleWildcardCount,
      hasTailWildcard,
    });
  }

  // Construct RouteTrie from compiled rules
  const trie = new RouteTrie(compiledList);

  return {
    trie,
    rules: compiledList,
  };
}


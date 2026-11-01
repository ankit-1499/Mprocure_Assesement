/**
 * Maximum allowed route path length.
 * Why: Untrusted inputs could send multi-megabyte strings causing event-loop latency spikes.
 */
export const MAX_ROUTE_LENGTH = 2048;

/**
 * Safely decodes percent-encoded characters without throwing URIError on malformed inputs.
 * Why: Standard decodeURIComponent throws on malformed byte sequences (e.g. "%E0%A4");
 * a public rate limiter must never crash on adversarial payload strings.
 */
function safePercentDecode(str: string): string {
  // First, normalize encoded slashes so attackers cannot bypass path segment matching
  const withNormalizedSlashes = str
    .replace(/%2f/gi, "/")
    .replace(/%5c/gi, "/");

  try {
    return decodeURIComponent(withNormalizedSlashes);
  } catch {
    // Fallback: decode individual valid 2-hex-digit sequences, leave invalid ones verbatim
    return withNormalizedSlashes.replace(/%([0-9a-fA-F]{2})/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }
}

/**
 * Normalizes an untrusted route string into a canonical list of path segments.
 *
 * Handles:
 * - Length capping (returns null if length > MAX_ROUTE_LENGTH)
 * - Empty string -> root path []
 * - Query string and hash fragment removal
 * - Unicode normalization (NFC)
 * - Safe percent-decoding (including %2f, %2e)
 * - Case insensitivity (canonical lowercase)
 * - Multiple consecutive slashes (collapsed)
 * - Path traversal ('.' and '..' segments resolved safely)
 *
 * @returns Array of normalized segment strings, or null if the input is invalid/excessive.
 */
export function normalizeRouteSegments(rawRoute: unknown): string[] | null {
  if (typeof rawRoute !== "string") {
    return null;
  }

  // Reject oversized strings early before processing
  if (rawRoute.length > MAX_ROUTE_LENGTH) {
    return null;
  }

  // Fast-path: empty string is treated as root "/"
  if (rawRoute.length === 0) {
    return [];
  }

  let route = rawRoute;

  // 1. Strip fragment (#...) first
  const hashIdx = route.indexOf("#");
  if (hashIdx !== -1) {
    route = route.slice(0, hashIdx);
  }

  // 2. Strip query string (?...)
  const queryIdx = route.indexOf("?");
  if (queryIdx !== -1) {
    route = route.slice(0, queryIdx);
  }

  // 3. Unicode NFC normalization (canonical decomposition followed by canonical composition)
  try {
    route = route.normalize("NFC");
  } catch {
    // If normalization fails on weird strings, proceed with raw
  }

  // 4. Safe percent-decoding
  route = safePercentDecode(route);

  // 5. Convert backslashes to forward slashes for cross-platform URL safety
  route = route.replace(/\\/g, "/");

  // 6. Split into segments and resolve . and ..
  const rawSegments = route.split("/");
  const resolvedSegments: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const rawSeg = rawSegments[i];
    if (rawSeg === undefined) continue;

    // Trim whitespace
    const seg = rawSeg.trim();

    // Ignore empty segments (from leading, duplicate, or trailing slashes) and single dots '.'
    if (seg === "" || seg === ".") {
      continue;
    }

    if (seg === "..") {
      // Path traversal: pop parent segment if available; cannot escape above root
      if (resolvedSegments.length > 0) {
        resolvedSegments.pop();
      }
    } else {
      // Canonicalize segment to lower case for uniform matching
      resolvedSegments.push(seg.toLowerCase());
    }
  }

  return resolvedSegments;
}

/**
 * Formats a normalized segment array into a canonical path string.
 */
export function canonicalizeRoute(rawRoute: unknown): string | null {
  const segments = normalizeRouteSegments(rawRoute);
  if (segments === null) return null;
  if (segments.length === 0) return "/";
  return "/" + segments.join("/");
}


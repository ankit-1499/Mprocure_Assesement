import { ConfigValidationError } from "./errors";

/**
 * A compiled rate limit rule with pre-calculated specificity metrics.
 */
export interface CompiledRule {
  readonly id: string;
  readonly pattern: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly index: number;
  readonly segments: readonly string[];
  readonly literalCount: number;
  readonly singleWildcardCount: number;
  readonly hasTailWildcard: boolean;
}

/**
 * Checks if candidate rule A is more specific than candidate rule B.
 * Specificity order:
 * 1. Higher literal segment count wins (more exact matches).
 * 2. Lower wildcard count wins.
 * 3. Exact segment match beats tail wildcard.
 * 4. Earlier declaration index wins (deterministic tie-break).
 */
export function isMoreSpecific(a: CompiledRule, b: CompiledRule): boolean {
  if (a.literalCount !== b.literalCount) {
    return a.literalCount > b.literalCount;
  }
  const aWildcards = a.singleWildcardCount + (a.hasTailWildcard ? 2 : 0);
  const bWildcards = b.singleWildcardCount + (b.hasTailWildcard ? 2 : 0);
  if (aWildcards !== bWildcards) {
    return aWildcards < bWildcards;
  }
  if (a.hasTailWildcard !== b.hasTailWildcard) {
    return !a.hasTailWildcard; // Exact/single beats tail wildcard
  }
  // Deterministic tie-breaker: earlier rule definition order
  return a.index < b.index;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  wildcardChild?: TrieNode;
  tailWildcardRule?: CompiledRule;
  exactRule?: CompiledRule;
}

function createTrieNode(): TrieNode {
  return {
    children: new Map(),
  };
}

/**
 * Pre-compiled Segment Trie for fast O(segments) route matching.
 * Why: No regular expressions, zero ReDoS risk, strictly bounded execution time.
 */
export class RouteTrie {
  private readonly root: TrieNode = createTrieNode();
  private readonly ruleList: CompiledRule[] = [];

  constructor(rules: readonly CompiledRule[]) {
    for (const rule of rules) {
      this.insert(rule);
      this.ruleList.push(rule);
    }
  }

  private insert(rule: CompiledRule): void {
    let current = this.root;
    const len = rule.segments.length;

    for (let i = 0; i < len; i++) {
      const seg = rule.segments[i]!;

      if (seg === "**") {
        if (i !== len - 1) {
          throw new ConfigValidationError(
            `Tail wildcard '**' must be the last segment in pattern '${rule.pattern}'`,
            rule.id
          );
        }
        current.tailWildcardRule = rule;
        return;
      }

      if (seg === "*") {
        if (!current.wildcardChild) {
          current.wildcardChild = createTrieNode();
        }
        current = current.wildcardChild;
      } else {
        let next = current.children.get(seg);
        if (!next) {
          next = createTrieNode();
          current.children.set(seg, next);
        }
        current = next;
      }
    }

    current.exactRule = rule;
  }

  /**
   * Matches normalized route segments against compiled rules.
   * Finds all matching rules and selects the one with highest specificity.
   *
   * @param segments Normalized route segments.
   * @returns Best matching CompiledRule or null if no rule matched.
   */
  match(segments: readonly string[]): CompiledRule | null {
    let bestMatch: CompiledRule | null = null;

    const search = (node: TrieNode, segIndex: number): void => {
      // 1. If this node has a tail wildcard (**), it matches all remaining segments (>= 1 segment)
      if (node.tailWildcardRule && segIndex < segments.length) {
        if (!bestMatch || isMoreSpecific(node.tailWildcardRule, bestMatch)) {
          bestMatch = node.tailWildcardRule;
        }
      }

      // If we reached the end of the input route segments
      if (segIndex === segments.length) {
        if (node.exactRule) {
          if (!bestMatch || isMoreSpecific(node.exactRule, bestMatch)) {
            bestMatch = node.exactRule;
          }
        }
        return;
      }

      const currentSeg = segments[segIndex]!;

      // 2. Try exact literal child match (highest priority branch)
      const exactChild = node.children.get(currentSeg);
      if (exactChild) {
        search(exactChild, segIndex + 1);
      }

      // 3. Try single-segment wildcard child '*'
      if (node.wildcardChild) {
        search(node.wildcardChild, segIndex + 1);
      }
    };

    search(this.root, 0);
    return bestMatch;
  }

  /**
   * Returns all compiled rules in insertion order.
   */
  getAllRules(): readonly CompiledRule[] {
    return this.ruleList;
  }
}

/**
 * Monotonic clock interface.
 * Decouples time retrieval from system Date.now(), enabling:
 * 1. Monotonicity (unaffected by NTP adjustments or timezone jumps).
 * 2. Deterministic, tick-by-tick testing with fake clocks.
 */
export interface Clock {
  /**
   * Returns current monotonic time in milliseconds.
   */
  now(): number;
}

/**
 * System monotonic clock based on Node.js performance.now().
 * Why: performance.now() is monotonic and provides fractional millisecond precision.
 */
export class SystemClock implements Clock {
  now(): number {
    return performance.now();
  }
}

/**
 * Deterministic test clock that only advances when explicitly instructed.
 */
export class FakeClock implements Clock {
  private currentTime: number;

  constructor(initialTimeMs: number = 0) {
    this.currentTime = initialTimeMs;
  }

  now(): number {
    return this.currentTime;
  }

  advanceBy(ms: number): void {
    if (ms < 0) {
      throw new Error("FakeClock cannot travel backwards in time");
    }
    this.currentTime += ms;
  }

  setTime(timeMs: number): void {
    if (timeMs < this.currentTime) {
      throw new Error("FakeClock time cannot move backwards");
    }
    this.currentTime = timeMs;
  }
}


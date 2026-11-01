/**
 * Custom error thrown when a rate limiting rule configuration is invalid.
 * Ensures caller can catch configuration errors specifically.
 */
export class ConfigValidationError extends Error {
  constructor(message: string, readonly ruleId?: string) {
    super(ruleId ? `Rule '${ruleId}': ${message}` : message);
    this.name = "ConfigValidationError";
    // Maintain prototype chain for instanceof checks across transpilation targets
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


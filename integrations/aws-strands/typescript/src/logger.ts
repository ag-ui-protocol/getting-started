/**
 * Injectable logger for the AWS Strands adapter.
 *
 * The Python sibling uses `logging.getLogger(__name__)` and emits warnings /
 * errors to stderr at `WARNING` and up, with `DEBUG` opt-in. This module
 * mirrors that behaviour: by default the adapter is silent below `warn`,
 * surfaces warnings via `console.warn`, and lets callers redirect output by
 * passing a `Logger` in `StrandsAgentConfig.logger`.
 *
 * Signature `(message: string, ...args: unknown[])` intentionally matches the
 * `console` method shape so existing `vi.spyOn(console, "warn")` test
 * scaffolding keeps working with the default logger in place, and so wiring
 * in pino / winston / bunyan is a one-liner.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Internal fallback used when `StrandsAgentConfig.logger` is omitted.
 * Mirrors Python's stdlib default: warnings + errors go to the console,
 * debug is dropped. Callers who want different behaviour inject their own
 * logger rather than reaching for this one.
 */
export const DEFAULT_LOGGER: Logger = {
  debug() {},
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};

/** Return `provided ?? DEFAULT_LOGGER`. */
export function resolveLogger(provided: Logger | undefined): Logger {
  return provided ?? DEFAULT_LOGGER;
}

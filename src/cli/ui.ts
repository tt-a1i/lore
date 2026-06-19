/**
 * CLI terminal UI helpers. Kept tiny and dependency-free so command modules can
 * share color output without importing the large CLI entrypoint.
 */

const USE_COLOR = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;

function c(code: string, text: string): string {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

/** Bold green: success / checkmarks. */
export function green(text: string): string { return c('1;32', text); }
/** Bold blue: info / steps. */
export function blue(text: string): string { return c('1;34', text); }
/** Bold yellow: warnings. */
export function yellow(text: string): string { return c('1;33', text); }
/** Bold red: errors. */
export function red(text: string): string { return c('1;31', text); }
/** Dim/gray: secondary info. */
export function dim(text: string): string { return c('2', text); }
/** Bold: emphasis. */
export function bold(text: string): string { return c('1', text); }

/** Small helpers shared by the CLI scripts (traffic generator, iteration demo, publish). */

export const isLocalUrl = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);

/**
 * The access key for a target URL: ADMIN_TOKEN from the environment, or the dev default for a local server only.
 * The key is never sent over plain http to a remote host.
 */
export function accessKey(url: string): string {
  const key = process.env.ADMIN_TOKEN ?? (isLocalUrl(url) ? 'dev-admin-token' : '');
  if (key && !isLocalUrl(url) && !url.startsWith('https://')) {
    console.error(`Refusing to send ADMIN_TOKEN over plain http to ${url}; use https://`);
    process.exit(1);
  }
  return key;
}

/** Numeric CLI option: a typo such as `--sessions abc` stops the run instead of silently doing nothing. */
export function intOption(name: string, raw: string, min = 0): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    console.error(`--${name} must be an integer ≥ ${min}, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

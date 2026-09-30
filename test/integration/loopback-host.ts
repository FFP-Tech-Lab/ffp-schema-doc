const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Integration tests reset a database. Refuse any host that is not loopback.
 */
export function assertLoopbackHost(host: string): void {
  if (LOOPBACK_HOSTS.has(host)) return;
  throw new Error(
    `refusing to run the integration script against ${host}. The host must be 127.0.0.1, localhost, or ::1.`,
  );
}

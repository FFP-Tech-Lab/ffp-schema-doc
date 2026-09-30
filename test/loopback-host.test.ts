import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertLoopbackHost } from './integration/loopback-host';

describe('integration host guard', () => {
  it('allows only loopback hosts', () => {
    assertLoopbackHost('127.0.0.1');
    assertLoopbackHost('localhost');
    assertLoopbackHost('::1');
  });

  it('refuses any other host', () => {
    for (const host of ['db.internal', '127.0.0.1.example', '::1%lo', '', '0.0.0.0']) {
      assert.throws(() => assertLoopbackHost(host), {
        message: `refusing to run the integration script against ${host}. The host must be 127.0.0.1, localhost, or ::1.`,
      });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { assertSSHAuthorizationOutcome } from './integration/ssh-authorization-outcome.js';

describe('caeast1 SSH authorization outcome', () => {
  it('accepts an opened session without a banner (autoaccept)', () => {
    expect(() => assertSSHAuthorizationOutcome({ stage: 'session-opened', bannerSeen: false, hasLoginURL: false })).not.toThrow();
  });

  it('accepts a check-mode banner with a login URL', () => {
    expect(() => assertSSHAuthorizationOutcome({ stage: 'banner', bannerSeen: true, hasLoginURL: true })).not.toThrow();
  });

  it.each([
    [{ stage: 'timeout', bannerSeen: false, hasLoginURL: false }, 'timeout'],
    [{ stage: 'authentication-failed', bannerSeen: false, hasLoginURL: false }, 'authentication-rejected'],
    [{ stage: 'connection-failed', bannerSeen: false, hasLoginURL: false }, 'connection-failed'],
    [{ stage: 'banner', bannerSeen: true, hasLoginURL: false }, 'authorization-url-missing'],
    [{ stage: 'banner', bannerSeen: false, hasLoginURL: true }, 'authorization-banner-missing'],
  ] as const)('rejects unsuccessful SSH outcome with a safe category', (outcome, category) => {
    expect(() => assertSSHAuthorizationOutcome(outcome)).toThrow(`caeast1 SSH probe failed at second-auth (category: ${category})`);
  });
});

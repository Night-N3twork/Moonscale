import { describe, expect, it } from 'vitest';
import { closeTailnetClient, formatTailnetTimeoutStatus, redactTailnetError } from './integration/tailnet-browser.js';
import { vi } from 'vitest';

describe('redactTailnetError', () => {
  it('replaces raw errors with a generic failure', () => {
    const authKey = 'tskey-auth-secret-value';
    const error = new TypeError(`request failed for ${authKey}: ${authKey} ${'x'.repeat(2_000)}`);

    const sanitized = redactTailnetError(error, authKey);

    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toBe('tailnet browser integration failed');
    expect(sanitized.message).not.toContain(authKey);
    expect(sanitized.message).not.toContain('request failed');
  });
});

describe('formatTailnetTimeoutStatus', () => {
  it('includes only bounded lifecycle states, callback occurrence, and capped timings', () => {
    const authKey = 'tskey-auth-secret-value';
    const authURL = `https://login.example.test/a/123?key=${authKey}`;
    const netmapAddress = '100.64.0.10';
    const serializedError = JSON.stringify({ message: authURL, stack: netmapAddress });

    const status = formatTailnetTimeoutStatus({
      states: ['Starting', authKey, authURL, netmapAddress, serializedError, 'Running'],
      moduleLoaded: true,
      clientCreated: false,
      stateCallbackReceived: true,
      authURLReceived: true,
      netmapCallbackReceived: true,
      netmapReceived: true,
      heartbeat: {
        animationFrames: 3,
        timers: 4,
        maximumGapMS: 120_000,
      },
      netcheckRequests: {
        started: 5,
        completed: 4,
        failed: 1,
        successfulResponses: 3,
      },
      observedNetcheckRequests: {
        started: 5,
        failed: 1,
        successfulResponses: 3,
      },
      netcheckLogObserved: true,
      phaseTimingsMS: {
        moduleLoad: 123,
        clientCreate: 120_000,
        stateCallback: 456,
        netmapCallback: 789,
      },
    });

    expect(status).toBe('tailnet browser integration timed out: states=Starting,Running; moduleLoaded=true; clientCreated=false; stateCallbackReceived=true; authURLReceived=true; netmapCallbackReceived=true; netmapReceived=true; netcheckLogObserved=true; heartbeat=animationFrames:3,timers:4,maximumGapMS:60000; netcheckRequests=started:5,completed:4,failed:1,successfulResponses:3; observedNetcheckRequests=started:5,failed:1,successfulResponses:3; phaseTimingsMS=moduleLoad:123,clientCreate:60000,stateCallback:456,netmapCallback:789');
    expect(status.length).toBeLessThanOrEqual(1_000);
    expect(status).not.toContain(authKey);
    expect(status).not.toContain(authURL);
    expect(status).not.toContain(netmapAddress);
    expect(status).not.toContain(serializedError);
  });
});

describe('closeTailnetClient', () => {
  it('stops waiting when client cleanup exceeds its timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {}));

    const cleanup = closeTailnetClient({ close });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

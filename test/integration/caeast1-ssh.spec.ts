import { expect, test } from '@playwright/test';
import { assertSSHAuthorizationOutcome } from './ssh-authorization-outcome.js';

const enabled = process.env.TAILSCALE_INTEGRATION === '1'
  && Boolean(process.env.TAILSCALE_TEST_AUTH_KEY)
  && process.env.TAILSCALE_TEST_SSH_USER === 'root'
  && process.env.TAILSCALE_TEST_TCP_TARGET === 'caeast1';

// The credential-backed evaluate argument contains the auth key; never record this file's tests.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('loads the built LunaSSH module and WASM without credentials', async ({ page, baseURL }) => {
  test.setTimeout(25_000);
  await page.goto(baseURL!);
  const version = await page.evaluate(async (origin) => {
    const { SSHClient } = await import(`${origin}/lunassh/index.mjs`);
    await SSHClient.initialize({
      wasmPath: `${origin}/lunassh/lunassh.wasm`,
      wasmExecPath: `${origin}/lunassh/wasm_exec.js`,
    });
    return SSHClient.getVersion();
  }, baseURL!);
  expect(version).toBeTruthy();
});

test('probes caeast1 SSH host key and root authorization outcome', async ({ page, baseURL }) => {
  test.skip(!enabled, 'requires TAILSCALE_INTEGRATION=1, TAILSCALE_TEST_AUTH_KEY, TAILSCALE_TEST_SSH_USER=root and TAILSCALE_TEST_TCP_TARGET=caeast1');
  test.setTimeout(120_000);

  let pagePhase = 'page-load';
  let result: {
    ok: true;
    fingerprint: string;
    stage: 'banner' | 'authentication-failed' | 'timeout' | 'connection-failed' | 'session-opened';
    bannerSeen: boolean;
    hasLoginURL: boolean;
    bannerDescription: string;
    errorCategory: string;
  } | { ok: false; phase: string; errorCategory: string };
  try {
    await page.goto(baseURL!);
    pagePhase = 'page-evaluate';
    result = await page.evaluate(async ({ baseURL, authKey }) => {
      let phase = 'module-load';
      const classify = (error: unknown): string => {
        if (!(error instanceof Error) && typeof error !== 'string') return 'non-error';
        const message = error instanceof Error ? error.message : error;
        if (/netmap timeout/i.test(message)) return 'netmap-timeout';
        if (/host key was accepted without verification/i.test(message)) return 'host-key-accepted';
        if (/host key verification failed|unverified host key/i.test(message)) return 'host-key-rejected';
        if (/unable to authenticate|no supported methods remain/i.test(message)) return 'authentication-rejected';
        if (/abort|cancel/i.test(message)) return 'aborted';
        if (/timed? out|timeout|deadline exceeded/i.test(message)) return 'timeout';
        if (/failed to fetch|networkerror|404|loading module|importing a module/i.test(message)) return 'asset-load';
        if (/wasm|webassembly/i.test(message)) return 'wasm-init';
        if (/transport|connect|dial|socket/i.test(message)) return 'connection';
        return 'unknown';
      };
      let moonScale: typeof import('../../src/index.js');
      let lunaSSH: typeof import('../../../../LunaSSH/src/index.js');
      try {
        moonScale = await import(`${baseURL}/moonscale/index.js`);
        lunaSSH = await import(`${baseURL}/lunassh/index.mjs`);
      } catch (error) {
        return { ok: false as const, phase, errorCategory: classify(error) };
      }
      let client: Awaited<ReturnType<typeof moonScale.MoonScaleClient.create>> | undefined;
      let provider: InstanceType<typeof moonScale.MoonScaleTransportProvider> | undefined;
      let result: { ok: false; phase: string; errorCategory: string } | {
        ok: true; fingerprint: string; stage: 'banner' | 'authentication-failed' | 'timeout' | 'connection-failed' | 'session-opened';
        bannerSeen: boolean; hasLoginURL: boolean; bannerDescription: string; errorCategory: string;
      } | undefined;
      try {
        phase = 'moon-login';
        client = await moonScale.MoonScaleClient.create({ authKey, wasmURL: `${baseURL}/runtime/main.wasm` });
        client.login();
        phase = 'peer-netmap';
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { clearInterval(poll); reject(new Error('netmap timeout')); }, 60_000);
          const poll = setInterval(() => {
            if (client?.state === 'Running' && client.netMap?.peers.some((peer: { name: string }) => peer.name.replace(/\.$/, '').split('.')[0].toLowerCase() === 'caeast1')) {
              clearTimeout(timer);
              clearInterval(poll);
              resolve();
            }
          }, 100);
        });
        provider = new moonScale.MoonScaleTransportProvider(client);
        const host = 'caeast1';
        phase = 'lunassh-init';
        await lunaSSH.SSHClient.initialize({
          wasmPath: `${baseURL}/lunassh/lunassh.wasm`,
          wasmExecPath: `${baseURL}/lunassh/wasm_exec.js`,
        });

        phase = 'first-host-key';
        const first = new AbortController();
        const firstTimer = setTimeout(() => first.abort(), 15_000);
        let fingerprint: string;
        try {
          const session = await lunaSSH.SSHWispClient.connectViaProvider(
            { host, port: 22, user: 'root', timeout: 15 }, provider, undefined, { signal: first.signal },
          );
          void session.disconnect().catch(() => {});
          throw new Error('host key was accepted without verification');
        } catch (error) {
          const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
          const match = message.match(/unverified host key for caeast1:22: (SHA256:[A-Za-z0-9+/]{43})(?![A-Za-z0-9+/])/);
          if (!match) throw error;
          fingerprint = match[1];
        } finally {
          clearTimeout(firstTimer);
          first.abort();
        }

        phase = 'second-auth';
        const second = new AbortController();
        let errorCategory = 'none';
        let resolveBanner!: (value: { stage: 'banner'; bannerSeen: true; hasLoginURL: boolean; bannerDescription: string }) => void;
        const banner = new Promise<{ stage: 'banner'; bannerSeen: true; hasLoginURL: boolean; bannerDescription: string }>((resolve) => { resolveBanner = resolve; });
        const secondTimer = setTimeout(() => second.abort(), 15_000);
        try {
          const connection = lunaSSH.SSHWispClient.connectViaProvider(
            { host, port: 22, user: 'root', hostKeyFingerprint: fingerprint, timeout: 15 }, provider,
            { onAuthBanner: (message: string) => {
              resolveBanner({
                stage: 'banner',
                bannerSeen: true,
                hasLoginURL: (message.match(/https:\/\/[^\s<>]+/gi) ?? []).some((candidate) => {
                  try {
                    const url = new URL(candidate.replace(/[.,;!?)]*$/, ''));
                    return url.origin === 'https://login.tailscale.com' && !url.username && !url.password;
                  } catch {
                    return false;
                  }
                }),
                bannerDescription: 'SSH authentication banner received (contents withheld)',
              });
              second.abort();
            } },
            { signal: second.signal },
          ).then(async (session: { disconnect(): Promise<void> }) => {
            await session.disconnect();
            return 'session-opened' as const;
          }, (error: unknown) => {
            errorCategory = classify(error);
            if (errorCategory === 'authentication-rejected') return 'authentication-failed' as const;
            if (second.signal.aborted) return 'timeout' as const;
            return 'connection-failed' as const;
          });
          const outcome = await Promise.race([banner, connection]);
          result = {
            ok: true as const,
            fingerprint,
            stage: typeof outcome === 'string' ? outcome : outcome.stage,
            bannerSeen: typeof outcome === 'string' ? false : outcome.bannerSeen,
            hasLoginURL: typeof outcome === 'string' ? false : outcome.hasLoginURL,
            bannerDescription: typeof outcome === 'string' ? 'No authentication banner observed' : outcome.bannerDescription,
            errorCategory,
          };
        } finally {
          clearTimeout(secondTimer);
          second.abort();
        }
      } catch (error) {
        result = { ok: false, phase, errorCategory: classify(error) };
      } finally {
        try {
          await provider?.close();
        } catch (error) {
          if (!result || result.ok) result = { ok: false, phase: 'cleanup', errorCategory: classify(error) };
        } finally {
          if (client) {
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                client.close().catch(() => undefined),
                new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 5_000); }),
              ]);
            } finally {
              if (cleanupTimer) clearTimeout(cleanupTimer);
            }
          }
        }
      }
      return result!;
    }, { baseURL: baseURL!, authKey: process.env.TAILSCALE_TEST_AUTH_KEY! });
  } catch {
    throw new Error(`caeast1 SSH probe failed at ${pagePhase} (category: unavailable)`);
  }

  if (!result.ok) throw new Error(`caeast1 SSH probe failed at ${result.phase} (category: ${result.errorCategory})`);
  assertSSHAuthorizationOutcome(result);
  expect(result.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  console.log(`caeast1 SSH probe: host key ${result.fingerprint}; stage=${result.stage}; ${result.bannerDescription}; login.tailscale.com present=${result.hasLoginURL}`);
});

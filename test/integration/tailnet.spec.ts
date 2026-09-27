import { expect, test } from '@playwright/test';
import { listExitNodesAfterNeedsLogin, runTailnet } from './tailnet-browser.js';

const authKey = process.env.TAILSCALE_TEST_AUTH_KEY;
const exitNodeId = process.env.TAILSCALE_TEST_EXIT_NODE_ID;
const tcpTarget = process.env.TAILSCALE_TEST_TCP_TARGET;
const enabled = process.env.TAILSCALE_INTEGRATION === '1' && Boolean(authKey);

test('lists no exit nodes after the browser runtime reaches NeedsLogin', async ({ page, baseURL }) => {
  const status = await listExitNodesAfterNeedsLogin(page, baseURL!);

  expect(status.states).toContain('NeedsLogin');
  expect(status.exitNodeCount).toBe(0);
});

test('reports a tailnet address from the browser runtime', async ({ page, baseURL }) => {
  test.skip(!enabled, 'requires TAILSCALE_INTEGRATION=1 and TAILSCALE_TEST_AUTH_KEY');

  const status = await runTailnet(page, baseURL!, authKey!);

  expect(status.hasTailnetAddress).toBe(true);
});

test('selects the configured stable exit node', async ({ page, baseURL }) => {
  test.skip(!enabled || !exitNodeId, 'requires TAILSCALE_INTEGRATION=1, TAILSCALE_TEST_AUTH_KEY and TAILSCALE_TEST_EXIT_NODE_ID');

  const status = await runTailnet(page, baseURL!, authKey!, exitNodeId);

  expect(status.selectedExitNodeID).toBe(exitNodeId);
});

test('reads an SSH identification through the tailnet', async ({ page, baseURL }) => {
  test.skip(!enabled || !tcpTarget, 'requires TAILSCALE_INTEGRATION=1, TAILSCALE_TEST_AUTH_KEY and TAILSCALE_TEST_TCP_TARGET');

  await page.goto(baseURL!);
  const result = await page.evaluate(async ({ authKey, baseURL, target }) => {
    const moonScale = await import(`${baseURL}/moonscale/index.js`);
    let client: Awaited<ReturnType<typeof moonScale.MoonScaleClient.create>> | undefined;
    try {
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const timeout = setTimeout(() => rejectReady(new Error('tailnet did not reach a netmap')), 60_000);
      client = await moonScale.MoonScaleClient.create({
        authKey,
        wasmURL: `${baseURL}/runtime/main.wasm`,
        onNetMap: () => {
          clearTimeout(timeout);
          resolveReady();
        },
      });
      client.login();
      await ready;
      const address = await client.resolveDNS(target, 22);
      const socket = await client.dialTcp(address, 22);
      const banner = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSH identification timed out')), 10_000);
        socket.on('data', (data) => {
          clearTimeout(timeout);
          resolve(new TextDecoder().decode(data));
        });
        socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      socket.close();
      return { address, banner };
    } finally {
      await client?.close();
    }
  }, { authKey, baseURL: baseURL!, target: tcpTarget! });

  console.log(`SSH probe ${tcpTarget} resolved to ${result.address}: ${result.banner.trim()}`);
  expect(result.banner).toMatch(/^SSH-/);
});

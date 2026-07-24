import { expect, test } from '@playwright/test';
import { listExitNodesAfterNeedsLogin, runTailnet } from './tailnet-browser.js';

const authKey = process.env.TAILSCALE_TEST_AUTH_KEY;
const exitNodeId = process.env.TAILSCALE_TEST_EXIT_NODE_ID;
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
  test.skip(!exitNodeId, 'requires TAILSCALE_TEST_EXIT_NODE_ID');

  const status = await runTailnet(page, baseURL!, authKey!, exitNodeId);

  expect(status.selectedExitNodeID).toBe(exitNodeId);
});

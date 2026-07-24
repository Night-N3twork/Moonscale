import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import integrationConfig, { integrationAssets } from '../vite.integration.config.js';
import playwrightConfig from '../playwright.config.js';

describe('browser integration assets', () => {
  it('resolves MoonScale-local runtime assets without integration credentials', () => {
    expect(process.env.TAILSCALE_TEST_AUTH_KEY).toBeUndefined();
    expect(existsSync(integrationAssets.moonScaleDist)).toBe(true);
    expect(integrationAssets.runtimeDir).toBe(resolve('dist/runtime'));
    expect(existsSync(integrationAssets.runtimeJS)).toBe(true);
    expect(existsSync(integrationAssets.wasm)).toBe(true);
    expect(existsSync(resolve(integrationAssets.runtimeDir, 'wasm_exec.js'))).toBe(true);
  });

  it('packages the runtime without the external Tailscale Connect fork', () => {
    const packageJSON = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string> | string[]>;

    expect(packageJSON.files).toContain('dist');
    expect(packageJSON.peerDependencies).toBeUndefined();
    expect(packageJSON.devDependencies).not.toHaveProperty('@nightnetwork/tailscale-connect');
  });

  it('starts the Vite browser fixture server for Playwright', () => {
    expect(playwrightConfig.webServer).toMatchObject({
      command: 'npm run build && vite --config vite.integration.config.ts --host 127.0.0.1 --port 4173',
    });
    expect(playwrightConfig.use).toMatchObject({ baseURL: 'http://127.0.0.1:4173' });
  });

  it('does not attempt dependency discovery for the static fixture', () => {
    expect(integrationConfig.optimizeDeps).toMatchObject({ noDiscovery: true });
  });

  it('skips credential-backed browser checks when integration credentials are absent', () => {
    const integrationSpec = readFileSync('test/integration/tailnet.spec.ts', 'utf8');

    expect(integrationSpec).toContain("test.skip(!enabled, 'requires TAILSCALE_INTEGRATION=1 and TAILSCALE_TEST_AUTH_KEY')");
  });
});

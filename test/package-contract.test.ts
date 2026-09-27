import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('installs a clean packed build with usable exports, declarations, and one current WASM', async () => {
  const packageJSON = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  expect(packageJSON.scripts.prepack).toBe('npm run build');

  const directory = mkdtempSync(join(tmpdir(), 'moonscale-contract-'));
  const staleFile = join('dist', '__moonscale_stale_generated__.js');
  let poisoned = false;
  try {
    expect(existsSync(staleFile)).toBe(false);
    mkdirSync('dist', { recursive: true });
    writeFileSync(staleFile, '// stale generated output\n');
    poisoned = true;
    const { TAILSCALE_TEST_AUTH_KEY: _authKey, ...packEnv } = process.env;
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
      env: packEnv,
      timeout: 180_000,
    })) as Array<{ filename: string }>;
    const archive = join(directory, pack.filename);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');

    expect(entries).not.toContain('package/dist/__moonscale_stale_generated__.js');
    expect(existsSync(staleFile)).toBe(false);
    expect(entries.filter((entry) => entry.endsWith('.wasm'))).toEqual(['package/dist/runtime/main.wasm']);
    for (const entry of ['index.js', 'index.d.ts', 'transport-provider.js', 'transport-provider.d.ts', 'runtime/runtime.js', 'runtime/wasm_exec.js']) {
      expect(entries).toContain(`package/dist/${entry}`);
    }
    expect(entries.some((entry) => /(^|\/)\.env(?:\.|$)/i.test(entry))).toBe(false);

    execFileSync('tar', ['-xzf', archive, '-C', directory], { timeout: 30_000 });
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(digest(join(directory, 'package/dist/runtime/main.wasm'))).toBe(digest('dist/runtime/main.wasm'));
    expect(entries.some((entry) => {
      const content = readFileSync(join(directory, entry));
      return content.includes(Buffer.from('tskey-')) || content.includes(Buffer.from('TAILSCALE_TEST_AUTH_KEY='));
    })).toBe(false);

    const consumer = join(directory, 'consumer');
    execFileSync('npm', ['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', archive], {
      env: packEnv,
      timeout: 30_000,
    });
    const installed = join(consumer, 'node_modules/@nightnetwork/moonscale');
    expect(existsSync(join(installed, 'dist/runtime/main.wasm'))).toBe(true);
    expect(execFileSync('node', ['--input-type=module', '--eval',
      'import { MoonScaleClient, MoonScaleTransportProvider } from "@nightnetwork/moonscale"; if (typeof MoonScaleClient.create !== "function" || typeof MoonScaleTransportProvider !== "function") process.exit(1);',
    ], { cwd: consumer, encoding: 'utf8', timeout: 10_000 })).toBe('');

    const source = join(consumer, 'contract.mts');
    writeFileSync(source, 'import { MoonScaleClient, MoonScaleTransportProvider, type TransportProvider, type MoonScaleClientOptions } from "@nightnetwork/moonscale"; declare const client: MoonScaleClient; declare const options: MoonScaleClientOptions; const provider: TransportProvider = new MoonScaleTransportProvider(client); void options; void provider;\n');
    const options: ts.CompilerOptions = {
      noEmit: true, strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const errors = ts.getPreEmitDiagnostics(ts.createProgram([source], options));
    expect(errors.map((error) => error.code)).toEqual([]);

    const probe = join(installed, 'dist/__packed_consumer_probe__.txt');
    writeFileSync(probe, 'packed consumer');
    const previousRoot = process.env.MOONSCALE_INSTALLED_PACKAGE_ROOT;
    process.env.MOONSCALE_INSTALLED_PACKAGE_ROOT = installed;
    try {
      const server = await createServer({ configFile: 'vite.integration.config.ts', server: { host: '127.0.0.1', port: 0 } });
      try {
        await server.listen();
        const baseURL = server.resolvedUrls!.local[0].replace(/\/$/, '');
        expect(await (await fetch(`${baseURL}/moonscale/__packed_consumer_probe__.txt`)).text()).toBe('packed consumer');
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(baseURL);
          const status = await page.evaluate(async (origin) => {
            // Keep the browser import out of Vitest's server-side import transform.
            const { MoonScaleClient } = await new Function('url', 'return import(url)')(`${origin}/moonscale/index.js`) as typeof import('../src/index.js');
            const states: string[] = [];
            const client = await MoonScaleClient.create({ wasmURL: `${origin}/runtime/main.wasm`, onState: (state) => states.push(state) });
            try {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('packed runtime did not reach NeedsLogin')), 15_000);
                const check = () => {
                  if (states.includes('NeedsLogin')) { clearTimeout(timeout); resolve(); }
                  else setTimeout(check, 20);
                };
                check();
              });
              return { states, exitNodeCount: client.listExitNodes().length };
            } finally {
              await client.close();
            }
          }, baseURL);
          expect(status.states).toContain('NeedsLogin');
          expect(status.exitNodeCount).toBe(0);
        } finally {
          await browser.close();
        }
      } finally {
        await server.close();
      }
    } finally {
      if (previousRoot === undefined) delete process.env.MOONSCALE_INSTALLED_PACKAGE_ROOT;
      else process.env.MOONSCALE_INSTALLED_PACKAGE_ROOT = previousRoot;
    }
  } finally {
    if (poisoned) rmSync(staleFile, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

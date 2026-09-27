import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { defineConfig } from 'vite';

const moonScaleDist = resolve(process.env.MOONSCALE_INSTALLED_PACKAGE_ROOT ?? '.', 'dist');
const runtimeDir = resolve(moonScaleDist, 'runtime');

export const integrationAssets = {
  moonScaleDist,
  lunaSSHDir: resolve('../LunaSSH/dist'),
  runtimeDir,
  runtimeJS: resolve(runtimeDir, 'runtime.js'),
  wasm: resolve(runtimeDir, 'main.wasm'),
};

function contentType(file: string): string {
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript';
  if (file.endsWith('.map')) return 'application/json';
  return 'application/octet-stream';
}

function setWorkerIsolationHeaders(response: { setHeader(name: string, value: string): void }): void {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
}

function staticFiles(root: string) {
  return async (request: { url?: string }, response: { setHeader(name: string, value: string): void; end(data?: Uint8Array): void }, next: () => void) => {
    setWorkerIsolationHeaders(response);
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = resolve(root, `.${pathname}`);
    if (relative(root, file).startsWith('..')) return next();
    try {
      if (!(await stat(file)).isFile()) return next();
      response.setHeader('Content-Type', contentType(file));
      response.end(await readFile(file));
    } catch {
      next();
    }
  };
}

export default defineConfig({
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  plugins: [{
    name: 'moonscale-integration-assets',
    configureServer(server) {
      server.middlewares.use('/moonscale', staticFiles(integrationAssets.moonScaleDist));
      server.middlewares.use('/lunassh', staticFiles(integrationAssets.lunaSSHDir));
      server.middlewares.use('/runtime', staticFiles(integrationAssets.runtimeDir));
      server.middlewares.use((_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(new TextEncoder().encode('<!doctype html><title>MoonScale integration</title>'));
      });
    },
  }],
});

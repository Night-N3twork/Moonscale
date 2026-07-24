import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const runtime = new URL('../runtime/', import.meta.url);
const output = new URL('../dist/runtime/', import.meta.url);
const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
const wasmExec = join(goRoot, 'lib', 'wasm', 'wasm_exec.js');

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', new URL('main.wasm', output).pathname, './wasm'], {
  cwd: runtime.pathname,
  env: { ...process.env, GOARCH: 'wasm', GOOS: 'js' },
  stdio: 'inherit',
});
await Promise.all([
  copyFile(new URL('runtime.js', runtime), new URL('runtime.js', output)),
  copyFile(wasmExec, new URL('wasm_exec.js', output)),
]);

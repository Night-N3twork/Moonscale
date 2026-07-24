import { describe, expect, it } from 'vitest';
import { createRuntimeBridge, validateRuntimeModule } from '../src/runtime.js';

describe('runtime module validation', () => {
  it('rejects dynamically loaded modules without createIPN', async () => {
    await expect(createRuntimeBridge({ panicHandler: () => {} }, async () => ({}))).rejects.toThrow(
      '@nightnetwork/moonscale/runtime does not export createIPN',
    );
  });

  it('rejects createIPN results without the complete callback bridge', async () => {
    const runtime = validateRuntimeModule({ createIPN: async () => ({}) });

    await expect(runtime.createIPN({ panicHandler: () => {} })).rejects.toThrow(
      '@nightnetwork/moonscale/runtime returned an invalid IPN bridge',
    );
  });

  it('requires exit-node controls on the runtime bridge', async () => {
    const runtime = validateRuntimeModule({
      createIPN: async () => ({ run() {}, login() {}, logout() {}, dialTcp() {}, dialUdp() {}, listenTcp() {}, listenUdp() {} }),
    });

    await expect(runtime.createIPN({ panicHandler: () => {} })).rejects.toThrow(
      '@nightnetwork/moonscale/runtime returned an invalid IPN bridge',
    );
  });

  it('rejects the browser bridge in Node before loading browser assets', async () => {
    await expect(createRuntimeBridge({ panicHandler: () => {} })).rejects.toThrow(
      '@nightnetwork/moonscale runtime requires a browser with WebAssembly and fetch support',
    );
  });
});

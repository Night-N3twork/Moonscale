// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

import './wasm_exec.js';

const wasmURL = new URL('./main.wasm', import.meta.url);

export async function createIPN(config) {
  const go = new Go();
  const wasmInstance = await WebAssembly.instantiateStreaming(fetch(config.wasmURL ?? wasmURL), go.importObject);
  go.run(wasmInstance.instance).then(() => config.panicHandler('Unexpected shutdown'));
  return newIPN(config);
}

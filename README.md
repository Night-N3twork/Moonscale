# @nightnetwork/moonscale

MoonScale is a TypeScript ESM Tailscale client built from Tailscale Connect.
It is not an alternative to Tailscale: it needs a Tailscale tailnet to connect
to one. Its browser-only Go/WASM runtime is bundled with this package.

## Install

```sh
npm install @nightnetwork/moonscale
```

## Use

```ts
import { MoonScaleClient } from '@nightnetwork/moonscale';

const client = await MoonScaleClient.create({
  onAuthURL: (url) => console.log(`Open this URL to authenticate: ${url}`),
});

client.login();
const socket = await client.dialTcp('100.64.0.10', 443);
```

Authorization URLs are reported to `onAuthURL`; MoonScale never opens them.
The supplied auth key is passed to Tailscale Connect during initialization and
is not retained by the client. `stateStorage` is passed directly to the runtime
for persistent node state. TCP and UDP callback APIs are exposed as promise
based socket adapters, and `close()` releases pending dials, listeners, and
active sockets.

## Local Tailnet Validation

The real-tailnet tests run in Chromium through Playwright and are skipped unless
`TAILSCALE_INTEGRATION=1` and `TAILSCALE_TEST_AUTH_KEY` are set. They
authenticate a disposable device and assert that MoonScale reports a tailnet
address. Install Chromium once for local runs with `npx playwright install
chromium`:

```sh
TAILSCALE_INTEGRATION=1 TAILSCALE_TEST_AUTH_KEY=tskey-auth-... npm run test:integration
```

Set `TAILSCALE_TEST_EXIT_NODE_ID` as well to run the separate exit-node test.
It verifies only that exact eligible node and clears the selection during
cleanup. Never put either value in a file or npm package.

For a local package check, build and pack MoonScale, then install it alongside
Moonbeam 1.1.0 in the demo:

```sh
mkdir -p /tmp/nightnetwork-pack
npm run build && npm pack --pack-destination /tmp/nightnetwork-pack
(cd ../MoonBeam/.worktrees/tailscale-integration && npm run build && npm pack --pack-destination /tmp/nightnetwork-pack)
(cd ../night-network-demo && npm install --no-save /tmp/nightnetwork-pack/*.tgz)
```

`npm run test:packages` from the demo performs the corresponding packed-import
check and rejects archives containing `.env` files or Tailscale test-variable
names.

## License and Attribution

MoonScale is licensed under the BSD 3-Clause License. It includes Tailscale
Connect browser-runtime source, whose redistribution includes BSD attribution.
See `NOTICE` and `runtime/` for the preserved notices and module metadata.

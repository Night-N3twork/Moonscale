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

## Exit Node Support

List, select, and clear exit nodes. Once an exit node is set, all outbound
traffic through the Tailscale dialer routes through that node:

```ts
const exitNodes = client.listExitNodes();
await client.setExitNode(exitNodes[0].id, { allowLANAccess: false });
await client.clearExitNode();
```

Exit nodes set through the dialer apply to `dialTcp`, `dialUdp`, and `fetch`.

## HTTP Client (fetch)

MoonScale exposes an HTTP client that routes through the Tailscale dialer
(respecting exit nodes). TLS verification is disabled for WASM compatibility:

```ts
const resp = await client.fetch('https://myip.wtf');
const body = await resp.text();
console.log(resp.status, body);
```

This creates an `http.Client` over `dialer.UserDial` with
`TLSClientConfig.InsecureSkipVerify: true` — the same TLS policy used by
`createTailscaleWebSocket`. The response exposes `status`, `statusText`, and
`text()` (returns the body as a string).

## API

| Method | Returns | Description |
|---|---|---|
| `create(options)` | `Promise<MoonScaleClient>` | Async factory. Connects to Tailscale control. |
| `login()` | `void` | Start interactive login. |
| `logout()` | `void` | Log out and clear credentials. |
| `dialTcp(host, port)` | `Promise<MoonScaleTcpSocket>` | TCP connection over the tailnet (exit-node-aware). |
| `dialUdp(host, port)` | `Promise<MoonScaleUdpSocket>` | UDP socket over the tailnet (exit-node-aware). |
| `listenTcp(host, port, handler)` | `Promise<MoonScaleTcpListener>` | Listen for TCP connections on the tailnet. |
| `listenUdp(host, port, handler)` | `Promise<MoonScaleUdpListener>` | Listen for UDP packets on the tailnet. |
| `fetch(url)` | `Promise<{status,statusText,text()}>` | HTTP client over the Tailscale dialer. |
| `listExitNodes()` | `readonly MoonScaleExitNode[]` | List eligible exit nodes from the netmap. |
| `setExitNode(id, options?)` | `Promise<void>` | Route outbound traffic through an exit node. |
| `clearExitNode()` | `Promise<void>` | Clear exit node selection. |
| `get exitNode()` | `MoonScaleExitNodeSelection \| null` | Current exit node selection (read-only). |
| `createTailscaleWebSocket(url)` | `unknown` | WebSocket through Tailscale netstack (used for Wisp under Tailscale). |
| `setFunnel(port, target)` | `Promise<void>` | Expose a port to the internet via Tailscale Funnel (443/8443) or register a netstack listener (other ports). Target format `host:port`. |
| `clearFunnel()` | `Promise<void>` | Disable all funnel/serve configs and close netstack listeners. |
| `resolveDNS(host, port)` | `Promise<string>` | Resolve a hostname via the Tailscale dialer (handles MagicDNS). |
| `close()` | `Promise<void>` | Close all sockets, listeners, and dials. |

## TLS

The WASM runtime has no OS root certificate store. Both `fetch()` and
`createTailscaleWebSocket()` use `InsecureSkipVerify: true`. This
is acceptable when traffic already routes through an encrypted WireGuard
tunnel (Tailscale), but means certificate validation is not performed
for non-Tailscale destinations reached via the exit node.

## Funnel & Port Forwarding

Tailscale Funnel exposes a port to the internet. MoonScale supports both Funnel (ports 443/8443) and plain serve (any port) via netstack TCP listeners that pipe to the bridge:

```ts
// Expose port 80 via netstack listener → forwards to bridge at 100.x.x.x:8080
await client.setFunnel(80, '127.0.0.1:8080');

// Expose port 443 via Tailscale Funnel → TCP forward to bridge
await client.setFunnel(443, '127.0.0.1:8080');

// Disable all
await client.clearFunnel();
```

For non-Funnel ports (e.g. 80), MoonScale registers a direct netstack TCP listener. Incoming connections are piped through `dialer.UserDial` (via netstack) to the target, avoiding Tailscale's serve proxy `SystemDial` which cannot reach netstack listeners.

For Funnel ports (443/8443), the standard Tailscale serve config with `AllowFunnel` and `TCPForward` is used. TLS is terminated at the Funnel edge so the backend receives plain TCP.

### Bridge Pattern

A common pattern is combining `listenTcp` with a MoonBeam relay client to bridge Tailscale traffic to in-browser services:

```
Tailscale peer ──→ netstack ──→ listenTcp(0.0.0.0:8080)
    │
    ├── MoonBeam relay (Wisp CONNECT to dusk.local:8080)
    │   └── MoonBeam local listener → Dusk HTTP server
    │
    └── direct dialer (dialTcp to 100.x.x.x:8080)
        └── bypasses MoonBeam, routes through Tailscale dialer
```

The bridge dynamically discovers the target host:port from `MoonbeamRelay.listenersSnapshot()`, so no IPs or hostnames are hardcoded.

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

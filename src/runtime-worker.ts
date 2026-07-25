import type {
  MoonScaleConnectionCallbacks,
  MoonScaleListenerCallbacks,
  MoonScaleUdpListenerCallbacks,
  RuntimeBridge,
  RuntimeCallbacks,
  RuntimeConfig,
  RuntimeConnection,
  RuntimeUdpConnection,
} from './types.js';

type Request =
  | { type: 'start'; config: Omit<RuntimeConfig, 'stateStorage' | 'panicHandler'> & { hasStateStorage: boolean } }
  | { type: 'request'; id: number; method: string; args: unknown[]; socketId?: number; listenerId?: number; data?: ArrayBuffer }
  | { type: 'storage-response'; id: number; value?: string }
  | { type: 'close' };

type StorageWaiter = { value?: string; resolve(): void };

let bridge: RuntimeBridge | undefined;
let closed = false;
let nextSocketID = 1;
let nextListenerID = 1;
let nextStorageID = 1;
const sockets = new Map<number, RuntimeConnection>();
const listeners = new Map<number, { close(): void }>();
const storageWaiters = new Map<number, StorageWaiter>();

function post(message: unknown, transfer?: Transferable[]): void {
  if (closed) return;
  const worker = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };
  if (transfer) worker.postMessage(message, transfer);
  else worker.postMessage(message);
}

function respond(id: number, value?: unknown): void {
  post({ type: 'response', id, value });
}

function fail(id: number): void {
  post({ type: 'response', id, error: 'MoonScale worker request failed' });
}

function snapshotExitNodes(): void {
  if (!bridge) return;
  post({ type: 'event', event: 'exit-nodes', value: bridge.listExitNodes().map((node) => ({ ...node, addresses: node.addresses.slice() })) });
  post({ type: 'event', event: 'exit-node', value: bridge.exitNode() });
}

function stateStorage(): RuntimeConfig['stateStorage'] {
  return {
    getState(key) {
      if (typeof SharedArrayBuffer === 'undefined') throw new Error('MoonScale worker state storage requires SharedArrayBuffer');
      const id = nextStorageID++;
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const waiter: StorageWaiter = { resolve: () => Atomics.store(signal, 0, 1) };
      storageWaiters.set(id, waiter);
      post({ type: 'storage-get', id, key });
      Atomics.wait(signal, 0, 0);
      storageWaiters.delete(id);
      return waiter.value ?? '';
    },
    setState(key, value) {
      if (typeof SharedArrayBuffer === 'undefined') throw new Error('MoonScale worker state storage requires SharedArrayBuffer');
      const id = nextStorageID++;
      const signal = new Int32Array(new SharedArrayBuffer(4));
      storageWaiters.set(id, { resolve: () => Atomics.store(signal, 0, 1) });
      post({ type: 'storage-set', id, key, value });
      Atomics.wait(signal, 0, 0);
      storageWaiters.delete(id);
    },
  };
}

function runtimeCallbacks(): RuntimeCallbacks {
  return {
    notifyState: (state) => post({ type: 'event', event: 'state', value: state }),
    notifyNetMap: (netmap) => {
      snapshotExitNodes();
      post({ type: 'event', event: 'netmap', value: netmap });
    },
    notifyBrowseToURL: (url) => post({ type: 'event', event: 'auth-url', value: url }),
    notifyPanicRecover: () => post({ type: 'event', event: 'panic', value: 'MoonScale runtime stopped unexpectedly' }),
    notifyRunning: () => post({ type: 'event', event: 'running' }),
  };
}

function connectionCallbacks(requestId: number, socketId: number, udp: boolean): MoonScaleConnectionCallbacks {
  return {
    onOpen(connection) {
      sockets.set(socketId, connection);
      post({ type: 'event', event: 'connection-open', requestId, socketId, udp });
    },
    onData(data) {
      const buffer = data.slice().buffer;
      post({ type: 'event', event: 'socket-data', socketId, data: buffer }, [buffer]);
    },
    onClose(message) {
      sockets.delete(socketId);
      post({ type: 'event', event: 'socket-close', socketId, message });
    },
    onError(message) {
      post({ type: 'event', event: 'socket-error', socketId, message });
    },
  };
}

async function start(config: Omit<RuntimeConfig, 'stateStorage' | 'panicHandler'> & { hasStateStorage: boolean }): Promise<void> {
  const runtime = await import(new URL('./runtime/runtime.js', import.meta.url).href);
  const wasmURL = config.wasmURL ?? new URL('./runtime/main.wasm', import.meta.url).href;
  const runtimeConfig: RuntimeConfig = {
    authKey: config.authKey,
    hostname: config.hostname,
    controlURL: config.controlURL,
    wasmURL,
    panicHandler: () => post({ type: 'event', event: 'panic', value: 'MoonScale runtime stopped unexpectedly' }),
  };
  if (config.hasStateStorage) runtimeConfig.stateStorage = stateStorage();
  const nextBridge = await runtime.createIPN(runtimeConfig);
  if (closed) {
    nextBridge.close?.();
    return;
  }
  bridge = nextBridge;
  nextBridge.run(runtimeCallbacks());
  snapshotExitNodes();
  post({ type: 'ready' });
}

function dial(id: number, udp: boolean, host: string, port: number): void {
  if (!bridge) return fail(id);
  const socketId = nextSocketID++;
  const callbacks = connectionCallbacks(id, socketId, udp);
  if (udp) bridge.dialUdp(host, port, callbacks);
  else bridge.dialTcp(host, port, callbacks);
}

function listen(id: number, udp: boolean, host: string, port: number): void {
  if (!bridge) return fail(id);
  const listenerId = nextListenerID++;
  if (udp) {
    const callbacks: MoonScaleUdpListenerCallbacks = {
      onListening(listener) {
        listeners.set(listenerId, listener);
        post({ type: 'event', event: 'listener-open', requestId: id, listenerId, udp: true });
      },
      onMessage(data, peer, socket) {
        const buffer = data.slice().buffer;
        post({ type: 'event', event: 'listener-message', listenerId, peer, data: buffer }, [buffer]);
        socket.close();
      },
      onError(message) { post({ type: 'event', event: 'socket-error', socketId: listenerId, message }); },
      onClose(message) { listeners.delete(listenerId); post({ type: 'event', event: 'socket-close', socketId: listenerId, message }); },
    };
    bridge.listenUdp(host, port, callbacks);
    return;
  }
  const callbacks: MoonScaleListenerCallbacks = {
    onListening(listener) {
      listeners.set(listenerId, listener);
      post({ type: 'event', event: 'listener-open', requestId: id, listenerId });
    },
    onConnection(connection, peer) {
      const socketId = nextSocketID++;
      sockets.set(socketId, connection);
      connection.setCallbacks(connectionCallbacks(-1, socketId, false));
      post({ type: 'event', event: 'listener-connection', listenerId, socketId, peer });
    },
    onError(message) { post({ type: 'event', event: 'socket-error', socketId: listenerId, message }); },
    onClose(message) { listeners.delete(listenerId); post({ type: 'event', event: 'socket-close', socketId: listenerId, message }); },
  };
  bridge.listenTcp(host, port, callbacks);
}

function shutdown(): void {
  if (closed) return;
  closed = true;
  for (const socket of sockets.values()) socket.close();
  for (const listener of listeners.values()) listener.close();
  sockets.clear();
  listeners.clear();
  bridge?.close?.();
  bridge = undefined;
  self.close();
}

self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  if (message.type === 'storage-response') {
    const waiter = storageWaiters.get(message.id);
    if (waiter) {
      waiter.value = message.value;
      waiter.resolve();
    }
    return;
  }
  if (message.type === 'close') {
    shutdown();
    return;
  }
  if (closed) return;
  if (message.type === 'start') {
    void start(message.config).catch(() => post({ type: 'error', message: 'MoonScale worker runtime failed to start' }));
    return;
  }
  if (!bridge) return fail(message.id);
  try {
    switch (message.method) {
      case 'login': bridge.login(); respond(message.id); break;
      case 'logout': bridge.logout(); respond(message.id); break;
      case 'setExitNode': void bridge.setExitNode(message.args[0] as string, message.args[1] as { allowLANAccess?: boolean } | undefined).then(() => { snapshotExitNodes(); respond(message.id); }, (err) => { console.error('[worker] setExitNode failed:', err); post({ type: 'response', id: message.id, error: String(err) }); }); break;
      case 'clearExitNode': void bridge.clearExitNode().then(() => { snapshotExitNodes(); respond(message.id); }, (err) => { console.error('[worker] clearExitNode failed:', err); post({ type: 'response', id: message.id, error: String(err) }); }); break;
      case 'setFunnel': void bridge.setFunnel(message.args[0] as number, message.args[1] as string).then(() => respond(message.id), (err) => { post({ type: 'response', id: message.id, error: String(err) }); }); break;
      case 'clearFunnel': void bridge.clearFunnel().then(() => respond(message.id), (err) => { post({ type: 'response', id: message.id, error: String(err) }); }); break;
      case 'resolveDNS': void bridge.resolveDNS(message.args[0] as string, message.args[1] as number).then((ip) => respond(message.id, ip), (err) => { post({ type: 'response', id: message.id, error: String(err) }); }); break;
      case 'fetch': {
        const url = message.args[0] as string;
        bridge.fetch(url).then((result: any) => {
          if (!result) { fail(message.id); return; }
          result.text().then((body: string) => {
            respond(message.id, { status: result.status, statusText: result.statusText, body });
          }).catch((err: any) => { post({ type: 'response', id: message.id, error: String(err) }); });
        }).catch((err: any) => { post({ type: 'response', id: message.id, error: String(err) }); });
        break;
      }
      case 'dialTcp': dial(message.id, false, message.args[0] as string, message.args[1] as number); break;
      case 'dialUdp': dial(message.id, true, message.args[0] as string, message.args[1] as number); break;
      case 'listenTcp': listen(message.id, false, message.args[0] as string, message.args[1] as number); break;
      case 'listenUdp': listen(message.id, true, message.args[0] as string, message.args[1] as number); break;
      case 'socketWrite': sockets.get(message.socketId!)?.write(new Uint8Array(message.data!)); respond(message.id); break;
      case 'socketSendTo': (sockets.get(message.socketId!) as RuntimeUdpConnection | undefined)?.sendTo(new Uint8Array(message.data!), message.args[0] as string, message.args[1] as number); respond(message.id); break;
      case 'socketClose': sockets.get(message.socketId!)?.close(); sockets.delete(message.socketId!); respond(message.id); break;
      case 'listenerClose': listeners.get(message.listenerId!)?.close(); listeners.delete(message.listenerId!); respond(message.id); break;
      case 'cancel': respond(message.id); break;
      case 'createTailscaleWebSocket': {
        const url = message.args[0] as string;
        const resolvedIP = message.args[1] as string | undefined;
        try {
          const ws = bridge.createTailscaleWebSocket(url, resolvedIP ?? '') as any;
          const wsId = nextStorageID++;
          (globalThis as any).__tsws ??= new Map();
          (globalThis as any).__tsws.set(wsId, ws);
          ws.addEventListener('open', () => {
            respond(message.id, wsId);
          });
          ws.addEventListener('error', () => {
            console.error('[worker] tswebsocket error for', url);
            fail(message.id);
            (globalThis as any).__tsws?.delete(wsId);
          });
          ws.addEventListener('message', (ev: any) => {
            post({ type: 'event', event: 'tsws-data', id: wsId, data: (ev.data as Uint8Array).buffer as ArrayBuffer }, [(ev.data as Uint8Array).buffer as ArrayBuffer]);
          });
          ws.addEventListener('close', () => {
            post({ type: 'event', event: 'tsws-close', id: wsId });
            (globalThis as any).__tsws?.delete(wsId);
          });
        } catch (err: any) {
          console.error('[worker] createTailscaleWebSocket exception:', err);
          fail(message.id);
        }
        break;
      }
      case 'tailscaleWsSend': {
        const wsId = message.args[0] as number;
        const ws: any = (globalThis as any).__tsws?.get(wsId);
        if (ws) ws.send(new Uint8Array(message.data!));
        respond(message.id);
        break;
      }
      case 'tailscaleWsClose': {
        const wsId = message.args[0] as number;
        const ws: any = (globalThis as any).__tsws?.get(wsId);
        if (ws) ws.close();
        (globalThis as any).__tsws?.delete(wsId);
        respond(message.id);
        break;
      }
      default: fail(message.id);
    }
  } catch {
    fail(message.id);
  }
};

import { createRuntimeBridge } from './runtime.js';
import { createWorkerRuntimeBridge } from './worker-runtime.js';
import type {
  MoonScaleClientOptions,
  MoonScaleConnectionCallbacks,
  MoonScaleExitNode,
  MoonScaleExitNodeOptions,
  MoonScaleExitNodeSelection,
  MoonScaleNetMap,
  MoonScaleState,
  MoonScaleTcpListener,
  MoonScaleTcpPeer,
  MoonScaleTcpSocket,
  MoonScaleUdpListener,
  MoonScaleUdpSocket,
  RuntimeBridge,
  RuntimeConnection,
  RuntimeModuleLoader,
  RuntimeUdpConnection,
} from './types.js';

type SocketEvent = 'data' | 'close' | 'error';
type SocketListener = (...args: never[]) => void;

class SocketAdapter implements MoonScaleTcpSocket {
  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  protected closed = false;

  constructor(protected readonly connection: RuntimeConnection, private readonly onClosed: () => void) {}

  send(data: Uint8Array): void {
    if (!this.closed) this.connection.write(data.slice());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.close();
    } finally {
      this.complete();
    }
  }

  on(event: SocketEvent, listener: SocketListener): () => void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  callbacks(): MoonScaleConnectionCallbacks {
    return {
      onOpen: () => {},
      onData: (data) => this.emit('data', data.slice()),
      onClose: (message) => this.finish(message),
      onError: (message) => {
        this.emit('error', new Error(message));
        this.finish(message);
      },
    };
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  }

  private finish(message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.complete(message);
  }

  private complete(message?: string): void {
    try {
      this.emit('close', message);
    } finally {
      try {
        this.listeners.clear();
      } finally {
        this.onClosed();
      }
    }
  }
}

class UdpSocketAdapter extends SocketAdapter implements MoonScaleUdpSocket {
  declare protected readonly connection: RuntimeUdpConnection;

  sendTo(data: Uint8Array, host: string, port: number): void {
    if (!this.closed) this.connection.sendTo(data.slice(), host, port);
  }
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

export class MoonScaleClient {
  private readonly sockets = new Set<SocketAdapter>();
  private readonly pendingDials = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private _state: MoonScaleState = 'NoState';
  private _netmap: MoonScaleNetMap | null = null;
  private closed = false;

  private constructor(private readonly bridge: RuntimeBridge, private readonly options: Omit<MoonScaleClientOptions, 'authKey'>) {}

  static async create(options: MoonScaleClientOptions = {}, runtimeLoader?: RuntimeModuleLoader): Promise<MoonScaleClient> {
    const { authKey, hostname, controlURL, stateStorage, wasmURL, onAuthURL, onState, onNetMap, onError } = options;
    const config = { authKey, hostname, controlURL, stateStorage, wasmURL, panicHandler: (message: string) => onError?.(new Error(message)) };
    const bridge = runtimeLoader ? await createRuntimeBridge(config, runtimeLoader) : await createWorkerRuntimeBridge(config);
    const client = new MoonScaleClient(bridge, { hostname, controlURL, stateStorage, wasmURL, onAuthURL, onState, onNetMap, onError });
    bridge.run({
      notifyState: (state) => client.setState(state),
      notifyNetMap: (netmap) => client.setNetmap(netmap),
      notifyBrowseToURL: (url) => client.options.onAuthURL?.(url),
      notifyPanicRecover: (message) => client.emitError(new Error(message)),
      notifyRunning: () => client.options.onState?.('Running'),
    });
    return client;
  }

  get state(): MoonScaleState { return this._state; }
  get netMap(): MoonScaleNetMap | null { return this._netmap; }
  /** @deprecated Use netMap. */
  get netmap(): MoonScaleNetMap | null { return this.netMap; }
  get addresses(): readonly string[] { return this._netmap?.self.addresses.slice() ?? []; }

  login(): void { if (!this.closed) this.bridge.login(); }
  logout(): void { if (!this.closed) this.bridge.logout(); }
  listExitNodes(): readonly MoonScaleExitNode[] {
    return freezeSnapshot(this.bridge.listExitNodes().map((node) => ({ ...node, addresses: node.addresses.slice() })));
  }
  get exitNode(): MoonScaleExitNodeSelection | null {
    const selection = this.bridge.exitNode();
    if (!selection.id) return null;
    const node = this.bridge.listExitNodes().find((candidate) => candidate.id === selection.id);
    if (!node) return null;
    return freezeSnapshot({ ...node, addresses: node.addresses.slice(), routeAll: selection.routeAll, allowLANAccess: selection.allowLANAccess });
  }
  setExitNode(id: string, options?: MoonScaleExitNodeOptions): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MoonScale client is closed'));
    return this.bridge.setExitNode(id, options);
  }
  clearExitNode(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MoonScale client is closed'));
    return this.bridge.clearExitNode();
  }

  dialTcp(host: string, port: number): Promise<MoonScaleTcpSocket> {
    return this.dial((callbacks) => this.bridge.dialTcp(host, port, callbacks));
  }

  dialUdp(host: string, port: number): Promise<MoonScaleUdpSocket> {
    return this.dial((callbacks) => this.bridge.dialUdp(host, port, callbacks), true) as Promise<MoonScaleUdpSocket>;
  }

  listenTcp(host: string, port: number, handler: (socket: MoonScaleTcpSocket, peer: MoonScaleTcpPeer) => void): Promise<MoonScaleTcpListener> {
    if (this.closed) return Promise.reject(new Error('MoonScale client is closed'));
    return new Promise((resolve, reject) => {
      let closed = false;
      let pendingHandle: { close(): void } | undefined;
      let listener: { close(): void } | undefined;
      let settled = false;
      const accepted = new Set<SocketAdapter>();
      const close = () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(close);
        pendingHandle?.close();
        listener?.close();
        for (const socket of accepted) socket.close();
      };
      pendingHandle = this.bridge.listenTcp(host, port, {
        onListening: (next) => {
          if (settled) { next.close(); return; }
          settled = true;
          listener = next;
          pendingHandle = undefined;
          if (this.closed) { close(); reject(new Error('MoonScale client is closed')); return; }
          this.listeners.add(close);
          resolve({ close });
        },
        onConnection: (connection, peer) => {
          if (closed || this.closed) { connection.close(); return; }
          let socket: SocketAdapter;
          socket = new SocketAdapter(connection, () => { accepted.delete(socket); this.sockets.delete(socket); });
          accepted.add(socket);
          this.sockets.add(socket);
          connection.setCallbacks(socket.callbacks());
          try { handler(socket, { ...peer }); } catch { socket.close(); }
        },
        onError: (message) => {
          if (!settled) { settled = true; close(); reject(new Error(message)); return; }
          this.emitError(new Error(message));
          close();
        },
        onClose: (message) => {
          if (!settled) { settled = true; close(); reject(new Error(message ?? 'MoonScale TCP listener closed')); return; }
          close();
        },
      });
      if (settled) {
        pendingHandle.close();
        pendingHandle = undefined;
      }
    });
  }

  listenUdp(host: string, port: number, handler: (data: Uint8Array, peer: MoonScaleTcpPeer) => void): Promise<MoonScaleUdpListener> {
    if (this.closed) return Promise.reject(new Error('MoonScale client is closed'));
    return new Promise((resolve, reject) => {
      let closed = false;
      let settled = false;
      let pendingHandle: { close(): void } | undefined;
      let listener: { close(): void } | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(close);
        pendingHandle?.close();
        listener?.close();
      };
      pendingHandle = this.bridge.listenUdp(host, port, {
        onListening: (next) => {
          if (settled) { next.close(); return; }
          settled = true;
          listener = next;
          pendingHandle = undefined;
          if (this.closed) { close(); reject(new Error('MoonScale client is closed')); return; }
          this.listeners.add(close);
          resolve({ close });
        },
        onMessage: (data, peer, _socket) => {
          if (closed || this.closed) return;
          try { handler(data.slice(), { ...peer }); } catch (error) { this.emitError(error instanceof Error ? error : new Error(String(error))); }
        },
        onError: (message) => {
          if (!settled) { settled = true; close(); reject(new Error(message)); return; }
          this.emitError(new Error(message));
          close();
        },
        onClose: (message) => {
          if (!settled) { settled = true; close(); reject(new Error(message ?? 'MoonScale UDP listener closed')); return; }
          close();
        },
      });
      if (settled) {
        pendingHandle.close();
        pendingHandle = undefined;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const close of [...this.listeners]) close();
    for (const cancel of [...this.pendingDials]) cancel();
    for (const socket of [...this.sockets]) socket.close();
    this.bridge.close?.();
  }

  private dial(start: (callbacks: MoonScaleConnectionCallbacks) => { close(): void }, udp = false): Promise<MoonScaleTcpSocket> {
    if (this.closed) return Promise.reject(new Error('MoonScale client is closed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle: { close(): void } | undefined;
      const cancel = () => {
        if (settled) return;
        settled = true;
        handle?.close();
        this.pendingDials.delete(cancel);
        reject(new Error('MoonScale client is closed'));
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        this.pendingDials.delete(cancel);
        handle?.close();
        reject(new Error(message));
      };
      const callbacks: MoonScaleConnectionCallbacks = {
        onOpen: (connection) => {
          if (settled) { connection.close(); return; }
          settled = true;
          this.pendingDials.delete(cancel);
          let socket: SocketAdapter;
          socket = udp ? new UdpSocketAdapter(connection as RuntimeUdpConnection, () => this.sockets.delete(socket)) : new SocketAdapter(connection, () => this.sockets.delete(socket));
          this.sockets.add(socket);
          connection.setCallbacks(socket.callbacks());
          resolve(socket);
        },
        onData: () => {},
        onClose: (message) => fail(message ?? 'MoonScale connection closed'),
        onError: fail,
      };
      handle = start(callbacks);
      if (settled) handle.close();
      else this.pendingDials.add(cancel);
    });
  }

  private setState(state: MoonScaleState): void {
    if (this.closed) return;
    this._state = state;
    this.options.onState?.(state);
  }

  private setNetmap(serialized: string): void {
    if (this.closed) return;
    try {
      const netmap = freezeSnapshot(JSON.parse(serialized) as MoonScaleNetMap);
      this._netmap = netmap;
      this.options.onNetMap?.(netmap);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitError(error: Error): void {
    if (!this.closed) this.options.onError?.(error);
  }
}

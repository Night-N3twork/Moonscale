import type {
  MoonScaleConnectionCallbacks,
  MoonScaleExitNode,
  MoonScaleExitNodeOptions,
  MoonScaleListenerCallbacks,
  MoonScaleState,
  MoonScaleTcpPeer,
  MoonScaleUdpListenerCallbacks,
  RuntimeBridge,
  RuntimeCallbacks,
  RuntimeConfig,
  RuntimeConnection,
  RuntimeUdpConnection,
} from './types.js';

type Event =
  | { type: 'ready' }
  | { type: 'closed' }
  | { type: 'error'; message: string }
  | { type: 'response'; id: number; value?: unknown; error?: string }
  | { type: 'storage-get'; id: number; key: string; signal?: SharedArrayBuffer; value?: SharedArrayBuffer }
  | { type: 'storage-set'; id: number; key: string; value: string; signal?: SharedArrayBuffer }
  | { type: 'event'; event: 'state'; value: MoonScaleState }
  | { type: 'event'; event: 'netmap' | 'auth-url' | 'panic'; value: string }
  | { type: 'event'; event: 'running' }
  | { type: 'event'; event: 'exit-nodes'; value: MoonScaleExitNode[] }
  | { type: 'event'; event: 'exit-node'; value: { id: string; routeAll: boolean; allowLANAccess: boolean } }
  | { type: 'event'; event: 'connection-open'; requestId: number; socketId: number; udp?: boolean }
  | { type: 'event'; event: 'socket-data'; socketId: number; data: ArrayBuffer }
  | { type: 'event'; event: 'socket-close' | 'socket-error'; socketId: number; message?: string }
  | { type: 'event'; event: 'listener-open'; requestId: number; listenerId: number; udp?: boolean }
  | { type: 'event'; event: 'listener-connection'; listenerId: number; socketId: number; peer: MoonScaleTcpPeer }
  | { type: 'event'; event: 'listener-message'; listenerId: number; peer: MoonScaleTcpPeer; data: ArrayBuffer };

type Request =
  | { type: 'start'; config: Omit<RuntimeConfig, 'stateStorage' | 'panicHandler'> & { hasStateStorage: boolean } }
  | { type: 'request'; id: number; method: string; args: unknown[]; socketId?: number; listenerId?: number; data?: ArrayBuffer }
  | { type: 'storage-response'; id: number; value?: string }
  | { type: 'close' };

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class RemoteConnection implements RuntimeUdpConnection {
  private callbacks: MoonScaleConnectionCallbacks | undefined;
  private readonly pendingData: ArrayBuffer[] = [];

  constructor(private readonly bridge: WorkerRuntimeBridge, readonly id: number, readonly udp: boolean) {}

  write(data: Uint8Array): void { this.bridge.sendSocket(this.id, 'socketWrite', data); }
  sendTo(data: Uint8Array, host: string, port: number): void { this.bridge.sendSocket(this.id, 'socketSendTo', data, host, port); }
  close(): void { this.bridge.closeSocket(this.id); }
  setCallbacks(callbacks: MoonScaleConnectionCallbacks): void {
    this.callbacks = callbacks;
    for (const data of this.pendingData.splice(0)) callbacks.onData(new Uint8Array(data));
  }
  open(): void { this.callbacks?.onOpen(this); }
  data(data: ArrayBuffer): void {
    if (this.callbacks) this.callbacks.onData(new Uint8Array(data));
    else this.pendingData.push(data);
  }
  closeFromWorker(message?: string): void { this.callbacks?.onClose(message); }
  error(message: string): void { this.callbacks?.onError(message); }
}

export class WorkerRuntimeBridge implements RuntimeBridge {
  private readonly pending = new Map<number, Pending>();
  private readonly connections = new Map<number, RemoteConnection>();
  private readonly listenerCallbacks = new Map<number, MoonScaleListenerCallbacks | MoonScaleUdpListenerCallbacks>();
  private readonly buffered: Event[] = [];
  private callbacks: RuntimeCallbacks | undefined;
  private exitNodes: MoonScaleExitNode[] = [];
  private selection = { id: '', routeAll: false, allowLANAccess: false };
  private nextID = 1;
  private closed = false;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(private readonly worker: Worker, private readonly storage?: RuntimeConfig['stateStorage']) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    worker.onmessage = (event: MessageEvent<Event>) => this.handle(event.data);
    worker.onerror = () => this.fail(new Error('MoonScale worker failed'));
  }

  static async create(config: RuntimeConfig): Promise<WorkerRuntimeBridge> {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') throw new Error('@nightnetwork/moonscale runtime requires a browser with Web Worker support');
    const bridge = new WorkerRuntimeBridge(new Worker(new URL('./runtime-worker.js', import.meta.url), { type: 'module' }), config.stateStorage);
    bridge.worker.postMessage({ type: 'start', config: { authKey: config.authKey, hostname: config.hostname, controlURL: config.controlURL, wasmURL: config.wasmURL, hasStateStorage: Boolean(config.stateStorage) } } satisfies Request);
    await bridge.ready;
    return bridge;
  }

  run(callbacks: RuntimeCallbacks): void { this.callbacks = callbacks; for (const event of this.buffered.splice(0)) this.dispatch(event); }
  login(): void { void this.request('login'); }
  logout(): void { void this.request('logout'); }
  listExitNodes(): readonly MoonScaleExitNode[] { return this.exitNodes; }
  exitNode(): { id: string; routeAll: boolean; allowLANAccess: boolean } { return this.selection; }
  async setExitNode(id: string, options?: MoonScaleExitNodeOptions): Promise<void> { await this.request('setExitNode', id, options); }
  async clearExitNode(): Promise<void> { await this.request('clearExitNode'); }

  dialTcp(host: string, port: number, callbacks: MoonScaleConnectionCallbacks): { close(): void } { return this.dial('dialTcp', host, port, callbacks, false); }
  dialUdp(host: string, port: number, callbacks: MoonScaleConnectionCallbacks): { close(): void } { return this.dial('dialUdp', host, port, callbacks, true); }

  listenTcp(host: string, port: number, callbacks: MoonScaleListenerCallbacks): { close(): void } { return this.listen('listenTcp', host, port, callbacks, false); }
  listenUdp(host: string, port: number, callbacks: MoonScaleUdpListenerCallbacks): { close(): void } { return this.listen('listenUdp', host, port, callbacks, true); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.listenerCallbacks.clear();
    this.worker.postMessage({ type: 'close' } satisfies Request);
    this.worker.terminate();
    this.fail(new Error('MoonScale client is closed'));
  }

  sendSocket(socketId: number, method: string, data: Uint8Array, host?: string, port?: number): void {
    const buffer = data.slice().buffer;
    this.send(method, host === undefined ? [] : [host, port], socketId, undefined, buffer, [buffer]);
  }

  closeSocket(socketId: number): void {
    this.send('socketClose', [], socketId);
  }

  private dial(method: string, host: string, port: number, callbacks: MoonScaleConnectionCallbacks, udp: boolean): { close(): void } {
    const id = this.nextID++;
    let socketId: number | undefined;
    this.pending.set(id, {
      resolve: (value) => {
        socketId = value as number;
        const connection = new RemoteConnection(this, socketId, udp);
        this.connections.set(socketId, connection);
        connection.setCallbacks(callbacks);
        connection.open();
      },
      reject: (error) => callbacks.onError(error.message),
    });
    this.send(method, [host, port], undefined, undefined, undefined, undefined, id);
    return { close: () => { if (socketId !== undefined) this.send('socketClose', [], socketId); else this.send('cancel', [id]); } };
  }

  private listen(method: string, host: string, port: number, callbacks: MoonScaleListenerCallbacks | MoonScaleUdpListenerCallbacks, udp: boolean): { close(): void } {
    const id = this.nextID++;
    let listenerId: number | undefined;
    this.pending.set(id, {
      resolve: (value) => {
        listenerId = value as number;
        this.listenerCallbacks.set(listenerId, callbacks);
        callbacks.onListening({ close: () => { if (listenerId !== undefined) this.send('listenerClose', [], undefined, listenerId); } });
      },
      reject: (error) => callbacks.onError(error.message),
    });
    this.send(method, [host, port, udp], undefined, undefined, undefined, undefined, id);
    return { close: () => { if (listenerId !== undefined) this.send('listenerClose', [], undefined, listenerId); else this.send('cancel', [id]); } };
  }

  private request(method: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextID++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send(method, args, undefined, undefined, undefined, undefined, id); });
  }

  private send(method: string, args: unknown[] = [], socketId?: number, listenerId?: number, data?: ArrayBuffer, transfer?: Transferable[], id = this.nextID++): void {
    if (this.closed) return;
    const message = { type: 'request', id, method, args, socketId, listenerId, data } satisfies Request;
    if (transfer) this.worker.postMessage(message, transfer);
    else this.worker.postMessage(message);
  }

  private handle(event: Event): void {
    if (this.closed) return;
    if (event.type === 'ready') { this.resolveReady(); return; }
    if (event.type === 'error') { this.fail(new Error(event.message)); return; }
    if (event.type === 'storage-get') {
      const value = this.storage?.getState(event.key) ?? '';
      if (event.signal && event.value) {
        const bytes = new TextEncoder().encode(value);
        const output = new Uint8Array(event.value);
        if (bytes.length <= output.byteLength - 4) {
          new DataView(event.value).setUint32(0, bytes.length, true);
          output.set(bytes, 4);
        } else {
          new DataView(event.value).setUint32(0, 0, true);
        }
        const signal = new Int32Array(event.signal);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      } else {
        this.worker.postMessage({ type: 'storage-response', id: event.id, value } satisfies Request);
      }
      return;
    }
    if (event.type === 'storage-set') {
      this.storage?.setState(event.key, event.value);
      if (event.signal) {
        const signal = new Int32Array(event.signal);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      } else {
        this.worker.postMessage({ type: 'storage-response', id: event.id } satisfies Request);
      }
      return;
    }
    if (event.type === 'response') { const pending = this.pending.get(event.id); if (!pending) return; this.pending.delete(event.id); event.error ? pending.reject(new Error(event.error)) : pending.resolve(event.value); return; }
    if (this.callbacks) this.dispatch(event); else this.buffered.push(event);
  }

  private dispatch(event: Event): void {
    if (event.type !== 'event') return;
    if (event.event === 'state') this.callbacks?.notifyState(event.value);
    else if (event.event === 'running') this.callbacks?.notifyRunning?.();
    else if (event.event === 'netmap') this.callbacks?.notifyNetMap(event.value);
    else if (event.event === 'auth-url') this.callbacks?.notifyBrowseToURL(event.value);
    else if (event.event === 'panic') this.callbacks?.notifyPanicRecover(event.value);
    else if (event.event === 'exit-nodes') this.exitNodes = event.value.map((node) => ({ ...node, addresses: node.addresses.slice() }));
    else if (event.event === 'exit-node') this.selection = event.value;
    else if (event.event === 'connection-open') { const pending = this.pending.get(event.requestId); if (pending) { this.pending.delete(event.requestId); pending.resolve(event.socketId); } }
    else if (event.event === 'socket-data') this.connections.get(event.socketId)?.data(event.data);
    else if (event.event === 'socket-close') { this.connections.get(event.socketId)?.closeFromWorker(event.message); this.connections.delete(event.socketId); }
    else if (event.event === 'socket-error') this.connections.get(event.socketId)?.error(event.message ?? 'MoonScale socket failed');
    else if (event.event === 'listener-open') { const pending = this.pending.get(event.requestId); if (pending) { this.pending.delete(event.requestId); pending.resolve(event.listenerId); } }
    else if (event.event === 'listener-connection') { const callbacks = this.listenerCallbacks.get(event.listenerId) as MoonScaleListenerCallbacks | undefined; if (!callbacks) return; const connection = new RemoteConnection(this, event.socketId, false); this.connections.set(event.socketId, connection); callbacks.onConnection(connection, event.peer); }
    else if (event.event === 'listener-message') (this.listenerCallbacks.get(event.listenerId) as MoonScaleUdpListenerCallbacks | undefined)?.onMessage(new Uint8Array(event.data), event.peer, new RemoteConnection(this, -1, true));
  }

  private fail(error: Error): void {
    this.closed = true;
    this.buffered.length = 0;
    this.callbacks = undefined;
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function createWorkerRuntimeBridge(config: RuntimeConfig): Promise<RuntimeBridge> { return WorkerRuntimeBridge.create(config); }

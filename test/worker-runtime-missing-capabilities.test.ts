import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonScaleClient } from '../src/index.js';

type Message = {
  type: string;
  id?: number;
  method?: string;
  args?: unknown[];
  socketId?: number;
  listenerId?: number;
  data?: ArrayBuffer;
  value?: unknown;
  event?: string;
  requestId?: number;
  peer?: { host: string; port: number };
  config?: Record<string, unknown>;
  signal?: SharedArrayBuffer;
  value?: SharedArrayBuffer | string;
};

class WorkerDouble {
  static instances: WorkerDouble[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Message[] = [];
  terminated = false;

  constructor(_url: string | URL, _options?: WorkerOptions) {
    WorkerDouble.instances.push(this);
  }

  postMessage(message: Message): void {
    this.posted.push(message);
    if (message.type === 'start') {
      queueMicrotask(() => this.emit({ type: 'ready' }));
      return;
    }
    if (message.method === 'dialUdp') {
      queueMicrotask(() => this.emit({ type: 'event', event: 'connection-open', requestId: message.id, socketId: 11, udp: true }));
      return;
    }
    if (message.method === 'listenTcp') {
      queueMicrotask(() => {
        this.emit({ type: 'event', event: 'listener-open', requestId: message.id, listenerId: 21 });
        this.emit({ type: 'event', event: 'listener-connection', listenerId: 21, socketId: 22, peer: { host: '100.64.0.3', port: 9000 } });
      });
      return;
    }
    if (message.method === 'listenUdp') {
      queueMicrotask(() => {
        this.emit({ type: 'event', event: 'listener-open', requestId: message.id, listenerId: 31, udp: true });
        this.emit({ type: 'event', event: 'listener-message', listenerId: 31, peer: { host: '100.64.0.4', port: 5353 }, data: new Uint8Array([4, 5]).buffer });
      });
      return;
    }
    if (message.type === 'request' && message.id !== undefined) queueMicrotask(() => this.emit({ type: 'response', id: message.id }));
  }

  terminate(): void { this.terminated = true; }
  emit(message: Message): void { this.onmessage?.({ data: message } as MessageEvent); }
}

describe('worker runtime API preservation', () => {
  const originalWorker = globalThis.Worker;
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    WorkerDouble.instances.length = 0;
  });

  it('round-trips caller-owned state storage requests', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerDouble });
    const stateStorage = { getState: vi.fn(() => 'persisted'), setState: vi.fn() };
    const client = await MoonScaleClient.create({ stateStorage });
    const worker = WorkerDouble.instances[0];
    const start = worker.posted[0];

    expect(start.config).toEqual(expect.objectContaining({ hasStateStorage: true }));
    const readSignal = new SharedArrayBuffer(4);
    const readValue = new SharedArrayBuffer(1_024);
    const writeSignal = new SharedArrayBuffer(4);
    worker.emit({ type: 'storage-get', id: 41, key: 'machine-key', signal: readSignal, value: readValue });
    worker.emit({ type: 'storage-set', id: 42, key: 'machine-key', value: 'updated', signal: writeSignal });

    expect(stateStorage.getState).toHaveBeenCalledWith('machine-key');
    expect(stateStorage.setState).toHaveBeenCalledWith('machine-key', 'updated');
    expect(Atomics.load(new Int32Array(readSignal), 0)).toBe(1);
    expect(Atomics.load(new Int32Array(writeSignal), 0)).toBe(1);
    const size = new DataView(readValue).getUint32(0, true);
    expect(new TextDecoder().decode(new Uint8Array(readValue, 4, size))).toBe('persisted');
    await client.close();
  });

  it('proxies UDP sendTo and TCP/UDP listener events with stable IDs', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerDouble });
    const client = await MoonScaleClient.create();
    const udp = await client.dialUdp('100.64.0.2', 53);
    udp.sendTo(new Uint8Array([1, 2]), '100.64.0.3', 53);

    const tcpAccepted = vi.fn();
    const tcpListener = await client.listenTcp('100.64.0.1', 8080, tcpAccepted);
    await vi.waitFor(() => expect(tcpAccepted).toHaveBeenCalledWith(expect.anything(), { host: '100.64.0.3', port: 9000 }));

    const datagram = vi.fn();
    const udpListener = await client.listenUdp('100.64.0.1', 5353, datagram);
    await vi.waitFor(() => expect(datagram).toHaveBeenCalledWith(new Uint8Array([4, 5]), { host: '100.64.0.4', port: 5353 }));

    const worker = WorkerDouble.instances[0];
    expect(worker.posted).toContainEqual(expect.objectContaining({ method: 'socketSendTo', socketId: 11, data: expect.any(ArrayBuffer) }));
    tcpListener.close();
    udpListener.close();
    expect(worker.posted).toContainEqual(expect.objectContaining({ method: 'listenerClose', listenerId: 21 }));
    expect(worker.posted).toContainEqual(expect.objectContaining({ method: 'listenerClose', listenerId: 31 }));
    await client.close();
  });

  it('suppresses late lifecycle events after close and rejects a pending dial', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerDouble });
    const onAuthURL = vi.fn();
    const onState = vi.fn();
    const onError = vi.fn();
    const client = await MoonScaleClient.create({ onAuthURL, onState, onError });
    const pending = client.dialTcp('100.64.0.9', 443);
    await client.close();
    await expect(pending).rejects.toThrow('MoonScale client is closed');

    WorkerDouble.instances[0].emit({ type: 'event', event: 'auth-url', value: 'https://secret.example.test/' });
    WorkerDouble.instances[0].emit({ type: 'event', event: 'state', value: 'Running' });
    WorkerDouble.instances[0].emit({ type: 'event', event: 'panic', value: 'late failure' });

    expect(onAuthURL).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects pending operations and suppresses later events after a worker error', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerDouble });
    const onAuthURL = vi.fn();
    const client = await MoonScaleClient.create({ onAuthURL });
    const pending = client.dialTcp('100.64.0.9', 443);
    const worker = WorkerDouble.instances[0];

    worker.onerror?.({} as ErrorEvent);
    await expect(pending).rejects.toThrow('MoonScale worker failed');
    worker.emit({ type: 'event', event: 'auth-url', value: 'https://late.example.test/' });

    expect(onAuthURL).not.toHaveBeenCalled();
  });
});

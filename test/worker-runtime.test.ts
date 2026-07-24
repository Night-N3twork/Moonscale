import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonScaleClient } from '../src/index.js';

type WorkerMessage = { type: string; id?: number; method?: string; args?: unknown[]; config?: Record<string, unknown>; socketId?: number; listenerId?: number; data?: ArrayBuffer; value?: unknown };

class SimulatedRuntimeWorker {
  static instances: SimulatedRuntimeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: WorkerMessage[] = [];
  terminated = false;

  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    SimulatedRuntimeWorker.instances.push(this);
  }

  postMessage(message: WorkerMessage, _transfer?: Transferable[]): void {
    this.posted.push(message);
    if (message.type === 'start') {
      queueMicrotask(() => {
        this.emit({ type: 'ready' });
        this.emit({ type: 'event', event: 'state', value: 'Running' });
        this.emit({ type: 'event', event: 'exit-nodes', value: [{ id: 'exit-1', name: 'exit.example.ts.net', addresses: ['100.64.0.2'], online: true }] });
        this.emit({ type: 'event', event: 'exit-node', value: { id: '', routeAll: false, allowLANAccess: false } });
        for (let i = 0; i < 100_000; i += 1) Math.sqrt(i);
      });
      return;
    }
    if (message.method === 'dialTcp') {
      queueMicrotask(() => {
        this.emit({ type: 'event', event: 'connection-open', requestId: message.id, socketId: 7 });
        setTimeout(() => this.emit({ type: 'event', event: 'socket-data', socketId: 7, data: new Uint8Array([8, 9]).buffer }), 0);
      });
      return;
    }
    if (message.type === 'request' && message.id !== undefined) {
      queueMicrotask(() => this.emit({ type: 'response', id: message.id }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('browser worker runtime', () => {
  const originalWorker = globalThis.Worker;
  const originalWindow = globalThis.window;
  const originalConsoleLog = console.log;

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    console.log = originalConsoleLog;
    SimulatedRuntimeWorker.instances.length = 0;
  });

  it('keeps the page responsive while the worker runs post-auth work without logging credentials', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: SimulatedRuntimeWorker });
    const authKey = 'tskey-auth-test';
    const consoleLog = vi.fn();
    console.log = consoleLog;
    const heartbeat = vi.fn();
    const timer = setInterval(heartbeat, 0);

    const client = await MoonScaleClient.create({ authKey });
    await vi.waitFor(() => expect(client.state).toBe('Running'));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());

    const worker = SimulatedRuntimeWorker.instances[0];
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.posted[0]?.type).toBe('start');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(authKey);

    await client.close();
    clearInterval(timer);
    expect(worker.terminated).toBe(true);
  });

  it('proxies exit-node snapshots and binary TCP events through request and socket IDs', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: SimulatedRuntimeWorker });
    const client = await MoonScaleClient.create();
    await vi.waitFor(() => expect(client.listExitNodes()).toEqual([{ id: 'exit-1', name: 'exit.example.ts.net', addresses: ['100.64.0.2'], online: true }]));

    const socket = await client.dialTcp('100.64.0.2', 443);
    const onData = vi.fn();
    socket.on('data', onData);
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith(new Uint8Array([8, 9])));
    socket.send(new Uint8Array([1, 2, 3]));

    const worker = SimulatedRuntimeWorker.instances[0];
    const dial = worker.posted.find((message) => message.method === 'dialTcp');
    const write = worker.posted.find((message) => message.method === 'socketWrite');
    expect(dial?.id).toEqual(expect.any(Number));
    expect(write?.socketId).toBe(7);
    expect(write?.data).toBeInstanceOf(ArrayBuffer);

    await client.close();
    expect(worker.posted.some((message) => message.method === 'socketClose' && message.socketId === 7)).toBe(true);
  });
});

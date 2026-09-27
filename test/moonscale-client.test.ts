import { describe, expect, it, vi } from 'vitest';
import { MoonScaleClient } from '../src/index.js';
import type { RuntimeBridge, RuntimeModule } from '../src/types.js';

function makeBridge(): RuntimeBridge {
  return {
    run: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    dialTcp: vi.fn(),
    dialUdp: vi.fn(),
    listenTcp: vi.fn(),
    listenUdp: vi.fn(),
    listExitNodes: vi.fn(),
    setExitNode: vi.fn(() => Promise.resolve()),
    clearExitNode: vi.fn(() => Promise.resolve()),
    exitNode: vi.fn(),
    createTailscaleWebSocket: vi.fn(),
    fetch: vi.fn(),
    setFunnel: vi.fn(() => Promise.resolve()),
    clearFunnel: vi.fn(() => Promise.resolve()),
    resolveDNS: vi.fn(),
  };
}

function runtimeFor(bridge: RuntimeBridge): RuntimeModule {
  return { createIPN: vi.fn(async () => bridge) };
}

describe('MoonScaleClient', () => {
  it('reports the interactive authorization URL without opening it', async () => {
    const bridge = makeBridge();
    const onAuthURL = vi.fn();
    const client = await MoonScaleClient.create({ onAuthURL }, async () => runtimeFor(bridge));

    const callbacks = vi.mocked(bridge.run).mock.calls[0][0];
    callbacks.notifyBrowseToURL('https://login.tailscale.com/a/123');

    expect(onAuthURL).toHaveBeenCalledWith('https://login.tailscale.com/a/123');
    expect(bridge.login).not.toHaveBeenCalled();
    client.login();
    expect(bridge.login).toHaveBeenCalledOnce();
  });

  it('notifies authorization URL subscribers until they unsubscribe', async () => {
    const bridge = makeBridge();
    const onAuthURL = vi.fn();
    const onAuthorizationURL = vi.fn();
    const otherOnAuthorizationURL = vi.fn();
    const client = await MoonScaleClient.create({ onAuthURL }, async () => runtimeFor(bridge));
    const unsubscribe = client.onAuthorizationURL(onAuthorizationURL);
    client.onAuthorizationURL(otherOnAuthorizationURL);
    const callbacks = vi.mocked(bridge.run).mock.calls[0][0];

    callbacks.notifyBrowseToURL('https://login.tailscale.com/a/123');

    expect(onAuthURL).toHaveBeenCalledWith('https://login.tailscale.com/a/123');
    expect(onAuthorizationURL).toHaveBeenCalledWith('https://login.tailscale.com/a/123');
    expect(otherOnAuthorizationURL).toHaveBeenCalledWith('https://login.tailscale.com/a/123');

    unsubscribe();
    callbacks.notifyBrowseToURL('https://login.tailscale.com/a/456');

    expect(onAuthURL).toHaveBeenCalledWith('https://login.tailscale.com/a/456');
    expect(onAuthorizationURL).toHaveBeenCalledOnce();
    expect(otherOnAuthorizationURL).toHaveBeenNthCalledWith(1, 'https://login.tailscale.com/a/123');
    expect(otherOnAuthorizationURL).toHaveBeenNthCalledWith(2, 'https://login.tailscale.com/a/456');
  });

  it('passes an auth key to the runtime without retaining it', async () => {
    const bridge = makeBridge();
    const runtime = runtimeFor(bridge);
    const client = await MoonScaleClient.create({ authKey: 'tskey-auth-test' }, async () => runtime);

    expect(runtime.createIPN).toHaveBeenCalledWith(expect.objectContaining({ authKey: 'tskey-auth-test' }));
    expect(JSON.stringify(client)).not.toContain('tskey-auth-test');
  });

  it('uses state storage and exposes immutable netmap snapshots', async () => {
    const bridge = makeBridge();
    const runtime = runtimeFor(bridge);
    const stateStorage = { getState: vi.fn(() => 'state'), setState: vi.fn() };
    const client = await MoonScaleClient.create({ stateStorage }, async () => runtime);
    const netmap = { self: { name: 'device.tailnet.ts.net', addresses: ['100.64.0.1'] }, peers: [], lockedOut: false };

    expect(runtime.createIPN).toHaveBeenCalledWith(expect.objectContaining({ stateStorage }));
    vi.mocked(bridge.run).mock.calls[0][0].notifyNetMap(JSON.stringify(netmap));

    expect(client.netMap).toEqual(netmap);
    expect(Object.isFrozen(client.netMap)).toBe(true);
    expect(client.addresses).toEqual(['100.64.0.1']);
  });

  it('resolves the selected stable ID to an immutable eligible exit-node snapshot', async () => {
    const bridge = makeBridge();
    vi.mocked(bridge.listExitNodes).mockReturnValue([{ id: 'exit-1', name: 'exit.tailnet.ts.net.', addresses: ['100.64.0.2'], online: true }]);
    vi.mocked(bridge.exitNode).mockReturnValue({ id: 'exit-1', routeAll: true, allowLANAccess: true });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));

    expect(client.listExitNodes()).toEqual([{ id: 'exit-1', name: 'exit.tailnet.ts.net.', addresses: ['100.64.0.2'], online: true }]);
    expect(client.exitNode).toEqual({ id: 'exit-1', name: 'exit.tailnet.ts.net.', addresses: ['100.64.0.2'], online: true, routeAll: true, allowLANAccess: true });
    expect(Object.isFrozen(client.exitNode)).toBe(true);
  });

  it('returns null when no exit node is selected', async () => {
    const bridge = makeBridge();
    vi.mocked(bridge.exitNode).mockReturnValue({ id: '', routeAll: false, allowLANAccess: true });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));

    expect(client.exitNode).toBeNull();
  });

  it('selects and clears exit nodes without changing the caller supplied LAN option', async () => {
    const bridge = makeBridge();
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));

    await client.setExitNode('exit-1');
    await client.clearExitNode();

    expect(bridge.setExitNode).toHaveBeenCalledWith('exit-1', undefined);
    expect(bridge.clearExitNode).toHaveBeenCalledOnce();
  });

  it('adapts callback TCP and UDP dials to promise sockets and cleans them up', async () => {
    const bridge = makeBridge();
    const tcpConnection = { write: vi.fn(), close: vi.fn(), setCallbacks: vi.fn() };
    const udpConnection = { write: vi.fn(), close: vi.fn(), setCallbacks: vi.fn(), sendTo: vi.fn() };
    vi.mocked(bridge.dialTcp).mockImplementation((_host, _port, callbacks) => {
      queueMicrotask(() => callbacks.onOpen(tcpConnection));
      return { close: vi.fn() };
    });
    vi.mocked(bridge.dialUdp).mockImplementation((_host, _port, callbacks) => {
      queueMicrotask(() => callbacks.onOpen(udpConnection));
      return { close: vi.fn() };
    });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));
    const tcp = await client.dialTcp('100.64.0.10', 443);
    const udp = await client.dialUdp('100.64.0.10', 53);

    tcp.send(new Uint8Array([1]));
    udp.sendTo(new Uint8Array([2]), '100.64.0.11', 53);
    await client.close();

    expect(tcpConnection.write).toHaveBeenCalledWith(new Uint8Array([1]));
    expect(udpConnection.sendTo).toHaveBeenCalledWith(new Uint8Array([2]), '100.64.0.11', 53);
    expect(tcpConnection.close).toHaveBeenCalledOnce();
    expect(udpConnection.close).toHaveBeenCalledOnce();
  });

  it('adapts UDP listeners and closes their runtime handles with the client', async () => {
    const bridge = makeBridge();
    const listener = { close: vi.fn() };
    const messageSocket = { write: vi.fn(), close: vi.fn(), setCallbacks: vi.fn(), sendTo: vi.fn() };
    vi.mocked(bridge.listenUdp).mockImplementation((_host, _port, callbacks) => {
      queueMicrotask(() => callbacks.onListening(listener));
      return { close: vi.fn() };
    });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));
    const onDatagram = vi.fn();

    await client.listenUdp('100.64.0.1', 53, onDatagram);
    await vi.waitFor(() => expect(onDatagram).not.toHaveBeenCalled());
    vi.mocked(bridge.listenUdp).mock.calls[0][2].onMessage(
      new Uint8Array([1]),
      { host: '100.64.0.2', port: 9000 },
      messageSocket,
    );
    await client.close();

    expect(onDatagram).toHaveBeenCalledWith(new Uint8Array([1]), { host: '100.64.0.2', port: 9000 });
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it('closes synchronous dial and listener handles after their callbacks settle', async () => {
    const bridge = makeBridge();
    const dialHandle = { close: vi.fn() };
    const pendingListenerHandle = { close: vi.fn() };
    const activeListener = { close: vi.fn() };
    const connection = { write: vi.fn(), close: vi.fn(), setCallbacks: vi.fn() };
    vi.mocked(bridge.dialTcp).mockImplementation((_host, _port, callbacks) => {
      callbacks.onOpen(connection);
      return dialHandle;
    });
    vi.mocked(bridge.listenTcp).mockImplementation((_host, _port, callbacks) => {
      callbacks.onListening(activeListener);
      return pendingListenerHandle;
    });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));

    await client.dialTcp('100.64.0.10', 443);
    await client.listenTcp('100.64.0.1', 8080, vi.fn());

    expect(dialHandle.close).toHaveBeenCalledOnce();
    expect(pendingListenerHandle.close).toHaveBeenCalledOnce();
    expect(activeListener.close).not.toHaveBeenCalled();

    await client.close();

    expect(activeListener.close).toHaveBeenCalledOnce();
  });

  it('terminalizes sockets even when the runtime close callback throws', async () => {
    const bridge = makeBridge();
    const connection = {
      write: vi.fn(),
      close: vi.fn(() => { throw new Error('runtime close failed'); }),
      setCallbacks: vi.fn(),
    };
    vi.mocked(bridge.dialTcp).mockImplementation((_host, _port, callbacks) => {
      queueMicrotask(() => callbacks.onOpen(connection));
      return { close: vi.fn() };
    });
    const client = await MoonScaleClient.create({}, async () => runtimeFor(bridge));
    const socket = await client.dialTcp('100.64.0.10', 443);
    const onClose = vi.fn();
    socket.on('close', onClose);

    expect(() => socket.close()).toThrow('runtime close failed');
    socket.send(new Uint8Array([1]));
    await client.close();

    expect(onClose).toHaveBeenCalledOnce();
    expect(connection.write).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledOnce();
  });
});

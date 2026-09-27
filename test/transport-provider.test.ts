import { describe, expect, it, vi } from 'vitest';
import { MoonScaleTransportProvider } from '../src/index.js';

describe('MoonScaleTransportProvider', () => {
  it('routes a known short name and normalized FQDN to the peer IPv4 without DNS', async () => {
    const tcp = { send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'caeast1.example.ts.net.', addresses: ['fd7a::1', '100.101.2.3'] }], lockedOut: false },
      resolveDNS: vi.fn(async () => '8.8.8.8'),
      dialTcp: vi.fn(async () => tcp), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    for (const host of ['caeast1', 'CAEAST1.EXAMPLE.TS.NET.']) {
      expect(provider.canDial({ host, port: 22, protocol: 'tcp' })).toBe(true);
      expect(await provider.dialTcp(host, 22)).toBe(tcp);
    }
    expect(client.dialTcp).toHaveBeenCalledTimes(2);
    expect(client.dialTcp).toHaveBeenCalledWith('100.101.2.3', 22);
    expect(client.resolveDNS).not.toHaveBeenCalled();
  });

  it('rejects unknown and public names even if DNS would return a private IP', async () => {
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'caeast1.example.ts.net.', addresses: ['100.101.2.3'] }], lockedOut: false },
      resolveDNS: vi.fn(async () => '100.101.2.3'), dialTcp: vi.fn(), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    for (const host of ['unknown', 'example.com', 'caeast1.other.ts.net', '8.8.8.8', 'fd7a::1']) {
      expect(provider.canDial({ host, port: 443, protocol: 'tcp' })).toBe(false);
      await expect(provider.dialTcp(host, 443)).rejects.toThrow('only dials Running tailnet IPv4 destinations');
    }
    expect(client.resolveDNS).not.toHaveBeenCalled();
    expect(client.dialTcp).not.toHaveBeenCalled();
  });

  it('selects a UDP-only peer without trying TCP', async () => {
    const udp = { send: vi.fn(), sendTo: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'caeast1.example.ts.net.', addresses: ['100.127.0.1'] }], lockedOut: false },
      resolveDNS: vi.fn(), dialTcp: vi.fn(), dialUdp: vi.fn(async () => udp), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    expect(provider.canDial({ host: 'caeast1', port: 53, protocol: 'udp' })).toBe(true);
    expect(await provider.dialUdp('caeast1', 53)).toBe(udp);
    expect(client.dialUdp).toHaveBeenCalledWith('100.127.0.1', 53);
    expect(client.dialTcp).not.toHaveBeenCalled();
    expect(client.resolveDNS).not.toHaveBeenCalled();
  });

  it('accepts concurrent requests for the same hostname', async () => {
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'caeast1.example.ts.net', addresses: ['100.64.0.2'] }], lockedOut: false },
      resolveDNS: vi.fn(), dialTcp: vi.fn(async () => ({ send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) })), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);
    const request = { host: 'caeast1', port: 22, protocol: 'tcp' as const };

    expect(await Promise.all([provider.canDial(request), provider.canDial(request)])).toEqual([true, true]);
    await Promise.all([provider.dialTcp('caeast1', 22), provider.dialTcp('caeast1', 22)]);
    expect(client.dialTcp).toHaveBeenCalledTimes(2);
    expect(client.resolveDNS).not.toHaveBeenCalled();
  });

  it('rejects ambiguous short labels and duplicate exact names', () => {
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [
        { name: 'caeast1.example.ts.net', addresses: ['100.64.0.2'] },
        { name: 'caeast1.other.ts.net', addresses: ['100.64.0.3'] },
      ], lockedOut: false },
      resolveDNS: vi.fn(), dialTcp: vi.fn(), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    expect(provider.canDial({ host: 'caeast1', port: 22, protocol: 'tcp' })).toBe(false);
    expect(provider.canDial({ host: 'caeast1.example.ts.net', port: 22, protocol: 'tcp' })).toBe(true);
    client.netMap.peers.push({ name: 'CAEAST1.EXAMPLE.TS.NET.', addresses: ['100.64.0.4'] });
    expect(provider.canDial({ host: 'caeast1.example.ts.net', port: 22, protocol: 'tcp' })).toBe(false);
    expect(client.resolveDNS).not.toHaveBeenCalled();
  });

  it('rejects a dial when a selected peer disappears rather than probing or switching peers', async () => {
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'caeast1.example.ts.net', addresses: ['100.64.0.2'] }], lockedOut: false },
      resolveDNS: vi.fn(async () => '100.64.0.9'), dialTcp: vi.fn(), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    expect(provider.canDial({ host: 'caeast1', port: 22, protocol: 'tcp' })).toBe(true);
    client.netMap.peers.splice(0);
    await expect(provider.dialTcp('caeast1', 22)).rejects.toThrow('only dials Running tailnet IPv4 destinations');
    expect(client.resolveDNS).not.toHaveBeenCalled();
    expect(client.dialTcp).not.toHaveBeenCalled();
  });

  it('does not select a peer without tailnet IPv4 even when it has IPv6', async () => {
    const client = {
      state: 'Running' as const,
      netMap: { self: { name: 'self.example.ts.net', addresses: ['100.64.0.1'] }, peers: [{ name: 'ipv6-peer.example.ts.net', addresses: ['fd7a:115c:a1e0::1'] }], lockedOut: false },
      dialTcp: vi.fn(), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);

    expect(provider.canDial({ host: 'ipv6-peer', port: 22, protocol: 'tcp' })).toBe(false);
    await expect(provider.dialTcp('ipv6-peer', 22)).rejects.toThrow('only dials Running tailnet IPv4 destinations');
    expect(client.dialTcp).not.toHaveBeenCalled();
  });

  it('forwards authorization URLs and removes manual unsubscribes from provider cleanup', async () => {
    const listeners = new Set<(url: string) => void>();
    const clientUnsubscribe = vi.fn();
    const client = {
      state: 'Running' as const,
      netMap: null,
      resolveDNS: vi.fn(),
      dialTcp: vi.fn(),
      dialUdp: vi.fn(),
      onAuthorizationURL: vi.fn((listener: (url: string) => void) => {
        listeners.add(listener);
        return () => {
          clientUnsubscribe();
          listeners.delete(listener);
        };
      }),
    };
    const provider = new MoonScaleTransportProvider(client);
    const onURL = vi.fn();
    const unsubscribe = provider.onAuthorizationURL!(onURL);

    for (const listener of listeners) listener('https://login.tailscale.com/check');
    unsubscribe();
    await provider.close();

    expect(onURL).toHaveBeenCalledWith('https://login.tailscale.com/check');
    expect(client.onAuthorizationURL).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
    expect(clientUnsubscribe).toHaveBeenCalledOnce();
  });

  it('revokes authorization URL subscriptions when closed', async () => {
    const listeners = new Set<(url: string) => void>();
    const client = {
      state: 'Running' as const,
      netMap: null,
      resolveDNS: vi.fn(),
      dialTcp: vi.fn(),
      dialUdp: vi.fn(),
      onAuthorizationURL: vi.fn((listener: (url: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const provider = new MoonScaleTransportProvider(client);
    const onURL = vi.fn();

    provider.onAuthorizationURL!(onURL);
    await provider.close();
    for (const listener of listeners) listener('https://login.tailscale.com/check');

    expect(listeners).toHaveLength(0);
    expect(onURL).not.toHaveBeenCalled();
  });

  it('does not retain a socket that closed before an awaited dial resolves', async () => {
    let resolveDial!: (socket: typeof tcp) => void;
    const tcp = { closed: false, send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    const client = {
      state: 'Running' as const,
      netMap: null,
      resolveDNS: vi.fn(),
      dialTcp: vi.fn(() => new Promise<typeof tcp>((resolve) => { resolveDial = resolve; })),
      dialUdp: vi.fn(),
      onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);
    const dial = provider.dialTcp('100.64.0.8', 22);
    await Promise.resolve();

    tcp.closed = true;
    resolveDial(tcp);
    await dial;
    await provider.close();

    expect(tcp.close).not.toHaveBeenCalled();
  });

  it('closes a socket that resolves after the provider closes', async () => {
    let resolveDial!: (socket: typeof tcp) => void;
    const tcp = { send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    const client = {
      state: 'Running' as const,
      netMap: null,
      resolveDNS: vi.fn(),
      dialTcp: vi.fn(() => new Promise<typeof tcp>((resolve) => { resolveDial = resolve; })),
      dialUdp: vi.fn(),
      onAuthorizationURL: vi.fn(() => () => {}),
    };
    const provider = new MoonScaleTransportProvider(client);
    const dial = provider.dialTcp('100.64.0.8', 22);
    await Promise.resolve();

    await provider.close();
    resolveDial(tcp);

    await expect(dial).rejects.toThrow('MoonScale transport provider is closed');
    expect(tcp.close).toHaveBeenCalledOnce();
  });

  it('selects only Running tailnet destinations and dials through MoonScale', async () => {
    const tcp = { send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    const client = { state: 'Running' as const, netMap: null, resolveDNS: vi.fn(), dialTcp: vi.fn(async () => tcp), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}) };
    const provider = new MoonScaleTransportProvider(client);

    expect(await provider.canDial({ host: '100.64.0.8', port: 22, protocol: 'tcp' })).toBe(true);
    expect(await provider.canDial({ host: '8.8.8.8', port: 53, protocol: 'udp' })).toBe(false);
    const socket = await provider.dialTcp('100.64.0.8', 22);

    expect(socket).toBe(tcp);
    expect(client.dialTcp).toHaveBeenCalledWith('100.64.0.8', 22);
  });

  it('does not select before readiness and closes every socket it owns', async () => {
    const tcp = { send: vi.fn(), close: vi.fn(), on: vi.fn(() => () => {}) };
    let state: 'Starting' | 'Running' = 'Starting';
    const client = { get state() { return state; }, netMap: null, resolveDNS: vi.fn(), dialTcp: vi.fn(async () => tcp), dialUdp: vi.fn(), onAuthorizationURL: vi.fn(() => () => {}) };
    const provider = new MoonScaleTransportProvider(client);

    expect(await provider.canDial({ host: '100.64.0.8', port: 22, protocol: 'tcp' })).toBe(false);
    state = 'Running';
    await provider.dialTcp('100.64.0.8', 22);
    await provider.close();

    expect(tcp.close).toHaveBeenCalledOnce();
    expect('listenTcp' in provider).toBe(false);
  });
});

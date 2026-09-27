import type { MoonScaleClient } from './client.js';
import type { MoonScaleTcpSocket, MoonScaleUdpSocket } from './types.js';

export interface TransportRequest { host: string; port: number; protocol: 'tcp' | 'udp'; }
export interface TransportSocket {
  readonly closed?: boolean;
  send(data: Uint8Array): void;
  close(): void;
  on(event: 'data' | 'close' | 'error', listener: (...args: any[]) => void): () => void;
}
export interface TransportProvider {
  readonly id: string;
  canDial(request: TransportRequest): boolean | Promise<boolean>;
  dialTcp(host: string, port: number): Promise<TransportSocket>;
  dialUdp(host: string, port: number): Promise<TransportSocket>;
  onAuthorizationURL?(listener: (url: string) => void): () => void;
  close(): void | Promise<void>;
}

/** Outbound-only MoonScale adapter. It never creates tailnet listeners or funnels. */
export class MoonScaleTransportProvider implements TransportProvider {
  readonly id = 'moonscale';
  private readonly sockets = new Set<TransportSocket>();
  private readonly authorizationURLUnsubscribers = new Set<() => void>();
  private closed = false;
  constructor(private readonly client: Pick<MoonScaleClient, 'state' | 'netMap' | 'dialTcp' | 'dialUdp' | 'onAuthorizationURL'>) {}
  canDial(request: TransportRequest): boolean {
    if (this.closed || this.client.state !== 'Running') return false;
    if (isTailnetIpv4(request.host)) return true;
    if (isIpLiteral(request.host)) return false;
    return this.peerIp(request.host) !== undefined;
  }
  onAuthorizationURL(listener: (url: string) => void): () => void {
    if (this.closed) return () => {};
    const unsubscribe = this.client.onAuthorizationURL((url) => { if (!this.closed) listener(url); });
    const cleanup = () => {
      if (!this.authorizationURLUnsubscribers.delete(cleanup)) return;
      unsubscribe();
    };
    this.authorizationURLUnsubscribers.add(cleanup);
    if (this.closed) cleanup();
    return cleanup;
  }
  async dialTcp(host: string, port: number): Promise<MoonScaleTcpSocket> {
    const ip = this.requireReady(host);
    return this.own(await this.client.dialTcp(ip, port));
  }
  async dialUdp(host: string, port: number): Promise<MoonScaleUdpSocket> {
    const ip = this.requireReady(host);
    return this.own(await this.client.dialUdp(ip, port)) as MoonScaleUdpSocket;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of [...this.authorizationURLUnsubscribers]) unsubscribe();
    for (const socket of [...this.sockets]) socket.close();
    this.sockets.clear();
  }
  private own<T extends TransportSocket>(socket: T): T {
    if (this.closed) { socket.close(); throw new Error('MoonScale transport provider is closed'); }
    if (socket.closed) return socket;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    return socket;
  }
  private requireReady(host: string): string {
    if (this.closed || this.client.state !== 'Running') throw new Error('MoonScale transport provider only dials Running tailnet IPv4 destinations');
    if (isTailnetIpv4(host)) return host;
    if (isIpLiteral(host)) throw new Error('MoonScale transport provider only dials Running tailnet IPv4 destinations');
    const ip = this.peerIp(host);
    if (!ip) throw new Error('MoonScale transport provider only dials Running tailnet IPv4 destinations');
    return ip;
  }
  private peerIp(host: string): string | undefined {
    const name = host.replace(/\.$/, '').toLowerCase();
    const short = !name.includes('.');
    const matches = this.client.netMap?.peers.filter((peer) => {
      const peerName = peer.name.replace(/\.$/, '').toLowerCase();
      return short ? peerName.split('.')[0] === name : peerName === name;
    });
    if (matches?.length !== 1) return undefined;
    return matches[0].addresses.find(isTailnetIpv4);
  }
}
function isIpLiteral(host: string): boolean {
  return host.includes(':') || /^[\d.]+$/.test(host);
}
function isTailnetIpv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && !parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255) && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}

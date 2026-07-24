export type MoonScaleState =
  | 'NoState'
  | 'NeedsLogin'
  | 'NeedsMachineAuth'
  | 'Starting'
  | 'Running'
  | 'Stopped'
  | 'InUseOtherUser';

export interface MoonScaleStateStorage {
  getState(id: string): string;
  setState(id: string, value: string): void;
}

export interface MoonScaleNetMapNode {
  name: string;
  addresses: readonly string[];
  [key: string]: unknown;
}

export interface MoonScaleNetMap {
  self: MoonScaleNetMapNode;
  peers: readonly MoonScaleNetMapNode[];
  lockedOut: boolean;
  [key: string]: unknown;
}

export interface MoonScaleClientOptions {
  authKey?: string;
  hostname?: string;
  controlURL?: string;
  stateStorage?: MoonScaleStateStorage;
  wasmURL?: string;
  onAuthURL?: (url: string) => void;
  onState?: (state: MoonScaleState) => void;
  onNetMap?: (netmap: MoonScaleNetMap) => void;
  onError?: (error: Error) => void;
}

export interface MoonScaleExitNode {
  id: string;
  name: string;
  addresses: readonly string[];
  online?: boolean;
}

export interface MoonScaleExitNodeOptions {
  allowLANAccess?: boolean;
}

export interface MoonScaleExitNodeSelection extends MoonScaleExitNode {
  routeAll: boolean;
  allowLANAccess: boolean;
}

export interface MoonScaleConnectionCallbacks {
  onOpen(connection: RuntimeConnection): void;
  onData(data: Uint8Array): void;
  onClose(message?: string): void;
  onError(message: string): void;
}

export interface RuntimeConnection {
  write(data: Uint8Array): void;
  close(): void;
  setCallbacks(callbacks: MoonScaleConnectionCallbacks): void;
}

export interface RuntimeUdpConnection extends RuntimeConnection {
  sendTo(data: Uint8Array, host: string, port: number): void;
}

export interface RuntimeBridge {
  close?(): void;
  run(callbacks: RuntimeCallbacks): void;
  login(): void;
  logout(): void;
  listExitNodes(): readonly MoonScaleExitNode[];
  setExitNode(id: string, options?: MoonScaleExitNodeOptions): Promise<void>;
  clearExitNode(): Promise<void>;
  exitNode(): { id: string; routeAll: boolean; allowLANAccess: boolean };
  dialTcp(host: string, port: number, callbacks: MoonScaleConnectionCallbacks): { close(): void };
  dialUdp(host: string, port: number, callbacks: MoonScaleConnectionCallbacks): { close(): void };
  listenTcp(host: string, port: number, callbacks: MoonScaleListenerCallbacks): { close(): void };
  listenUdp(host: string, port: number, callbacks: MoonScaleUdpListenerCallbacks): { close(): void };
}

export interface RuntimeCallbacks {
  notifyState(state: MoonScaleState): void;
  notifyNetMap(netmap: string): void;
  notifyBrowseToURL(url: string): void;
  notifyPanicRecover(message: string): void;
  notifyRunning?(): void;
}

export interface MoonScaleListenerCallbacks {
  onListening(listener: { close(): void }): void;
  onConnection(connection: RuntimeConnection, peer: MoonScaleTcpPeer): void;
  onError(message: string): void;
  onClose(message?: string): void;
}

export interface MoonScaleUdpListenerCallbacks {
  onListening(listener: { close(): void }): void;
  onMessage(data: Uint8Array, peer: MoonScaleTcpPeer, socket: RuntimeUdpConnection): void;
  onError(message: string): void;
  onClose(message?: string): void;
}

export interface RuntimeModule {
  createIPN(config: RuntimeConfig): Promise<RuntimeBridge>;
}

export interface RuntimeConfig {
  authKey?: string;
  hostname?: string;
  controlURL?: string;
  stateStorage?: MoonScaleStateStorage;
  wasmURL?: string;
  panicHandler(message: string): void;
}

export type RuntimeModuleLoader = () => Promise<unknown>;

export interface MoonScaleTcpSocket {
  send(data: Uint8Array): void;
  close(): void;
  on(event: 'data', listener: (data: Uint8Array) => void): () => void;
  on(event: 'close', listener: (message?: string) => void): () => void;
  on(event: 'error', listener: (error: Error) => void): () => void;
}

export interface MoonScaleUdpSocket extends MoonScaleTcpSocket {
  sendTo(data: Uint8Array, host: string, port: number): void;
}

export interface MoonScaleTcpPeer {
  host: string;
  port: number;
}

export interface MoonScaleTcpListener {
  close(): void;
}

export interface MoonScaleUdpListener {
  close(): void;
}

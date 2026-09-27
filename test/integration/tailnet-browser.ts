import type { Page } from '@playwright/test';

type TailnetStatus = {
  hasTailnetAddress: boolean;
  selectedExitNodeID?: string;
};

type TailnetTimeoutStatus = {
  states: readonly string[];
  observedNetcheckRequests: {
    started: number;
    failed: number;
    successfulResponses: number;
  };
  netcheckLogObserved: boolean;
  moduleLoaded: boolean;
  clientCreated: boolean;
  stateCallbackReceived: boolean;
  authURLReceived: boolean;
  netmapCallbackReceived: boolean;
  netmapReceived: boolean;
  heartbeat: {
    animationFrames: number;
    timers: number;
    maximumGapMS: number;
  };
  netcheckRequests: {
    started: number;
    completed: number;
    failed: number;
    successfulResponses: number;
  };
  phaseTimingsMS: {
    moduleLoad?: number;
    clientCreate?: number;
    stateCallback?: number;
    netmapCallback?: number;
  };
};

type TailnetFailure = { failure: TailnetTimeoutStatus };

const lifecycleStates = new Set([
  'NoState',
  'NeedsLogin',
  'NeedsMachineAuth',
  'Starting',
  'Running',
  'Stopped',
  'InUseOtherUser',
]);
const cleanupTimeout = 5_000;
const diagnosticTimingMaximum = 60_000;

type CloseableTailnetClient = {
  close(): Promise<void>;
};

export async function closeTailnetClient(client: CloseableTailnetClient): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, cleanupTimeout);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatTailnetTimeoutStatus(status: TailnetTimeoutStatus): string {
  const states = status.states.filter((state) => lifecycleStates.has(state)).slice(0, 16);
  const timing = (value: number | undefined) => value === undefined
    ? 'none'
    : String(Math.min(diagnosticTimingMaximum, Math.max(0, Math.floor(value))));
  const { phaseTimingsMS, heartbeat, netcheckRequests, observedNetcheckRequests } = status;
  return `tailnet browser integration timed out: states=${states.join(',')}; moduleLoaded=${status.moduleLoaded}; clientCreated=${status.clientCreated}; stateCallbackReceived=${status.stateCallbackReceived}; authURLReceived=${status.authURLReceived}; netmapCallbackReceived=${status.netmapCallbackReceived}; netmapReceived=${status.netmapReceived}; netcheckLogObserved=${status.netcheckLogObserved}; heartbeat=animationFrames:${heartbeat.animationFrames},timers:${heartbeat.timers},maximumGapMS:${timing(heartbeat.maximumGapMS)}; netcheckRequests=started:${netcheckRequests.started},completed:${netcheckRequests.completed},failed:${netcheckRequests.failed},successfulResponses:${netcheckRequests.successfulResponses}; observedNetcheckRequests=started:${observedNetcheckRequests.started},failed:${observedNetcheckRequests.failed},successfulResponses:${observedNetcheckRequests.successfulResponses}; phaseTimingsMS=moduleLoad:${timing(phaseTimingsMS.moduleLoad)},clientCreate:${timing(phaseTimingsMS.clientCreate)},stateCallback:${timing(phaseTimingsMS.stateCallback)},netmapCallback:${timing(phaseTimingsMS.netmapCallback)}`;
}

export function redactTailnetError(_error: unknown, _authKey: string): Error {
  return new Error('tailnet browser integration failed');
}

export async function listExitNodesAfterNeedsLogin(page: Page, baseURL: string): Promise<{ states: readonly string[]; exitNodeCount: number }> {
  await page.goto(baseURL);
  return page.evaluate(async ({ baseURL }) => {
    const states: string[] = [];
    const errors: string[] = [];
    window.addEventListener('error', (event) => errors.push(event.message));
    window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
    const moonScale = await import(`${baseURL}/moonscale/index.js`);
    const client = await moonScale.MoonScaleClient.create({
      wasmURL: `${baseURL}/runtime/main.wasm`,
      onState: (state: string) => states.push(state),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('did not reach NeedsLogin')), 15_000);
        const check = () => {
          if (states.includes('NeedsLogin')) {
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      });
      const exitNodeCount = client.listExitNodes().length;
      if (errors.length) throw new Error(errors.join('\n'));
      return { states, exitNodeCount };
    } finally {
      await client.close();
    }
  }, { baseURL });
}

export async function runTailnet(page: Page, baseURL: string, authKey: string, exitNodeID?: string): Promise<TailnetStatus> {
  let result: TailnetStatus | TailnetFailure;
  let netcheckLogObserved = false;
  const observedNetcheckRequests = { started: 0, failed: 0, successfulResponses: 0 };
  page.on('console', (message) => {
    if (message.text().includes('running HTTP-only netcheck')) netcheckLogObserved = true;
  });
  page.on('request', (request) => {
    if (request.url().includes('/derp/probe')) observedNetcheckRequests.started += 1;
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/derp/probe')) observedNetcheckRequests.failed += 1;
  });
  page.on('response', (response) => {
    if (response.url().includes('/derp/probe') && response.ok()) observedNetcheckRequests.successfulResponses += 1;
  });
  try {
    await page.goto(baseURL);
    result = await page.evaluate(async ({ baseURL, authKey, exitNodeID }): Promise<TailnetStatus | TailnetFailure> => {
      const lifecycleStates = new Set([
        'NoState',
        'NeedsLogin',
        'NeedsMachineAuth',
        'Starting',
        'Running',
        'Stopped',
        'InUseOtherUser',
      ]);
      const cleanupTimeout = 5_000;
      const diagnosticTimingMaximum = 60_000;
      const startedAt = performance.now();
      const elapsed = (started: number) => Math.min(diagnosticTimingMaximum, Math.max(0, performance.now() - started));
      let animationFrames = 0;
      let timers = 0;
      let maximumGapMS = 0;
      let lastHeartbeatAt = startedAt;
      let heartbeatActive = true;
      const heartbeat = () => {
        if (!heartbeatActive) return;
        const now = performance.now();
        maximumGapMS = Math.max(maximumGapMS, now - lastHeartbeatAt);
        lastHeartbeatAt = now;
        animationFrames += 1;
        requestAnimationFrame(heartbeat);
      };
      requestAnimationFrame(heartbeat);
      const heartbeatTimer = setInterval(() => {
        const now = performance.now();
        maximumGapMS = Math.max(maximumGapMS, now - lastHeartbeatAt);
        lastHeartbeatAt = now;
        timers += 1;
      }, 50);
      let netcheckRequestsStarted = 0;
      let netcheckRequestsCompleted = 0;
      let netcheckRequestsFailed = 0;
      let netcheckSuccessfulResponses = 0;
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const request = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
        const isNetcheckProbe = request.url.includes('/derp/probe');
        if (isNetcheckProbe) netcheckRequestsStarted += 1;
        try {
          const response = await nativeFetch(...args);
          if (isNetcheckProbe) {
            netcheckRequestsCompleted += 1;
            if (response.ok) netcheckSuccessfulResponses += 1;
          }
          return response;
        } catch (error) {
          if (isNetcheckProbe) netcheckRequestsFailed += 1;
          throw error;
        }
      };
      const states: string[] = [];
      let moduleLoaded = false;
      let clientCreated = false;
      let stateCallbackReceived = false;
      let authURLReceived = false;
      let netmapCallbackReceived = false;
      let netmapReceived = false;
      let moduleLoadMS: number | undefined;
      let clientCreateStartedAt: number | undefined;
      let clientCreateMS: number | undefined;
      let stateCallbackMS: number | undefined;
      let netmapCallbackMS: number | undefined;
      const diagnostics = () => ({
        states,
        moduleLoaded,
        clientCreated,
        stateCallbackReceived,
        authURLReceived,
        netmapCallbackReceived,
        netmapReceived,
        heartbeat: {
          animationFrames,
          timers,
          maximumGapMS,
        },
        netcheckRequests: {
          started: netcheckRequestsStarted,
          completed: netcheckRequestsCompleted,
          failed: netcheckRequestsFailed,
          successfulResponses: netcheckSuccessfulResponses,
        },
        phaseTimingsMS: {
          moduleLoad: moduleLoadMS ?? elapsed(startedAt),
          clientCreate: clientCreateStartedAt === undefined ? undefined : clientCreateMS ?? elapsed(clientCreateStartedAt),
          stateCallback: stateCallbackMS,
          netmapCallback: netmapCallbackMS,
        },
      });

      let client: {
        clearExitNode(): Promise<void>;
        close(): Promise<void>;
        exitNode?: { id: string; routeAll: boolean };
        listExitNodes(): Array<{ id: string }>;
        setExitNode(id: string): Promise<void>;
      } | undefined;
      let result: TailnetStatus | TailnetFailure | undefined;
      try {
        const moonScale = await import(`${baseURL}/moonscale/index.js`);
        moduleLoaded = true;
        moduleLoadMS = elapsed(startedAt);
        const hasTailnetAddress = await new Promise<boolean>(async (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('tailnet browser integration timed out')), 60_000);
          try {
            clientCreateStartedAt = performance.now();
            client = await moonScale.MoonScaleClient.create({
              authKey,
              wasmURL: `${baseURL}/runtime/main.wasm`,
              onState: (state) => {
                stateCallbackReceived = true;
                stateCallbackMS ??= elapsed(startedAt);
                if (states.length < 16 && lifecycleStates.has(state)) states.push(state);
              },
              onAuthURL: () => {
                authURLReceived = true;
              },
              onNetMap: (netmap) => {
                netmapCallbackReceived = true;
                netmapCallbackMS ??= elapsed(startedAt);
                netmapReceived = true;
                if (netmap.self.addresses.some((address) => address.startsWith('100.'))) {
                  clearTimeout(timeout);
                  resolve(true);
                }
              },
            });
            client.login();
            clientCreated = true;
            clientCreateMS = elapsed(clientCreateStartedAt);
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });

        if (!exitNodeID) {
          result = { hasTailnetAddress };
        } else if (!client?.listExitNodes().some((node) => node.id === exitNodeID)) {
          throw new Error('configured exit node is not eligible');
        } else {
          await client.setExitNode(exitNodeID);
          if (client.exitNode?.id !== exitNodeID || !client.exitNode.routeAll) {
            throw new Error('configured exit node was not selected');
          }
          result = { hasTailnetAddress, selectedExitNodeID: client.exitNode.id };
        }
      } catch {
        result = { failure: diagnostics() };
      }
      if (client) {
        try {
          if (exitNodeID) await client.clearExitNode();
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              client.close().catch(() => undefined),
              new Promise<void>((resolve) => {
                cleanupTimer = setTimeout(resolve, cleanupTimeout);
              }),
            ]);
          } finally {
            if (cleanupTimer) clearTimeout(cleanupTimer);
          }
        } catch {
          result = { failure: diagnostics() };
        }
      }
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
      return result ?? { failure: diagnostics() };
    }, { baseURL, authKey, exitNodeID });
    if ('failure' in result) {
      result.failure.observedNetcheckRequests = observedNetcheckRequests;
      result.failure.netcheckLogObserved = netcheckLogObserved;
    }
  } catch (error) {
    throw redactTailnetError(error, authKey);
  }
  if ('failure' in result) throw new Error(formatTailnetTimeoutStatus(result.failure));
  return result;
}

import type { RuntimeBridge, RuntimeConfig, RuntimeModule, RuntimeModuleLoader } from './types.js';

function isBridge(value: unknown): value is RuntimeBridge {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['run', 'login', 'logout', 'listExitNodes', 'setExitNode', 'clearExitNode', 'exitNode', 'dialTcp', 'dialUdp', 'listenTcp', 'listenUdp'].every((name) => typeof candidate[name] === 'function');
}

export function validateRuntimeModule(module: unknown): RuntimeModule {
  if (!module || typeof module !== 'object' || typeof (module as Partial<RuntimeModule>).createIPN !== 'function') {
    throw new Error('@nightnetwork/moonscale/runtime does not export createIPN');
  }
  return {
    async createIPN(config) {
      const bridge = await (module as RuntimeModule).createIPN(config);
      if (!isBridge(bridge)) throw new Error('@nightnetwork/moonscale/runtime returned an invalid IPN bridge');
      return bridge;
    },
  };
}

export const loadRuntimeModule: RuntimeModuleLoader = async () => {
  if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined' || typeof window === 'undefined') {
    throw new Error('@nightnetwork/moonscale runtime requires a browser with WebAssembly and fetch support');
  }
  try {
    return await import(new URL('./runtime/runtime.js', import.meta.url).href);
  } catch (error) {
    throw new Error('Unable to load @nightnetwork/moonscale runtime assets. Run the package build before publishing.', { cause: error });
  }
};

export async function createRuntimeBridge(config: RuntimeConfig, loader = loadRuntimeModule): Promise<RuntimeBridge> {
  return validateRuntimeModule(await loader()).createIPN(config);
}

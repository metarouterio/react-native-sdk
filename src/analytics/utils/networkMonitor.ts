import { warn } from './logger';

export type NetworkStatus = 'connected' | 'disconnected';

export interface NetworkReachability {
  /** Current connectivity snapshot */
  readonly currentStatus: NetworkStatus;
  /**
   * Whether the default network is wifi; `null` when unknown: before the
   * native module's first reading, without the module, after stop(), or
   * when native could not read the interface.
   * Read per event by enrichment for `context.network.wifi`.
   */
  readonly isWifi: boolean | null;
  /**
   * `isWifi`, waiting up to `timeoutMs` for the native module's first reading
   * when none has arrived yet. Once a reading arrives or one wait times out,
   * it returns at once.
   */
  awaitIsWifi(timeoutMs: number): Promise<boolean | null>;
  /** Register callback for status transitions. Returns unsubscribe function. */
  onStatusChange(handler: (status: NetworkStatus) => void): () => void;
  /** Tear down monitoring */
  stop(): void;
}

/**
 * Native state as either module build reports it. Modules built before wifi
 * tracking (host app not rebuilt since upgrading) resolve a bare boolean and
 * send events without `isWifi`, so wifi stays unknown rather than guessed.
 */
function parseNativeState(raw: unknown): {
  connected: boolean;
  wifi: boolean | null;
} {
  if (typeof raw === 'boolean') return { connected: raw, wifi: null };
  const state = (raw ?? {}) as { isConnected?: unknown; isWifi?: unknown };
  return {
    connected: state.isConnected !== false,
    wifi: typeof state.isWifi === 'boolean' ? state.isWifi : null,
  };
}

export class NetworkMonitor implements NetworkReachability {
  private _currentStatus: NetworkStatus = 'connected';
  private _isWifi: boolean | null = null;
  private handler: ((status: NetworkStatus) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private receivedNativeEvent = false;
  private stopped = false;
  // Set once a first reading has arrived or none is coming (no module, failed
  // read, a timed-out wait, stop()): later waits return at once.
  private stopWaiting = false;
  private wifiWaiters: Array<(wifi: boolean | null) => void> = [];

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  get isWifi(): boolean | null {
    return this._isWifi;
  }

  constructor() {
    try {
      const { NativeModules, NativeEventEmitter } = require('react-native');
      const MetaRouterNetworkMonitor = NativeModules.MetaRouterNetworkMonitor;
      if (!MetaRouterNetworkMonitor)
        throw new Error('Native module not available');

      // Get initial state from native — skip if a live event already arrived
      MetaRouterNetworkMonitor.getCurrentStatus()
        .then((raw: unknown) => {
          if (this.receivedNativeEvent) return;
          const { connected, wifi } = parseNativeState(raw);
          this.apply(connected, wifi);
        })
        .catch((err: unknown) => {
          this.settleWaiters();
          warn(
            'Failed to get initial network status, defaulting to connected',
            err
          );
        });

      // Subscribe to native connectivity events
      const emitter = new NativeEventEmitter(MetaRouterNetworkMonitor);
      const subscription = emitter.addListener(
        'onConnectivityChange',
        (event: unknown) => {
          this.receivedNativeEvent = true;
          const { connected, wifi } = parseNativeState(event);
          this.apply(connected, wifi);
        }
      );

      this.unsubscribe = () => subscription.remove();
    } catch (err) {
      this.stopWaiting = true;
      warn(
        'Native network monitor not available, defaulting to connected',
        err
      );
    }
  }

  private apply(connected: boolean, wifi: boolean | null): void {
    // A reading already in flight when stop() ran would otherwise restore the
    // wifi value stop() cleared, and every later event would stamp it.
    if (this.stopped) return;
    // Every reading is authoritative, unknown included: native reports null
    // when it can't read the interface, and keeping the last-known value then
    // would stamp a stale one. The iOS module answers its first status call
    // only once it has a path, so the first reading is the one to wait for.
    this._isWifi = wifi;
    this.settleWaiters();
    const newStatus: NetworkStatus = connected ? 'connected' : 'disconnected';
    if (newStatus !== this._currentStatus) {
      this._currentStatus = newStatus;
      this.handler?.(newStatus);
    }
  }

  private settleWaiters(): void {
    this.stopWaiting = true;
    const waiters = this.wifiWaiters;
    this.wifiWaiters = [];
    for (const resolve of waiters) resolve(this._isWifi);
  }

  awaitIsWifi(timeoutMs: number): Promise<boolean | null> {
    if (this._isWifi !== null || this.stopWaiting || !(timeoutMs > 0)) {
      return Promise.resolve(this._isWifi);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleWaiters(), timeoutMs);
      this.wifiWaiters.push((wifi) => {
        clearTimeout(timer);
        resolve(wifi);
      });
    });
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handler = null;
    // Unknown, not last-known: a stopped monitor sees no further switches, and
    // stamping a frozen value is the staleness per-event reads exist to remove.
    this.stopped = true;
    this._isWifi = null;
    this.settleWaiters();
  }
}

export class StubNetworkMonitor implements NetworkReachability {
  private _currentStatus: NetworkStatus;
  private handler: ((status: NetworkStatus) => void) | null = null;

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  /** Settable from tests to simulate an interface switch. */
  isWifi: boolean | null;

  constructor(
    initialStatus: NetworkStatus = 'connected',
    isWifi: boolean | null = null
  ) {
    this._currentStatus = initialStatus;
    this.isWifi = isWifi;
  }

  awaitIsWifi(): Promise<boolean | null> {
    return Promise.resolve(this.isWifi);
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    this.handler = null;
  }

  /** Simulate a network transition from tests */
  simulate(status: NetworkStatus): void {
    if (status !== this._currentStatus) {
      this._currentStatus = status;
      this.handler?.(status);
    }
  }
}

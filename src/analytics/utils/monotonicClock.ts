import { NativeModules } from 'react-native';
import { warn } from './logger';

interface NativeClockModule {
  continuousMillis(): number;
}

// Resolved once: touch() reads the clock on every enriched event.
let nativeClock: NativeClockModule | null | undefined;
// Last good native reading and the wall time it was taken at. A fallback after
// native readings continues from here: switching straight to Date.now() would
// jump from boot-relative to epoch milliseconds, and the session manager would
// read that jump as decades of inactivity and roll the session over.
let lastNative: { value: number; wall: number } | null = null;

/**
 * Milliseconds on a monotonic clock that keeps counting through device sleep —
 * `mach_continuous_time` on iOS, `SystemClock.elapsedRealtime` on Android, the
 * same clocks the native SDKs measure session inactivity with. Read
 * synchronously from the MetaRouterClock native module.
 *
 * Not `performance.now()`: React Native backs it with clocks that stop while
 * the device sleeps, so an app backgrounded on a phone locked for hours would
 * resume into the same session. Without the native module (e.g. Expo Go), or
 * once a synchronous call fails, this falls back to wall-clock for the rest of
 * the process with a one-time warning: sleep is then measured, but a clock
 * change can end or stretch a session.
 */
export function continuousMillis(): number {
  if (nativeClock === undefined) {
    const mod = NativeModules.MetaRouterClock as NativeClockModule | undefined;
    nativeClock = mod ?? null;
    if (!mod) {
      warn(
        'MetaRouterClock native module is not available. Session inactivity is measured on the wall clock.'
      );
    }
  }
  if (nativeClock) {
    try {
      const value: unknown = nativeClock.continuousMillis();
      if (typeof value === 'number' && Number.isFinite(value)) {
        lastNative = { value, wall: Date.now() };
        return value;
      }
      throw new Error(`continuousMillis returned ${String(value)}`);
    } catch (err) {
      // A sync native call can throw where blocking methods are unsupported
      // (Chrome remote debugging, some interop setups). Every track() reads
      // this clock, so the failure must not reach host code; fall back for the
      // rest of the process rather than alternating between two clocks.
      nativeClock = null;
      warn(
        'MetaRouterClock native call failed; session inactivity is measured on the wall clock from now on.',
        err
      );
    }
  }
  return lastNative
    ? lastNative.value + (Date.now() - lastNative.wall)
    : Date.now();
}

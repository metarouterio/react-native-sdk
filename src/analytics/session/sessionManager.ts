import { continuousMillis } from '../utils/monotonicClock';
import {
  loadSession,
  saveLastActivity,
  saveSession,
  type StoredSession,
} from '../utils/sessionStorage';

/**
 * Emitted when a new session is minted and `fireSessionStarted` is on. The
 * name matches the web SDK's session-management sync verbatim (the pipeline
 * snake_cases it to `session_started`), so mappings keyed on the event name
 * treat every platform as one.
 */
export const SESSION_STARTED_EVENT = 'Session Started';

export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/**
 * The persisted last-activity only matters across a process restart, where its
 * precision competes with a timeout of at least one minute — a write per event
 * is pure AsyncStorage churn under a chatty producer (rapid screen tracking).
 * Under a monotone wall clock, a crash loses at most this much of the window.
 */
export const PERSIST_THROTTLE_MS = 5_000;

/**
 * The session an event belongs to.
 * - `sessionId`: epoch ms of the session's first activity, as a string — the
 *   format the web SDK's MetaRouter session mints.
 * - `sessionCount`: lifetime session ordinal for this install, from 1.
 * - `startedNewSession`: true exactly once per session, on the touch that
 *   minted it.
 */
export interface SessionInfo {
  sessionId: string;
  sessionCount: number;
  startedNewSession: boolean;
}

export interface SessionManagerDeps {
  load?: () => Promise<StoredSession>;
  saveSession?: typeof saveSession;
  saveLastActivity?: typeof saveLastActivity;
  wallClockMs?: () => number;
  monotonicClockMs?: () => number;
}

/**
 * Owns the sliding-inactivity session: mints, extends and rolls it over, with
 * the same rules as the iOS and Android SessionManager.
 *
 * A session ends after `timeoutMinutes` of inactivity, where activity is any
 * touch() — one per outbound event. The window slides: steady activity extends
 * the session indefinitely (web MetaRouter session and GA4's app-session
 * model), NOT the web GA4 injector's from-start cap.
 *
 * Two clocks, on purpose:
 * - In-process inactivity is measured on a monotonic clock that counts through
 *   sleep. Wall-clock can jump minutes either way (NTP, user changes the time)
 *   and would end or immortalize a session that saw no real inactivity.
 * - Across restarts only wall-clock survives, so the persisted last-activity is
 *   epoch ms. A persisted reading from the future (clock set back since) is
 *   treated as expired: resuming would make the session immortal until the
 *   clock catches up, while minting costs one extra session.
 *
 * Rollover uses `>` (exactly `timeout` old is still the same session) to stay
 * boundary-identical with web, iOS and Android.
 *
 * AsyncStorage is async but enrichment is not, so the persisted state is read
 * once by load() — which init() awaits before any event can be enriched — and
 * every write after that is fire-and-forget. JS is single-threaded, so the
 * native locks have no counterpart here.
 */
export class SessionManager {
  private readonly timeoutMs: number;
  private readonly load: () => Promise<StoredSession>;
  private readonly persistSession: typeof saveSession;
  private readonly persistLastActivity: typeof saveLastActivity;
  private readonly wallClockMs: () => number;
  private readonly monotonicClockMs: () => number;

  private stored: StoredSession | null = null;
  private sessionId: string | null = null;
  private sessionCount = 0;
  private lastActivityMono = 0;
  private lastActivityWall = 0;
  private lastPersistedMono = 0;
  private onSessionStart: ((info: SessionInfo) => void) | null = null;

  constructor(
    timeoutMinutes: number = DEFAULT_SESSION_TIMEOUT_MINUTES,
    deps: SessionManagerDeps = {}
  ) {
    // Clamped with a warning at the InitOptions boundary; by here a
    // non-positive timeout is SDK-internal misuse, not user input.
    if (!(timeoutMinutes > 0)) {
      throw new Error('timeoutMinutes must be > 0');
    }
    this.timeoutMs = timeoutMinutes * 60_000;
    this.load = deps.load ?? loadSession;
    this.persistSession = deps.saveSession ?? saveSession;
    this.persistLastActivity = deps.saveLastActivity ?? saveLastActivity;
    this.wallClockMs = deps.wallClockMs ?? Date.now;
    this.monotonicClockMs = deps.monotonicClockMs ?? continuousMillis;
  }

  /**
   * Reads the persisted session so the first touch can resume it. Must settle
   * before the first touch(); a touch without it mints a new session over the
   * stored one. A no-op once this process has a session.
   */
  async loadPersisted(): Promise<void> {
    if (this.sessionId !== null) return;
    this.stored = await this.load();
  }

  /**
   * Writes the latest activity now, skipping the throttle. Called on reset():
   * the next client resumes from storage, and a write held back by the
   * throttle would leave it up to a throttle window short.
   */
  persistActivity(): void {
    if (this.sessionId === null) return;
    this.persistLastActivity(this.lastActivityWall);
  }

  /**
   * Handler for "a new session was minted". Set before events can flow: a
   * handler installed after the install's first mint drops its Session
   * Started, which never recurs for that session.
   */
  setOnSessionStart(handler: ((info: SessionInfo) => void) | null): void {
    this.onSessionStart = handler;
  }

  /**
   * Records activity and returns the session it belongs to, minting or rolling
   * over first when the inactivity window has lapsed. Call once per outbound
   * event.
   */
  touch(): SessionInfo {
    const wallNow = this.wallClockMs();
    const monoNow = this.monotonicClockMs();
    let info: SessionInfo;

    if (this.sessionId !== null) {
      if (monoNow - this.lastActivityMono > this.timeoutMs) {
        info = this.mint(wallNow, monoNow);
      } else {
        this.lastActivityMono = monoNow;
        this.lastActivityWall = wallNow;
        if (monoNow - this.lastPersistedMono >= PERSIST_THROTTLE_MS) {
          this.persistLastActivity(wallNow);
          this.lastPersistedMono = monoNow;
        }
        info = {
          sessionId: this.sessionId,
          sessionCount: this.sessionCount,
          startedNewSession: false,
        };
      }
    } else {
      // First touch of this process: resume the persisted session when the
      // restart happened inside the inactivity window.
      const stored = this.stored;
      if (
        stored?.id != null &&
        stored.lastActivityMs != null &&
        stored.lastActivityMs <= wallNow &&
        wallNow - stored.lastActivityMs <= this.timeoutMs
      ) {
        this.sessionId = stored.id;
        this.sessionCount = stored.count ?? 1;
        this.lastActivityMono = monoNow;
        this.lastActivityWall = wallNow;
        // Once per process — no throttle; skipping it would leave the
        // pre-restart timestamp in place for up to a throttle window.
        this.persistLastActivity(wallNow);
        this.lastPersistedMono = monoNow;
        info = {
          sessionId: stored.id,
          sessionCount: this.sessionCount,
          startedNewSession: false,
        };
      } else {
        info = this.mint(wallNow, monoNow);
      }
    }

    if (info.startedNewSession) {
      // Deferred so the event that minted the session is enqueued first, as on
      // iOS and Android, where Session Started rides a later task. Its own
      // enrichment re-enters touch() and sees startedNewSession=false, so the
      // handler cannot loop.
      const handler = this.onSessionStart;
      if (handler) {
        Promise.resolve(info)
          .then(handler)
          .catch(() => {});
      }
    }
    return info;
  }

  /**
   * The current session without recording activity — a read must not extend
   * the window, or a diagnostics poller could keep a session alive forever.
   * Null before the first touch() of the process.
   */
  peek(): SessionInfo | null {
    if (this.sessionId === null) return null;
    return {
      sessionId: this.sessionId,
      sessionCount: this.sessionCount,
      startedNewSession: false,
    };
  }

  private mint(wallNow: number, monoNow: number): SessionInfo {
    // Continue the persisted lifetime counter even when the session itself
    // expired — the ordinal is per install, not per session chain.
    const previousCount =
      this.sessionCount > 0 ? this.sessionCount : (this.stored?.count ?? 0);
    const newId = String(wallNow);
    this.sessionId = newId;
    this.sessionCount = previousCount + 1;
    this.lastActivityMono = monoNow;
    this.lastActivityWall = wallNow;
    this.persistSession(newId, this.sessionCount, wallNow);
    this.lastPersistedMono = monoNow;
    return {
      sessionId: newId,
      sessionCount: this.sessionCount,
      startedNewSession: true,
    };
  }
}

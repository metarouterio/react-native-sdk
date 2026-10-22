# @metarouter/react-native-sdk

[![npm version](https://img.shields.io/npm/v/@metarouter/react-native-sdk)](https://www.npmjs.com/package/@metarouter/react-native-sdk)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A lightweight React Native analytics SDK that transmits events to your MetaRouter cluster.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Basic Setup](#basic-setup)
  - [React Context Usage](#react-context-usage)
  - [Direct Usage](#direct-usage)
- [API Reference](#api-reference)
- [Features](#features)
- [Disk-Backed Queue Persistence](#disk-backed-queue-persistence)
- [Application Lifecycle Events](#application-lifecycle-events)
- [Session Tracking](#session-tracking)
- [Compatibility](#-compatibility)
- [Debugging](#debugging)
- [Identity Persistence](#identity-persistence)
- [Advertising ID (IDFA/GAID)](#advertising-id-idfagaid)
- [Using the alias() Method](#using-the-alias-method)
- [License](#license)

## Installation

```sh
npm install @metarouter/react-native-sdk @react-native-async-storage/async-storage react-native-device-info
```

After installing or upgrading, run `cd ios && pod install` and rebuild the native app. This release includes native iOS and Android modules for queue persistence, so a JavaScript-only reload is not sufficient.

## Usage

### Basic Setup

```js
import { createAnalyticsClient } from "@metarouter/react-native-sdk";

// Returns the client right away; initialization finishes in the background
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
  debug: __DEV__, // Optional: verbose logs, never in a store release
  flushIntervalSeconds: 30, // Optional: flush events every 30 seconds
});
```

### React Context Usage

```jsx
import React from "react";
import {
  createAnalyticsClient,
  MetaRouterProvider,
  useMetaRouter,
} from "@metarouter/react-native-sdk";

// Create the client once, outside any component. It is usable immediately:
// there is no promise to await, and nothing to catch in a release build.
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

const App = () => (
  <MetaRouterProvider analyticsClient={analytics}>
    <YourApp />
  </MetaRouterProvider>
);

// Use analytics in any component
const MyComponent = () => {
  const { analytics } = useMetaRouter();

  const handleButtonPress = () => {
    analytics.track("Button Pressed", {
      buttonName: "submit",
      timestamp: Date.now(),
    });
  };

  return <Button onPress={handleButtonPress} title="Submit" />;
};
```

### Direct Usage

```js
import { createAnalyticsClient } from "@metarouter/react-native-sdk";

// Usable immediately: calls made before initialization finishes are
// buffered and sent once the client is ready.
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

// Track events
analytics.track("User Action", {
  action: "button_click",
  screen: "home",
});

// Identify users
analytics.identify("user123", {
  name: "John Doe",
  email: "john@example.com",
});

// Track screen views
analytics.screen("Home Screen", {
  category: "navigation",
});

// Track page views
analytics.page("Home Page", {
  url: "/home",
  referrer: "/landing",
});

// Group users
analytics.group("company123", {
  name: "Acme Corp",
  industry: "technology",
});

// Flush events immediately
analytics.flush();

// Reset analytics (useful for testing or logout)
await analytics.reset();
```

### Reconfiguring the Analytics Client

⚠️ **Important**: If you need to change the analytics configuration (e.g., different `writeKey` or `ingestionHost`), you must call `reset()` first:

```js
// Initial configuration
const analytics = createAnalyticsClient({
  writeKey: "key-1",
  ingestionHost: "https://endpoint-1.com",
});

// Later, if you need to change configuration:
await analytics.reset(); // Must reset first!

// Now reconfigure with new options. The same client object is returned, so
// existing references (and MetaRouterProvider) keep working.
createAnalyticsClient({
  writeKey: "key-2",
  ingestionHost: "https://endpoint-2.com",
});
```

If you call `createAnalyticsClient()` with different options without resetting first, you'll see this warning:

```
[MetaRouter] Config changed but client not reset. Call await client.reset() before reinitializing with new options.
```

## API Reference

### createAnalyticsClient(options)

Starts initialization and returns a **live proxy** to the client instance, synchronously. It does not return a Promise, so there is nothing to `await`, and in a release build nothing to `catch`: invalid options never throw there (development builds throw so the mistake surfaces at the call site). See [Invalid configuration](#invalid-configuration).

Calls to `track`, `identify`, etc. are **buffered in-memory** by the proxy and replayed **in order** once the client is fully initialized.

**Options:**

- `writeKey` (string, required): Your MetaRouter write key. Trimmed; empty or whitespace-only is a config error.
- `ingestionHost` (string, required): Your MetaRouter ingestion endpoint: an `http`/`https` URL with a host. Trimmed, and trailing slashes are removed. Cleartext `http` logs a warning unless the host is `localhost`, `127.0.0.1` or `::1`.
- `flushIntervalSeconds` (number, optional, default: `10`): How often the SDK attempts to send queued events. Values below 1 are clamped to 1.
- `debug` (boolean, optional, default: `false`): Enables verbose SDK logging. Can also be toggled at runtime via `analytics.enableDebugLogging()`.
- `maxQueueEvents` (number, optional, default: `2000`): Maximum events held in the in-memory queue. Values below 1 are clamped to 1. The queue is also bounded by a 5 MB byte cap — whichever limit is reached first triggers drop-oldest eviction.
- `maxDiskEvents` (number, optional, default: `10000`): Maximum unsent events retained on disk for crash safety and offline recovery. Negative values are clamped to `0` with a warning. Set to `0` to disable disk persistence (events are lost on app kill).
- `trackLifecycleEvents` (boolean, optional, default: `false`): Opt-in. Set to `true` to emit `Application Installed`, `Application Updated`, `Application Opened`, and `Application Backgrounded` events automatically. See [Application Lifecycle Events](#application-lifecycle-events).
- `sessionTimeoutMinutes` (number, optional, default: `30`): Minutes of inactivity after which the next event starts a new session. Values below 1 are clamped to 1. See [Session Tracking](#session-tracking).
- `fireSessionStarted` (boolean, optional, default: `false`): Emit a `Session Started` track event each time a new session starts. See [Session Tracking](#session-tracking).
- `onConfigError` (function, optional): Called with a `ConfigError` (`type`, `description`, and `raw` for a bad host) when the options are invalid in a release build. See [Invalid configuration](#invalid-configuration).

Out-of-range numbers are clamped and logged as a warning; they never fail initialization.

**Proxy behavior (quick notes):**

- Buffer is **in-memory only** (not persisted). Calls made before ready are lost if the process exits.
- Ordering is preserved relative to other buffered calls; normal FIFO + batching applies after ready.
- On fatal config errors from the ingestion host (`401/403/404`), the client enters **disabled** state and drops subsequent calls. This is separate from [invalid options](#invalid-configuration) and does not call `onConfigError`.
- `sentAt` is stamped when the batch is prepared for transmission (just before network send). If you need the original occurrence time, pass your own `timestamp` on each event.

### Invalid configuration

Invalid options (an empty `writeKey`, or an `ingestionHost` that is not an `http`/`https` URL with a host) never crash a release build. The same rules apply on iOS and Android.

| Build | What happens |
| ----- | ------------ |
| Development (`__DEV__`) | `createAnalyticsClient` throws `Invalid InitOptions: <reason>`, so the mistake shows up immediately at the call site. |
| Release | An always-on error is logged (`[MetaRouter] MetaRouter disabled for this session — <reason>`), `onConfigError` is called once, synchronously, and the SDK stays inert for the session: calls are accepted and nothing is sent. |

While the session is disabled:

- `getAnonymousId()` resolves `""` instead of waiting, and `flush()` resolves immediately.
- `getDebugInfo()` returns `lifecycle: "disabled"` and the reason as `configError`.
- Calls made while disabled are kept (up to the usual 20) and sent if the session recovers.

A later `createAnalyticsClient` with valid options recovers the session, and so does `reset()`. An invalid call made while a valid session is running disables that session too, rather than leaving the old configuration running unnoticed.

Disabling a running session resets its client, which clears the stored identity (anonymous ID, user ID, group ID, advertising ID), the same as the Android SDK. A single invalid call between two valid ones therefore starts the recovered session as a new anonymous user.

```js
const analytics = createAnalyticsClient({
  writeKey: remoteConfig.writeKey,
  ingestionHost: remoteConfig.ingestionHost,
  onConfigError: (error) => {
    // error.type is "emptyWriteKey" or "invalidIngestionHost" (with error.raw);
    // error.description is the same text the iOS and Android SDKs report.
    reportToYourDiagnostics("MetaRouter config", error.description);
  },
});
```

### Analytics Interface

The analytics client provides the following methods:

- `track(event: string, properties?: Record<string, any>)`: Track custom events
- `identify(userId: string, traits?: Record<string, any>)`: Identify users
- `group(groupId: string, traits?: Record<string, any>)`: Group users
- `screen(name: string, properties?: Record<string, any>)`: Track screen views
- `page(name: string, properties?: Record<string, any>)`: Track page views
- `alias(newUserId: string)`: Connect anonymous users to known user IDs. See [Using the alias() Method](#using-the-alias-method) for details
- `recordOpenedURL(url: string, sourceApplication?: string)`: Forward a URL the host received (from `Linking.getInitialURL`, `Linking.addEventListener('url', ...)`, a UIScene URL handler, or an Android Intent) so it is attached to the next `Application Opened` event. The SDK does not read `Linking` itself, so only URLs passed here are recorded. One-shot — the buffer is cleared after the next Opened emit; last-write-wins if called multiple times. No-op (with a warning, always logged) when `trackLifecycleEvents` is disabled. See [Application Lifecycle Events](#application-lifecycle-events) for deep-link wiring details.
- `setAdvertisingId(advertisingId: string)`: Set the advertising identifier (IDFA on iOS, GAID on Android) for ad tracking. See [Advertising ID](#advertising-id-idfagaid) section for usage and compliance requirements
- `clearAdvertisingId()`: Clear the advertising identifier from storage and context. Useful for GDPR/CCPA compliance when users opt out of ad tracking
- `getAnonymousId(): Promise<string>`: Returns the current anonymous ID. Async, never returns null — guaranteed to resolve a string after `init()`
- `getSessionId(): Promise<string | null>`: Returns the current session ID, or `null` before the first event has been sent this launch. Never waits for initialization and never extends the session. See [Session Tracking](#session-tracking)
- `setTracing(enabled: boolean)`: Enable or disable tracing headers on API requests. When enabled, includes a `Trace: true` header for debugging request flows
- `flush()`: Flush events immediately
- `reset()`: Reset analytics state and clear stored identity (includes clearing advertising ID). The analytics session survives, so a logout does not split it
- `enableDebugLogging()`: Enable debug logging
- `getDebugInfo()`: Get current debug information

### React Hooks

- `useMetaRouter()`: Hook to access the analytics client within a `MetaRouterProvider`

### Components

- `MetaRouterProvider`: React context provider for the analytics client

## Features

- 🎯 **Custom Endpoints**: Send events to your own ingestion endpoints
- 📱 **React Native Optimized**: Built specifically for React Native
- 🎣 **React Hooks**: Easy integration with React components
- 🔧 **TypeScript Support**: Full TypeScript support included
- 🚀 **Lightweight**: Minimal overhead and dependencies
- 💾 **Best-Effort Queue Persistence**: Persists unsent events to native disk storage and delivers them on reconnect or next launch
- ⏱️ **Session Tracking**: Every event carries a session ID and count — see [Session Tracking](#session-tracking)
- 📲 **Lifecycle Events (opt-in)**: Emit `Application Installed/Updated/Opened/Backgrounded` automatically when enabled — see [Application Lifecycle Events](#application-lifecycle-events)
- 🔄 **Reset Capability**: Easily reset analytics state for testing or logout scenarios
- 🐛 **Debug Support**: Built-in debugging tools for troubleshooting

## Disk-Backed Queue Persistence

Native iOS and Android storage gives the queue best-effort durability.

- Events still in memory when the app backgrounds are written to disk.
- Once 500 events or 2 MB are queued in memory, the queue is also written to disk as a crash-safety snapshot.
- When the in-memory queue reaches `maxQueueEvents`, or the device is offline, overflowing events go to disk instead of being dropped.
- Events on disk are sent straight to the network when connectivity returns or on the next launch, without being loaded back into the memory queue. Events older than 7 days are discarded.
- When disk storage reaches `maxDiskEvents`, the oldest events are dropped. `reset()` deletes everything on disk.
- Without the native modules (for example in Expo Go), persistence is disabled with a warning.
- This is a durability baseline, not a full offline mode. The SDK still primarily uses in-memory batching and normal network delivery, and it does not guarantee zero-loss across every crash or termination window.

## Application Lifecycle Events

Opt-in. When enabled, the SDK emits four lifecycle events that mirror the iOS and Android native SDKs. They are sent through the same enrichment + batching pipeline as user-emitted events.

| Event                       | When it fires                                                          | Properties                                                                                                |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Application Installed`     | First launch with no prior version stored and no prior identity state. | `version`, `build`                                                                                        |
| `Application Updated`       | First launch where the stored version/build differs from the current. | `version`, `build`, `previous_version`, `previous_build`                                                  |
| `Application Opened`        | Cold launch (foreground) and every return to the foreground after a background entry. | `from_background` (false on cold launch, true on resume), `version`, `build`, optional `url`, optional `referring_application` |
| `Application Backgrounded`  | App enters background from the foreground.                             | _(none)_                                                                                                  |

### Enabling lifecycle events

Lifecycle events are **opt-in** — existing customers upgrading the SDK do not begin emitting these events without explicitly setting the flag. To enable:

```js
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
  trackLifecycleEvents: true, // default: false
});
```

### Notes

- `active → inactive → active` blips (Control Center, a FaceID prompt, system alerts) are **suppressed**. `Application Opened` with `from_background: true` needs a real background entry first; a return that passes through `inactive` (e.g. a passcode prompt on resume) still counts.
- On iOS, React Native reports `active → inactive → background` when the app is left; `Application Backgrounded` fires on the `background` step. A process that settles straight into the background from `unknown` (headless task, push wake) does not emit `Application Backgrounded`. On iOS the launch state is `inactive`, so locking the device before the app first becomes active does emit one, the same as the native iOS SDK.
- Cold launches in a background process state (silent push, headless task) suppress the cold-launch `Application Opened`; the next `background → active` transition emits with `from_background: false` as the cold-launch bridge.
- Existing users upgrading from a pre-lifecycle SDK build receive `Application Updated` with `previous_version="unknown"` and `previous_build="unknown"` (instead of a spurious `Application Installed`).
- Lifecycle storage (`metarouter:lifecycle:version`, `metarouter:lifecycle:build`) is **not** cleared by `reset()` — install/update history survives logout.
- `Application Backgrounded` is emitted **before** the SDK's flush-to-disk pass on background entry, so the event is captured by the same drain that ships pending events.

### Deep-link wiring

The SDK does **not** read `Linking` itself, the same as the iOS and Android SDKs: only URLs your app forwards through `recordOpenedURL` are attached to `Application Opened` (as `url`, plus `referring_application` when you pass one). Forward the cold-launch URL and runtime URL events:

```js
import { Linking } from "react-native";

const analytics = createAnalyticsClient({ /* ... */ trackLifecycleEvents: true });

// Cold launch: safe to call right after createAnalyticsClient(). A URL
// forwarded while initialization is still running reaches the cold-launch
// Application Opened.
Linking.getInitialURL().then((url) => {
  if (url) analytics.recordOpenedURL(url);
});

// Resume: attached to the next Application Opened.
Linking.addEventListener("url", ({ url }) => {
  analytics.recordOpenedURL(url);
});

// With a referring application (typically forwarded from native):
analytics.recordOpenedURL("myapp://product/123", "com.example.referrer");
```

URLs from outside `Linking` (a UIScene URL handler on iOS, an Android `Intent.ACTION_VIEW`, a deep-link library such as Branch) are forwarded the same way.

**Buffer semantics:**

- One-shot — the buffer is cleared after the next `Application Opened` emits.
- Last-write-wins — multiple `recordOpenedURL` calls before the next Opened keep only the most recent URL.
- No-op with an always-on warning when `trackLifecycleEvents` is disabled, so misconfigurations surface in logs instead of failing silently.

### Privacy & sanitization

URLs can contain sensitive material (auth tokens, OTPs, magic-link secrets, PII in query strings). The SDK records the URL verbatim, and because it only records what you forward, sanitizing before the call is enough:

```js
function sanitize(url) {
  const u = new URL(url);
  // Strip known sensitive query params before forwarding.
  ["token", "otp", "auth"].forEach((k) => u.searchParams.delete(k));
  return u.toString();
}

Linking.addEventListener("url", ({ url }) => {
  analytics.recordOpenedURL(sanitize(url));
});
```

### Why the SDK does not auto-instrument deep links

- **Privacy.** Hosts often receive URLs that contain credentials. Capturing them automatically would record secrets before the app has a chance to strip them.
- **Host control.** Apps with custom URL routers or deep-link libraries (react-navigation linking, react-native-firebase dynamic links, Branch) need to decide *if* and *which* URLs reach analytics — `recordOpenedURL` is the explicit hand-off point.
- **Parity.** The iOS (`recordOpenedURL`) and Android (`recordOpenedUrl`) SDKs work the same way, so the same app behaves the same on every platform.

## Session Tracking

Every event carries the analytics session it belongs to, stamped as:

```json
"context": {
  "providers": {
    "metarouter": {
      "sessionID": "1757400000000",
      "sessionCount": 3
    }
  }
}
```

This is the same path and shape the web SDK's MetaRouter session sync and the iOS and Android SDKs produce, so pipeline mappings (e.g. GA4 `session_id` / `session_number`) read one field from every platform. `sessionID` is the epoch-millisecond timestamp of the session's first activity, as a string; `sessionCount` is the lifetime session ordinal for the install.

Session stamping is **always on** — there is nothing to enable and no network cost. A session starts with the first event and ends after `sessionTimeoutMinutes` (default 30) of inactivity; the window slides, so steady activity keeps one session alive indefinitely. Any tracked or lifecycle event counts as activity. Sessions survive app restarts that happen inside the window, and survive `reset()` — a logout mid-session does not split the session.

While the app is running, inactivity is measured on a native clock that keeps counting while the device sleeps and ignores changes to the device time. Across an app restart only the device time is available, so changing it can start a new session. Without the SDK's native modules (for example in Expo Go), the SDK uses the device time throughout and logs a warning.

### Session Started event

Optionally, the SDK emits a `Session Started` track event (no properties, matching web) each time a new session starts:

```ts
const analytics = createAnalyticsClient({
  writeKey: 'YOUR_WRITE_KEY',
  ingestionHost: 'https://your-ingestion-host.com',
  sessionTimeoutMinutes: 30, // default
  fireSessionStarted: true, // default false
});
```

`fireSessionStarted` is off by default so upgrading the SDK never changes an app's event volume. Turn it on when a downstream destination needs an explicit session-start signal (GA4's `session_start`, for example).

## ✅ Compatibility

| Component                  | Supported Versions |
| -------------------------- | ------------------ |
| React Native               | >= 0.73            |
| React                      | >= 16.8            |
| iOS Deployment Target      | >= iOS 13          |
| Android Min SDK            | >= API 23          |
| Android Build JDK          | >= 17              |
| Node.js                    | >= 18              |

## Debugging

If you're not seeing API calls being made, here are some steps to troubleshoot:

### 1. Enable Debug Logging

```js
// Initialize with debug enabled
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
  debug: true, // This enables detailed logging
});

// Or enable debug logging after initialization
analytics.enableDebugLogging?.();
```

### 2. Check Debug Information

```js
// Get current state information
const debugInfo = await analytics.getDebugInfo?.();
console.log("Analytics debug info:", debugInfo);
```

### 3. Force Flush Events

```js
// Manually flush events to see if they're being sent
await analytics.flush();
```

### 4. Common Issues

- **Network Permissions**: Ensure your app has network permissions
- **AsyncStorage**: The SDK uses AsyncStorage for identity persistence (anonymousId, userId, groupId, advertisingId)
- **Endpoint URL**: Verify your ingestion endpoint is correct and accessible
- **Write Key**: Ensure your write key is valid

### Delivery & Backoff (How events flow under failures)

Queue capacity: The SDK caps the in-memory queue at 5 MB (hardcoded). When either the 5 MB byte cap or the `maxQueueEvents` count cap is reached, the oldest events are dropped first (drop-oldest). Tune the event count via `maxQueueEvents` in `createAnalyticsClient(options)`.

This SDK uses a circuit breaker around network I/O. It keeps ordering stable, avoids tight retry loops, and backs off cleanly when your cluster is unhealthy or throttling.

Queueing during backoff: While the breaker is OPEN, new events are accepted and appended to the in-memory queue; nothing is sent until the cooldown elapses.

Ordering (FIFO): If a batch fails with a retryable error, that batch is requeued at the front (original order preserved). New events go to the tail. After cooldown, we try again; on success we continue draining in order.

Half-open probe: After cooldown, one probe is allowed.
Success → breaker CLOSED (keep flushing).
Failure → breaker OPEN again with longer cooldown.

sentAt semantics: sentAt is stamped when a batch is prepared for transmission. If the client is backing off, the actual transmit may be later; if you need the original occurrence time, include your own event `timestamp`.

| Status / Failure                    | Action                                                               | Breaker | Queue effect                   |
| ----------------------------------- | -------------------------------------------------------------------- | ------- | ------------------------------ |
| `2xx`                               | Success                                                              | close   | Batch removed                  |
| `5xx`                               | Retry: requeue **front**, schedule after cooldown                    | open↑   | Requeued (front)               |
| `408` (timeout)                     | Retry: requeue **front**, schedule after cooldown                    | open↑   | Requeued (front)               |
| `429` (throttle)                    | Retry: requeue **front**, wait = `max(Retry-After, breaker, 1000ms)` | open↑   | Requeued (front)               |
| `413` (payload too large)           | Halve `maxBatchSize`; requeue and retry; if already `1`, **drop**    | close   | Requeued or dropped (`size=1`) |
| `400`, `422`, other non-fatal `4xx` | **Drop** bad batch, continue                                         | close   | Dropped                        |
| `401`, `403`, `404`                 | **Disable** client (stop timers), clear queue                        | close   | Cleared                        |
| Network error / Abort / Timeout     | Retry: requeue **front**, schedule after cooldown                    | open↑   | Requeued (front)               |
| Reset during flush                  | Do **not** requeue in-flight chunk; **drop** it                      | —       | Dropped                        |

**Defaults:** `failureThreshold=3`, `cooldownMs=10s`, `maxCooldownMs=120s`, `jitter=±20%`, `halfOpenMaxConcurrent=1`.

**Identifiers:**

- `anonymousId` is a stable, persisted UUID for the device/user before identify; it does **not** include timestamps.
- `messageId` is generated as `<epochMillis>-<uuid>` (e.g., `1734691572843-6f0c7e85-...`) to aid debugging.

## Identity Persistence

The MetaRouter React Native SDK automatically manages and persists user identifiers across app sessions using React Native's AsyncStorage. This ensures consistent user tracking even after app restarts.

### The Four Identity Fields

#### 1. userId (Common User ID)

The `userId` is set when you identify a user and represents their unique identifier in your system (e.g., database ID, email, employee ID).

**How to set:**

```js
analytics.identify("user123", {
  name: "John Doe",
  email: "john@example.com",
  role: "Sales Associate",
});
```

**Behavior:**

- Persisted to device storage (`AsyncStorage` key: `metarouter:user_id`)
- Automatically loaded on app restart
- Automatically included in **all** subsequent events (`track`, `page`, `screen`, `group`)
- Remains set until `reset()` is called or app is uninstalled

**Example flow:**

```js
// Day 1: User logs in
analytics.identify("employeeID", { name: "Jane" });
analytics.track("Product Viewed", { sku: "ABC123" });
// Event includes: userId: "employeeID"

// App restarts...

// Day 2: User opens app
analytics.track("App Opened");
// Event STILL includes: userId: "employeeID" (auto-loaded from storage)
```

#### 2. anonymousId

The `anonymousId` is a unique identifier automatically generated for each device/installation before a user is identified.

**How it's set:**

- **Automatically** generated as a UUID v4 on first SDK initialization
- No manual action required

**Behavior:**

- Persisted to device storage (`AsyncStorage` key: `metarouter:anonymous_id`)
- Automatically loaded on app restart
- Automatically included in **all** events
- Remains stable across app sessions until `reset()` is called
- Cleared on `reset()` and a **new** UUID is generated on next `init()`

**Accessing the anonymous ID:**

```js
const anonymousId = await analytics.getAnonymousId();
console.log(anonymousId); // e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Use case:**
Track user behavior before they log in or create an account, then connect pre-login and post-login activity using the `alias()` method.

#### 3. groupId

The `groupId` associates a user with an organization, team, account, or other group entity.

**How to set:**

```js
analytics.group("company123", {
  name: "Acme Corp",
  plan: "Enterprise",
  industry: "Technology",
});
```

**Behavior:**

- Persisted to device storage (`AsyncStorage` key: `metarouter:group_id`)
- Automatically loaded on app restart
- Automatically included in **all** subsequent events after being set
- Remains set until `reset()` is called

**Example use case:**

```js
// User logs into their company account
analytics.identify("user123", { name: "Jane" });
analytics.group("acme-corp", { name: "Acme Corp" });

// All future events include both userId and groupId
analytics.track("Report Generated");
// Event includes: userId: "user123", groupId: "acme-corp"
```

#### 4. advertisingId (Optional)

The `advertisingId` is used for ad tracking and attribution (IDFA on iOS, GAID on Android). See the [Advertising ID](#advertising-id-idfagaid) section below for detailed usage and compliance requirements.

### Persistence Summary

| Field             | Set By                   | Storage Key                 | Auto-Attached        | Cleared By                                |
| ----------------- | ------------------------ | --------------------------- | -------------------- | ----------------------------------------- |
| **userId**        | `identify(userId)`       | `metarouter:user_id`        | All events           | `reset()`                                 |
| **anonymousId**   | Auto-generated (UUID v4) | `metarouter:anonymous_id`   | All events           | `reset()` (new ID generated on next init) |
| **groupId**       | `group(groupId)`         | `metarouter:group_id`       | All events after set | `reset()`                                 |
| **advertisingId** | `setAdvertisingId(id)`   | `metarouter:advertising_id` | Event context        | `clearAdvertisingId()`, `reset()`         |

### Event Enrichment Flow

Every event you send (track, page, screen, group) is automatically enriched with persisted identity information:

```js
// You call:
analytics.track("Button Clicked", { buttonName: "Submit" });

// SDK automatically adds:
{
  "type": "track",
  "event": "Button Clicked",
  "properties": { "buttonName": "Submit" },
  "userId": "employeeID",        // ← Auto-added from storage
  "anonymousId": "a1b2c3d4-...", // ← Auto-added from storage
  "groupId": "company123",       // ← Auto-added from storage (if set)
  "timestamp": "2025-10-23T...",
  "context": {
    "device": {
      "advertisingId": "..."     // ← Auto-added from storage (if set)
    }
  }
}
```

### Resetting Identity

Call `reset()` to clear **all** identity data, typically when a user logs out:

```js
await analytics.reset();
```

**What `reset()` does:**

- Clears `userId`, `anonymousId`, `groupId`, and `advertisingId` from memory
- Removes all identity fields from AsyncStorage
- Stops background flush loops
- Clears event queue
- Next `init()` will generate a **new** `anonymousId`

**Common logout flow:**

```js
// User logs out
await analytics.reset();

// User is now tracked with a new anonymousId (auto-generated on next event)
// No userId or groupId until they log in again
```

### Best Practices

1. **On Login:** Call `identify()` immediately after successful authentication
2. **On Logout:** Call `reset()` to clear user identity
3. **Cross-Session Tracking:** The SDK handles this automatically - no action needed
4. **Group Associations:** Set `groupId` after determining the user's organization/team
5. **Pre-Login Tracking:** Events are tracked with `anonymousId` before login
6. **Connecting Sessions:** Use `alias()` to connect pre-login and post-login activity

### Example: Complete User Journey

```js
// App starts - SDK initializes
const analytics = createAnalyticsClient({...});
// anonymousId: "abc-123" (auto-generated and persisted)

// User browses before login
analytics.track("Product Viewed", { sku: "XYZ" });
// Includes: anonymousId: "abc-123"

// User logs in
analytics.identify("user456", { name: "John", email: "john@example.com" });
// userId: "user456" is now persisted

// User performs actions
analytics.track("Added to Cart", { sku: "XYZ" });
// Includes: userId: "user456", anonymousId: "abc-123"

// App closes and reopens...

// SDK auto-loads userId from storage
analytics.track("App Reopened");
// STILL includes: userId: "user456", anonymousId: "abc-123"

// User logs out
await analytics.reset();
// All IDs cleared, new anonymousId will be generated on next init
```

### Storage Location

All identity data is stored in **React Native AsyncStorage**, which provides:

- Persistent storage across app sessions
- Automatic data encryption on iOS (Keychain-backed)
- Secure local storage on Android
- Cleared only on app uninstall or explicit `reset()` call

## Using the alias() Method

The `alias()` method connects an **anonymous user** (tracked by `anonymousId`) to a **known user ID**. It's used to link pre-login activity to post-login identity.

### When to Use alias()

Use `alias()` when a user **signs up** or **logs in for the first time**, and you want to connect their pre-login browsing activity to their new account.

**Primary use case:** Connecting anonymous browsing sessions to newly created user accounts.

### How It Works

```js
analytics.alias(newUserId);
```

This does two things:

1. Sets the new `userId` (same as `identify()`)
2. Sends an `alias` event to your analytics backend, telling it: "This anonymousId and this userId are the same person"

### Example: User Sign-Up Flow

```js
// App starts - user is anonymous
const analytics = createAnalyticsClient({...});
// anonymousId: "abc-123" (auto-generated)

// User browses anonymously
analytics.track("Product Viewed", { productId: "XYZ" });
analytics.track("Add to Cart", { productId: "XYZ" });
// Both events tracked with anonymousId: "abc-123"

// User creates an account / signs up
analytics.alias("user-456");
// Sends alias event connecting: anonymousId "abc-123" → userId "user-456"

// Optionally add user traits
analytics.identify("user-456", {
  name: "John Doe",
  email: "john@example.com"
});

// Future events now tracked as authenticated user
analytics.track("Purchase Complete", { orderId: "789" });
// Event includes: userId: "user-456", anonymousId: "abc-123"
```

### alias() vs identify()

| Method           | When to Use                                                     | What It Does                                                   |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **`alias()`**    | **First-time sign-up/login** when connecting anonymous activity | Sets userId + sends `alias` event to link anonymousId → userId |
| **`identify()`** | Subsequent logins or updating user traits                       | Sets userId + sends `identify` event with user traits          |

### Best Practices

1. **First-time sign-up:** Call `alias()` to connect anonymous activity to the new account
2. **Subsequent logins:** Use `identify()` - no need to alias again
3. **Backend support:** Ensure your analytics backend supports alias events for merging user profiles
4. **One-time operation:** You typically only need `alias()` once per user - when they first create an account

### Real-World Example: E-Commerce App

```js
// Day 1: Anonymous browsing
analytics.track("App Opened");
analytics.track("Product Viewed", { sku: "SHOE-123" });
analytics.track("Product Viewed", { sku: "SHIRT-456" });
// All tracked with anonymousId: "anon-xyz"

// User signs up
analytics.alias("user-789");
analytics.identify("user-789", {
  name: "Jane Doe",
  email: "jane@example.com",
});

// User continues shopping (now authenticated)
analytics.track("Added to Cart", { sku: "SHIRT-456" });
analytics.track("Purchase", { total: 49.99 });

// Your analytics platform can now show the complete customer journey:
// - Pre-signup activity (anonymous product views)
// - Post-signup activity (cart additions, purchase)
// - Full conversion funnel from anonymous → identified → converted
```

## Advertising ID (IDFA/GAID)

The SDK supports including advertising identifiers (IDFA on iOS, GAID on Android) in event context for ad tracking and attribution purposes.

### Usage

Use the `setAdvertisingId()` method to set the advertising identifier after initializing the analytics client:

```js
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

// Set advertising ID after initialization
await analytics.setAdvertisingId("your-advertising-id"); // IDFA on iOS, GAID on Android
```

Once set, the `advertisingId` will be automatically included in the device context of all subsequent events:

```json
{
  "context": {
    "device": {
      "advertisingId": "your-advertising-id",
      "manufacturer": "Apple",
      "model": "iPhone 14",
      ...
    }
  }
}
```

### Privacy & Compliance

⚠️ **Important**: Advertising identifiers are Personally Identifiable Information (PII). Before collecting advertising IDs, you must:

1. **Obtain User Consent**: Request explicit permission from users before tracking
2. **Comply with Regulations**: Follow GDPR, CCPA, and other applicable privacy laws
3. **App Store Requirements**:
   - iOS: Follow Apple's [App Tracking Transparency (ATT)](https://developer.apple.com/documentation/apptrackingtransparency) framework
   - Android: Follow Google Play's [advertising ID policies](https://support.google.com/googleplay/android-developer/answer/6048248)

### iOS Example (with ATT)

> **Note:** The examples below use third-party libraries for demonstration purposes. You should choose appropriate packages that fit your project's needs and are actively maintained.

```js
import { AppTrackingTransparency } from "react-native-tracking-transparency";
import { getAdvertisingId } from "@react-native-community/google-advertiser-id"; // or similar library

// Initialize analytics first
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

// Request tracking permission
const trackingStatus =
  await AppTrackingTransparency.requestTrackingAuthorization();

if (trackingStatus === "authorized") {
  // Get and set IDFA only if authorized
  const advertisingId = await getAdvertisingId();
  await analytics.setAdvertisingId(advertisingId);
}
```

### Android Example

```js
import { getAdvertisingId } from "@react-native-community/google-advertiser-id"; // or similar library

// Initialize analytics first
const analytics = createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

// Check if user has opted out of personalized ads
const { advertisingId, isLimitAdTrackingEnabled } = await getAdvertisingId();

if (!isLimitAdTrackingEnabled && advertisingId) {
  await analytics.setAdvertisingId(advertisingId);
}
```

### Clearing Advertising ID

When users opt out of ad tracking or revoke consent, use `clearAdvertisingId()` to remove the advertising ID from storage and context:

```js
// User opts out of ad tracking
await analytics.clearAdvertisingId();

// All subsequent events will not include advertisingId in context
analytics.track("Event After Opt Out");
```

**Note:** The `reset()` method also clears the advertising ID along with all other analytics data.

### Validation

The SDK validates advertising IDs before setting them:

- Must be a non-empty string
- Cannot be only whitespace
- Invalid values are rejected and logged as warnings

## License

MIT

---

## Attributions

This library includes code from the following third-party packages:

- [react-native-uuid](https://github.com/eugenehp/react-native-uuid), MIT License

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
- [WebView Bridge](#webview-bridge)
- [Consent](#consent)
- [Provider Context](#provider-context)
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
- `sessionTimeoutMinutes` (number, optional, default: `30`): Minutes of inactivity after which the next event starts a new session. Fractions are accepted (`1.5` is 90 seconds); values below 1 are clamped to 1. See [Session Tracking](#session-tracking).
- `fireSessionStarted` (boolean, optional, default: `false`): Emit a `Session Started` track event each time a new session starts. See [Session Tracking](#session-tracking).
- `onConfigError` (function, optional): Called with a `ConfigError` (`type`, `description`, and `raw` for a bad host) when the options are invalid in a release build. See [Invalid configuration](#invalid-configuration).

Out-of-range numbers are clamped and logged as a warning; they never fail initialization.

**Proxy behavior (quick notes):**

- Buffer is **in-memory only** (not persisted). Calls made before ready are lost if the process exits.
- Ordering is preserved relative to other buffered calls; normal FIFO + batching applies after ready.
- On fatal config errors from the ingestion host (`401/403/404`), the client enters **disabled** state and drops subsequent calls. This is separate from [invalid options](#invalid-configuration) and does not call `onConfigError`.
- `sentAt` is stamped when the batch is prepared for transmission (just before network send). Each event's `timestamp` is set by the SDK when the call reaches the client, so a call buffered before ready is stamped when it is replayed, not when it was made. There is no way to pass your own.

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
- `attachWebView(webViewRef, allowedOrigins: string[])`: Bridge a `react-native-webview` WebView so its pages' events are sent through the SDK. Returns props to spread onto the `<WebView>`. See [WebView Bridge](#webview-bridge)
- `getSessionId(): Promise<string | null>`: Returns the current session ID, or `null` before the first event has been sent this launch. Never waits for initialization and never extends the session. See [Session Tracking](#session-tracking)
- `registerConsentCategories(categories)`, `setConsent(consent): boolean`, `getConsent()`, `clearConsent()`, `subscribeToConsent(handler): () => void`: Consent state stamped at `context.consent` on every event. See [Consent](#consent)
- `setProviderContext(provider: string, key: string, value: unknown): boolean`: Stamp a value at `context.providers.<provider>.<key>` on every event. Persisted, survives `reset()`, usable before initialization. `null` or `undefined` removes the key. Returns `false` when the write is rejected. See [Provider Context](#provider-context)
- `getProviderContext()`: Everything set with `setProviderContext`, read-only
- `clearProviderContext(provider: string)` / `clearAllProviderContext()`: Remove one provider's block, or all of them
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
- 🌐 **WebView Bridge**: Events from pages in a `react-native-webview` WebView arrive with the app's identity — see [WebView Bridge](#webview-bridge)
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

Session stamping is **always on** — there is nothing to enable and no network cost. A session starts with the first event and ends after `sessionTimeoutMinutes` (default 30) of inactivity; the window slides, so steady activity keeps one session alive indefinitely. Any tracked or lifecycle event counts as activity. Sessions survive app restarts that happen inside the window, and survive `reset()` — a logout mid-session does not split the session. Session state (id, count and last activity) is kept in AsyncStorage as one JSON value under `metarouter:session`, separate from identity, which is why `reset()` leaves it alone.

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

## WebView Bridge

Hybrid apps render some screens as web content inside a WebView. Without extra work that activity is invisible to MetaRouter, or double-tracked by an in-page analytics setup on a separate identity. The WebView bridge captures events fired by page JavaScript and sends them through the SDK, so WebView and app activity arrive at your cluster as **one user, one pipeline**: the app's identity, device context and session, plus the page's own facts, on every event.

### Attaching

The bridge works with [`react-native-webview`](https://github.com/react-native-webview/react-native-webview) 13.13.1 or newer, an optional peer dependency (earlier versions report the main page's URL for messages from iframes, which the origin check relies on). `attachWebView` returns the props that wire the bridge into a `<WebView>`:

```tsx
import { useRef } from 'react';
import { WebView } from 'react-native-webview';

function CheckoutScreen() {
  const webViewRef = useRef<WebView>(null);
  const bridge = analytics.attachWebView(webViewRef, ['https://www.example.com']);

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: 'https://www.example.com/checkout' }}
      injectedJavaScriptBeforeContentLoaded={bridge.injectedJavaScriptBeforeContentLoaded}
      onMessage={(event) => {
        if (!bridge.onMessage(event)) {
          // Not a bridge message — the app's own page messages arrive here.
        }
      }}
    />
  );
}
```

- `bridge.onMessage` returns `true` when it handled a bridge message and `false` for anything else, so an app that already uses `onMessage` chains its own handler. Without one, pass `onMessage={bridge.onMessage}`.
- Pass the ref so the page receives an ack or error for each message. Without a ref, events are still captured.
- Calling `attachWebView` on every render is fine, and so is calling it before `createAnalyticsClient` has finished initializing: messages that arrive before then are answered `not_ready`. The bridge keeps working across `reset()` and re-initialization.
- If the app already sets `injectedJavaScriptBeforeContentLoaded`, join the two scripts (`bridge.injectedJavaScriptBeforeContentLoaded + yourScript`). When the attach is refused the bridge script is empty, so the join stays safe.

Origins must be explicit `scheme://host[:port]` rules — no wildcards, paths or trailing slashes. Scheme and host are case-insensitive and default ports are ignored. Invalid rules are refused with a warning, and the returned props then do nothing. Origin scoping is the bridge's security boundary: it keeps other pages loaded in the same WebView (ads, redirects) from injecting events. `react-native-webview` does not scope its message channel to origins, so the SDK enforces the allowlist in two places: the injected wrapper defines nothing on other pages, and every message's sending-frame URL is checked — a message from any other origin is ignored without a reply. Messages must also carry a random token that the injected wrapper holds, as a second layer against frames that never received the wrapper. The token is not a secret from scripts on an allowed page (they are trusted already, and can call the bridge directly). Cleartext `http` origins log a warning unless the host is loopback.

### What the page sees

Pages loaded from an allowed origin get a `window.metarouterBridge` object with two methods. Properties may be a plain object or a JSON string of one:

```js
window.metarouterBridge.page('page_view', { section: 'checkout' });
window.metarouterBridge.track('product_viewed', JSON.stringify({ sku: 'SKU-123' }));
```

A typical integration is a small shim in the page's tag manager:

```js
function logEvent(name, params) {
  var value = JSON.stringify(params);
  if (!window.metarouterBridge) return; // origin not allowed
  if (name === 'page_view') {
    window.metarouterBridge.page(name, value);
  } else {
    window.metarouterBridge.track(name, value);
  }
}
```

The page-visible surface is identical in the iOS, Android and React Native SDKs, so one tag-manager integration serves every app.

### What arrives at the cluster

Bridged events go through the same enrichment as the app's own events. The page contributes only what the app cannot know:

| From the page (stamped at call time) | From the SDK (merged at receipt) |
|---|---|
| event type (`track`/`page`), name, properties | `anonymousId` / `userId`, device + app context, session |
| `context.page` — url, path, search, title, referrer | `messageId`, `timestamp` |

Each bridge message carries an ID minted by the page, used to drop duplicate deliveries within 5 minutes. Malformed input is rejected with a coded error, never silently dropped, and events arriving while the SDK cannot accept them are answered `not_ready` rather than acknowledged.

### Limits

- **Main frame only.** `react-native-webview` injects scripts before content loads into the main frame only, so iframes do not get the bridge (the iOS and Android SDKs also bridge allowlisted iframes).
- **Injection timing.** On iOS the wrapper is injected at document start. On Android, `react-native-webview` injects it when the page starts loading, which is not guaranteed to happen before the page's own scripts: an inline script at the top of the page can run first, find no bridge, and lose its call. Calls made once the page has loaded (and user-triggered ones) see the bridge. Guard calls with `if (window.metarouterBridge)` as in the shim above. A page already loaded when the props were first set has no bridge until it reloads.
- **Android WebView 82 or newer.** On Android the bridge needs the device's WebView provider to support `WEB_MESSAGE_LISTENER`, which Android System WebView has had since version 82 (2020) and which updates through Google Play. Without it `react-native-webview` reports the main page's URL for messages from every frame, so the origin check could not keep an iframe out; the bridge then refuses to attach, with a warning, and `attachWebView` returns props that do nothing (the Android SDK does the same). The check is a native module, so the app must be rebuilt after upgrading; without the module (e.g. Expo Go) the bridge also stays off.
- **Replies go to the current page.** Replies are delivered to whatever page is in the main frame when they are sent, and only if its origin is allowed.

### Debugging

- SDK logs (`debug: true` or `enableDebugLogging()`) show attach confirmations, rejected messages with their error codes, and duplicate drops.
- In Safari's Develop menu (iOS) or `chrome://inspect` (Android), check `typeof window.metarouterBridge` to verify injection, and read replies with `window.__metaRouterNativeChannel.onmessage = e => console.log(e.data)`.

## Consent

The host app owns consent acquisition — a CMP SDK callback, a cookie read out of a WebView, your own preference screen. The SDK owns storage, reconciliation, observation, and putting consent on the wire. Every event carries the current consent at `context.consent`, in the same shape the web SDK emits, so the cluster enforces one set of per-integration rules for web and mobile:

```json
"context": {
  "consent": {
    "explicit": true,
    "optOut": {
      "c0001": false,
      "c0002": false,
      "c0004": true
    }
  }
}
```

- `explicit` — `true` when the user made an explicit choice, `false` for an implicit or regional default. You set it; the SDK cannot infer it.
- `optOut` — a flat map with **opt-out** semantics: `true` means blocked. Keys are lowercase and pass through from your CMP (`c0001`…, `analytics`, `advertising`, …). `setConsent` canonicalizes the keys you pass (`C0004` → `c0004`); when two keys collapse to one, opted-out wins.

Consent never gates delivery. Events send immediately and the server gates per integration, so there is no buffering, no init flag, and nothing to wait for.

### 1. Register categories — right after `createAnalyticsClient`

Register the category set your pipeline gates on, with each category's default posture. Default is opt-out (`defaultOptOut: true`): a category is opted *in* deliberately, and the absence of a signal never opts a user in. Consent calls never wait for initialization, so register on the returned object in the same synchronous block:

```ts
const analytics = createAnalyticsClient(options);
analytics.registerConsentCategories([
  { key: 'c0001', defaultOptOut: false }, // strictly necessary — always on
  { key: 'c0002' }, // performance
  { key: 'c0004' }, // targeting
]);
```

Initialization runs after the current synchronous code, so a registration on the next line lands before `Application Opened` / `Session Started`. The registry is not persisted: until it is registered the implicit default has an empty `optOut`, which the cluster reads as nothing blocked.

Keys are trimmed and lowercased, blank keys dropped, and duplicates keep their first occurrence, each with a warning. In **development** (`__DEV__`) any of those throws at the registration itself; release builds degrade with the warning.

Registration is what lets the SDK complete a sparse CMP payload into a full block: known keys keep their value, unknown keys are dropped, missing categories take their registered default. Re-registering replaces the set and recomputes the view of any stored consent against it — the stored snapshot itself is kept whole, so a category one build drops and the next re-adds comes back with the user's original choice.

### 2. Push consent whenever it changes

```ts
analytics.setConsent({
  explicit: true,
  optOut: { c0002: false, c0004: true },
});
```

`setConsent` fully replaces the previous state, persists it across launches, and takes effect immediately: an event tracked on the next line carries it. Before the client is ready, `track` calls are queued and enriched when it binds, so every queued event carries the consent current at bind, not at its call. It is safe to call before `createAnalyticsClient` (CMP callbacks often fire first), and the state survives `reset()`: consent is a compliance record scoped to the device and person, not to the analytics identity, so a logout must not resurrect tracking the user opted out of. Only `clearConsent()` removes it.

Each `Consent` carries an optional epoch-millisecond `timestamp`. If you supply timestamps (for example from the CMP's own record), a snapshot older than the newest timestamp you have supplied is ignored, so a CMP replaying a cached choice cannot overwrite a fresher one; `setConsent` returns `false` when that happens. `clearConsent()` resets that history, so after a clear any snapshot applies — do not re-push one from before the clear. Use one unit: a single millisecond timestamp followed by seconds rejects every seconds call until the next clear. A call without a timestamp is always applied as the user's current choice; the SDK stamps the device clock for information only and never compares it with yours. The timestamp never goes on the wire.

Before the first `setConsent`, `getConsent()` and every outbound event carry the **implicit default** — `explicit: false` with every registered category at its default — which the cluster gates exactly like an implicit-consent web visitor. There is no "unknown" state.

Consent is stored natively (UserDefaults on iOS, SharedPreferences on Android) and read synchronously when the SDK loads, as the iOS and Android SDKs read theirs: `getConsent()` and the first subscriber delivery carry the user's stored decision from your first line of code, and so do the first events.

Without the SDK's native modules — Expo Go, or JavaScript shipped over the air onto a binary built before this release — consent falls back to AsyncStorage, which loads moments after the SDK does (initialization still waits for it, so events are unaffected). Until it loads, `getConsent()` and a subscriber's first delivery reflect only the registered defaults and what was set this launch; the stored decision follows as a change. If you gate a third-party SDK on a category that defaults to opted in, treat that first value as provisional there. Calls made before the stored state loads are applied on top of it (a timestamped `setConsent` older than the newest stored timestamp returns `true` and is then dropped, with a warning — on this path, treat that `true` as provisional). Consent stored that way is not carried over once the app is rebuilt with the native modules: it starts from the implicit default until your CMP pushes the user's choice again.

If storage cannot be read at startup (including a failing native read), that launch applies consent in memory only and leaves the stored state untouched rather than overwrite it — until `clearConsent()`: the clear is saved whenever storage accepts the write, and consent set after it in that launch is saved too.

### OneTrust

`OneTrustAdapter` translates OneTrust's opt-in statuses into the canonical shape: category IDs lowercased (`C0004` → `c0004`), values inverted to opt-out semantics. It is a pure function with no dependency on the OneTrust SDK — read OneTrust however you already do and hand the raw result over. Reconciliation against your registered categories happens in `setConsent`, so you can pass everything OneTrust reports.

```ts
import { OneTrustAdapter } from '@metarouter/react-native-sdk';

// From the OneTrust SDK's category statuses
analytics.setConsent(
  OneTrustAdapter.normalize({ C0001: 1, C0002: 1, C0004: 0 }, true)
);

// From the OptanonConsent cookie's `groups` parameter (e.g. read out of a
// WebView). Percent-encoded values, the whole cookie value and a full
// document.cookie string are all accepted.
analytics.setConsent(
  OneTrustAdapter.normalize('C0001%3A1%2CC0002%3A1%2CC0004%3A0', true)
);
```

Pass `explicit: true` from the banner-interaction callback and `false` when applying a regional default — the payload does not say which it was; your code does. Re-run it on every OneTrust consent-changed callback. If the cookie is absent, do not call `setConsent`: `normalize('', true)` reports no categories, so every registered category takes its default and the result is recorded as the user's explicit choice: a rejection the user never made for categories that default to opted out, an opt-in they never gave for any registered with `defaultOptOut: false`. With no categories registered yet, it records nothing blocked until they are; then each takes its default as that same explicit choice. Any other CMP (or your own preference screen) can build a `Consent` directly: adapters are a convenience, not a requirement.

### Observing and withdrawing

```ts
useEffect(() => {
  // Fires once with the current value (queued, never inline), then on every
  // real change.
  const unsubscribe = analytics.subscribeToConsent((consent) => {
    thirdPartySdk.setEnabled(consent.optOut.c0004 === false);
  });
  // Nothing is delivered after this returns, even if already queued. Without
  // it the handler keeps running for the life of the app.
  return unsubscribe;
}, [analytics]);

analytics.clearConsent(); // back to the implicit default; stored state wiped
```

A `setConsent` whose values equal the current state does not notify subscribers, even with a fresher timestamp — handlers react to decisions, not clocks.

## Provider Context

Some destinations will not accept an event unless it carries a vendor's own identifier — one the app can read but a web page cannot. GA4's app streams, for example, reject app event data without a genuine Firebase app instance id. On the web, sync injectors write values like this into `context.providers`; on mobile, `setProviderContext` is how the app puts them there.

Set a value once and the SDK stamps it onto **every** outbound event — your calls, lifecycle events, and WebView-bridge events alike:

```ts
import firebaseAnalytics from '@react-native-firebase/analytics';

// On every launch, as early as possible. null while Firebase Analytics
// collection is disabled, and a null value removes the key, so a stale id
// from an earlier launch never lingers.
firebaseAnalytics()
  .getAppInstanceId()
  .then((id) => analytics.setProviderContext('googleFirebase', 'appInstanceId', id));
```

Every event then carries:

```json
"context": {
  "providers": {
    "googleFirebase": {
      "appInstanceId": "c0ffee1234567890abcdef"
    },
    "metarouter": {
      "sessionID": "1757400000000",
      "sessionCount": 3
    }
  }
}
```

The provider namespace and key are **wire paths, stamped verbatim** apart from trimming surrounding whitespace — no casing or separator normalisation — because pipeline mappings match them exactly. `googleFirebase` / `appInstanceId` above is one worked example, not a special case: any provider and key your pipeline reads will do.

```ts
// Several keys under one provider, and several providers, are all fine.
analytics.setProviderContext('googleFirebase', 'nonPersonalizedAds', false);
analytics.setProviderContext('adjust', 'adid', adjustAdid);

analytics.getProviderContext(); // everything you have set
analytics.setProviderContext('adjust', 'adid', null); // remove one key
analytics.clearProviderContext('adjust'); // remove one provider's block
analytics.clearAllProviderContext(); // remove everything

// A rejected write (oversize, not JSON) returns false and logs. Without the
// native modules, before the stored values have loaded, the 16 KiB total is
// checked against this launch's values only: a write that fits those but not
// the stored ones returns true and can be dropped, with a warning, when they
// load.
if (!analytics.setProviderContext('adjust', 'attribution', attribution)) {
  // too big to stamp on every event — send a smaller id instead
}
```

### Lifetime and timing

- **Usable before initialization**, and immediately effective — an event tracked on the next line carries the value. These calls never wait for a bind and never take a slot in the pre-initialization call queue.
- **Persisted across launches** in native storage (UserDefaults, SharedPreferences) and read synchronously when the SDK loads, so a value set in one launch is in `getProviderContext()` from the next launch's first line and on its first event (`Application Installed` / `Opened` included). Without the SDK's native modules (Expo Go, or JavaScript newer than the app binary) it falls back to AsyncStorage, which loads moments later (initialization waits for it): values set before the stored ones load are applied on top of them, a set that the limits reject against the loaded values returns `true` and is then dropped, with a warning, and until the load finishes `getProviderContext()` shows only this launch's sets. Values stored that way are not carried over once the app is rebuilt with the native modules — set them again, as on every launch. If storage cannot be read at startup (including a failing native read), that launch applies values in memory only and leaves the stored ones untouched rather than overwrite them; the next launch reads them again. `clearAllProviderContext()` is the exception: it is saved regardless, so a clear on logout always sticks.
- **Survives `reset()`**. These are install-scoped vendor identifiers, not user state; a logout must not quietly stop events being forwardable. Use `clearProviderContext` to remove one deliberately. Note that `reset()` clears the advertising ID but leaves an advertising-id-shaped value you put under a provider alone.

**Set values on every launch, and clear the ones that rotate.** The persisted value is stamped on every event until you overwrite it, so an id that changes underneath you — Firebase after `resetAnalyticsData()`, an advertising id the user resets — goes out stale with nothing to flag it. Re-set each value on launch, and call `clearProviderContext` on logout or ad-id reset for privacy-sensitive values. Firebase's id resolves asynchronously, so on the install launch it usually arrives after the first events; from the next launch onward the persisted value covers them.

### Limits

Because this map rides on every event, it is bounded by size, not count: **2 KiB** (2,048 bytes) per value encoded as JSON, **16 KiB** (16,384 bytes) for everything you set, encoded as JSON with names included, and **64 bytes** per name (UTF-8). There is no limit on the number of providers or keys. A write that would grow the map past 16 KiB is rejected; overwriting a key with a value of the same or smaller size, or removing one, is always allowed. The SDK's own `metarouter` session block is added to each event and does not count against your budget. Names are trimmed and must not be blank. The `metarouter` provider is reserved for the SDK's own session block, in any casing or with separators (`Meta_Router`). Values must be plain JSON all the way down — strings, finite numbers, booleans, `null`, arrays and plain objects: an object holding a `Date`, `undefined`, `NaN` or a class instance is rejected whole.

A write that breaks one of these rules is **ignored**: `setProviderContext` returns `false` and logs a warning, and prior values stay. It never throws, even in development, because these values often come from third-party SDKs you do not control. Nothing is silently truncated: a trimmed vendor id looks valid and matches nothing downstream, which is worse than an absent one. `getDebugInfo()` reports the shape (providers and their key names) under `providerContext`, without the values, since these are device identifiers and debug info lands in logs.

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

sentAt semantics: sentAt is stamped when a batch is prepared for transmission. If the client is backing off, the actual transmit may be later. Each event's `timestamp` is set by the SDK and cannot be supplied.

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
| **consent** | `setConsent(…)` | `metarouter:consent:state` | All events (`context.consent`) | `clearConsent()` (survives `reset()`) |
| **provider context** | `setProviderContext(…)` | `metarouter:providers:context` | All events (`context.providers`) | `clearProviderContext`, `clearAllProviderContext` (survives `reset()`) |

Identity keys are in AsyncStorage. Consent and provider context are in native storage (UserDefaults keys prefixed `com.metarouter.reactnative:` on iOS; the `com.metarouter.reactnative.store` preferences file on Android), with AsyncStorage as the fallback without the native modules; on iOS the stored key is the table's key with that prefix. These never share state with the iOS or Android SDK: an app that embeds both keeps separate consent and provider context for each, so set them through each SDK.

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
- Storage inside the app's sandbox, readable only by the app; iOS encrypts it at rest with Data Protection. The SDK does not encrypt it itself.
- Cleared on explicit `reset()` call or app uninstall; on Android, Auto Backup (on unless the app turns it off) can restore it when the app is reinstalled

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

# @metarouter/react-native-sdk

[![npm version](https://img.shields.io/npm/v/@metarouter/react-native-sdk)](https://www.npmjs.com/package/@metarouter/react-native-sdk)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A lightweight React Native analytics SDK that transmits events to your MetaRouter cluster.

## Installation

```sh
npm install @metarouter/react-native-sdk @react-native-async-storage/async-storage react-native-device-info
```

## Usage

### Basic Setup

```js
import { createAnalyticsClient } from "@metarouter/react-native-sdk";

// Initialize the analytics client
const analytics = await createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
  debug: true, // Optional: enable debug mode
  flushIntervalSeconds: 30, // Optional: flush events every 30 seconds
});
```

### React Context Usage

```jsx
import React, { useEffect, useState } from "react";
import {
  createAnalyticsClient,
  MetaRouterProvider,
  useMetaRouter,
} from "@metarouter/react-native-sdk";

const App = () => {
  const [analyticsClient, setAnalyticsClient] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initializeAnalytics = async () => {
      try {
        // Initialize the analytics client
        const client = await createAnalyticsClient({
          writeKey: "your-write-key",
          ingestionHost: "https://your-ingestion-endpoint.com",
        });
        setAnalyticsClient(client);
      } catch (error) {
        console.error("Failed to initialize analytics:", error);
      } finally {
        setIsLoading(false);
      }
    };
    initializeAnalytics();
  }, []);

  if (isLoading) return null; // or a loading spinner

  return (
    <MetaRouterProvider analyticsClient={analyticsClient}>
      <YourApp />
    </MetaRouterProvider>
  );
};

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

// Initialize optionally await it but can use at anytime with events transmitted when client is available.
const analytics = await createAnalyticsClient({
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

## API Reference

### createAnalyticsClient(options)

Initializes the analytics client and returns a **live proxy** to the client instance.

⚠️ `createAnalyticsClient()` is asynchronous, but you **do not** need to `await` it before using analytics methods.

Calls to `track`, `identify`, etc. are **buffered in-memory** by the proxy and replayed **in order** once the client is fully initialized.

**Options:**

- `writeKey` (string, required): Your write key
- `ingestionHost` (string, required): Your MetaRouter ingestor host
- `debug` (boolean, optional): Enable debug mode
- `flushIntervalSeconds` (number, optional): Interval in seconds to flush events
- `maxQueueEvents` (number, optional): number of max events stored in memory

**Proxy behavior (quick notes):**

- Buffer is **in-memory only** (not persisted). Calls made before ready are lost if the process exits.
- Ordering is preserved relative to other buffered calls; normal FIFO + batching applies after ready.
- On fatal config errors (`401/403/404`), the client enters **disabled** state and drops subsequent calls.
- `sentAt` is stamped when the batch is prepared for transmission (just before network send). If you need the original occurrence time, pass your own `timestamp` on each event.

### Analytics Interface

The analytics client provides the following methods:

- `track(event: string, properties?: Record<string, any>)`: Track custom events
- `identify(userId: string, traits?: Record<string, any>)`: Identify users
- `group(groupId: string, traits?: Record<string, any>)`: Group users
- `screen(name: string, properties?: Record<string, any>)`: Track screen views
- `alias(newUserId: string)`: Alias user IDs
- `setAdvertisingId(advertisingId: string)`: Set the advertising identifier (IDFA on iOS, GAID on Android) for ad tracking. See [Advertising ID](#advertising-id-idfagaid) section for usage and compliance requirements
- `clearAdvertisingId()`: Clear the advertising identifier from storage and context. Useful for GDPR/CCPA compliance when users opt out of ad tracking
- `flush()`: Flush events immediately
- `reset()`: Reset analytics state and clear all stored data (includes clearing advertising ID)
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
- 🔄 **Reset Capability**: Easily reset analytics state for testing or logout scenarios
- 🐛 **Debug Support**: Built-in debugging tools for troubleshooting

## ✅ Compatibility

| Component             | Supported Versions |
| --------------------- | ------------------ |
| React Native          | >= 0.63            |
| React                 | >= 16.8            |
| iOS Deployment Target | >= iOS 10          |
| Android Min SDK       | >= API 16          |
| Node.js               | >= 16              |

## Debugging

If you're not seeing API calls being made, here are some steps to troubleshoot:

### 1. Enable Debug Logging

```js
// Initialize with debug enabled
const analytics = await createAnalyticsClient({
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
- **AsyncStorage**: The SDK uses AsyncStorage for anonymous ID persistence
- **Endpoint URL**: Verify your ingestion endpoint is correct and accessible
- **Write Key**: Ensure your write key is valid

### Delivery & Backoff (How events flow under failures)

Queue capacity: The SDK keeps up to 2,000 events in memory. When the cap is reached, the oldest events are dropped first (drop-oldest). You can change this via maxQueueEvents in createAnalyticsClient(options)

This SDK uses a circuit breaker around network I/O. It keeps ordering stable, avoids tight retry loops, and backs off cleanly when your cluster is unhealthy or throttling.

Queueing during backoff: While the breaker is OPEN, new events are accepted and appended to the in-memory queue; nothing is sent until the cooldown elapses.

Ordering (FIFO): If a batch fails with a retryable error, that batch is requeued at the front (original order preserved). New events go to the tail. After cooldown, we try again; on success we continue draining in order.

Half-open probe: After cooldown, one probe is allowed.
Success → breaker CLOSED (keep flushing).
Failure → breaker OPEN again with longer cooldown.

sentAt semantics: sentAt is stamped when the event is enqueued. If the client is backing off, the actual transmit may be later; sentAt reflects when the event entered the queue.

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

## Advertising ID (IDFA/GAID)

The SDK supports including advertising identifiers (IDFA on iOS, GAID on Android) in event context for ad tracking and attribution purposes.

### Usage

Use the `setAdvertisingId()` method to set the advertising identifier after initializing the analytics client:

```js
const analytics = await createAnalyticsClient({
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
import { AppTrackingTransparency } from 'react-native-tracking-transparency';
import { getAdvertisingId } from '@react-native-community/google-advertiser-id'; // or similar library

// Initialize analytics first
const analytics = await createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com",
});

// Request tracking permission
const trackingStatus = await AppTrackingTransparency.requestTrackingAuthorization();

if (trackingStatus === 'authorized') {
  // Get and set IDFA only if authorized
  const advertisingId = await getAdvertisingId();
  await analytics.setAdvertisingId(advertisingId);
}
```

### Android Example

```js
import { getAdvertisingId } from '@react-native-community/google-advertiser-id'; // or similar library

// Initialize analytics first
const analytics = await createAnalyticsClient({
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

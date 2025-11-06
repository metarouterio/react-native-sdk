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

// Initialize the client (optionally await it), but you can use it at any time
// with events transmitted when the client is ready.
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
const analytics = await createAnalyticsClient({
  writeKey: "key-1",
  ingestionHost: "https://endpoint-1.com",
});

// Later, if you need to change configuration:
await analytics.reset(); // Must reset first!

// Now reconfigure with new options
const analytics = await createAnalyticsClient({
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
- `page(name: string, properties?: Record<string, any>)`: Track page views
- `alias(newUserId: string)`: Connect anonymous users to known user IDs. See [Using the alias() Method](#using-the-alias-method) for details
- `setAdvertisingId(advertisingId: string)`: Set the advertising identifier (IDFA on iOS, GAID on Android) for ad tracking. See [Advertising ID](#advertising-id-idfagaid) section for usage and compliance requirements
- `clearAdvertisingId()`: Clear the advertising identifier from storage and context. Useful for GDPR/CCPA compliance when users opt out of ad tracking
- `setTracing(enabled: boolean)`: Enable or disable tracing headers on API requests. When enabled, includes a `Trace: true` header for debugging request flows
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

| Component                  | Supported Versions |
| -------------------------- | ------------------ |
| React Native               | >= 0.63            |
| React                      | >= 16.8            |
| iOS Deployment Target      | >= iOS 13          |
| Android Min SDK            | >= API 21          |
| Node.js                    | >= 16              |

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
- **AsyncStorage**: The SDK uses AsyncStorage for identity persistence (anonymousId, userId, groupId, advertisingId)
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
const analytics = await createAnalyticsClient({...});
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
const analytics = await createAnalyticsClient({...});
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
import { AppTrackingTransparency } from "react-native-tracking-transparency";
import { getAdvertisingId } from "@react-native-community/google-advertiser-id"; // or similar library

// Initialize analytics first
const analytics = await createAnalyticsClient({
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

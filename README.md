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

// Initialize
const analytics = await createAnalyticsClient({
  writeKey: "your-write-key",
  ingestionHost: "https://your-ingestion-endpoint.com/events",
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

Initializes the analytics client and returns a promise resolving to the client instance.

⚠️ createAnalyticsClient() is asynchronous, but you do not need to await it before using analytics methods.

Calls to track, identify, etc. are queued and replayed once the client is fully initialized.

**Options:**

- `writeKey` (string, required): Your write key
- `ingestionHost` (string, required): Your MetaRouter ingestor host
- `debug` (boolean, optional): Enable debug mode
- `flushIntervalSeconds` (number, optional): Interval in seconds to flush events

### Analytics Interface

The analytics client provides the following methods:

- `track(event: string, properties?: Record<string, any>)`: Track custom events
- `identify(userId: string, traits?: Record<string, any>)`: Identify users
- `group(groupId: string, traits?: Record<string, any>)`: Group users
- `screen(name: string, properties?: Record<string, any>)`: Track screen views
- `alias(newUserId: string)`: Alias user IDs
- `flush()`: Flush events immediately
- `reset()`: Reset analytics state and clear all stored data
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
const debugInfo = analytics.getDebugInfo?.();
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

## License

MIT

---

## Attributions

This library includes code from the following third-party packages:

- [uuid](https://github.com/uuidjs/uuid), MIT License

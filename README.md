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
import MetaRouter from "@metarouter/react-native-sdk";

// Initialize the analytics client
const analytics = await MetaRouter.analytics.init({
  writeKey: "your-write-key",
  ingestionEndpoint: "https://your-ingestion-endpoint.com/events",
  debug: true, // Optional: enable debug mode
  flushInterval: 30, // Optional: flush events every 30 seconds
});
```

### React Context Usage

```jsx
import React, { useEffect, useState } from "react";
import MetaRouter, {
  MetaRouterProvider,
  useMetaRouter,
} from "@metarouter/react-native-sdk";

const App = () => {
  const [metaRouterInstance, setMetaRouterInstance] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initializeAnalytics = async () => {
      try {
        // Initialize the analytics client
        await MetaRouter.analytics.init({
          writeKey: "your-write-key",
          ingestionEndpoint: "https://your-ingestion-endpoint.com",
        });

        setMetaRouterInstance(MetaRouter);
      } catch (error) {
        console.error("Failed to initialize analytics:", error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeAnalytics();
  }, []);

  return (
    <MetaRouterProvider instance={metaRouterInstance}>
      <YourApp />
    </MetaRouterProvider>
  );
};

// Use analytics in any component
const MyComponent = () => {
  const metaRouter = useMetaRouter();
  const analytics = metaRouter.analytics.getClient();

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
import MetaRouter from "@metarouter/react-native-sdk";

// Initialize
const analytics = await MetaRouter.analytics.init({
  writeKey: "your-write-key",
  ingestionEndpoint: "https://your-ingestion-endpoint.com/events",
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

// Cleanup when done
analytics.cleanup();

// Reset analytics (useful for testing or logout)
await MetaRouter.analytics.reset();
```

## API Reference

### MetaRouter.analytics.init(options)

Initializes the analytics client and returns a promise that resolves to the client instance.

**Options:**

- `writeKey` (string, required): Your write key
- `ingestionEndpoint` (string, required): Your custom ingestion endpoint URL
- `debug` (boolean, optional): Enable debug mode
- `flushInterval` (number, optional): Interval in seconds to flush events

### MetaRouter.analytics.getClient()

Returns the current analytics client instance. Must be called after initialization.

### MetaRouter.analytics.reset()

Resets the analytics client and clears all stored data. Returns a promise.

### Analytics Interface

The analytics client provides the following methods:

- `track(event: string, properties?: Record<string, any>)`: Track custom events
- `identify(userId: string, traits?: Record<string, any>)`: Identify users
- `group(groupId: string, traits?: Record<string, any>)`: Group users
- `screen(name: string, properties?: Record<string, any>)`: Track screen views
- `alias(newUserId: string)`: Alias user IDs
- `flush()`: Flush events immediately
- `cleanup()`: Clean up resources

### React Hooks

- `useMetaRouter()`: Hook to access the MetaRouter instance within a `MetaRouterProvider`

### Components

- `MetaRouterProvider`: React context provider for MetaRouter instance

## Features

- 🎯 **Custom Endpoints**: Send events to your own ingestion endpoints
- 📱 **React Native Optimized**: Built specifically for React Native
- 🎣 **React Hooks**: Easy integration with React components
- 🔧 **TypeScript Support**: Full TypeScript support included
- 🚀 **Lightweight**: Minimal overhead and dependencies
- 🔄 **Reset Capability**: Easily reset analytics state for testing or logout scenarios

## License

MIT

---

## Attributions

This library includes code from the following third-party packages:

- [uuid](https://github.com/uuidjs/uuid), MIT License

# @metarouter/react-native-sdk

[![npm version](https://img.shields.io/npm/v/@metarouter/react-native-sdk)](https://www.npmjs.com/package/@metarouter/react-native-sdk)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A lightweight React Native analytics SDK that transmits events to your MetaRouter cluster using Segment-compatible methods. Built on top of `@segment/analytics-react-native`.

## Installation

```sh
npm install @metarouter/react-native-sdk
```

## Usage

### Basic Setup

```js
import { createMetaRouterClient } from "@metarouter/react-native-sdk";

// Initialize the analytics client
const analytics = createMetaRouterClient({
  writeKey: "your-write-key",
  ingestionEndpoint: "https://your-ingestion-endpoint.com/events",
  debug: true, // Optional: enable debug mode
  flushInterval: 30, // Optional: flush events every 30 seconds
});
```

### React Context Usage

```jsx
import React from "react";
import {
  createMetaRouterClient,
  MetaRouterProvider,
  useMetaRouter,
} from "@metarouter/react-native-sdk";

const App = () => {
  const analytics = createMetaRouterClient({
    writeKey: "your-write-key",
    ingestionEndpoint: "https://your-ingestion-endpoint.com/events",
  });

  return (
    <MetaRouterProvider client={analytics}>
      <YourApp />
    </MetaRouterProvider>
  );
};

// Use analytics in any component
const MyComponent = () => {
  const analytics = useMetaRouter();

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
import { createMetaRouterClient } from "@metarouter/react-native-sdk";

// Initialize
const analytics = createMetaRouterClient({
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
```

## API Reference

### createMetaRouterClient(options)

Creates and initializes the analytics client.

**Options:**

- `writeKey` (string, required): Your write key
- `ingestionEndpoint` (string, required): Your custom ingestion endpoint URL
- `debug` (boolean, optional): Enable debug mode
- `flushAt` (number, optional): Number of events to batch before sending
- `flushInterval` (number, optional): Interval in seconds to flush events
- `trackLifecycleEvents` (boolean, optional): Track app lifecycle events
- `maxBatchSize` (number, optional): Maximum batch size for events

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

- `useMetaRouter()`: Hook to access the analytics client within a `MetaRouterProvider`

### Components

- `MetaRouterProvider`: React context provider for analytics client

## Features

- 🎯 **Custom Endpoints**: Send events to your own ingestion endpoints
- 📱 **React Native Optimized**: Built on top of Segment's analytics-react-native
- 🎣 **React Hooks**: Easy integration with React components
- 🔧 **TypeScript Support**: Full TypeScript support included
- 🚀 **Lightweight**: Minimal overhead and dependencies

## License

MIT

---

## Attributions

This library includes code from the following third-party packages:

- [@segment/analytics-react-native](https://github.com/segmentio/analytics-react-native), MIT License

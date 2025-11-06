# MetaRouter React Native SDK - Onboarding Guide

Welcome! This guide will help you integrate the MetaRouter React Native SDK into your application quickly and correctly. This is a hands-on companion to the [technical README](./README.md) and the [official React Native SDK documentation](https://docs.metarouter.io/docs/react).

## Who This Guide Is For

This guide is designed for:
- **Mobile developers** integrating MetaRouter for the first time
- **Teams migrating** from other analytics solutions
- **Product managers** who need to understand the implementation scope
- **QA engineers** validating analytics implementation

**Time commitment:** 15-30 minutes for basic integration, 1-2 hours for complete setup with testing

---

## Table of Contents

1. [Quick Start (15 Minutes)](#quick-start-15-minutes)
2. [Common Integration Patterns](#common-integration-patterns)
3. [Platform-Specific Setup](#platform-specific-setup)
4. [Testing & Validation](#testing--validation)
5. [Common Pitfalls & Troubleshooting](#common-pitfalls--troubleshooting)
6. [Environment Management](#environment-management)
7. [Best Practices](#best-practices)
8. [Migration Guide](#migration-guide)
9. [Appendix: Quick Reference](#appendix-quick-reference)

---

## Quick Start (15 Minutes)

### Prerequisites

Before you begin, ensure you have:
- ✅ React Native app (version 0.63 or higher)
- ✅ Your MetaRouter **Write Key** (get this from your MetaRouter dashboard)
- ✅ Your MetaRouter **Ingestion Host URL** (e.g., `https://platform.aws-us-east-1.mr-in.com`)
- ✅ Node.js 16 or higher

### Step 1: Install Dependencies (2 minutes)

```bash
npm install @metarouter/react-native-sdk @react-native-async-storage/async-storage react-native-device-info
```


### Step 2: Initialize Analytics (5 minutes)

Create a new file `src/services/analytics.ts`:

```typescript
import { createAnalyticsClient } from '@metarouter/react-native-sdk';

// Initialize the analytics client
export const analytics = createAnalyticsClient({
  writeKey: 'YOUR_WRITE_KEY_HERE',
  ingestionHost: 'https://your-ingestion-endpoint.com',
  debug: __DEV__, // Enable debug mode in development
  flushIntervalSeconds: 30, // Flush events every 30 seconds
});

// Export for use throughout your app
export default analytics;
```

**⚠️ Important:**
- You can start using `analytics` immediately without awaiting initialization. Events are buffered in memory and sent once the client is ready.
- **Only create ONE analytics client instance** in your entire app. The SDK is designed as a singleton pattern - creating multiple instances can lead to unexpected behavior.
- You have **two ways to access the same client** throughout your app:
  1. **Direct import**: `import { analytics } from './services/analytics'`
  2. **React hook**: `const { analytics } = useMetaRouter()` (requires MetaRouterProvider)

Both approaches use the **same underlying client instance**, so choose based on your preference and architecture.

### Step 3: Wrap Your App with MetaRouterProvider (3 minutes)

**Note:** This step is **optional** if you prefer to use direct imports throughout your app. However, using the provider and hook pattern is recommended for React components as it follows React best practices.

Update your `App.tsx` or `App.js`:

```typescript
import React, { useEffect, useState } from 'react';
import { MetaRouterProvider } from '@metarouter/react-native-sdk';
import { analytics } from './src/services/analytics';
import { YourMainComponent } from './src/components/YourMainComponent';

const App = () => {
  return (
    <MetaRouterProvider analyticsClient={analytics}>
      <YourMainComponent />
    </MetaRouterProvider>
  );
};

export default App;
```

### Step 4: Track Your First Event (5 minutes)

You can access the analytics client in two ways:

**Option A: Using the React Hook (recommended for components)**

```typescript
import React from 'react';
import { View, Button } from 'react-native';
import { useMetaRouter } from '@metarouter/react-native-sdk';

const MyComponent = () => {
  const { analytics } = useMetaRouter();

  const handleButtonPress = () => {
    analytics.track('Button Pressed', {
      buttonName: 'Get Started',
      screen: 'Welcome',
      timestamp: new Date().toISOString(),
    });
  };

  return (
    <View>
      <Button title="Get Started" onPress={handleButtonPress} />
    </View>
  );
};

export default MyComponent;
```

**Option B: Direct Import (works anywhere)**

```typescript
import React from 'react';
import { View, Button } from 'react-native';
import { analytics } from './services/analytics'; // Direct import

const MyComponent = () => {
  const handleButtonPress = () => {
    analytics.track('Button Pressed', {
      buttonName: 'Get Started',
      screen: 'Welcome',
      timestamp: new Date().toISOString(),
    });
  };

  return (
    <View>
      <Button title="Get Started" onPress={handleButtonPress} />
    </View>
  );
};

export default MyComponent;
```

**Both options access the exact same client instance.** Choose whichever fits your code style better.

### Step 5: Verify It Works

1. Run your app: `npx react-native run-ios` or `npx react-native run-android`
2. Press the button you just created
3. Check your console for debug logs: `[MetaRouter] Flushing 1 events`
4. Check your MetaRouter dashboard to see the event arrive (may take 1-2 minutes)

**🎉 Congratulations!** You've successfully integrated MetaRouter. Continue reading for production-ready patterns.

---

## Common Integration Patterns

### Understanding Client Access: Direct Import vs. Hook

Before diving into patterns, it's important to understand that **the SDK maintains a single client instance** across your entire app. You can access this same instance in two ways:

#### Method 1: Direct Import (Simple & Universal)
```typescript
// Anywhere in your app
import { analytics } from './services/analytics';

analytics.track('Event Name', { prop: 'value' });
```

**Pros:**
- Works anywhere (components, utilities, services, navigation callbacks)
- No need for React Context or hooks
- Simpler for non-React code

#### Method 2: React Hook (React-Friendly)
```typescript
// Inside React components
import { useMetaRouter } from '@metarouter/react-native-sdk';

function MyComponent() {
  const { analytics } = useMetaRouter();

  analytics.track('Event Name', { prop: 'value' });
}
```

**Pros:**
- Follows React best practices
- Clearly indicates React-specific code
- Better for testing (easier to mock providers)

**Requires:** Wrapping your app with `<MetaRouterProvider analyticsClient={analytics}>`

#### Important: Both Methods Use the Same Client

```typescript
// services/analytics.ts
export const analytics = createAnalyticsClient({...}); // Created ONCE

// Component A - using direct import
import { analytics } from './services/analytics';
analytics.track('Event A'); // Tracked

// Component B - using hook
const { analytics } = useMetaRouter();
analytics.track('Event B'); // Tracked by the SAME client instance

// Both events go through the same queue, same network layer, same everything!
```
---

### Pattern 1: User Authentication Flow

Handle user login, logout, and registration with proper identity management.

```typescript
import { analytics } from './services/analytics';

// ✅ When a user signs up (first time)
async function handleUserSignup(email: string, password: string) {
  const user = await createUserAccount(email, password);

  // Use alias() to connect anonymous browsing to the new account
  analytics.alias(user.id);

  // Then identify with user traits
  analytics.identify(user.id, {
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    plan: 'free',
  });

  analytics.track('User Signed Up', {
    method: 'email',
  });
}

// ✅ When a user logs in (returning user)
async function handleUserLogin(email: string, password: string) {
  const user = await authenticateUser(email, password);

  // Use identify() for subsequent logins (no need for alias)
  analytics.identify(user.id, {
    email: user.email,
    name: user.name,
    lastLogin: new Date().toISOString(),
  });

  analytics.track('User Logged In', {
    method: 'email',
  });
}

// ✅ When a user logs out
async function handleUserLogout() {
  analytics.track('User Logged Out');

  // IMPORTANT: Flush events BEFORE reset
  // reset() does NOT flush - it immediately clears the queue
  await analytics.flush();

  // Reset clears all identity data and generates a new anonymousId
  await analytics.reset();
}
```

**Why this matters:**
- `alias()` connects pre-signup activity to the new user account
- `identify()` is used for returning users to update their profile
- `reset()` ensures clean separation between user sessions

**⚠️ Critical: Always flush() before reset()**

The `reset()` method does **NOT** automatically flush events. It immediately:
1. Stops the flush loop
2. **Clears the event queue** (all unsent events are lost)
3. Clears all identity data (userId, anonymousId, groupId, advertisingId)

If you don't call `flush()` first, any pending events (including your logout event!) will be lost.

### Pattern 2: Screen Tracking with React Navigation

Automatically track screen views as users navigate through your app.

```typescript
import { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { useMetaRouter } from '@metarouter/react-native-sdk';

function App() {
  const { analytics } = useMetaRouter();
  const routeNameRef = useRef<string>();
  const navigationRef = useRef<any>();

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        routeNameRef.current = navigationRef.current?.getCurrentRoute()?.name;
      }}
      onStateChange={async () => {
        const previousRouteName = routeNameRef.current;
        const currentRouteName = navigationRef.current?.getCurrentRoute()?.name;

        if (previousRouteName !== currentRouteName) {
          // Track screen view
          analytics.screen(currentRouteName, {
            previousScreen: previousRouteName,
            timestamp: new Date().toISOString(),
          });
        }

        // Save the current route name for next time
        routeNameRef.current = currentRouteName;
      }}
    >
      {/* Your app screens */}
    </NavigationContainer>
  );
}
```

### Pattern 3: E-Commerce Event Tracking

Track product views, cart actions, and purchases.

```typescript
import { analytics } from './services/analytics';

// Product viewed
function trackProductViewed(product: Product) {
  analytics.track('Product Viewed', {
    productId: product.id,
    productName: product.name,
    category: product.category,
    price: product.price,
    currency: 'USD',
  });
}

// Add to cart
function trackAddToCart(product: Product, quantity: number) {
  analytics.track('Product Added to Cart', {
    productId: product.id,
    productName: product.name,
    price: product.price,
    quantity: quantity,
    cartTotal: calculateCartTotal(),
  });
}

// Purchase completed
function trackPurchaseCompleted(order: Order) {
  analytics.track('Order Completed', {
    orderId: order.id,
    total: order.total,
    revenue: order.revenue,
    tax: order.tax,
    shipping: order.shipping,
    currency: 'USD',
    products: order.items.map(item => ({
      productId: item.productId,
      productName: item.name,
      quantity: item.quantity,
      price: item.price,
    })),
  });
}
```

### Pattern 4: Group/Organization Tracking (B2B Apps)

Associate users with their organizations or teams.

```typescript
import { analytics } from './services/analytics';

// When a user selects their organization
function trackOrganizationSelection(org: Organization, user: User) {
  // Set the group
  analytics.group(org.id, {
    name: org.name,
    industry: org.industry,
    employeeCount: org.employeeCount,
    plan: org.subscriptionPlan,
    createdAt: org.createdAt,
  });

  // Identify the user within that organization
  analytics.identify(user.id, {
    email: user.email,
    role: user.role,
    organizationId: org.id,
  });

  analytics.track('Organization Selected', {
    organizationId: org.id,
    organizationName: org.name,
  });
}
```

### Pattern 5: Advertising ID Tracking (with Consent)

Properly handle advertising identifiers with user consent.

```typescript
import { Platform } from 'react-native';
import { analytics } from './services/analytics';
import {
  requestTrackingPermission,
  getTrackingStatus
} from 'react-native-tracking-transparency';

async function setupAdvertisingTracking() {
  if (Platform.OS === 'ios') {
    // iOS requires ATT (App Tracking Transparency)
    const trackingStatus = await requestTrackingPermission();

    if (trackingStatus === 'authorized') {
      const idfa = await getIDFA(); // Use appropriate library
      await analytics.setAdvertisingId(idfa);
    }
  } else if (Platform.OS === 'android') {
    // Android - check if user has limited ad tracking
    const { advertisingId, isLimitAdTrackingEnabled } = await getGAID(); // Use appropriate library

    if (!isLimitAdTrackingEnabled && advertisingId) {
      await analytics.setAdvertisingId(advertisingId);
    }
  }
}

// When user opts out of tracking
async function handleUserOptOut() {
  await analytics.clearAdvertisingId();
  analytics.track('User Opted Out of Ad Tracking');
}
```

**⚠️ Privacy Warning:** Always obtain explicit user consent before collecting advertising IDs. Follow GDPR, CCPA, and platform-specific requirements (Apple's ATT, Google Play policies).

---

## Platform-Specific Setup

### iOS Configuration

#### 1. Permissions in Info.plist

If you're using advertising ID tracking, add these keys to `ios/YourApp/Info.plist`:

```xml
<key>NSUserTrackingUsageDescription</key>
<string>We use tracking to provide personalized ads and improve your experience.</string>
```

#### 2. Privacy Manifest (iOS 17+)

If required by Apple, declare your tracking domains in `ios/YourApp/PrivacyInfo.xcprivacy`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <true/>
    <key>NSPrivacyTrackingDomains</key>
    <array>
        <string>your-ingestion-endpoint.com</string>
    </array>
</dict>
</plist>
```

#### 3. Run Pod Install

```bash
cd ios && pod install && cd ..
```

### Android Configuration

#### 1. Permissions in AndroidManifest.xml

Add internet permission in `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

For advertising ID (optional):
```xml
<uses-permission android:name="com.google.android.gms.permission.AD_ID"/>
```

#### 2. ProGuard Rules

If using ProGuard/R8, add to `android/app/proguard-rules.pro`:

```proguard
# MetaRouter React Native SDK
-keep class com.metarouter.** { *; }
-keep interface com.metarouter.** { *; }

# React Native AsyncStorage
-keep class com.reactnativecommunity.asyncstorage.** { *; }

# React Native Device Info
-keep class com.learnium.RNDeviceInfo.** { *; }
```

#### 3. Gradle Configuration

Ensure minimum SDK version in `android/app/build.gradle`:

```gradle
android {
    defaultConfig {
        minSdkVersion 16
        targetSdkVersion 33 // or higher
    }
}
```

---

## Testing & Validation

### Debug Mode

Enable debug logging to see events in your console:

```typescript
import { analytics } from './services/analytics';

// Enable debug mode
analytics.enableDebugLogging();

// Track an event
analytics.track('Test Event', { foo: 'bar' });

// Check debug info
const debugInfo = await analytics.getDebugInfo();
console.log('Analytics Debug Info:', debugInfo);
```

**Expected console output:**
```
[MetaRouter] Event queued: Test Event
[MetaRouter] Flushing 1 events...
[MetaRouter] Batch sent successfully (1 events)
```

---

## Common Pitfalls & Troubleshooting

### Events Not Appearing in Dashboard

**Symptoms:** You're tracking events but nothing shows up in MetaRouter dashboard.

**Possible causes & solutions:**

1. **Wrong Write Key or Ingestion Host**
   ```typescript
   // ❌ Wrong
   writeKey: 'YOUR_WRITE_KEY_HERE' // You forgot to replace this!

   // ✅ Correct
   writeKey: 'wk_prod_abc123xyz789' // Actual write key from dashboard
   ```

2. **Network connectivity issues**
   ```typescript
   // Check network state
   import NetInfo from '@react-native-community/netinfo';

   const state = await NetInfo.fetch();
   console.log('Network connected:', state.isConnected);
   ```

3. **Events buffered but not flushed**
   ```typescript
   // Force flush for testing
   await analytics.flush();
   ```

4. **Client entered disabled state (401/403/404)**
   ```typescript
   const debugInfo = await analytics.getDebugInfo();
   console.log('Client lifecycle:', debugInfo.lifecycle);
   // If lifecycle is "disabled", check your write key and ingestion host and internet connection
   ```


## Environment Management

### Managing Multiple Environments

Create environment-specific configurations:

```typescript
// config/analytics.config.ts
const analyticsConfig = {
  development: {
    writeKey: 'wk_dev_abc123',
    ingestionHost: 'https://dev-ingest.metarouter.com',
    debug: true,
    flushIntervalSeconds: 10, // Faster flush in dev
  },
  staging: {
    writeKey: 'wk_staging_xyz789',
    ingestionHost: 'https://staging-ingest.metarouter.com',
    debug: true,
    flushIntervalSeconds: 20,
  },
  production: {
    writeKey: 'wk_prod_def456',
    ingestionHost: 'https://prod-ingest.metarouter.com',
    debug: false,
    flushIntervalSeconds: 30,
  },
};

// Get config based on environment
const ENV = __DEV__ ? 'development' : 'production'; // Or use react-native-config

export const getAnalyticsConfig = () => {
  return analyticsConfig[ENV];
};
```

**Usage:**
```typescript
// services/analytics.ts
import { createAnalyticsClient } from '@metarouter/react-native-sdk';
import { getAnalyticsConfig } from '../config/analytics.config';

const config = getAnalyticsConfig();

export const analytics = createAnalyticsClient(config);
```

---

## Best Practices

### 1. Event Naming Conventions

Use consistent, clear event names:

```typescript
// ✅ Good - Clear, past tense, object-action format
analytics.track('Order Completed', {...});
analytics.track('Product Added to Cart', {...});
analytics.track('User Logged In', {...});

// ❌ Bad - Inconsistent, unclear
analytics.track('order_complete', {...}); // Snake case
analytics.track('Adding Product', {...}); // Present tense
analytics.track('Login', {...}); // Ambiguous (login shown? attempted? completed?)
```

**Recommended naming pattern:**
- Use **past tense** (event already happened)
- Use **Object + Action** format: "Object Action" or "Action Performed"
- Use **Title Case** for readability
- Be **specific** and **descriptive**

### 2. Property Structure

Keep properties flat and consistent:

```typescript
// ✅ Good - Flat, consistent types
analytics.track('Product Viewed', {
  productId: 'SKU123',
  productName: 'Blue Widget',
  category: 'Widgets',
  price: 29.99,
  currency: 'USD',
  inStock: true,
});

// ❌ Bad - Nested objects, inconsistent
analytics.track('Product Viewed', {
  product: {
    id: 'SKU123',
    details: {
      name: 'Blue Widget',
      pricing: {
        amount: 29.99,
      },
    },
  },
});
```

### 3. Don't Track PII Without Consent

Be mindful of what you track:

```typescript
// ❌ Bad - Tracking sensitive PII without consent
analytics.track('Checkout Started', {
  creditCardNumber: '4111111111111111', // NEVER!
  ssn: '123-45-6789', // NEVER!
  password: 'user_password', // NEVER!
});

// ✅ Good - Track identifiers and anonymized data
analytics.track('Checkout Started', {
  userId: 'user_abc123', // OK if this is your internal ID
  paymentMethod: 'credit_card', // Type, not actual card number
  cartTotal: 199.99,
});
```

### 4. Identity Management Best Practices

```typescript
// ✅ Best practice flow:
// 1. App starts -> anonymousId auto-generated
// 2. User browses -> track events with anonymousId
// 3. User signs up -> call alias() to link anonymous to new userId
// 4. User logs in (subsequent) -> call identify()
// 5. User logs out -> call reset()

// First-time user signup
async function handleSignup(userId: string, traits: Record<string, any>) {
  analytics.alias(userId); // Link anonymous to new user
  analytics.identify(userId, traits); // Set traits
}

// Returning user login
async function handleLogin(userId: string, traits: Record<string, any>) {
  analytics.identify(userId, traits); // No need for alias
}

// User logout
async function handleLogout() {
  await analytics.flush(); // Send any pending events
  await analytics.reset(); // Clear identity
}
```


---

## Migration Guide

### From Segment Analytics

MetaRouter's API is compatible with Segment's. Most code will work with minimal changes:

```typescript
// ❌ Old Segment code
import Analytics from '@segment/analytics-react-native';

await Analytics.setup('WRITE_KEY', {
  trackAppLifecycleEvents: true,
});

Analytics.track('Event Name', { property: 'value' });

// ✅ New MetaRouter code
import { createAnalyticsClient } from '@metarouter/react-native-sdk';

const analytics = createAnalyticsClient({
  writeKey: 'WRITE_KEY',
  ingestionHost: 'YOUR_INGESTION_HOST', // New required field
});

analytics.track('Event Name', { property: 'value' });
```

**Key differences:**
1. **Initialization:** `createAnalyticsClient()` instead of `Analytics.setup()`
2. **Ingestion host:** Must provide your MetaRouter ingestion endpoint
3. **No default plugins:** MetaRouter doesn't include destination plugins by default
4. **Simplified API:** Focused on core tracking, identity, and reset functionality

### From Firebase Analytics

```typescript
// ❌ Old Firebase code
import analytics from '@react-native-firebase/analytics';

await analytics().logEvent('purchase', {
  value: 99.99,
  currency: 'USD',
});

// ✅ New MetaRouter code
import { analytics } from './services/analytics';

analytics.track('Purchase', {
  value: 99.99,
  currency: 'USD',
});
```

**Key differences:**
1. **Event names:** MetaRouter uses clear, human-readable names (not snake_case)
2. **User ID:** Use `identify()` instead of `setUserId()`
3. **User properties:** Use `identify(userId, traits)` instead of `setUserProperty()`

### From Mixpanel

```typescript
// ❌ Old Mixpanel code
import Mixpanel from 'mixpanel-react-native';

await Mixpanel.init('PROJECT_TOKEN');
Mixpanel.track('Event Name', { prop: 'value' });
Mixpanel.identify('user123');

// ✅ New MetaRouter code
import { analytics } from './services/analytics';

analytics.track('Event Name', { prop: 'value' });
analytics.identify('user123');
```

**Key differences:**
1. **Initialization:** Provide both writeKey and ingestionHost
2. **Super properties:** Use `identify(userId, traits)` to set persistent properties
3. **Time-based properties:** MetaRouter auto-adds timestamp; no need for manual time events

---

## Appendix: Quick Reference

### Common Methods

```typescript
// Tracking
analytics.track('Event Name', { prop: 'value' });
analytics.screen('Screen Name', { prop: 'value' });
analytics.page('Page Name', { prop: 'value' });

// Identity
analytics.identify('userId', { name: 'John', email: 'john@example.com' });
analytics.alias('newUserId'); // Connect anonymous to known user
analytics.group('orgId', { name: 'Acme Corp' });

// Privacy
await analytics.setAdvertisingId('idfa-or-gaid');
await analytics.clearAdvertisingId();

// Lifecycle
await analytics.flush(); // Send events immediately
await analytics.reset(); // Clear all data and identity

// Debugging
analytics.enableDebugLogging();
const info = await analytics.getDebugInfo();
```

### Configuration Options

```typescript
createAnalyticsClient({
  writeKey: string;              // Required: Your MetaRouter write key
  ingestionHost: string;         // Required: Your ingestion endpoint
  debug?: boolean;               // Optional: Enable console logging (default: false)
  flushIntervalSeconds?: number; // Optional: Auto-flush interval (default: 30)
  maxQueueEvents?: number;       // Optional: Max in-memory events (default: 2000)
});
```

---

**You're all set!** You now have a production-ready MetaRouter integration. Happy tracking!

// @metarouter/react-native-sdk/react-native.config.js
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageInstance: 'new MetaRouterReactNativeSDKPackage()',
        packageImportPath: 'com.metarouter.reactnativesdk.MetaRouterReactNativeSDKPackage',
      },
    },
  },
  dependencies: {
    '@segment/analytics-react-native': {
      platforms: {
        android: null,
        ios: null,
      },
    },
    '@segment/sovran-react-native': {
      platforms: {
        android: null,
        ios: null,
      },
    },
    'react-native-get-random-values': {
      platforms: {
        android: null,
        ios: null,
      },
    },
    '@react-native-async-storage/async-storage': {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};
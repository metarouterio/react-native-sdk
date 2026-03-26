module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: './metarouter-react-native-sdk.podspec',
      },
      android: {
        sourceDir: './android',
        packageImportPath:
          'import com.metarouter.reactnative.MetaRouterQueueStoragePackage;',
        packageInstance: 'new MetaRouterQueueStoragePackage()',
      },
    },
  },
};

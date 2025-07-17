Pod::Spec.new do |s|
    s.name         = 'MetaRouterReactNative'
    s.version      = '0.1.0'
    s.summary      = 'MetaRouter analytics wrapper for React Native'
    s.description  = 'MetaRouter analytics SDK that wraps Segment and handles event routing.'
    s.license      = { :type => 'MIT', :file => 'LICENSE' }
    s.authors      = { 'Chris Houdlette' => 'chris@example.com' }
    s.homepage     = 'https://github.com/metarouterio/react-native-sdk'
    s.source       = { :git => 'https://github.com/metarouterio/react-native-sdk.git', :tag => s.version.to_s }
  
    s.platform     = :ios, '12.0'
    s.requires_arc = true
    s.swift_version = '5.0'
  
    # No need to manually specify source_files if your SDK has no native code
    # s.source_files = 'ios/**/*.{h,m,mm,swift}'
  
    # React Native internals
    s.dependency 'React-Core'
    s.dependency 'React-RCTBridge'
    s.dependency 'React-RCTUtils'
  
    # Real native dependencies that you want CocoaPods to fetch and install
    s.dependency 'AnalyticsReactNative', '~> 2.21.2'
    s.dependency 'SovranReactNative', '~> 1.1.3'
    s.dependency 'react-native-get-random-values', '~> 1.11.0'
  end
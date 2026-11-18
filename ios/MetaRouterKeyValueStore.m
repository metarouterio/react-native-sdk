#import <React/RCTBridgeModule.h>

// Synchronous string store for state that must be known before host code runs:
// consent and provider context. AsyncStorage resolves after the first host
// line, so a synchronous getConsent() there could only report defaults — the
// iOS SDK reads UserDefaults synchronously and has no such window.
//
// Its own UserDefaults keys, prefixed: the iOS SDK stores Data under the bare
// names in a hybrid app, and a String read of Data is nil.
@interface MetaRouterKeyValueStore : NSObject <RCTBridgeModule>
@end

@implementation MetaRouterKeyValueStore

static NSString *const kPrefix = @"com.metarouter.reactnative:";

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// NSNull when nothing is stored under the key.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getSync : (NSString *)key)
{
  NSString *value = [[NSUserDefaults standardUserDefaults]
      stringForKey:[kPrefix stringByAppendingString:key]];
  return value ?: (id)[NSNull null];
}

// Synchronous so writes land in call order; a nil value removes the key.
// Returns YES once UserDefaults holds the value: it persists in the background
// and offers no disk confirmation (synchronize is deprecated), unlike Android's
// commit(). A blocking method must return a value to stay synchronous under the
// new architecture.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setSync : (NSString *)key value : (nullable NSString *)value)
{
  [[NSUserDefaults standardUserDefaults]
      setObject:value
         forKey:[kPrefix stringByAppendingString:key]];
  return @YES;
}

@end

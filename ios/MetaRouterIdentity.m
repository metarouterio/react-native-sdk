#import <React/RCTBridgeModule.h>

@interface MetaRouterIdentity : NSObject <RCTBridgeModule>
@end

@implementation MetaRouterIdentity

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_EXPORT_METHOD(getAnonymousId:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  // Delegate to the native MetaRouter iOS SDK's identity layer.
  // If the native SDK is not initialized or unavailable, resolve nil.
  @try {
    Class metaRouterClass = NSClassFromString(@"MetaRouter.Analytics");
    if (!metaRouterClass) {
      resolve([NSNull null]);
      return;
    }

    // The native iOS SDK exposes getAnonymousId() on the AnalyticsInterface
    // returned by MetaRouter.Analytics. Because the iOS SDK is actor-based and
    // async, the bridge resolves nil when the client is not yet available.
    SEL clientSel = NSSelectorFromString(@"client");
    if (![metaRouterClass respondsToSelector:clientSel]) {
      resolve([NSNull null]);
      return;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id client = [metaRouterClass performSelector:clientSel];
#pragma clang diagnostic pop

    if (!client) {
      resolve([NSNull null]);
      return;
    }

    SEL anonIdSel = NSSelectorFromString(@"getAnonymousId");
    if (![client respondsToSelector:anonIdSel]) {
      resolve([NSNull null]);
      return;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id anonymousId = [client performSelector:anonIdSel];
#pragma clang diagnostic pop

    resolve(anonymousId ?: [NSNull null]);
  } @catch (NSException *exception) {
    resolve([NSNull null]);
  }
}

@end

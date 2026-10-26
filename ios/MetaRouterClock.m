#import <React/RCTBridgeModule.h>
#include <mach/mach_time.h>

// Synchronous monotonic clock for session inactivity. mach_continuous_time
// keeps counting while the device sleeps; mach_absolute_time (and the
// CACurrentMediaTime behind React Native's performance.now) does not, so a
// phone locked for hours would resume into the same session. Same clock as
// the iOS SDK's MonotonicClock.
@interface MetaRouterClock : NSObject <RCTBridgeModule>
@end

@implementation MetaRouterClock

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(continuousMillis)
{
  static mach_timebase_info_data_t timebase;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    mach_timebase_info(&timebase);
  });
  uint64_t nanos = mach_continuous_time() * timebase.numer / timebase.denom;
  return @((double)(nanos / NSEC_PER_MSEC));
}

@end

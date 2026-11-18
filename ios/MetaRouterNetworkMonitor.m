#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <Network/Network.h>

@interface MetaRouterNetworkMonitor : RCTEventEmitter <RCTBridgeModule>
@end

@implementation MetaRouterNetworkMonitor {
  nw_path_monitor_t _monitor;
  dispatch_queue_t _monitorQueue;
  BOOL _isConnected;
  // nil until the first path: wifi is unknown, not false, before then.
  NSNumber *_isWifi;
  // Read and written only on _monitorQueue, like the state it gates.
  BOOL _hasListeners;
  // getCurrentStatus calls made before the first path, answered when it lands.
  // Touched only on _monitorQueue. JS bounds its own wait for these.
  NSMutableArray<RCTPromiseResolveBlock> *_pendingStatus;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _isConnected = YES; // optimistic default
    _hasListeners = NO;
    _pendingStatus = [NSMutableArray array];
    _monitorQueue = dispatch_queue_create("com.metarouter.network.monitor", DISPATCH_QUEUE_SERIAL);
    _monitor = nw_path_monitor_create();

    __weak typeof(self) weakSelf = self;
    nw_path_monitor_set_update_handler(_monitor, ^(nw_path_t path) {
      __strong typeof(weakSelf) strongSelf = weakSelf;
      if (!strongSelf) return;

      BOOL connected = (nw_path_get_status(path) == nw_path_status_satisfied);
      NSNumber *wifi = @(nw_path_uses_interface_type(path, nw_interface_type_wifi));
      // A wifi <-> cellular switch keeps the path satisfied, so the interface
      // change has to emit on its own or JS keeps stamping the old interface.
      BOOL changed = (connected != strongSelf->_isConnected) ||
                     strongSelf->_isWifi == nil ||
                     ![wifi isEqualToNumber:strongSelf->_isWifi];
      strongSelf->_isConnected = connected;
      strongSelf->_isWifi = wifi;
      [strongSelf resolvePendingStatus];

      if (changed && strongSelf->_hasListeners) {
        [strongSelf sendEventWithName:@"onConnectivityChange"
                                 body:[strongSelf currentState]];
      }
    });

    nw_path_monitor_set_queue(_monitor, _monitorQueue);
    nw_path_monitor_start(_monitor);
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"onConnectivityChange"];
}

// A path that lands before JS's listener attaches is emitted to no one, so
// attaching re-sends the current state: JS then never misses a change, however
// the attach races the path updates.
- (void)startObserving {
  dispatch_async(_monitorQueue, ^{
    self->_hasListeners = YES;
    if (self->_isWifi != nil) {
      [self sendEventWithName:@"onConnectivityChange" body:[self currentState]];
    }
  });
}

- (void)stopObserving {
  dispatch_async(_monitorQueue, ^{
    self->_hasListeners = NO;
  });
}

- (NSDictionary *)currentState {
  return @{@"isConnected": @(_isConnected),
           @"isWifi": _isWifi ?: [NSNull null]};
}

- (void)resolvePendingStatus {
  NSDictionary *state = [self currentState];
  for (RCTPromiseResolveBlock resolve in _pendingStatus) resolve(state);
  [_pendingStatus removeAllObjects];
}

// Answers with the first path rather than the optimistic defaults: JS waits
// on this answer for the wifi stamp on cold-launch events, and an early
// "unknown" would release that wait with nothing.
RCT_EXPORT_METHOD(getCurrentStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(_monitorQueue, ^{
    if (self->_isWifi != nil) {
      resolve([self currentState]);
      return;
    }
    [self->_pendingStatus addObject:resolve];
  });
}

// Bridge reload or host teardown: stop sending into a module React Native has
// already dropped. Pending getCurrentStatus promises belong to that torn-down
// runtime, so they are released, not answered.
- (void)invalidate {
  [super invalidate];
  dispatch_async(_monitorQueue, ^{
    self->_hasListeners = NO;
    [self->_pendingStatus removeAllObjects];
    if (self->_monitor) {
      nw_path_monitor_cancel(self->_monitor);
      self->_monitor = nil;
    }
  });
}

- (void)dealloc {
  if (_monitor) {
    nw_path_monitor_cancel(_monitor);
  }
}

@end

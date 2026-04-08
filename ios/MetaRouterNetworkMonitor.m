#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <Network/Network.h>

@interface MetaRouterNetworkMonitor : RCTEventEmitter <RCTBridgeModule>
@end

@implementation MetaRouterNetworkMonitor {
  nw_path_monitor_t _monitor;
  dispatch_queue_t _monitorQueue;
  BOOL _isConnected;
  BOOL _hasListeners;
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
    _monitorQueue = dispatch_queue_create("com.metarouter.network.monitor", DISPATCH_QUEUE_SERIAL);
    _monitor = nw_path_monitor_create();

    __weak typeof(self) weakSelf = self;
    nw_path_monitor_set_update_handler(_monitor, ^(nw_path_t path) {
      __strong typeof(weakSelf) strongSelf = weakSelf;
      if (!strongSelf) return;

      BOOL connected = (nw_path_get_status(path) == nw_path_status_satisfied);
      BOOL changed = (connected != strongSelf->_isConnected);
      strongSelf->_isConnected = connected;

      if (changed && strongSelf->_hasListeners) {
        [strongSelf sendEventWithName:@"onConnectivityChange"
                                 body:@{@"isConnected": @(connected)}];
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

- (void)startObserving {
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

RCT_EXPORT_METHOD(getCurrentStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve(@(_isConnected));
}

- (void)dealloc {
  if (_monitor) {
    nw_path_monitor_cancel(_monitor);
  }
}

@end

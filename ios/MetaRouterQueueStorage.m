#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

@interface MetaRouterQueueStorage : NSObject <RCTBridgeModule>
@end

@implementation MetaRouterQueueStorage

RCT_EXPORT_MODULE()

/**
 * Returns the path to the queue snapshot file.
 * Location: Application Support/metarouter/disk-queue/queue.v1.json
 * The directory is created on first write and marked as excluded from backup.
 */
- (NSString *)snapshotPath {
  NSArray *paths = NSSearchPathForDirectoriesInDomains(
    NSApplicationSupportDirectory, NSUserDomainMask, YES
  );
  NSString *appSupport = paths.firstObject;
  return [appSupport stringByAppendingPathComponent:@"metarouter/disk-queue/queue.v1.json"];
}

/**
 * Ensures the queue directory exists and is excluded from backup.
 */
- (BOOL)ensureDirectoryExists:(NSError **)error {
  NSString *dir = [[self snapshotPath] stringByDeletingLastPathComponent];
  NSFileManager *fm = [NSFileManager defaultManager];

  if (![fm fileExistsAtPath:dir]) {
    if (![fm createDirectoryAtPath:dir
       withIntermediateDirectories:YES
                        attributes:nil
                             error:error]) {
      return NO;
    }
  }

  // Mark directory as excluded from backup
  NSURL *dirURL = [NSURL fileURLWithPath:dir];
  return [dirURL setResourceValue:@YES
                           forKey:NSURLIsExcludedFromBackupKey
                            error:error];
}

RCT_EXPORT_METHOD(readSnapshot:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *path = [self snapshotPath];
  NSFileManager *fm = [NSFileManager defaultManager];

  if (![fm fileExistsAtPath:path]) {
    resolve([NSNull null]);
    return;
  }

  NSError *error = nil;
  NSString *contents = [NSString stringWithContentsOfFile:path
                                                 encoding:NSUTF8StringEncoding
                                                    error:&error];
  if (error) {
    reject(@"READ_ERROR", @"Failed to read queue snapshot", error);
    return;
  }

  resolve(contents);
}

RCT_EXPORT_METHOD(writeSnapshot:(NSString *)data
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSError *error = nil;

  if (![self ensureDirectoryExists:&error]) {
    reject(@"DIR_ERROR", @"Failed to create queue directory", error);
    return;
  }

  NSString *path = [self snapshotPath];
  if (![data writeToFile:path
              atomically:YES
                encoding:NSUTF8StringEncoding
                   error:&error]) {
    reject(@"WRITE_ERROR", @"Failed to write queue snapshot", error);
    return;
  }

  resolve([NSNull null]);
}

RCT_EXPORT_METHOD(deleteSnapshot:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *path = [self snapshotPath];
  NSFileManager *fm = [NSFileManager defaultManager];

  if ([fm fileExistsAtPath:path]) {
    NSError *error = nil;
    if (![fm removeItemAtPath:path error:&error]) {
      reject(@"DELETE_ERROR", @"Failed to delete queue snapshot", error);
      return;
    }
  }

  resolve([NSNull null]);
}

@end

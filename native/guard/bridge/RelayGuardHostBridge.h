#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// Matches the explicit @objc class/selector in RelayGuardHostBridge.swift.
// Kept small so syntax checking the C++ bridge does not require linking or
// loading the Swift implementation into a running application.
@interface RelayGuardHostBridge : NSObject
+ (void)request:(NSString*)request validity:(BOOL (^)(void))validity completion:(void (^)(NSString*))completion;
@end
@interface RelayMaintenanceHostBridge : NSObject
+ (void)request:(NSString*)request validity:(BOOL (^)(void))validity completion:(void (^)(NSString*))completion;
@end
@interface RelayScopedStorageHostBridge : NSObject
+ (void)request:(NSString*)request validity:(BOOL (^)(void))validity completion:(void (^)(NSString*))completion;
@end
@interface RelayTerminalLeaseHostBridge : NSObject
+ (void)request:(NSString*)request completion:(void (^)(NSString*))completion;
+ (void)invalidate;
@end
NS_ASSUME_NONNULL_END

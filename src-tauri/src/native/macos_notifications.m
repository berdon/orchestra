#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <dispatch/dispatch.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef NS_ENUM(NSInteger, OrchestraNotificationPermissionState) {
  OrchestraNotificationPermissionStateUnsupported = 0,
  OrchestraNotificationPermissionStateNotDetermined = 1,
  OrchestraNotificationPermissionStateDenied = 2,
  OrchestraNotificationPermissionStateGranted = 3,
  OrchestraNotificationPermissionStateProvisional = 4,
  OrchestraNotificationPermissionStateEphemeral = 5,
};

static char *orchestra_copy_c_string(NSString *value) {
  if (value == nil) {
    return NULL;
  }
  const char *utf8 = [value UTF8String];
  if (utf8 == NULL) {
    return NULL;
  }
  size_t length = strlen(utf8);
  char *copy = (char *)malloc(length + 1);
  if (copy == NULL) {
    return NULL;
  }
  memcpy(copy, utf8, length + 1);
  return copy;
}

static NSString *orchestra_string_from_c_string(const char *value) {
  if (value == NULL) {
    return nil;
  }
  return [NSString stringWithUTF8String:value];
}

static NSInteger orchestra_map_authorization_status(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined:
      return OrchestraNotificationPermissionStateNotDetermined;
    case UNAuthorizationStatusDenied:
      return OrchestraNotificationPermissionStateDenied;
    case UNAuthorizationStatusAuthorized:
      return OrchestraNotificationPermissionStateGranted;
#ifdef UNAuthorizationStatusProvisional
    case UNAuthorizationStatusProvisional:
      return OrchestraNotificationPermissionStateProvisional;
#endif
#ifdef UNAuthorizationStatusEphemeral
    case UNAuthorizationStatusEphemeral:
      return OrchestraNotificationPermissionStateEphemeral;
#endif
    default:
      return OrchestraNotificationPermissionStateUnsupported;
  }
}

@interface OrchestraNotificationCenterDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation OrchestraNotificationCenterDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
  if (@available(macOS 11.0, *)) {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
  } else {
    completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
  }
}

@end

static OrchestraNotificationCenterDelegate *orchestra_notification_delegate = nil;

bool orchestra_macos_notifications_initialize(char **error_out) {
  @autoreleasepool {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    if (orchestra_notification_delegate == nil) {
      orchestra_notification_delegate = [[OrchestraNotificationCenterDelegate alloc] init];
    }
    center.delegate = orchestra_notification_delegate;
    return true;
  }
}

int orchestra_macos_notifications_permission_state(char **error_out) {
  @autoreleasepool {
    __block NSInteger permissionState = OrchestraNotificationPermissionStateNotDetermined;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
          permissionState = orchestra_map_authorization_status(settings.authorizationStatus);
          dispatch_semaphore_signal(semaphore);
        }];

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(semaphore, timeout) != 0) {
      if (error_out != NULL) {
        *error_out = orchestra_copy_c_string(@"Timed out waiting for macOS notification settings.");
      }
      return OrchestraNotificationPermissionStateUnsupported;
    }

    return (int)permissionState;
  }
}

int orchestra_macos_notifications_request_permission(char **error_out) {
  @autoreleasepool {
    __block BOOL granted = NO;
    __block NSError *requestError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionBadge | UNAuthorizationOptionSound)
                      completionHandler:^(BOOL didGrant, NSError *error) {
                        granted = didGrant;
                        requestError = error;
                        dispatch_semaphore_signal(semaphore);
                      }];

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(semaphore, timeout) != 0) {
      if (error_out != NULL) {
        *error_out = orchestra_copy_c_string(@"Timed out requesting macOS notification permission.");
      }
      return OrchestraNotificationPermissionStateUnsupported;
    }

    if (requestError != nil) {
      if (error_out != NULL) {
        *error_out = orchestra_copy_c_string(requestError.localizedDescription ?: @"Unable to request macOS notification permission.");
      }
      return OrchestraNotificationPermissionStateUnsupported;
    }

    if (granted) {
      return OrchestraNotificationPermissionStateGranted;
    }

    return orchestra_macos_notifications_permission_state(error_out);
  }
}

bool orchestra_macos_notifications_send(
    const char *identifier,
    const char *title,
    const char *body,
    const char *thread_identifier,
    char **error_out
) {
  @autoreleasepool {
    NSString *identifierString = orchestra_string_from_c_string(identifier);
    NSString *titleString = orchestra_string_from_c_string(title) ?: @"";
    NSString *bodyString = orchestra_string_from_c_string(body) ?: @"";
    NSString *threadIdentifierString = orchestra_string_from_c_string(thread_identifier);

    if (identifierString == nil || identifierString.length == 0) {
      identifierString = [[NSUUID UUID] UUIDString];
    }

    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = titleString;
    content.body = bodyString;
    content.sound = [UNNotificationSound defaultSound];
    if (threadIdentifierString != nil && threadIdentifierString.length > 0) {
      content.threadIdentifier = threadIdentifierString;
    }

    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifierString content:content trigger:nil];
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSError *deliveryError = nil;

    [[UNUserNotificationCenter currentNotificationCenter]
        addNotificationRequest:request
         withCompletionHandler:^(NSError *error) {
           deliveryError = error;
           dispatch_semaphore_signal(semaphore);
         }];

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(semaphore, timeout) != 0) {
      if (error_out != NULL) {
        *error_out = orchestra_copy_c_string(@"Timed out scheduling macOS notification.");
      }
      return false;
    }

    if (deliveryError != nil) {
      if (error_out != NULL) {
        *error_out = orchestra_copy_c_string(deliveryError.localizedDescription ?: @"Unable to schedule macOS notification.");
      }
      return false;
    }

    return true;
  }
}

void orchestra_macos_notifications_free_string(char *value) {
  if (value != NULL) {
    free(value);
  }
}

use crate::models::{SystemNotificationPermissionState, SystemNotificationRequest};

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};

    use crate::models::{SystemNotificationPermissionState, SystemNotificationRequest};

    unsafe extern "C" {
        fn orchestra_macos_notifications_initialize(error_out: *mut *mut c_char) -> bool;
        fn orchestra_macos_notifications_permission_state(error_out: *mut *mut c_char) -> c_int;
        fn orchestra_macos_notifications_request_permission(error_out: *mut *mut c_char) -> c_int;
        fn orchestra_macos_notifications_send(
            identifier: *const c_char,
            title: *const c_char,
            body: *const c_char,
            thread_identifier: *const c_char,
            error_out: *mut *mut c_char,
        ) -> bool;
        fn orchestra_macos_notifications_free_string(value: *mut c_char);
    }

    fn take_error(error_ptr: *mut c_char) -> Option<String> {
        if error_ptr.is_null() {
            return None;
        }

        let message = unsafe { CStr::from_ptr(error_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { orchestra_macos_notifications_free_string(error_ptr) };
        Some(message)
    }

    fn map_permission_state(value: c_int) -> SystemNotificationPermissionState {
        match value {
            1 => SystemNotificationPermissionState::NotDetermined,
            2 => SystemNotificationPermissionState::Denied,
            3 => SystemNotificationPermissionState::Granted,
            4 => SystemNotificationPermissionState::Provisional,
            5 => SystemNotificationPermissionState::Ephemeral,
            _ => SystemNotificationPermissionState::Unsupported,
        }
    }

    fn into_c_string(value: &str, field_name: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| {
            format!(
                "System notification {} contains an embedded NUL byte and cannot be delivered.",
                field_name
            )
        })
    }

    fn optional_c_string(value: Option<&str>, field_name: &str) -> Result<Option<CString>, String> {
        value.map(|entry| into_c_string(entry, field_name)).transpose()
    }

    pub fn initialize() -> Result<(), String> {
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { orchestra_macos_notifications_initialize(&mut error_ptr) };
        if ok {
            Ok(())
        } else {
            Err(take_error(error_ptr)
                .unwrap_or_else(|| "Unable to initialize macOS system notifications.".into()))
        }
    }

    pub fn permission_state() -> Result<SystemNotificationPermissionState, String> {
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let state = unsafe { orchestra_macos_notifications_permission_state(&mut error_ptr) };
        if let Some(error) = take_error(error_ptr) {
            return Err(error);
        }
        Ok(map_permission_state(state))
    }

    pub fn request_permission() -> Result<SystemNotificationPermissionState, String> {
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let state = unsafe { orchestra_macos_notifications_request_permission(&mut error_ptr) };
        if let Some(error) = take_error(error_ptr) {
            return Err(error);
        }
        Ok(map_permission_state(state))
    }

    pub fn send(request: &SystemNotificationRequest) -> Result<bool, String> {
        let identifier = into_c_string(
            request
                .tag
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("orchestra-notification"),
            "tag",
        )?;
        let title = into_c_string(&request.title, "title")?;
        let body = into_c_string(&request.body, "body")?;
        let thread_identifier = optional_c_string(request.tag.as_deref(), "tag")?;
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let ok = unsafe {
            orchestra_macos_notifications_send(
                identifier.as_ptr(),
                title.as_ptr(),
                body.as_ptr(),
                thread_identifier
                    .as_ref()
                    .map(|value| value.as_ptr())
                    .unwrap_or(std::ptr::null()),
                &mut error_ptr,
            )
        };
        if let Some(error) = take_error(error_ptr) {
            return Err(error);
        }
        Ok(ok)
    }
}

pub fn initialize() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::initialize();
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

pub fn get_permission_state() -> Result<SystemNotificationPermissionState, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::permission_state();
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(SystemNotificationPermissionState::Unsupported)
    }
}

pub fn request_permission() -> Result<SystemNotificationPermissionState, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::request_permission();
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(SystemNotificationPermissionState::Unsupported)
    }
}

pub fn send(request: &SystemNotificationRequest) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::send(request);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(false)
    }
}

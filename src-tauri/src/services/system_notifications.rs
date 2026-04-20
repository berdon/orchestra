use crate::models::{
    SystemNotificationEnvironmentStatus, SystemNotificationPermissionState,
    SystemNotificationRequest,
};

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        ffi::{CStr, CString},
        os::raw::{c_char, c_int},
        path::PathBuf,
        sync::OnceLock,
    };

    use crate::models::{
        SystemNotificationEnvironmentStatus, SystemNotificationPermissionState,
        SystemNotificationRequest,
    };

    unsafe extern "C" {
        fn orchestra_macos_notifications_initialize(error_out: *mut *mut c_char) -> bool;
        fn orchestra_macos_notifications_permission_state(error_out: *mut *mut c_char) -> c_int;
        fn orchestra_macos_notifications_request_permission(error_out: *mut *mut c_char) -> c_int;
        fn orchestra_macos_notifications_send(
            identifier: *const c_char,
            title: *const c_char,
            body: *const c_char,
            thread_identifier: *const c_char,
            icon_path: *const c_char,
            error_out: *mut *mut c_char,
        ) -> bool;
        fn orchestra_macos_notifications_free_string(value: *mut c_char);
    }

    static INITIALIZE_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

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
        value
            .map(|entry| into_c_string(entry, field_name))
            .transpose()
    }

    fn detect_app_bundle_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let contents = exe.parent()?.parent()?;
        if contents.file_name()?.to_string_lossy() != "Contents" {
            return None;
        }
        let app_bundle = contents.parent()?;
        if app_bundle.extension()?.to_string_lossy().to_lowercase() != "app" {
            return None;
        }
        Some(app_bundle.to_path_buf())
    }

    pub fn environment_status() -> SystemNotificationEnvironmentStatus {
        let app_bundle_path = detect_app_bundle_path();
        let native_supported = app_bundle_path.is_some();
        let reason = if native_supported {
            None
        } else {
            Some(
                "Native macOS notifications require running Orchestra as an app bundle (.app). The current process appears to be an unbundled development binary, so UserNotifications is disabled to avoid startup crashes in cargo tauri dev.".into(),
            )
        };

        SystemNotificationEnvironmentStatus {
            platform: "macos".into(),
            native_supported,
            reason,
            app_bundle_path: app_bundle_path.map(|path| path.display().to_string()),
        }
    }

    fn ensure_supported() -> Result<(), String> {
        let status = environment_status();
        if status.native_supported {
            Ok(())
        } else {
            Err(status.reason.unwrap_or_else(|| {
                "Native macOS notifications are unavailable in this environment.".into()
            }))
        }
    }

    fn ensure_initialized() -> Result<(), String> {
        ensure_supported()?;
        INITIALIZE_RESULT
            .get_or_init(|| {
                let mut error_ptr: *mut c_char = std::ptr::null_mut();
                let ok = unsafe { orchestra_macos_notifications_initialize(&mut error_ptr) };
                if ok {
                    Ok(())
                } else {
                    Err(take_error(error_ptr).unwrap_or_else(|| {
                        "Unable to initialize macOS system notifications.".into()
                    }))
                }
            })
            .clone()
    }

    pub fn initialize() -> Result<(), String> {
        ensure_initialized()
    }

    pub fn permission_state() -> Result<SystemNotificationPermissionState, String> {
        ensure_supported()?;
        ensure_initialized()?;
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let state = unsafe { orchestra_macos_notifications_permission_state(&mut error_ptr) };
        if let Some(error) = take_error(error_ptr) {
            return Err(error);
        }
        Ok(map_permission_state(state))
    }

    pub fn request_permission() -> Result<SystemNotificationPermissionState, String> {
        ensure_supported()?;
        ensure_initialized()?;
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let state = unsafe { orchestra_macos_notifications_request_permission(&mut error_ptr) };
        if let Some(error) = take_error(error_ptr) {
            return Err(error);
        }
        Ok(map_permission_state(state))
    }

    pub fn send(request: &SystemNotificationRequest) -> Result<bool, String> {
        ensure_supported()?;
        ensure_initialized()?;
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

        // Resolve icon path relative to app bundle resources
        let resolved_icon_path = request.icon_path.as_ref().and_then(|path| {
            if let Some(bundle_path) = detect_app_bundle_path() {
                let resource_path = bundle_path.join("Contents").join("Resources").join(path);
                if resource_path.exists() {
                    Some(resource_path.to_string_lossy().into_owned())
                } else {
                    None
                }
            } else {
                None
            }
        });
        let icon_path = optional_c_string(resolved_icon_path.as_deref(), "icon_path")?;

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
                icon_path
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

pub fn get_environment_status() -> SystemNotificationEnvironmentStatus {
    #[cfg(target_os = "macos")]
    {
        return macos::environment_status();
    }

    #[cfg(not(target_os = "macos"))]
    {
        SystemNotificationEnvironmentStatus {
            platform: std::env::consts::OS.into(),
            native_supported: false,
            reason: Some(
                "Native Orchestra notifications are currently implemented only for macOS desktop builds."
                    .into(),
            ),
            app_bundle_path: None,
        }
    }
}

pub fn get_permission_state() -> Result<SystemNotificationPermissionState, String> {
    #[cfg(target_os = "macos")]
    {
        let status = macos::environment_status();
        if !status.native_supported {
            return Ok(SystemNotificationPermissionState::Unsupported);
        }
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
        let status = macos::environment_status();
        if !status.native_supported {
            return Ok(SystemNotificationPermissionState::Unsupported);
        }
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
        let status = macos::environment_status();
        if !status.native_supported {
            return Ok(false);
        }
        return macos::send(request);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(false)
    }
}

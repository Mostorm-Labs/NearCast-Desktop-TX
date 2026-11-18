#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    LocalNetwork,
    ScreenRecording,
    Accessibility,
}

#[cfg(target_os = "macos")]
mod native {
    use super::Permission;
    use std::{ffi::c_void, process::Command};

    extern "C" {
        fn nearcast_macos_local_network_status() -> u8;
        fn nearcast_macos_has_content_sharing_picker() -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    pub fn status() -> serde_json::Value {
        let network = match unsafe { nearcast_macos_local_network_status() } {
            1 => "available",
            2 => "not_granted",
            _ => "unknown",
        };
        let (screen, accessibility) =
            unsafe { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() != 0) };
        serde_json::json!({
            "localNetwork": network,
            "screenRecording": if screen { "granted" } else { "not_granted" },
            "accessibility": if accessibility { "granted" } else { "not_granted" },
        })
    }

    pub fn screen_capture_requirement() -> &'static str {
        if unsafe { nearcast_macos_has_content_sharing_picker() } != 0 { "on_selection" } else { "required" }
    }

    pub fn open_settings(permission: Permission) -> Result<(), String> {
        let pane = match permission {
            Permission::LocalNetwork => "Privacy_LocalNetwork",
            Permission::ScreenRecording => {
                // Register a first-time request so this app appears in Settings.
                unsafe {
                    if !CGPreflightScreenCaptureAccess() {
                        CGRequestScreenCaptureAccess();
                    }
                }
                "Privacy_ScreenCapture"
            }
            Permission::Accessibility => {
                unsafe {
                    if AXIsProcessTrusted() == 0 {
                        let options = CFDictionaryCreate(
                            std::ptr::null(),
                            &kAXTrustedCheckOptionPrompt,
                            &kCFBooleanTrue,
                            1,
                            std::ptr::null(),
                            std::ptr::null(),
                        );
                        if !options.is_null() {
                            AXIsProcessTrustedWithOptions(options);
                            CFRelease(options);
                        }
                    }
                }
                "Privacy_Accessibility"
            }
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
        let result = Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| format!("无法打开系统设置：{error}"))?;
        if result.success() {
            Ok(())
        } else {
            Err("无法打开系统设置，请手动前往“隐私与安全”。".into())
        }
    }
}

pub fn status() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(native::status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("not_supported".into())
    }
}

#[cfg(target_os = "macos")]
pub fn screen_capture_requirement() -> &'static str { native::screen_capture_requirement() }

pub fn open_settings(permission: Permission) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        native::open_settings(permission)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("not_supported".into())
    }
}

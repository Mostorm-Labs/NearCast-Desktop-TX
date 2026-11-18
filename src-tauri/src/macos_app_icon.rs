extern "C" {
    fn nearcast_macos_set_app_icon(bytes: *const u8, length: usize) -> u8;
}

// Tauri only supplies its runtime app_icon override in dev mode. Bundled apps
// also set the current icon explicitly, so native UI can use the same asset.
pub fn install() {
    const ICON: &[u8] = include_bytes!("../icons/nearhub-cast.icns");
    if unsafe { nearcast_macos_set_app_icon(ICON.as_ptr(), ICON.len()) } == 0 {
        eprintln!("Unable to initialize the native NearHub Cast application icon");
    }
}

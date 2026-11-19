#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    nearcast_desktop_tx_lib::run_audio_worker_if_requested();
    nearcast_desktop_tx_lib::run();
}

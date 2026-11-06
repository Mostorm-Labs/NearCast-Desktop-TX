#[test]
fn native_input_work_runs_off_the_caller_thread_and_reports_execution_time() {
    let caller = std::thread::current().id();
    let result = tauri::async_runtime::block_on(crate::native_input_task(move || {
        assert_ne!(
            std::thread::current().id(),
            caller,
            "native input must not run on the UI/caller thread"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
        serde_json::json!({"status":"submitted"})
    }))
    .unwrap();
    assert_eq!(result["status"], "submitted");
    assert!(result["nativeDurationMs"].as_f64().unwrap() >= 4.0);
}

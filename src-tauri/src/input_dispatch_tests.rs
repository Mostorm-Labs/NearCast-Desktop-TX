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

#[test]
fn feedback_is_dispatched_without_waiting_on_the_window_thread() {
    // A pending native input must not hold a synchronous command on the caller
    // thread. The actual Tauri handler is async and returns its future at once.
    let future =
        crate::nearcast_input_feedback("missing-owner".into(), "missing-lease".into(), None);
    let value = tauri::async_runtime::block_on(future).unwrap();
    assert_eq!(value["status"], "rejected");
}

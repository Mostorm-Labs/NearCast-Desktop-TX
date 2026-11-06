use crate::capture_target::{capture_rect, Rect};

#[test]
fn window_mapping_uses_the_bounds_that_match_actual_capture_pixels() {
    let window = Rect {
        x: 92,
        y: 92,
        width: 816,
        height: 639,
    };
    let visible = Rect {
        x: 100,
        y: 100,
        width: 800,
        height: 631,
    };
    assert_eq!(capture_rect(800, 631, visible, window).unwrap(), visible);
    assert_eq!(capture_rect(816, 639, visible, window).unwrap(), window);
    assert!(capture_rect(800, 600, visible, window).is_err());
}

#[test]
fn negative_monitor_origins_and_zero_size_are_not_confused() {
    let left = Rect {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };
    assert!(left.contains(-1920, 0));
    assert!(left.contains(-1, 1079));
    assert!(!left.contains(0, 0));
    assert!(!Rect {
        x: 0,
        y: 0,
        width: 0,
        height: 100
    }
    .valid());
}

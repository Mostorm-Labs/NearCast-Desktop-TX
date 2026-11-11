#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseButton {
    pub number: u32,
    pub down: u32,
    pub up: u32,
    pub drag: u32,
}

pub fn mouse_button(mask: u8) -> Result<MouseButton, String> {
    match mask {
        1 => Ok(MouseButton { number: 0, down: 1, up: 2, drag: 6 }),
        2 => Ok(MouseButton { number: 1, down: 3, up: 4, drag: 7 }),
        4 => Ok(MouseButton { number: 2, down: 25, up: 26, drag: 27 }),
        _ => Err("not_supported".into()),
    }
}

pub fn coordinate(value: i32, origin: f64, extent: f64) -> Result<f64, String> {
    if !(0..=65535).contains(&value) || !origin.is_finite() || !extent.is_finite() || extent < 1.0 {
        return Err("invalid_state".into());
    }
    Ok(origin + f64::from(value) * (extent - 1.0) / 65535.0)
}

pub fn modifier_flags(modifiers: u16) -> Result<u64, String> {
    if modifiers & !0x0f != 0 { return Err("not_supported".into()); }
    Ok(((modifiers as u64) & 0x0f) << 17)
}

pub fn scroll_delta(value: i32, extent: f64, remainder: f64) -> Result<(i32, f64), String> {
    if !(-65535..=65535).contains(&value) || !extent.is_finite() || extent < 1.0 || extent > i32::MAX as f64 || !remainder.is_finite() || remainder.abs() > 0.5 {
        return Err("invalid_state".into());
    }
    let points = f64::from(value) * (extent - 1.0) / 65535.0 + remainder;
    let rounded = points.round();
    Ok((rounded as i32, points - rounded))
}

pub fn scroll_phase(phase: &str) -> Result<u32, String> {
    match phase {
        "began" => Ok(1),
        "changed" => Ok(2),
        "ended" => Ok(4),
        "cancelled" => Ok(8),
        _ => Err("invalid_state".into()),
    }
}

pub fn wheel_points(unit:u8,value:i32,extent:f64,remainder:f64)->Result<(i32,f64),String>{
    if !extent.is_finite()||extent<1.0||!remainder.is_finite()||remainder.abs()>0.5{return Err("invalid_state".into());}
    let points=match unit {0=>f64::from(value)/120.0*40.0,1=>f64::from(value)/65536.0*(extent-1.0),_=>return Err("unsupported_wheel_unit".into())}+remainder;
    if !points.is_finite()||points.abs()>1_000_000.0{return Err("wheel_delta_out_of_range".into());}
    let rounded=points.round();Ok((rounded as i32,points-rounded))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_wheel_converts_q16_region_deltas_and_detents_in_display_points() {
        assert_eq!(wheel_points(1,65536,1440.0,0.0).unwrap(),(1439,0.0));
        assert_eq!(wheel_points(1,-32768,901.0,0.0).unwrap(),(-450,0.0));
        assert_eq!(wheel_points(0,120,1440.0,0.0).unwrap(),(40,0.0));
        assert!(wheel_points(2,1,1440.0,0.0).is_err());
        assert!(wheel_points(1,i32::MAX,1440.0,0.0).is_err());
    }

    #[test]
    fn scroll_deltas_use_display_points_and_accumulate_small_movements() {
        assert_eq!(scroll_delta(65535, 1440.0, 0.0).unwrap(), (1439, 0.0));
        assert_eq!(scroll_delta(-65535, 900.0, 0.0).unwrap(), (-899, 0.0));
        let mut remainder = 0.0;
        let mut emitted = 0;
        for _ in 0..4 {
            let (delta, next) = scroll_delta(1, 16384.75, remainder).unwrap();
            emitted += delta;
            remainder = next;
        }
        assert_eq!(emitted, 1);
        assert_eq!(remainder, 0.0);
        assert!(scroll_delta(65536, 1440.0, 0.0).is_err());
        assert!(scroll_delta(1, f64::NAN, 0.0).is_err());
        assert!(scroll_delta(1, 1440.0, f64::NAN).is_err());
        assert!(scroll_delta(1, 0.0, 0.0).is_err());
    }

    #[test]
    fn scroll_phases_have_terminal_end_and_cancel_events() {
        assert_eq!(scroll_phase("began").unwrap(), 1);
        assert_eq!(scroll_phase("changed").unwrap(), 2);
        assert_eq!(scroll_phase("ended").unwrap(), 4);
        assert_eq!(scroll_phase("cancelled").unwrap(), 8);
        assert!(scroll_phase("other").is_err());
    }

    #[test]
    fn button_masks_select_down_up_and_drag_events() {
        assert_eq!(mouse_button(1).unwrap(), MouseButton {number:0, down:1, up:2, drag:6});
        assert_eq!(mouse_button(2).unwrap(), MouseButton {number:1, down:3, up:4, drag:7});
        assert_eq!(mouse_button(4).unwrap(), MouseButton {number:2, down:25, up:26, drag:27});
        for unsupported in [0,3,5,6,7,8,255] { assert!(mouse_button(unsupported).is_err()); }
    }

    #[test]
    fn coordinates_use_coregraphics_bounds_and_reject_invalid_inputs() {
        assert_eq!(coordinate(0, -1440.0, 1440.0).unwrap(), -1440.0);
        assert_eq!(coordinate(65535, -1440.0, 1440.0).unwrap(), -1.0);
        assert_eq!(coordinate(65535, 0.0, 900.0).unwrap(), 899.0);
        assert!(coordinate(32768, 0.0, 1440.0).unwrap() > 719.0);
        for value in [-1,65536] { assert!(coordinate(value, 0.0, 1440.0).is_err()); }
        assert!(coordinate(0, 0.0, 0.0).is_err());
    }

    #[test]
    fn modifiers_map_to_shift_control_option_and_command() {
        assert_eq!(modifier_flags(1).unwrap(), 1 << 17);
        assert_eq!(modifier_flags(2).unwrap(), 1 << 18);
        assert_eq!(modifier_flags(4).unwrap(), 1 << 19);
        assert_eq!(modifier_flags(8).unwrap(), 1 << 20);
        assert_eq!(modifier_flags(15).unwrap(), 15 << 17);
        assert!(modifier_flags(16).is_err());
    }
}

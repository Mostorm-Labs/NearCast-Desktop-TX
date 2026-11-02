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

#[cfg(test)]
mod tests {
    use super::*;

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

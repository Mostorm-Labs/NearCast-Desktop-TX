use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Dark,
    Light,
    System,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    State,
    Minimize,
    Hide,
    Show,
    ToggleMaximize,
    Close,
    SetTheme { theme: ThemePreference },
    Move { x: i32, y: i32 },
}

// Keep window operations off the WebView thread receiving injected input.
#[tauri::command]
pub async fn nearcast_window_action(
    window: tauri::Window,
    action: Action,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Unsupported window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        match action {
            Action::State => {},
            Action::SetTheme { theme } => {
                let theme = match theme {
                    ThemePreference::Dark => Some(tauri::Theme::Dark),
                    ThemePreference::Light => Some(tauri::Theme::Light),
                    ThemePreference::System => None,
                };
                window.set_theme(theme).map_err(|e| e.to_string())?;
            },
            Action::Minimize => window.minimize().map_err(|e| e.to_string())?,
            Action::Hide => window.hide().map_err(|e| e.to_string())?,
            Action::Show => {
                window.unminimize().map_err(|e| e.to_string())?;
                window.show().map_err(|e| e.to_string())?;
                window.set_focus().map_err(|e| e.to_string())?;
            },
            Action::ToggleMaximize => {
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())?;
                } else { window.maximize().map_err(|e| e.to_string())?; }
            },
            Action::Close => {
                window.close().map_err(|e| e.to_string())?;
                return Ok(json!({"closing":true}));
            },
            Action::Move { x, y } => {
                if !window.is_maximized().map_err(|e| e.to_string())? {
                    window.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|e| e.to_string())?;
                }
            },
        }
        let position=window.outer_position().map_err(|e| e.to_string())?;
        Ok(json!({"maximized":window.is_maximized().map_err(|e| e.to_string())?,
            "minimized":window.is_minimized().map_err(|e| e.to_string())?,
            "visible":window.is_visible().map_err(|e| e.to_string())?,
            "x":position.x,"y":position.y,"scaleFactor":window.scale_factor().map_err(|e| e.to_string())?}))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_theme_accepts_supported_preferences_only() {
        for theme in ["dark", "light", "system"] {
            assert!(serde_json::from_value::<Action>(json!({"kind":"setTheme","theme":theme})).is_ok(), "unsupported theme action: {theme}");
        }
        for theme in [json!("blue"), json!(null), json!(true)] {
            assert!(serde_json::from_value::<Action>(json!({"kind":"setTheme","theme":theme})).is_err());
        }
    }
}

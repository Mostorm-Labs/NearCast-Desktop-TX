use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    State,
    Minimize,
    Hide,
    Show,
    ToggleMaximize,
    Close,
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
            "x":position.x,"y":position.y,"scaleFactor":window.scale_factor().map_err(|e| e.to_string())?}))
    }).await.map_err(|e| e.to_string())?
}

mod app_config;

use app_config::AppConfig;

#[tauri::command]
fn load_app_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    app_config::load(&app)
}

#[tauri::command]
fn save_app_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    app_config::save(&app, &config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_app_config, save_app_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

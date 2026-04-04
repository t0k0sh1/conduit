mod app_config;
mod db_metadata;

use app_config::AppConfig;
use db_metadata::PgConnectionParams;

#[tauri::command]
fn load_app_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    app_config::load(&app)
}

#[tauri::command]
fn save_app_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    app_config::save(&app, &config)
}

#[tauri::command]
async fn pg_list_user_schemas(params: PgConnectionParams) -> Result<Vec<String>, String> {
    db_metadata::list_user_schemas(params).await
}

#[tauri::command]
async fn pg_list_system_schema_names(params: PgConnectionParams) -> Result<Vec<String>, String> {
    db_metadata::list_system_schema_names(params).await
}

#[tauri::command]
async fn pg_list_relation_objects(
    params: PgConnectionParams,
    schema: String,
    kind: String,
) -> Result<Vec<String>, String> {
    let k = db_metadata::parse_relation_kind(&kind)?;
    db_metadata::list_relation_objects(params, schema, k).await
}

#[tauri::command]
async fn pg_list_extensions(params: PgConnectionParams) -> Result<Vec<String>, String> {
    db_metadata::list_extensions(params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_app_config,
            save_app_config,
            pg_list_user_schemas,
            pg_list_system_schema_names,
            pg_list_relation_objects,
            pg_list_extensions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

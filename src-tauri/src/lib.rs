mod app_config;
mod db_metadata;

use app_config::AppConfig;
use db_metadata::PgConnectionParams;

/// Reserved-looking tokens that are valid PostgreSQL identifiers and should keep their
/// original spelling when formatting. `sqlformat` matches `ignore_case_convert` against
/// the exact token text (e.g. `day` vs `Day`).
const SQLFORMAT_KEEP_ORIGINAL_CASE: &[&str] = &["day", "Day", "DAY"];

#[tauri::command]
fn load_app_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    app_config::load(&app)
}

#[tauri::command]
fn save_app_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    app_config::save(&app, &config)
}

#[tauri::command]
async fn pg_list_user_schemas(
    params: PgConnectionParams,
) -> Result<db_metadata::UserSchemasSnapshot, String> {
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

#[tauri::command]
async fn pg_test_connection(params: PgConnectionParams) -> Result<(), String> {
    db_metadata::test_connection(params).await
}

#[tauri::command]
async fn pg_fetch_table_preview(
    params: PgConnectionParams,
    schema: String,
    table: String,
    limit: Option<u32>,
) -> Result<db_metadata::TablePreview, String> {
    db_metadata::fetch_table_preview(params, schema, table, limit).await
}

#[tauri::command]
async fn pg_execute_sql(
    params: PgConnectionParams,
    sql: String,
) -> Result<db_metadata::SqlExecutionResult, String> {
    db_metadata::execute_sql(params, sql).await
}

#[tauri::command]
fn format_sql(sql: String) -> Result<String, String> {
    if sql.len() > db_metadata::MAX_SQL_TEXT_BYTES {
        return Err("SQL text is too large to format.".to_string());
    }
    let mut opts = sqlformat::FormatOptions::default();
    opts.dialect = sqlformat::Dialect::PostgreSql;
    opts.uppercase = Some(true);
    opts.ignore_case_convert = Some(SQLFORMAT_KEEP_ORIGINAL_CASE.to_vec());
    let formatted = sqlformat::format(&sql, &sqlformat::QueryParams::None, &opts);
    Ok(formatted)
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
            pg_test_connection,
            pg_fetch_table_preview,
            pg_execute_sql,
            format_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

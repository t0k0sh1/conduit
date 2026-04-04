//! アプリ設定の単一ソース（[`AppConfig`]）と、ディスク上の `app.json` への読み書き。
//!
//! - **キー**: JSON のプロパティ名は各 struct のフィールドに対応させ、`#[serde(rename_all = "camelCase")]` で
//!   フロント（JS）とファイル形式を揃える。新しい設定はネストした struct を足す形で追加する。
//! - **読み書き**: 他コードからは [`load`] / [`save`] / [`mutate`] のみを使う（パスやファイル名はこのモジュール内だけ）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const CONFIG_FILENAME: &str = "app.json";

/// ディスクと IPC でやり取りする設定のルート。フィールドを増やすときはここ（と下位の struct）だけ触る。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub ui: UiSettings,
    pub connections: Vec<ConnectionProfile>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            ui: UiSettings::default(),
            connections: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct UiSettings {
    /// Whether the sidebar is expanded.
    pub sidebar_open: bool,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self { sidebar_open: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    /// When `false`, password is never stored in the profile (empty string); prompt at connect time (future).
    #[serde(default = "default_save_password_in_profile")]
    pub save_password_in_profile: bool,
}

fn default_save_password_in_profile() -> bool {
    false
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILENAME))
}

/// 設定ファイルを読む。無い場合は [`AppConfig::default`]。
pub fn load(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// 設定を丸ごと保存する。
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// 読み込み → クロージャで変更 → 保存。Rust 側（将来のコマンドやプラグイン）から一部更新するときに使う。
// 現状フロントは `invoke(load/save)` のみ。未使用警告を抑止。
#[allow(dead_code)]
pub fn mutate<F>(app: &AppHandle, f: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig),
{
    let mut config = load(app)?;
    f(&mut config);
    save(app, &config)?;
    Ok(config)
}

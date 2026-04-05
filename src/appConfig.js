/**
 * アプリ設定の読み書きはこのモジュール経由に統一する。
 * - IPC コマンド名は COMMANDS のみ
 * - オブジェクトの形は Rust の AppConfig と揃え、プロパティは camelCase（serde と一致）
 */

/** @typedef {{ sidebarOpen: boolean, sidebarWidthPx: number }} UiSettings */
/**
 * @typedef {{
 *   kind: 'default';
 * } | {
 *   kind: 'all';
 * } | {
 *   kind: 'selected';
 *   schemas: string[];
 * }} UserSchemaVisibility
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 *   host: string;
 *   port: number;
 *   database: string;
 *   user: string;
 *   password: string;
 *   savePasswordInProfile: boolean;
 *   userSchemaVisibility?: UserSchemaVisibility;
 * }} ConnectionProfile
 */
/** @typedef {{ ui: UiSettings, connections: ConnectionProfile[] }} AppConfig */

export const COMMANDS = {
  load: "load_app_config",
  save: "save_app_config",
};

function getInvoke() {
  return globalThis.__TAURI__?.core?.invoke;
}

export function defaultAppConfig() {
  return {
    ui: { sidebarOpen: true, sidebarWidthPx: 256 },
    connections: [],
  };
}

/** @returns {Promise<AppConfig | null>} */
export async function loadAppConfig() {
  const invoke = getInvoke();
  if (!invoke) return null;
  return invoke(COMMANDS.load);
}

export async function saveAppConfig(config) {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke(COMMANDS.save, { config });
}

/** メモリ上のキャッシュ（load / update 後に更新） */
let cache = null;

/**
 * 現在の設定を返す。未ロードならディスクから読む（失敗時は defaultAppConfig）。
 * @returns {Promise<AppConfig>}
 */
export async function getAppConfig() {
  if (cache) return cache;
  const loaded = await loadAppConfig();
  cache = loaded ?? defaultAppConfig();
  return cache;
}

/**
 * キャッシュを置き換える（外部で読み込んだオブジェクトを渡す場合）。
 * @param {AppConfig} config
 */
export function setAppConfigCache(config) {
  cache = config;
}

/**
 * 設定を読み、変更関数を適用し、保存する。呼び出し側はキー文字列を触らなくてよい。
 * @param {(config: AppConfig) => void} mutator
 * @returns {Promise<AppConfig>}
 */
export async function updateAppConfig(mutator) {
  const invoke = getInvoke();
  if (!invoke) {
    const c = structuredClone(await getAppConfig());
    mutator(c);
    cache = c;
    return c;
  }
  const current = await loadAppConfig();
  const base = current ?? defaultAppConfig();
  const next = structuredClone(base);
  mutator(next);
  cache = next;
  await saveAppConfig(next);
  return next;
}

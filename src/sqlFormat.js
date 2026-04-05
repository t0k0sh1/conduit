/**
 * Pretty-print SQL via the Tauri backend (PostgreSQL dialect).
 */

function getInvoke() {
  return globalThis.__TAURI__?.core?.invoke;
}

/**
 * @param {string} sql
 * @returns {Promise<string>}
 */
export async function formatSql(sql) {
  const invoke = getInvoke();
  if (typeof invoke !== "function") {
    throw new Error("SQL formatting is only available in the desktop app.");
  }
  return await invoke("format_sql", { sql });
}

/**
 * PostgreSQL catalog via Tauri invoke. Cached with a short TTL for tree navigation.
 */

const CACHE_TTL_MS = 60_000;

/** @type {Map<string, { at: number, payload: unknown }>} */
const cache = new Map();

/** In-memory password when `savePasswordInProfile` is false (never persisted). */
/** @type {Map<string, string>} */
const sessionPasswordByConnectionId = new Map();

function cacheKey(...parts) {
  return parts.join("::");
}

function getInvoke() {
  return globalThis.__TAURI__?.core?.invoke;
}

export function hasTauriInvoke() {
  return typeof getInvoke() === "function";
}

/**
 * @param {string} connectionId
 * @param {string} password
 */
export function setSessionPassword(connectionId, password) {
  sessionPasswordByConnectionId.set(connectionId, password);
}

/**
 * @param {string} connectionId
 */
export function clearSessionPassword(connectionId) {
  sessionPasswordByConnectionId.delete(connectionId);
}

/**
 * @param {string} connectionId
 * @returns {string | undefined}
 */
export function getSessionPassword(connectionId) {
  return sessionPasswordByConnectionId.get(connectionId);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
export function shouldPromptForSessionPassword(profile) {
  return !profile.savePasswordInProfile && !sessionPasswordByConnectionId.has(profile.id);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
export function profileToParams(profile) {
  const password = profile.savePasswordInProfile
    ? profile.password
    : (sessionPasswordByConnectionId.get(profile.id) ?? "");
  return {
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    password,
  };
}

/**
 * @param {{
 *   host: string;
 *   port: number;
 *   database: string;
 *   user: string;
 *   password: string;
 * }} params
 * @returns {Promise<void>}
 */
export async function testPgConnection(params) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  await invoke("pg_test_connection", { params });
}

/**
 * Fresh snapshot only (within TTL). Used by fetch* to skip network when still valid.
 * Expired entries stay in the map for display (stale-while-revalidate).
 * @param {string} key
 */
function getFreshCached(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) return undefined;
  return e.payload;
}

/**
 * Last fetched payload for UI if present, including past TTL (tree keeps showing until refresh completes).
 * @param {string} key
 */
function getCachedPayloadAnyAge(key) {
  const e = cache.get(key);
  return e ? e.payload : undefined;
}

/**
 * Whether an entry exists and is past TTL (needs background refresh).
 * @param {...string} parts
 */
export function isPgCacheStale(...parts) {
  const key = cacheKey(...parts);
  const e = cache.get(key);
  if (!e) return false;
  return Date.now() - e.at > CACHE_TTL_MS;
}

function setCached(key, payload) {
  cache.set(key, { at: Date.now(), payload });
}

/**
 * @param {string} connectionId
 */
export function pruneCacheForConnection(connectionId) {
  const prefix = cacheKey("pg", connectionId);
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/**
 * @param {string} connectionId
 * @returns {string[] | undefined}
 */
export function getCachedUserSchemas(connectionId) {
  return /** @type {string[] | undefined} */ (
    getCachedPayloadAnyAge(cacheKey("pg", connectionId, "user-schemas"))
  );
}

/**
 * @param {string} connectionId
 * @returns {string[] | undefined}
 */
export function getCachedSystemSchemas(connectionId) {
  return /** @type {string[] | undefined} */ (
    getCachedPayloadAnyAge(cacheKey("pg", connectionId, "system-schemas"))
  );
}

/**
 * @param {string} connectionId
 * @returns {string[] | undefined}
 */
export function getCachedExtensions(connectionId) {
  return /** @type {string[] | undefined} */ (
    getCachedPayloadAnyAge(cacheKey("pg", connectionId, "extensions"))
  );
}

/**
 * @param {string} connectionId
 * @param {string} schema
 * @param {string} kind tables|views|materialized_views|functions|sequences
 * @returns {string[] | undefined}
 */
export function getCachedRelations(connectionId, schema, kind) {
  return /** @type {string[] | undefined} */ (
    getCachedPayloadAnyAge(cacheKey("pg", connectionId, "rel", schema, kind))
  );
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @returns {Promise<string[]>}
 */
export async function fetchUserSchemas(profile) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  const k = cacheKey("pg", profile.id, "user-schemas");
  const hit = getFreshCached(k);
  if (hit !== undefined) return /** @type {string[]} */ (hit);
  const rows = await invoke("pg_list_user_schemas", { params: profileToParams(profile) });
  setCached(k, rows);
  return /** @type {string[]} */ (rows);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @returns {Promise<string[]>}
 */
export async function fetchSystemSchemaNames(profile) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  const k = cacheKey("pg", profile.id, "system-schemas");
  const hit = getFreshCached(k);
  if (hit !== undefined) return /** @type {string[]} */ (hit);
  const rows = await invoke("pg_list_system_schema_names", { params: profileToParams(profile) });
  setCached(k, rows);
  return /** @type {string[]} */ (rows);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @returns {Promise<string[]>}
 */
export async function fetchExtensions(profile) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  const k = cacheKey("pg", profile.id, "extensions");
  const hit = getFreshCached(k);
  if (hit !== undefined) return /** @type {string[]} */ (hit);
  const rows = await invoke("pg_list_extensions", { params: profileToParams(profile) });
  setCached(k, rows);
  return /** @type {string[]} */ (rows);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schema
 * @param {"tables"|"views"|"materialized_views"|"functions"|"sequences"} kind
 * @returns {Promise<string[]>}
 */
export async function fetchRelationObjects(profile, schema, kind) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  const k = cacheKey("pg", profile.id, "rel", schema, kind);
  const hit = getFreshCached(k);
  if (hit !== undefined) return /** @type {string[]} */ (hit);
  const rows = await invoke("pg_list_relation_objects", {
    params: profileToParams(profile),
    schema,
    kind,
  });
  setCached(k, rows);
  return /** @type {string[]} */ (rows);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schema
 * @param {string} table
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ columns: string[]; rows: unknown[] }>}
 */
export async function fetchTablePreview(profile, schema, table, options = {}) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  return await invoke("pg_fetch_table_preview", {
    params: profileToParams(profile),
    schema,
    table,
    limit: options.limit,
  });
}

/**
 * Runs arbitrary SQL (including multiple statements) against the given profile.
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} sql
 * @returns {Promise<{ statements: Array<
 *   | { kind: "rows"; columns: string[]; rows: unknown[][] }
 *   | { kind: "command"; rowsAffected: number }
 * > }>}
 */
export async function executePgSql(profile, sql) {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Database metadata is only available in the desktop app.");
  }
  return await invoke("pg_execute_sql", {
    params: profileToParams(profile),
    sql,
  });
}

export const PG_JSON_PREFIX = "PG_JSON:";

/**
 * @param {unknown} err
 * @returns {string}
 */
function extractInvokeErrorMessage(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = /** @type {Record<string, unknown>} */ (err).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * Parses structured SQL execution errors returned from `pg_execute_sql` (`PG_JSON:` prefix).
 * @param {unknown} err
 * @returns {{
 *   category: string;
 *   sqlState?: string;
 *   message: string;
 *   detail?: string;
 *   hint?: string;
 *   position?: number;
 * } | null}
 */
export function parsePgExecutionError(err) {
  const raw = extractInvokeErrorMessage(err);
  if (typeof raw !== "string") {
    return null;
  }
  const jsonStart = raw.indexOf(PG_JSON_PREFIX);
  if (jsonStart === -1) {
    return null;
  }
  const jsonText = raw.slice(jsonStart + PG_JSON_PREFIX.length);
  try {
    const parsed = JSON.parse(jsonText);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof /** @type {{ message?: unknown }} */ (parsed).message === "string" &&
      typeof /** @type {{ category?: unknown }} */ (parsed).category === "string"
    ) {
      return /** @type {NonNullable<ReturnType<typeof parsePgExecutionError>>} */ (parsed);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * @param {{
 *   category: string;
 *   sqlState?: string;
 *   message: string;
 *   detail?: string;
 *   hint?: string;
 *   position?: number;
 * }} p
 */
export function formatPgExecutionErrorMessage(p) {
  let head;
  if (p.sqlState) {
    head = `PostgreSQL error (${p.sqlState})`;
  } else if (p.category === "connection") {
    head = "Connection error";
  } else if (p.category === "authentication") {
    head = "Authentication error";
  } else if (p.category === "query") {
    head = "Query error";
  } else {
    head = `Database error (${p.category})`;
  }
  const lines = [head, p.message];
  if (p.detail) lines.push(`Detail: ${p.detail}`);
  if (p.hint) lines.push(`Hint: ${p.hint}`);
  if (p.position != null) lines.push(`Position: ${p.position}`);
  return lines.join("\n");
}

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

function getCached(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return e.payload;
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
  return /** @type {string[] | undefined} */ (getCached(cacheKey("pg", connectionId, "user-schemas")));
}

/**
 * @param {string} connectionId
 * @returns {string[] | undefined}
 */
export function getCachedSystemSchemas(connectionId) {
  return /** @type {string[] | undefined} */ (getCached(cacheKey("pg", connectionId, "system-schemas")));
}

/**
 * @param {string} connectionId
 * @returns {string[] | undefined}
 */
export function getCachedExtensions(connectionId) {
  return /** @type {string[] | undefined} */ (getCached(cacheKey("pg", connectionId, "extensions")));
}

/**
 * @param {string} connectionId
 * @param {string} schema
 * @param {string} kind tables|views|materialized_views|functions|sequences
 * @returns {string[] | undefined}
 */
export function getCachedRelations(connectionId, schema, kind) {
  return /** @type {string[] | undefined} */ (
    getCached(cacheKey("pg", connectionId, "rel", schema, kind))
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
  const hit = getCached(k);
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
  const hit = getCached(k);
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
  const hit = getCached(k);
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
  const hit = getCached(k);
  if (hit !== undefined) return /** @type {string[]} */ (hit);
  const rows = await invoke("pg_list_relation_objects", {
    params: profileToParams(profile),
    schema,
    kind,
  });
  setCached(k, rows);
  return /** @type {string[]} */ (rows);
}

import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { initConnectionWizard } from "./connectionWizard.js";
import { installPlainTextInputDefaults } from "./inputBehavior.js";
import {
  pruneCacheForConnection,
  fetchUserSchemas,
  fetchSystemSchemaNames,
  fetchExtensions,
  fetchRelationObjects,
  fetchTablePreview,
  getCachedUserSchemas,
  getCachedSystemSchemas,
  getCachedExtensions,
  getCachedRelations,
  isPgCacheStale,
  setSessionPassword,
  clearSessionPassword,
  shouldPromptForSessionPassword,
} from "./dbMetadata.js";

const SIDEBAR_OPEN = ["w-64", "opacity-100", "border-r"];
const SIDEBAR_CLOSED = ["w-0", "opacity-0", "border-r-0", "pointer-events-none"];

/** @type {string | null} */
let selectedConnectionId = null;

/** `connectionId::schema::table` when a table leaf is selected for preview. */
/** @type {string | null} */
let selectedTablePreviewKey = null;

const TABLE_PREVIEW_DEFAULT_LIMIT = 100;

/** Deferred re-render after selection change so double-click can complete on the same DOM. */
let pendingSelectionRafId = 0;

/** Connection profiles whose database node is expanded in the tree. */
const openConnectionIds = new Set();

/**
 * Open connections whose object tree is hidden in the sidebar (not persisted).
 * @type {Set<string>}
 */
const objectTreeCollapsedByConnectionId = new Set();

/**
 * Expanded paths under a connection (lazy-loaded from PostgreSQL).
 * @type {Set<string>}
 */
const expandedTreePaths = new Set();

/** Paths currently awaiting metadata (show loading row). @type {Set<string>} */
const loadingPaths = new Set();

/** Background revalidation in flight (no loading row; avoids full-tree flicker). @type {Set<string>} */
const silentStaleRefreshInFlight = new Set();

/** @type {Map<string, string>} */
const errorsByPath = new Map();

/** @type {import("./appConfig.js").ConnectionProfile[]} */
let lastConnections = [];

/** Object-kind folders under each schema (matches Rust `parse_relation_kind`). */
const KIND_GROUPS = [
  { key: "tables", label: "Tables" },
  { key: "views", label: "Views" },
  { key: "materialized_views", label: "Materialized views" },
  { key: "functions", label: "Functions" },
  { key: "sequences", label: "Sequences" },
];

/**
 * @param {string} id
 */
function isConnectionOpen(id) {
  return openConnectionIds.has(id);
}

/**
 * @param {string} connectionId
 */
function pruneExpandedPathsForConnection(connectionId) {
  const head = `${connectionId}::`;
  for (const p of [...expandedTreePaths]) {
    if (p.startsWith(head)) expandedTreePaths.delete(p);
  }
  for (const k of [...errorsByPath.keys()]) {
    if (k.startsWith(head)) errorsByPath.delete(k);
  }
  for (const k of [...loadingPaths]) {
    if (k.startsWith(head)) loadingPaths.delete(k);
  }
  for (const k of [...silentStaleRefreshInFlight]) {
    if (k.startsWith(head)) silentStaleRefreshInFlight.delete(k);
  }
}

/**
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
async function ensureLoaded(path, profile) {
  const id = profile.id;
  const parts = path.split("::");
  if (parts[0] !== id) return;
  if (parts.length === 2 && parts[1] === "schemas") {
    await fetchUserSchemas(profile);
    return;
  }
  if (parts.length === 2 && parts[1] === "system") {
    await fetchSystemSchemaNames(profile);
    return;
  }
  if (parts.length === 2 && parts[1] === "extensions") {
    await fetchExtensions(profile);
    return;
  }
  if (parts.length === 4 && parts[1] === "schema") {
    const schema = parts[2];
    const kind = parts[3];
    await fetchRelationObjects(profile, schema, kind);
    return;
  }
  if (parts.length === 4 && parts[1] === "system") {
    const schema = parts[2];
    const kind = parts[3];
    await fetchRelationObjects(profile, schema, kind);
  }
}

/**
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
async function toggleTreePath(path, profile) {
  if (expandedTreePaths.has(path)) {
    expandedTreePaths.delete(path);
    renderConnections(lastConnections);
    return;
  }
  expandedTreePaths.add(path);

  const id = profile.id;
  const needsFetch =
    path === `${id}::schemas` ||
    path === `${id}::system` ||
    path === `${id}::extensions` ||
    (path.startsWith(`${id}::schema::`) && path.split("::").length === 4) ||
    (path.startsWith(`${id}::system::`) && path.split("::").length === 4);

  if (needsFetch) {
    loadingPaths.add(path);
    renderConnections(lastConnections);
    try {
      errorsByPath.delete(path);
      await ensureLoaded(path, profile);
    } catch (e) {
      errorsByPath.set(path, formatConnectionFailureMessage(e));
    } finally {
      loadingPaths.delete(path);
    }
    renderConnections(lastConnections);
    return;
  }
  renderConnections(lastConnections);
}

/**
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function isExpandedPathStale(path, profile) {
  const id = profile.id;
  const parts = path.split("::");
  if (parts[0] !== id) return false;
  if (path === `${id}::schemas`) return isPgCacheStale("pg", id, "user-schemas");
  if (path === `${id}::system`) return isPgCacheStale("pg", id, "system-schemas");
  if (path === `${id}::extensions`) return isPgCacheStale("pg", id, "extensions");
  if (parts.length === 4 && parts[1] === "schema") {
    return isPgCacheStale("pg", id, "rel", parts[2], parts[3]);
  }
  if (parts.length === 4 && parts[1] === "system") {
    return isPgCacheStale("pg", id, "rel", parts[2], parts[3]);
  }
  return false;
}

/**
 * Re-fetch in the background when cache is stale; keeps showing last snapshot until done (no loading row).
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function scheduleSilentStaleRefreshIfNeeded(path, profile) {
  if (silentStaleRefreshInFlight.has(path)) return;
  if (loadingPaths.has(path)) return;
  if (errorsByPath.has(path)) return;
  if (!expandedTreePaths.has(path)) return;
  if (!isExpandedPathStale(path, profile)) return;
  silentStaleRefreshInFlight.add(path);
  void (async () => {
    try {
      errorsByPath.delete(path);
      await ensureLoaded(path, profile);
    } catch (e) {
      errorsByPath.set(path, formatConnectionFailureMessage(e));
    } finally {
      silentStaleRefreshInFlight.delete(path);
      renderConnections(lastConnections);
    }
  })();
}

/**
 * First load when the node is expanded but no cache entry exists (rare). Shows loading row like {@link toggleTreePath}.
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function ensureExpandedPathMissingData(path, profile) {
  if (loadingPaths.has(path)) return;
  if (errorsByPath.has(path)) return;
  loadingPaths.add(path);
  renderConnections(lastConnections);
  void (async () => {
    try {
      errorsByPath.delete(path);
      await ensureLoaded(path, profile);
    } catch (e) {
      errorsByPath.set(path, formatConnectionFailureMessage(e));
    } finally {
      loadingPaths.delete(path);
      renderConnections(lastConnections);
    }
  })();
}

/**
 * @param {string} label
 * @param {boolean} expanded
 * @param {boolean} hasChildren
 * @param {() => void} onToggle
 */
function createTreeRow(label, expanded, hasChildren, onToggle) {
  const row = document.createElement("div");
  row.className = "flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-stone-700";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-200/80 hover:text-stone-800";
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (hasChildren) {
    btn.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle();
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute(
      "class",
      `h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`,
    );
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const tri = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tri.setAttribute("d", "M8 5l8 7-8 7V5z");
    svg.appendChild(tri);
    btn.appendChild(svg);
  } else {
    btn.classList.add("invisible", "pointer-events-none");
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("aria-hidden", "true");
  }
  const span = document.createElement("span");
  span.className = "min-w-0 truncate";
  span.textContent = label;
  row.appendChild(btn);
  row.appendChild(span);
  return row;
}

/**
 * @param {string} label
 */
function createLeafRow(label) {
  const row = document.createElement("div");
  row.className = "rounded px-1 py-0.5 pl-6 font-mono text-xs text-stone-600";
  row.textContent = label;
  return row;
}

/**
 * @param {string} connectionId
 * @param {string} schemaName
 * @param {string} tableName
 */
function tablePreviewKey(connectionId, schemaName, tableName) {
  return `${connectionId}::${schemaName}::${tableName}`;
}

function renderTablePreviewPlaceholder() {
  const area = document.getElementById("table-preview-area");
  if (area) area.classList.add("hidden");
  const body = document.getElementById("table-preview-body");
  const heading = document.getElementById("table-preview-heading");
  const meta = document.getElementById("table-preview-meta");
  const tab = document.getElementById("table-preview-tab-label");
  if (heading) heading.textContent = "";
  if (meta) meta.textContent = "";
  if (tab) tab.textContent = "Table preview";
  if (body) {
    body.className = "min-h-0 flex-1 overflow-auto p-3 text-sm text-stone-500 select-text";
    body.replaceChildren();
    body.appendChild(document.createTextNode("Select a table to preview rows."));
  }
}

/**
 * @param {string} schemaName
 * @param {string} tableName
 */
function renderTablePreviewLoading(schemaName, tableName) {
  const area = document.getElementById("table-preview-area");
  if (area) area.classList.remove("hidden");
  const body = document.getElementById("table-preview-body");
  const heading = document.getElementById("table-preview-heading");
  const meta = document.getElementById("table-preview-meta");
  const tab = document.getElementById("table-preview-tab-label");
  const label = `${schemaName}.${tableName}`;
  if (heading) heading.textContent = label;
  if (meta) meta.textContent = "Loading…";
  if (tab) tab.textContent = label;
  if (body) {
    body.className = "min-h-0 flex-1 overflow-auto p-3 text-sm text-stone-500 select-text";
    body.replaceChildren();
    body.appendChild(document.createTextNode("Loading…"));
  }
}

/**
 * @param {string} message
 */
function renderTablePreviewError(message) {
  const body = document.getElementById("table-preview-body");
  const meta = document.getElementById("table-preview-meta");
  if (meta) meta.textContent = "";
  if (body) {
    body.className = "min-h-0 flex-1 overflow-auto p-3 text-sm select-text";
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "text-red-600";
    p.textContent = message;
    body.appendChild(p);
  }
}

/**
 * @param {unknown} value
 * @returns {{ type: "null" } | { type: "text"; text: string }}
 */
function formatTableCellPreview(value) {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "object") {
    return { type: "text", text: JSON.stringify(value) };
  }
  return { type: "text", text: String(value) };
}

/**
 * @param {{ columns: string[]; rows: unknown[] }} data
 * @param {string} schemaName
 * @param {string} tableName
 */
function renderTablePreviewTable(data) {
  const body = document.getElementById("table-preview-body");
  const meta = document.getElementById("table-preview-meta");
  if (meta) {
    meta.textContent = `${data.rows.length} rows (limit ${TABLE_PREVIEW_DEFAULT_LIMIT})`;
  }
  if (!body) return;

  body.className = "min-h-0 flex-1 overflow-auto p-0 select-text";
  body.replaceChildren();

  const table = document.createElement("table");
  table.className = "w-full border-collapse text-left text-xs text-stone-800";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const col of data.columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className =
      "sticky top-0 border-b border-stone-200/90 bg-[#fffcf7] px-2 py-2 font-medium text-stone-700";
    th.textContent = col;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of data.rows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-stone-100/90";
    const rowObj =
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? /** @type {Record<string, unknown>} */ (row)
        : {};
    for (const col of data.columns) {
      const td = document.createElement("td");
      td.className = "max-w-[24rem] whitespace-pre-wrap break-words px-2 py-1.5 align-top";
      const cell = formatTableCellPreview(rowObj[col]);
      if (cell.type === "null") {
        const span = document.createElement("span");
        span.className = "italic text-stone-400";
        span.textContent = "NULL";
        td.appendChild(span);
      } else {
        td.appendChild(document.createTextNode(cell.text));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} tableName
 */
async function loadTablePreview(profile, schemaName, tableName) {
  renderTablePreviewLoading(schemaName, tableName);
  setStatusMessage("Loading…");
  try {
    const data = await fetchTablePreview(profile, schemaName, tableName, {
      limit: TABLE_PREVIEW_DEFAULT_LIMIT,
    });
    renderTablePreviewTable(data);
    setStatusMessage("Ready");
  } catch (e) {
    const msg = formatConnectionFailureMessage(e);
    renderTablePreviewError(msg);
    setStatusMessage(msg);
  }
}

function resetTablePreviewPanel() {
  selectedTablePreviewKey = null;
  renderTablePreviewPlaceholder();
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} tableName
 */
function createTableLeafRow(profile, schemaName, tableName) {
  const key = tablePreviewKey(profile.id, schemaName, tableName);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "w-full rounded px-1 py-0.5 pl-6 text-left font-mono text-xs text-stone-600 hover:bg-stone-200/80";
  if (selectedTablePreviewKey === key) {
    btn.classList.add("bg-stone-200/80", "ring-1", "ring-stone-300/40");
  }
  btn.textContent = tableName;
  btn.setAttribute("aria-label", `Preview table ${schemaName}.${tableName}`);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedTablePreviewKey = key;
    renderConnections(lastConnections);
    void loadTablePreview(profile, schemaName, tableName);
  });
  return btn;
}

/**
 * @param {HTMLUListElement} parentUl
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function renderDbTreeInto(parentUl, profile) {
  const id = profile.id;
  const prefix = `${id}::`;

  const schemasPath = `${prefix}schemas`;
  const schemasOpen = expandedTreePaths.has(schemasPath);
  const liSchemas = document.createElement("li");
  liSchemas.appendChild(
    createTreeRow("Schemas", schemasOpen, true, () => void toggleTreePath(schemasPath, profile)),
  );
  if (schemasOpen) {
    const ul = document.createElement("ul");
    ul.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    ul.setAttribute("aria-label", "Schemas");
    if (loadingPaths.has(schemasPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
      li.textContent = "Loading…";
      ul.appendChild(li);
    } else if (errorsByPath.has(schemasPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-red-600";
      li.textContent = errorsByPath.get(schemasPath) ?? "";
      ul.appendChild(li);
    } else {
      const names = getCachedUserSchemas(id);
      if (names === undefined) {
        ensureExpandedPathMissingData(schemasPath, profile);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
        scheduleSilentStaleRefreshIfNeeded(schemasPath, profile);
      } else {
        for (const schemaName of names) {
          appendSchemaSubtree(ul, profile, schemaName, false);
        }
        scheduleSilentStaleRefreshIfNeeded(schemasPath, profile);
      }
    }
    liSchemas.appendChild(ul);
  }
  parentUl.appendChild(liSchemas);

  const systemPath = `${prefix}system`;
  const systemOpen = expandedTreePaths.has(systemPath);
  const liSys = document.createElement("li");
  liSys.appendChild(
    createTreeRow("System schemas", systemOpen, true, () => void toggleTreePath(systemPath, profile)),
  );
  if (systemOpen) {
    const ul = document.createElement("ul");
    ul.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    ul.setAttribute("aria-label", "System schemas");
    if (loadingPaths.has(systemPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
      li.textContent = "Loading…";
      ul.appendChild(li);
    } else if (errorsByPath.has(systemPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-red-600";
      li.textContent = errorsByPath.get(systemPath) ?? "";
      ul.appendChild(li);
    } else {
      const names = getCachedSystemSchemas(id);
      if (names === undefined) {
        ensureExpandedPathMissingData(systemPath, profile);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
        scheduleSilentStaleRefreshIfNeeded(systemPath, profile);
      } else {
        for (const schemaName of names) {
          appendSchemaSubtree(ul, profile, schemaName, true);
        }
        scheduleSilentStaleRefreshIfNeeded(systemPath, profile);
      }
    }
    liSys.appendChild(ul);
  }
  parentUl.appendChild(liSys);

  const extPath = `${prefix}extensions`;
  const extOpen = expandedTreePaths.has(extPath);
  const liExt = document.createElement("li");
  liExt.appendChild(
    createTreeRow("Extensions", extOpen, true, () => void toggleTreePath(extPath, profile)),
  );
  if (extOpen) {
    const ul = document.createElement("ul");
    ul.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    ul.setAttribute("aria-label", "Extensions");
    if (loadingPaths.has(extPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
      li.textContent = "Loading…";
      ul.appendChild(li);
    } else if (errorsByPath.has(extPath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-red-600";
      li.textContent = errorsByPath.get(extPath) ?? "";
      ul.appendChild(li);
    } else {
      const names = getCachedExtensions(id);
      if (names === undefined) {
        ensureExpandedPathMissingData(extPath, profile);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
        scheduleSilentStaleRefreshIfNeeded(extPath, profile);
      } else {
        for (const name of names) {
          const li = document.createElement("li");
          li.appendChild(createLeafRow(name));
          ul.appendChild(li);
        }
        scheduleSilentStaleRefreshIfNeeded(extPath, profile);
      }
    }
    liExt.appendChild(ul);
  }
  parentUl.appendChild(liExt);
}

/**
 * @param {HTMLUListElement} ul
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {boolean} isSystem
 */
function appendSchemaSubtree(ul, profile, schemaName, isSystem) {
  const id = profile.id;
  const basePath = isSystem
    ? `${id}::system::${schemaName}`
    : `${id}::schema::${schemaName}`;
  const open = expandedTreePaths.has(basePath);
  const li = document.createElement("li");
  li.appendChild(
    createTreeRow(schemaName, open, true, () => void toggleTreePath(basePath, profile)),
  );
  if (open) {
    const ulG = document.createElement("ul");
    ulG.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    for (const { key, label } of KIND_GROUPS) {
      const p = `${basePath}::${key}`;
      const gOpen = expandedTreePaths.has(p);
      const liG = document.createElement("li");
      liG.appendChild(
        createTreeRow(label, gOpen, true, () => void toggleTreePath(p, profile)),
      );
      if (gOpen) {
        const ulN = document.createElement("ul");
        ulN.className = "mt-0.5 border-l border-stone-200/80 pl-2";
        if (loadingPaths.has(p)) {
          const liL = document.createElement("li");
          liL.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
          liL.textContent = "Loading…";
          ulN.appendChild(liL);
        } else if (errorsByPath.has(p)) {
          const liL = document.createElement("li");
          liL.className = "rounded px-1 py-0.5 pl-6 text-xs text-red-600";
          liL.textContent = errorsByPath.get(p) ?? "";
          ulN.appendChild(liL);
        } else {
          const objs = getCachedRelations(id, schemaName, key);
          if (objs === undefined) {
            ensureExpandedPathMissingData(p, profile);
          } else if (objs.length === 0) {
            const liL = document.createElement("li");
            liL.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
            liL.textContent = "(no items)";
            ulN.appendChild(liL);
            scheduleSilentStaleRefreshIfNeeded(p, profile);
          } else {
            for (const n of objs) {
              const liN = document.createElement("li");
              if (key === "tables") {
                liN.appendChild(createTableLeafRow(profile, schemaName, n));
              } else {
                liN.appendChild(createLeafRow(n));
              }
              ulN.appendChild(liN);
            }
            scheduleSilentStaleRefreshIfNeeded(p, profile);
          }
        }
        liG.appendChild(ulN);
      }
      ulG.appendChild(liG);
    }
    li.appendChild(ulG);
  }
  ul.appendChild(li);
}

/**
 * @param {string} message
 */
function setStatusMessage(message) {
  const status = document.getElementById("status-message");
  if (status) status.textContent = message;
}

/**
 * User-facing message when PostgreSQL metadata fetch / connection fails.
 * @param {unknown} err
 */
function formatConnectionFailureMessage(err) {
  const detail = err instanceof Error ? err.message : String(err);
  const trimmed = detail.trim();
  if (!trimmed) {
    return "Could not connect to the database. The server did not return a specific reason.";
  }
  return `Could not connect to the database. Details: ${trimmed}`;
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @returns {Promise<string | null>}
 */
function waitForSessionPassword(profile) {
  const dialog = /** @type {HTMLDialogElement | null} */ (
    document.getElementById("session-password-dialog")
  );
  const form = document.getElementById("session-password-form");
  const desc = document.getElementById("session-password-description");
  const input = /** @type {HTMLInputElement | null} */ (
    document.getElementById("session-password-input")
  );
  const cancelBtn = document.getElementById("session-password-cancel");
  if (!dialog || !form || !desc || !input || !cancelBtn) {
    return Promise.resolve(null);
  }
  desc.textContent = `Enter password for "${profile.label || profile.id}". It is not stored on disk.`;
  input.value = "";
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onDialogCancel);
      resolve(value);
    };
    /** @param {SubmitEvent} e */
    const onSubmit = (e) => {
      e.preventDefault();
      finish(input.value);
      dialog.close();
    };
    const onCancel = () => {
      dialog.close();
      finish(null);
    };
    const onDialogCancel = () => {
      finish(null);
    };
    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onDialogCancel);
  });
}

/**
 * @param {string} id
 */
async function openConnection(id) {
  const profile = lastConnections.find((c) => c.id === id);
  if (!profile) return;

  resetTablePreviewPanel();

  if (shouldPromptForSessionPassword(profile)) {
    const pw = await waitForSessionPassword(profile);
    if (pw === null) return;
    setSessionPassword(profile.id, pw);
  }

  pruneCacheForConnection(id);
  /** @type {string[]} */
  let schemaNames = [];
  try {
    schemaNames = await fetchUserSchemas(profile);
    await Promise.all(
      schemaNames.map((schemaName) =>
        fetchRelationObjects(profile, schemaName, "tables"),
      ),
    );
  } catch (e) {
    setStatusMessage(formatConnectionFailureMessage(e));
    clearSessionPassword(id);
    return;
  }

  expandedTreePaths.add(`${id}::schemas`);

  openConnectionIds.add(id);
  setStatusMessage("Ready");
  renderConnections(lastConnections);
}

/**
 * @param {string} id
 */
function closeConnection(id) {
  openConnectionIds.delete(id);
  objectTreeCollapsedByConnectionId.delete(id);
  pruneExpandedPathsForConnection(id);
  pruneCacheForConnection(id);
  clearSessionPassword(id);
  if (selectedTablePreviewKey?.startsWith(`${id}::`)) {
    resetTablePreviewPanel();
  }
  renderConnections(lastConnections);
}

function setSidebarOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !toggle) return;

  if (open) {
    SIDEBAR_CLOSED.forEach((c) => sidebar.classList.remove(c));
    SIDEBAR_OPEN.forEach((c) => sidebar.classList.add(c));
  } else {
    SIDEBAR_OPEN.forEach((c) => sidebar.classList.remove(c));
    SIDEBAR_CLOSED.forEach((c) => sidebar.classList.add(c));
  }

  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncConnectionActionButtons() {
  const removeBtn = document.getElementById("remove-connection-btn");
  const editBtn = document.getElementById("edit-connection-btn");
  const disabled = selectedConnectionId == null;
  if (removeBtn instanceof HTMLButtonElement) removeBtn.disabled = disabled;
  if (editBtn instanceof HTMLButtonElement) editBtn.disabled = disabled;
}

/**
 * @param {import("./appConfig.js").ConnectionProfile[]} connections
 */
function renderConnections(connections) {
  const list = document.getElementById("connections-list");
  if (!list) return;

  cancelAnimationFrame(pendingSelectionRafId);
  pendingSelectionRafId = 0;

  lastConnections = connections;

  for (const id of [...openConnectionIds]) {
    if (!connections.some((c) => c.id === id)) {
      openConnectionIds.delete(id);
      objectTreeCollapsedByConnectionId.delete(id);
      pruneExpandedPathsForConnection(id);
      pruneCacheForConnection(id);
      clearSessionPassword(id);
    }
  }

  if (selectedConnectionId && !connections.some((c) => c.id === selectedConnectionId)) {
    selectedConnectionId = null;
  }

  list.replaceChildren();

  for (const c of connections) {
    const li = document.createElement("li");
    li.dataset.connectionId = c.id;
    li.className = "rounded";

    const row = document.createElement("div");
    row.className =
      "flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-stone-800";
    if (selectedConnectionId === c.id) {
      row.classList.add("bg-stone-200/80", "ring-1", "ring-stone-300/40");
    }
    row.title = `${c.host}:${c.port}/${c.database}`;
    row.setAttribute("aria-selected", selectedConnectionId === c.id ? "true" : "false");

    const dbOpen = openConnectionIds.has(c.id);
    const treeVisible = dbOpen && !objectTreeCollapsedByConnectionId.has(c.id);
    row.setAttribute("aria-expanded", treeVisible ? "true" : "false");

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const changed = selectedConnectionId !== c.id;
      selectedConnectionId = c.id;
      if (!changed) return;
      resetTablePreviewPanel();
      cancelAnimationFrame(pendingSelectionRafId);
      pendingSelectionRafId = requestAnimationFrame(() => {
        pendingSelectionRafId = 0;
        renderConnections(connections);
      });
    });

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "h-4 w-4 shrink-0 text-amber-700/90");
    icon.setAttribute("fill", "currentColor");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M4 7c0-1.1.9-2 2-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7zm2 0v10h12V7H6z",
    );
    icon.appendChild(path);

    const nameArea = document.createElement("div");
    nameArea.className = "flex min-h-0 min-w-0 flex-1 items-center";
    const label = document.createElement("span");
    label.className = "min-w-0 flex-1 truncate";
    label.textContent = c.label || c.id;
    nameArea.appendChild(label);
    nameArea.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      cancelAnimationFrame(pendingSelectionRafId);
      pendingSelectionRafId = 0;
      if (!dbOpen) {
        void openConnection(c.id);
        return;
      }
      if (objectTreeCollapsedByConnectionId.has(c.id)) {
        objectTreeCollapsedByConnectionId.delete(c.id);
      } else {
        objectTreeCollapsedByConnectionId.add(c.id);
      }
      renderConnections(connections);
    });

    row.appendChild(icon);
    row.appendChild(nameArea);
    li.appendChild(row);

    if (treeVisible) {
      const nested = document.createElement("ul");
      nested.className = "mt-0.5 ml-2 border-l border-stone-200/80 pl-2";
      nested.setAttribute("aria-label", "Database objects");
      renderDbTreeInto(nested, c);
      li.appendChild(nested);
    }

    list.appendChild(li);
  }

  syncConnectionActionButtons();
}

/**
 * @param {string} connectionLabel
 * @returns {Promise<boolean>}
 */
function waitForDeleteConfirmation(connectionLabel) {
  const dialog = /** @type {HTMLDialogElement | null} */ (
    document.getElementById("delete-connection-dialog")
  );
  const msg = document.getElementById("delete-connection-message");
  const cancelBtn = document.getElementById("delete-connection-cancel");
  const confirmBtn = document.getElementById("delete-connection-confirm");
  if (!dialog || !msg || !cancelBtn || !confirmBtn) {
    return Promise.resolve(false);
  }
  msg.textContent = `Remove "${connectionLabel}"?`;
  dialog.showModal();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      dialog.removeEventListener("cancel", onEscape);
      resolve(confirmed);
    };
    const onCancel = () => {
      dialog.close();
      finish(false);
    };
    const onConfirm = () => {
      dialog.close();
      finish(true);
    };
    const onEscape = () => {
      finish(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    dialog.addEventListener("cancel", onEscape);
  });
}

/**
 * @param {string} id
 */
async function removeConnectionAfterConfirm(id) {
  const config = await getAppConfig();
  const profile = config.connections.find((p) => p.id === id);
  if (!profile) return;
  const label = profile.label || profile.id;
  const ok = await waitForDeleteConfirmation(label);
  if (!ok) return;
  try {
    const next = await updateAppConfig((c) => {
      c.connections = c.connections.filter((p) => p.id !== id);
    });
    if (selectedConnectionId === id) {
      selectedConnectionId = null;
    }
    if (selectedTablePreviewKey?.startsWith(`${id}::`)) {
      resetTablePreviewPanel();
    }
    pruneExpandedPathsForConnection(id);
    pruneCacheForConnection(id);
    clearSessionPassword(id);
    renderConnections(next.connections);
  } catch (err) {
    const status = document.getElementById("status-message");
    if (status) {
      status.textContent = err instanceof Error ? err.message : "Failed to remove connection.";
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  installPlainTextInputDefaults();

  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;

  const config = await getAppConfig();

  setSidebarOpen(config.ui.sidebarOpen);
  renderConnections(config.connections);

  const wizard = initConnectionWizard({
    onConfigUpdated: (next) => {
      renderConnections(next.connections);
    },
    onDeleteConnection: removeConnectionAfterConfirm,
    isConnectionOpen,
    onOpenConnection: openConnection,
    onCloseConnection: closeConnection,
  });

  const editBtn = document.getElementById("edit-connection-btn");
  editBtn?.addEventListener("click", () => {
    if (selectedConnectionId && wizard?.openEditWizard) {
      void wizard.openEditWizard(selectedConnectionId);
    }
  });

  const removeBtn = document.getElementById("remove-connection-btn");
  removeBtn?.addEventListener("click", () => {
    if (selectedConnectionId) {
      void removeConnectionAfterConfirm(selectedConnectionId);
    }
  });

  toggle.addEventListener("click", async () => {
    const next = await updateAppConfig((c) => {
      c.ui.sidebarOpen = !c.ui.sidebarOpen;
    });
    setSidebarOpen(next.ui.sidebarOpen);
  });
});

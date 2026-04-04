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

const SIDEBAR_DEFAULT_WIDTH_PX = 256;
const SIDEBAR_MIN_WIDTH_PX = 160;
const SIDEBAR_MAX_WIDTH_PX = 560;

const SIDEBAR_OPEN = ["opacity-100", "border-r"];
const SIDEBAR_CLOSED = ["w-0", "opacity-0", "border-r-0", "pointer-events-none"];

/** @type {number} */
let sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH_PX;

/**
 * @param {number} px
 * @returns {number}
 */
function clampSidebarWidth(px) {
  const max = Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.min(SIDEBAR_MAX_WIDTH_PX, Math.floor(window.innerWidth * 0.8)),
  );
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(max, Math.round(px)));
}

/** @type {string | null} */
let selectedConnectionId = null;

/** `connectionId::schema::table` when a table leaf is selected for preview (active tab). */
/** @type {string | null} */
let selectedTablePreviewKey = null;

/**
 * @typedef {{
 *   id: string;
 *   connectionId: string;
 *   schemaName: string;
 *   tableName: string;
 *   previewKey: string;
 *   panelEl: HTMLElement;
 *   headingEl: HTMLElement;
 *   metaEl: HTMLElement;
 *   bodyEl: HTMLElement;
 * }} TablePreviewTab
 */

/** @type {TablePreviewTab[]} */
let tablePreviewTabs = [];

/** @type {string | null} */
let activeTablePreviewTabId = null;

let nextTablePreviewTabSeq = 1;

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

/**
 * @param {string} tabId
 */
function createTabPanelElements(tabId) {
  const panelEl = document.createElement("div");
  panelEl.id = `table-preview-panel-${tabId}`;
  panelEl.setAttribute("role", "tabpanel");
  panelEl.setAttribute("aria-labelledby", `table-preview-tab-${tabId}`);
  panelEl.className =
    "flex h-full min-h-[12rem] flex-1 select-none flex-col rounded-md border border-stone-200/90 bg-[#fffcf7]/90 font-mono text-sm shadow-sm shadow-stone-200/40";

  const header = document.createElement("div");
  header.className =
    "flex shrink-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-b border-stone-200/80 px-3 py-2 text-xs";

  const headingEl = document.createElement("span");
  headingEl.className = "min-w-0 font-medium text-stone-800";

  const metaEl = document.createElement("span");
  metaEl.className = "shrink-0 text-stone-500";

  header.appendChild(headingEl);
  header.appendChild(metaEl);

  const bodyEl = document.createElement("div");
  bodyEl.className =
    "min-h-0 flex-1 overflow-auto p-3 text-sm text-stone-500 select-text";

  panelEl.appendChild(header);
  panelEl.appendChild(bodyEl);

  return { panelEl, headingEl, metaEl, bodyEl };
}

function syncTabPanelVisibility() {
  for (const t of tablePreviewTabs) {
    t.panelEl.classList.toggle("hidden", t.id !== activeTablePreviewTabId);
  }
}

function renderTabStrip() {
  const tabsStrip = document.getElementById("table-preview-tabs");
  if (!tabsStrip) return;
  tabsStrip.replaceChildren();

  for (const tab of tablePreviewTabs) {
    const isActive = tab.id === activeTablePreviewTabId;
    const wrap = document.createElement("div");
    wrap.className = isActive
      ? "flex min-w-0 max-w-[14rem] shrink-0 items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#faf8f4] px-1 pl-2.5 py-1 text-xs text-stone-800 ring-1 ring-stone-300/40"
      : "flex min-w-0 max-w-[14rem] shrink-0 items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#f0ebe3]/90 px-1 pl-2.5 py-1 text-xs text-stone-700";

    const dot = document.createElement("span");
    dot.className = "shrink-0 text-emerald-600";
    dot.setAttribute("aria-hidden", "true");
    dot.textContent = "●";

    const tabBtn = document.createElement("button");
    tabBtn.type = "button";
    tabBtn.setAttribute("role", "tab");
    tabBtn.id = `table-preview-tab-${tab.id}`;
    tabBtn.className = "min-w-0 flex-1 truncate text-left";
    tabBtn.setAttribute("aria-controls", `table-preview-panel-${tab.id}`);
    tabBtn.setAttribute("aria-selected", isActive ? "true" : "false");
    const label = `${tab.schemaName}.${tab.tableName}`;
    tabBtn.textContent = label;
    tabBtn.setAttribute("aria-label", `Preview ${label}`);
    tabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeTablePreviewTabId !== tab.id) {
        activateTablePreviewTab(tab.id);
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "shrink-0 rounded px-1 text-stone-500 hover:bg-stone-200/80 hover:text-stone-800";
    closeBtn.setAttribute("aria-label", "Close tab");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTablePreviewTab(tab.id);
    });

    wrap.appendChild(dot);
    wrap.appendChild(tabBtn);
    wrap.appendChild(closeBtn);
    tabsStrip.appendChild(wrap);
  }
}

/**
 * @param {string} tabId
 */
function activateTablePreviewTab(tabId) {
  if (!tablePreviewTabs.some((t) => t.id === tabId)) return;
  activeTablePreviewTabId = tabId;
  const tab = tablePreviewTabs.find((t) => t.id === tabId);
  if (tab) selectedTablePreviewKey = tab.previewKey;
  syncTabPanelVisibility();
  renderTabStrip();
  renderConnections(lastConnections);
}

/**
 * @param {string} tabId
 */
function closeTablePreviewTab(tabId) {
  const idx = tablePreviewTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const wasActive = activeTablePreviewTabId === tabId;
  const tab = tablePreviewTabs[idx];
  tab.panelEl.remove();

  tablePreviewTabs.splice(idx, 1);

  if (tablePreviewTabs.length === 0) {
    activeTablePreviewTabId = null;
    selectedTablePreviewKey = null;
    renderTablePreviewPlaceholder();
    renderConnections(lastConnections);
    return;
  }

  if (wasActive) {
    const nextIdx = idx < tablePreviewTabs.length ? idx : idx - 1;
    const nextTab = tablePreviewTabs[nextIdx];
    if (nextTab) {
      activeTablePreviewTabId = nextTab.id;
      selectedTablePreviewKey = nextTab.previewKey;
    }
  }

  syncTabPanelVisibility();
  renderTabStrip();
  renderConnections(lastConnections);
}

/**
 * @param {string} connectionId
 */
function removeTabsForConnection(connectionId) {
  const toRemove = tablePreviewTabs.filter((t) => t.connectionId === connectionId);
  if (toRemove.length === 0) return;

  for (const t of toRemove) {
    t.panelEl.remove();
  }
  tablePreviewTabs = tablePreviewTabs.filter((t) => t.connectionId !== connectionId);

  if (tablePreviewTabs.length === 0) {
    activeTablePreviewTabId = null;
    selectedTablePreviewKey = null;
    const tabsStrip = document.getElementById("table-preview-tabs");
    if (tabsStrip) tabsStrip.replaceChildren();
    const area = document.getElementById("table-preview-area");
    if (area) area.classList.add("hidden");
    return;
  }

  if (!activeTablePreviewTabId || !tablePreviewTabs.some((t) => t.id === activeTablePreviewTabId)) {
    const last = tablePreviewTabs[tablePreviewTabs.length - 1];
    activeTablePreviewTabId = last.id;
    selectedTablePreviewKey = last.previewKey;
  } else {
    const t = tablePreviewTabs.find((x) => x.id === activeTablePreviewTabId);
    selectedTablePreviewKey = t?.previewKey ?? null;
  }

  const area = document.getElementById("table-preview-area");
  if (area) area.classList.remove("hidden");
  syncTabPanelVisibility();
  renderTabStrip();
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} tableName
 */
function openNewTableTab(profile, schemaName, tableName) {
  const key = tablePreviewKey(profile.id, schemaName, tableName);
  const tabId = `tab-${nextTablePreviewTabSeq++}`;
  const { panelEl, headingEl, metaEl, bodyEl } = createTabPanelElements(tabId);

  const panelsRoot = document.getElementById("table-preview-panels");
  if (!panelsRoot) return;
  panelsRoot.appendChild(panelEl);

  /** @type {TablePreviewTab} */
  const tab = {
    id: tabId,
    connectionId: profile.id,
    schemaName,
    tableName,
    previewKey: key,
    panelEl,
    headingEl,
    metaEl,
    bodyEl,
  };
  tablePreviewTabs.push(tab);
  activeTablePreviewTabId = tabId;
  selectedTablePreviewKey = key;

  const area = document.getElementById("table-preview-area");
  if (area) area.classList.remove("hidden");

  syncTabPanelVisibility();
  renderTabStrip();
  renderConnections(lastConnections);

  void loadTablePreview(tabId, profile, schemaName, tableName);
}

function renderTablePreviewPlaceholder() {
  const area = document.getElementById("table-preview-area");
  if (area) area.classList.add("hidden");
  const tabsStrip = document.getElementById("table-preview-tabs");
  const panelsRoot = document.getElementById("table-preview-panels");
  if (tabsStrip) tabsStrip.replaceChildren();
  if (panelsRoot) panelsRoot.replaceChildren();
  tablePreviewTabs = [];
  activeTablePreviewTabId = null;
  selectedTablePreviewKey = null;
}

/**
 * @param {HTMLElement} headingEl
 * @param {HTMLElement} metaEl
 * @param {HTMLElement} bodyEl
 * @param {string} schemaName
 * @param {string} tableName
 */
function renderTablePreviewLoading(headingEl, metaEl, bodyEl, schemaName, tableName) {
  const label = `${schemaName}.${tableName}`;
  if (headingEl) headingEl.textContent = label;
  if (metaEl) metaEl.textContent = "Loading…";
  if (bodyEl) {
    bodyEl.className = "min-h-0 flex-1 overflow-auto p-3 text-sm text-stone-500 select-text";
    bodyEl.replaceChildren();
    bodyEl.appendChild(document.createTextNode("Loading…"));
  }
}

/**
 * @param {HTMLElement} bodyEl
 * @param {HTMLElement} metaEl
 * @param {string} message
 */
function renderTablePreviewError(bodyEl, metaEl, message) {
  if (metaEl) metaEl.textContent = "";
  if (bodyEl) {
    bodyEl.className = "min-h-0 flex-1 overflow-auto p-3 text-sm select-text";
    bodyEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "text-red-600";
    p.textContent = message;
    bodyEl.appendChild(p);
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
 * @param {HTMLElement} bodyEl
 * @param {HTMLElement} metaEl
 * @param {{ columns: string[]; rows: unknown[] }} data
 */
function renderTablePreviewTable(bodyEl, metaEl, data) {
  if (metaEl) {
    metaEl.textContent = `${data.rows.length} rows (limit ${TABLE_PREVIEW_DEFAULT_LIMIT})`;
  }
  if (!bodyEl) return;

  bodyEl.className = "min-h-0 flex-1 overflow-auto p-0 select-text";
  bodyEl.replaceChildren();

  const table = document.createElement("table");
  table.className =
    "min-w-full w-max border-collapse text-left text-xs text-stone-800";

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
  bodyEl.appendChild(table);
}

/**
 * @param {string} tabId
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} tableName
 */
async function loadTablePreview(tabId, profile, schemaName, tableName) {
  const tab = tablePreviewTabs.find((t) => t.id === tabId);
  if (!tab) return;
  renderTablePreviewLoading(tab.headingEl, tab.metaEl, tab.bodyEl, schemaName, tableName);
  setStatusMessage("Loading…");
  try {
    const data = await fetchTablePreview(profile, schemaName, tableName, {
      limit: TABLE_PREVIEW_DEFAULT_LIMIT,
    });
    const still = tablePreviewTabs.find((t) => t.id === tabId);
    if (!still) return;
    renderTablePreviewTable(still.bodyEl, still.metaEl, data);
    setStatusMessage("Ready");
  } catch (e) {
    const still = tablePreviewTabs.find((t) => t.id === tabId);
    if (!still) return;
    const msg = formatConnectionFailureMessage(e);
    renderTablePreviewError(still.bodyEl, still.metaEl, msg);
    setStatusMessage(msg);
  }
}

function resetTablePreviewPanel() {
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
    openNewTableTab(profile, schemaName, tableName);
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
  removeTabsForConnection(id);
  renderConnections(lastConnections);
}

function setSidebarOpen(open) {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  const handle = document.getElementById("sidebar-resize-handle");
  if (!sidebar || !toggle) return;

  if (open) {
    SIDEBAR_CLOSED.forEach((c) => sidebar.classList.remove(c));
    SIDEBAR_OPEN.forEach((c) => sidebar.classList.add(c));
    sidebar.style.width = `${sidebarWidthPx}px`;
    handle?.classList.remove("hidden");
  } else {
    SIDEBAR_OPEN.forEach((c) => sidebar.classList.remove(c));
    SIDEBAR_CLOSED.forEach((c) => sidebar.classList.add(c));
    sidebar.style.width = "";
    handle?.classList.add("hidden");
  }

  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function initSidebarResize() {
  const handle = document.getElementById("sidebar-resize-handle");
  const sidebar = document.getElementById("sidebar");
  if (!handle || !sidebar) return;

  /** @type {number | null} */
  let activePointerId = null;
  let startX = 0;
  let startWidth = 0;

  const endDrag = () => {
    activePointerId = null;
    document.body.classList.remove("select-none");
    sidebar.classList.remove("transition-none");
  };

  const finishResizeAndPersist = (e) => {
    if (activePointerId !== e.pointerId) return;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endDrag();
    void updateAppConfig((c) => {
      c.ui.sidebarWidthPx = sidebarWidthPx;
    });
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (sidebar.classList.contains("w-0")) return;
    e.preventDefault();
    activePointerId = e.pointerId;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.classList.add("select-none");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      endDrag();
      return;
    }
    /* Avoid animating width during drag (transition-[width] feels like cursor lag). */
    sidebar.classList.add("transition-none");
  });

  handle.addEventListener("pointermove", (e) => {
    if (activePointerId !== e.pointerId) return;
    const delta = e.clientX - startX;
    const next = clampSidebarWidth(startWidth + delta);
    sidebarWidthPx = next;
    sidebar.style.width = `${next}px`;
  });

  handle.addEventListener("pointerup", finishResizeAndPersist);

  handle.addEventListener("pointercancel", finishResizeAndPersist);
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
    removeTabsForConnection(id);
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

  sidebarWidthPx = clampSidebarWidth(
    typeof config.ui.sidebarWidthPx === "number" ? config.ui.sidebarWidthPx : SIDEBAR_DEFAULT_WIDTH_PX,
  );
  setSidebarOpen(config.ui.sidebarOpen);
  initSidebarResize();
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

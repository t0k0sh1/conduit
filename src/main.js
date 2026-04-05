import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { initConnectionWizard } from "./connectionWizard.js";
import {
  clearSessionPassword,
  executePgSql,
  fetchExtensions,
  fetchRelationObjects,
  fetchSystemSchemaNames,
  fetchTablePreview,
  fetchUserSchemas,
  formatPgExecutionErrorMessage,
  getCachedExtensions,
  getCachedRelations,
  getCachedSystemSchemas,
  getCachedUserSchemas,
  isPgCacheStale,
  parsePgExecutionError,
  pruneCacheForConnection,
  setSessionPassword,
  shouldPromptForSessionPassword,
} from "./dbMetadata.js";
import { installPlainTextInputDefaults } from "./inputBehavior.js";
import { formatSql } from "./sqlFormat.js";
import {
  addDataSourceTitle,
  ariaModDigit,
  ariaModLetter,
  ariaRunSqlShortcut,
  ARIA_FORMAT_SQL_SHORTCUT,
  formatSqlButtonTitle,
  runSqlButtonTitle,
  toggleDatabaseExplorerTitle,
} from "./shortcutHints.js";

const SIDEBAR_DEFAULT_WIDTH_PX = 256;
const SIDEBAR_MIN_WIDTH_PX = 160;
const SIDEBAR_MAX_WIDTH_PX = 560;

const SIDEBAR_OPEN = ["opacity-100", "border-r"];
const SIDEBAR_CLOSED = [
  "w-0",
  "opacity-0",
  "border-r-0",
  "pointer-events-none",
];

/**
 * `contextmenu` / `click` targets can be a `Text` node inside a button or label.
 * Use this before `Element#closest` so we resolve the interactive ancestor.
 * @param {Event} ev
 * @returns {Element | null}
 */
function eventTargetElement(ev) {
  const t = ev.target;
  if (t instanceof Element) return t;
  if (t instanceof Text && t.parentElement) return t.parentElement;
  return null;
}

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

/**
 * @typedef {{
 *   id: string;
 *   connectionId: string;
 *   tabLabel: string;
 *   panelEl: HTMLElement;
 *   textareaEl: HTMLTextAreaElement;
 *   runBtn: HTMLButtonElement;
 *   formatBtn: HTMLButtonElement;
 *   resultMetaEl: HTMLElement;
 *   resultBodyEl: HTMLElement;
 * }} SqlQueryTab
 */

/** @type {SqlQueryTab[]} */
let sqlQueryTabs = [];

/** @type {string | null} */
let activeSqlQueryTabId = null;

let nextSqlQueryTabSeq = 1;

const TABLE_PREVIEW_DEFAULT_LIMIT = 100;

/**
 * Table catalog metadata returned with `fetchTablePreview` (camelCase from Tauri).
 * @typedef {{
 *   statistics: null | {
 *     relkind: string;
 *     estimatedRowCount: number;
 *     totalBytes: number;
 *     heapBytes: number;
 *     indexBytes: number;
 *     heapStatsAvailable: boolean;
 *     seqScan: number | null;
 *     seqTupRead: number | null;
 *     idxScan: number | null;
 *     idxTupFetch: number | null;
 *     nTupIns: number | null;
 *     nTupUpd: number | null;
 *     nTupDel: number | null;
 *     nLiveTup: number | null;
 *     nDeadTup: number | null;
 *     lastVacuum: string | null;
 *     lastAutovacuum: string | null;
 *     lastAnalyze: string | null;
 *     lastAutoanalyze: string | null;
 *     vacuumCount: number | null;
 *     autovacuumCount: number | null;
 *     analyzeCount: number | null;
 *     autoanalyzeCount: number | null;
 *   };
 *   primaryKey: null | { name: string; columns: string[] };
 *   foreignKeys: Array<{
 *     name: string;
 *     columns: string[];
 *     referencedSchema: string;
 *     referencedTable: string;
 *     referencedColumns: string[];
 *   }>;
 *   uniqueConstraints: Array<{ name: string; columns: string[] }>;
 *   indexes: Array<{ name: string; definition: string }>;
 * }} TablePreviewMetadata
 */

/**
 * @returns {TablePreviewMetadata}
 */
function emptyTablePreviewMetadata() {
  return {
    statistics: null,
    primaryKey: null,
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
  };
}

/**
 * @param {TablePreviewMetadata} metadata
 * @param {string} columnName
 * @returns {("PK"|"FK"|"UK")[]}
 */
function columnTagsForTablePreview(metadata, columnName) {
  /** @type {("PK"|"FK"|"UK")[]} */
  const tags = [];
  const pk = metadata.primaryKey;
  if (pk?.columns?.includes(columnName)) tags.push("PK");
  for (const fk of metadata.foreignKeys ?? []) {
    if (fk.columns?.includes(columnName)) {
      tags.push("FK");
      break;
    }
  }
  for (const u of metadata.uniqueConstraints ?? []) {
    if (u.columns?.includes(columnName)) {
      tags.push("UK");
      break;
    }
  }
  return tags;
}

/**
 * @param {string[]} parts
 * @returns {string}
 */
function formatIdentList(parts) {
  return parts.join(", ");
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatByteSize(n) {
  if (n == null || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const shown = u === 0 || v >= 10 ? Math.round(v) : Number(v.toFixed(1));
  return `${shown} ${units[u]}`;
}

/**
 * @param {string} kind
 * @returns {string}
 */
function pgRelkindLabel(kind) {
  const map = {
    r: "Table",
    p: "Partitioned table",
    v: "View",
    m: "Materialized view",
    f: "Foreign table",
    I: "Partitioned index",
    t: "TOAST table",
    c: "Composite type",
  };
  return map[kind] ?? `Other (${kind})`;
}

/**
 * @param {number | null | undefined} n
 * @returns {string}
 */
function formatNullableStatInt(n) {
  if (n == null) return "—";
  return String(n);
}

/**
 * @param {string | null | undefined} t
 * @returns {string}
 */
function formatNullableTimestamp(t) {
  if (t == null || t === "") return "—";
  return t;
}

/**
 * @param {TablePreviewMetadata} metadata
 * @param {HTMLElement} container
 */
function renderTablePreviewMetadataSection(metadata, container) {
  container.className =
    "min-h-0 flex-1 overflow-auto bg-[#faf8f4]/90 px-3 py-2 text-xs text-stone-700";

  const sectionTitle = (label) => {
    const el = document.createElement("div");
    el.className =
      "mt-2 first:mt-0 text-[11px] font-semibold uppercase tracking-wide text-stone-500";
    el.textContent = label;
    return el;
  };

  const bodyMuted = (text) => {
    const el = document.createElement("div");
    el.className = "font-mono text-[11px] text-stone-600";
    el.textContent = text;
    return el;
  };

  const none = () => {
    const el = document.createElement("div");
    el.className = "italic text-stone-400";
    el.textContent = "None";
    return el;
  };

  container.appendChild(sectionTitle("Primary key"));
  if (metadata.primaryKey) {
    const pk = metadata.primaryKey;
    container.appendChild(
      bodyMuted(
        `${pk.name} (${formatIdentList(pk.columns)})`,
      ),
    );
  } else {
    container.appendChild(none());
  }

  container.appendChild(sectionTitle("Foreign keys"));
  const fks = metadata.foreignKeys ?? [];
  if (fks.length === 0) {
    container.appendChild(none());
  } else {
    for (const fk of fks) {
      const line = `${fk.name}: (${formatIdentList(fk.columns)}) REFERENCES ${fk.referencedSchema}.${fk.referencedTable} (${formatIdentList(fk.referencedColumns)})`;
      container.appendChild(bodyMuted(line));
    }
  }

  container.appendChild(sectionTitle("Unique constraints"));
  const uniqs = metadata.uniqueConstraints ?? [];
  if (uniqs.length === 0) {
    container.appendChild(none());
  } else {
    for (const u of uniqs) {
      container.appendChild(
        bodyMuted(`${u.name} (${formatIdentList(u.columns)})`),
      );
    }
  }

  container.appendChild(sectionTitle("Indexes"));
  const idxs = metadata.indexes ?? [];
  if (idxs.length === 0) {
    container.appendChild(none());
  } else {
    for (const ix of idxs) {
      const wrap = document.createElement("div");
      wrap.className = "mb-1.5 last:mb-0";
      const nameEl = document.createElement("div");
      nameEl.className = "font-mono text-[11px] font-medium text-stone-700";
      nameEl.textContent = ix.name;
      const defEl = document.createElement("pre");
      defEl.className =
        "mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-stone-600";
      defEl.textContent = ix.definition;
      wrap.appendChild(nameEl);
      wrap.appendChild(defEl);
      container.appendChild(wrap);
    }
  }
}

/**
 * @param {TablePreviewMetadata["statistics"]} statistics
 * @param {HTMLElement} container
 */
function renderTablePreviewStatisticsSection(statistics, container) {
  container.className =
    "min-h-0 flex-1 overflow-auto bg-[#faf8f4]/90 px-3 py-2 text-xs text-stone-700";
  if (!statistics) {
    const empty = document.createElement("div");
    empty.className = "italic text-stone-400";
    empty.textContent = "No statistics available.";
    container.appendChild(empty);
    return;
  }
  const st = statistics;
  const statBlock = document.createElement("div");
  statBlock.className = "space-y-1 font-mono text-[11px] text-stone-600";
  const lines = [
    `Relation kind: ${pgRelkindLabel(st.relkind)}`,
    `Estimated rows (planner): ${
      st.estimatedRowCount < 0
        ? "Unknown (run ANALYZE)"
        : String(st.estimatedRowCount)
    }`,
    `Total size: ${formatByteSize(st.totalBytes)}`,
    `Heap size: ${formatByteSize(st.heapBytes)}`,
    `Indexes size: ${formatByteSize(st.indexBytes)}`,
  ];
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    statBlock.appendChild(row);
  }
  if (!st.heapStatsAvailable) {
    const hint = document.createElement("div");
    hint.className = "mt-2 italic text-stone-500";
    hint.textContent =
      "Heap activity statistics (scans, tuple counts, vacuum) are not tracked for this relation type (e.g. views).";
    statBlock.appendChild(hint);
  } else {
    const activityTitle = document.createElement("div");
    activityTitle.className =
      "mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-500";
    activityTitle.textContent = "Activity (since stats reset)";
    statBlock.appendChild(activityTitle);
    const actLines = [
      `Sequential scans: ${formatNullableStatInt(st.seqScan)}`,
      `Sequential tuples read: ${formatNullableStatInt(st.seqTupRead)}`,
      `Index scans: ${formatNullableStatInt(st.idxScan)}`,
      `Index tuples fetched: ${formatNullableStatInt(st.idxTupFetch)}`,
      `Inserts: ${formatNullableStatInt(st.nTupIns)}`,
      `Updates: ${formatNullableStatInt(st.nTupUpd)}`,
      `Deletes: ${formatNullableStatInt(st.nTupDel)}`,
      `Live tuples (estimate): ${formatNullableStatInt(st.nLiveTup)}`,
      `Dead tuples (estimate): ${formatNullableStatInt(st.nDeadTup)}`,
    ];
    for (const line of actLines) {
      const row = document.createElement("div");
      row.textContent = line;
      statBlock.appendChild(row);
    }
    const maintTitle = document.createElement("div");
    maintTitle.className =
      "mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-500";
    maintTitle.textContent = "Maintenance";
    statBlock.appendChild(maintTitle);
    const maintLines = [
      `Last vacuum: ${formatNullableTimestamp(st.lastVacuum)}`,
      `Last autovacuum: ${formatNullableTimestamp(st.lastAutovacuum)}`,
      `Last analyze: ${formatNullableTimestamp(st.lastAnalyze)}`,
      `Last autoanalyze: ${formatNullableTimestamp(st.lastAutoanalyze)}`,
      `Vacuum count: ${formatNullableStatInt(st.vacuumCount)}`,
      `Autovacuum count: ${formatNullableStatInt(st.autovacuumCount)}`,
      `Analyze count: ${formatNullableStatInt(st.analyzeCount)}`,
      `Autoanalyze count: ${formatNullableStatInt(st.autoanalyzeCount)}`,
    ];
    for (const line of maintLines) {
      const row = document.createElement("div");
      row.textContent = line;
      statBlock.appendChild(row);
    }
  }
  container.appendChild(statBlock);
}

/**
 * PostgreSQL double-quoted identifier (escape embedded quotes).
 * @param {string} ident
 */
function pgQuoteIdent(ident) {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * @param {string} schemaName
 * @param {string} tableName
 */
function defaultSelectSqlForTable(schemaName, tableName) {
  const rel = `${pgQuoteIdent(schemaName)}.${pgQuoteIdent(tableName)}`;
  return `SELECT *\nFROM ${rel}\nLIMIT 100;`;
}

/** Deferred re-render after selection change so double-click can complete on the same DOM. */
let pendingSelectionRafId = 0;

/** Coalesce rapid `renderConnections` calls (toggle + many stale-refresh completions) into one DOM rebuild. */
let connectionsUiFlushScheduled = false;

/** Debounce timer for `renderConnections` after silent stale-refresh completions (see `scheduleSilentStaleRefreshIfNeeded`). */
let staleRefreshRenderDebounceTimer = 0;

/** @see flushConnectionsUi — long tasks here block input until the browser finishes; profile with Performance / Long Task. */
const STALE_REFRESH_RENDER_DEBOUNCE_MS = 100;

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

/** True while {@link expandAllExplorerTree} is running (disables expand/collapse controls). */
let explorerExpandAllInFlight = false;

/** Object-kind folders under each schema (matches Rust `parse_relation_kind`). */
const KIND_GROUPS = [
  { key: "tables", label: "Tables" },
  { key: "views", label: "Views" },
  { key: "materialized_views", label: "Materialized views" },
  { key: "functions", label: "Functions" },
  { key: "sequences", label: "Sequences" },
];

/** Kinds that support the same row preview as base tables (`SELECT *`). */
const PREVIEWABLE_REL_KINDS = new Set(["tables", "views", "materialized_views"]);

/** Relation leaf lists: sync first chunk, then rAF chunks to avoid long main-thread tasks. */
const RELATION_LEAF_SYNC_FIRST = 80;
const RELATION_LEAF_RAF_CHUNK = 100;
/** Lists longer than this use "Show more" after the first visible window. */
const RELATION_LIST_SHOW_MORE_TOTAL = 320;
const RELATION_SHOW_MORE_INITIAL_VISIBLE = 300;

/**
 * @param {"tables"|"views"|"materialized_views"} kind
 * @returns {{ openHint: string; ariaPreview: string }}
 */
function previewableRelationKindUi(kind) {
  switch (kind) {
    case "views":
      return {
        openHint: "Double-click to open view preview",
        ariaPreview: "Preview view",
      };
    case "materialized_views":
      return {
        openHint: "Double-click to open materialized view preview",
        ariaPreview: "Preview materialized view",
      };
    default:
      return {
        openHint: "Double-click to open table preview",
        ariaPreview: "Preview table",
      };
  }
}

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
  if (parts.length === 2 && parts[1] === "database") {
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
    renderAfterTreeToggle(profile);
    return;
  }
  expandedTreePaths.add(path);

  const id = profile.id;
  const needsFetch =
    path === `${id}::database` ||
    path === `${id}::system` ||
    path === `${id}::extensions` ||
    (path.startsWith(`${id}::schema::`) && path.split("::").length === 4) ||
    (path.startsWith(`${id}::system::`) && path.split("::").length === 4);

  if (needsFetch) {
    loadingPaths.add(path);
    renderAfterTreeToggle(profile);
    try {
      errorsByPath.delete(path);
      await ensureLoaded(path, profile);
    } catch (e) {
      errorsByPath.set(path, formatConnectionFailureMessage(e));
    } finally {
      loadingPaths.delete(path);
    }
    renderAfterTreeToggle(profile);
    return;
  }
  renderAfterTreeToggle(profile);
}

/**
 * @param {string} path
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function isExpandedPathStale(path, profile) {
  const id = profile.id;
  const parts = path.split("::");
  if (parts[0] !== id) return false;
  if (path === `${id}::database`)
    return isPgCacheStale("pg", id, "user-schemas");
  if (path === `${id}::system`)
    return isPgCacheStale("pg", id, "system-schemas");
  if (path === `${id}::extensions`)
    return isPgCacheStale("pg", id, "extensions");
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
/**
 * Batches UI updates when many `scheduleSilentStaleRefreshIfNeeded` runs finish around the same time.
 */
function scheduleDebouncedRenderAfterStaleRefresh() {
  if (staleRefreshRenderDebounceTimer) {
    clearTimeout(staleRefreshRenderDebounceTimer);
  }
  staleRefreshRenderDebounceTimer = window.setTimeout(() => {
    staleRefreshRenderDebounceTimer = 0;
    renderConnections(lastConnections);
  }, STALE_REFRESH_RENDER_DEBOUNCE_MS);
}

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
      scheduleDebouncedRenderAfterStaleRefresh();
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
  row.className =
    "flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-stone-700";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-200/80 hover:text-stone-800";
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (hasChildren) {
    btn.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Second rapid click on the same control is still `click` with detail 2 (double-click pair); must toggle.
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
  span.className =
    "min-w-0 flex-1 cursor-pointer select-none truncate";
  span.textContent = label;
  if (hasChildren) {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      // Same as chevron: rapid successive clicks on one row use detail 2 for the second click.
      onToggle();
    });
  }
  row.appendChild(btn);
  row.appendChild(span);
  return row;
}

/**
 * Tree row with optional relation count (immediately after label, smaller text). Count omitted when `undefined`.
 * @param {string} label
 * @param {number | undefined} relationCount
 * @param {boolean} expanded
 * @param {boolean} hasChildren
 * @param {() => void} onToggle
 */
function createTreeRowWithRelationCount(
  label,
  relationCount,
  expanded,
  hasChildren,
  onToggle,
) {
  const row = document.createElement("div");
  row.className =
    "flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-stone-700";
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
  const labelWrap = document.createElement("div");
  labelWrap.className =
    "flex min-w-0 flex-1 items-center justify-start overflow-hidden";
  const inner = document.createElement("div");
  inner.className =
    "inline-flex w-max max-w-full min-w-0 items-center gap-1.5";
  const span = document.createElement("span");
  span.className =
    "min-w-0 cursor-pointer select-none truncate text-left";
  span.textContent = label;
  if (hasChildren) {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle();
    });
  }
  inner.appendChild(span);
  if (relationCount !== undefined) {
    const countEl = document.createElement("span");
    countEl.className =
      "shrink-0 tabular-nums text-[0.65rem] leading-none text-stone-400";
    countEl.textContent = String(relationCount);
    inner.appendChild(countEl);
  }
  labelWrap.appendChild(inner);
  row.appendChild(btn);
  row.appendChild(labelWrap);
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

/**
 * @param {string} tabId
 */
function createSqlQueryPanelElements(tabId) {
  const panelEl = document.createElement("div");
  panelEl.id = `sql-editor-panel-${tabId}`;
  panelEl.setAttribute("role", "tabpanel");
  panelEl.setAttribute("aria-labelledby", `sql-editor-tab-${tabId}`);
  panelEl.className =
    "flex h-full min-h-[8rem] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-stone-200/90 bg-[#fffcf7]/90 shadow-sm shadow-stone-200/40";

  const toolbar = document.createElement("div");
  toolbar.className =
    "flex shrink-0 items-center gap-2 border-b border-stone-200/80 bg-[#faf8f4]/90 px-2 py-1.5";

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.id = `sql-editor-run-${tabId}`;
  runBtn.className =
    "rounded border border-stone-300/90 bg-stone-100/90 px-2.5 py-1 text-xs font-medium text-stone-800 hover:bg-stone-200/90 disabled:cursor-not-allowed disabled:opacity-50";
  runBtn.textContent = "Run";
  runBtn.title = runSqlButtonTitle();
  runBtn.setAttribute("aria-label", "Run SQL");
  runBtn.setAttribute("aria-keyshortcuts", ariaRunSqlShortcut());

  const formatBtn = document.createElement("button");
  formatBtn.type = "button";
  formatBtn.id = `sql-editor-format-${tabId}`;
  formatBtn.className =
    "rounded border border-stone-300/90 bg-stone-100/90 px-2.5 py-1 text-xs font-medium text-stone-800 hover:bg-stone-200/90 disabled:cursor-not-allowed disabled:opacity-50";
  formatBtn.textContent = "Format";
  formatBtn.title = formatSqlButtonTitle();
  formatBtn.setAttribute("aria-label", "Format SQL");
  formatBtn.setAttribute("aria-keyshortcuts", ARIA_FORMAT_SQL_SHORTCUT);

  toolbar.appendChild(runBtn);
  toolbar.appendChild(formatBtn);

  const editorWrap = document.createElement("div");
  editorWrap.className = "flex min-h-0 flex-1 flex-col";

  const textareaEl = document.createElement("textarea");
  textareaEl.id = `sql-editor-textarea-${tabId}`;
  textareaEl.className =
    "min-h-0 w-full flex-1 resize-none select-text border-0 bg-transparent p-3 font-mono text-sm text-stone-800 outline-none ring-0 placeholder:text-stone-400";
  textareaEl.setAttribute("aria-label", "SQL query");
  textareaEl.placeholder = "";
  textareaEl.rows = 1;

  editorWrap.appendChild(textareaEl);

  const resultWrap = document.createElement("div");
  resultWrap.className =
    "flex min-h-[6rem] flex-1 flex-col min-h-0 border-t border-stone-200/80 bg-[#faf8f4]/50";

  const resultMetaEl = document.createElement("div");
  resultMetaEl.id = `sql-editor-result-meta-${tabId}`;
  resultMetaEl.className =
    "shrink-0 border-b border-stone-200/60 px-3 py-1.5 text-xs text-stone-500";
  resultMetaEl.textContent = "No results yet.";

  const resultBodyEl = document.createElement("div");
  resultBodyEl.id = `sql-editor-result-body-${tabId}`;
  resultBodyEl.className = "min-h-0 flex-1 overflow-auto";
  resultBodyEl.setAttribute("role", "region");
  resultBodyEl.setAttribute("aria-label", "SQL result");

  resultWrap.appendChild(resultMetaEl);
  resultWrap.appendChild(resultBodyEl);

  panelEl.appendChild(toolbar);
  panelEl.appendChild(editorWrap);
  panelEl.appendChild(resultWrap);

  runBtn.addEventListener("click", () => {
    void runSqlQueryForTab(tabId);
  });

  formatBtn.addEventListener("click", () => {
    void formatSqlForTab(tabId);
  });

  textareaEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runSqlQueryForTab(tabId);
      return;
    }
    if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      void formatSqlForTab(tabId);
    }
  });

  return { panelEl, textareaEl, runBtn, formatBtn, resultMetaEl, resultBodyEl };
}

function syncTabPanelVisibility() {
  for (const t of tablePreviewTabs) {
    t.panelEl.classList.toggle("hidden", t.id !== activeTablePreviewTabId);
  }
}

function syncSqlQueryPanelVisibility() {
  for (const t of sqlQueryTabs) {
    t.panelEl.classList.toggle("hidden", t.id !== activeSqlQueryTabId);
  }
}

function updateSqlEditorAreaVisibility() {
  const area = document.getElementById("sql-editor-area");
  if (!area) return;
  area.classList.toggle("hidden", sqlQueryTabs.length === 0);
  renderSqlConnectionRow();
}

/**
 * Toolbar row below the main menu: always visible; shows which database the active
 * SQL tab uses (or the sidebar selection when no query tabs) and allows switching
 * among open connections.
 */
function renderSqlConnectionRow() {
  const row = document.getElementById("sql-editor-connection-row");
  const select = document.getElementById("sql-editor-connection-select");
  if (!row || !select) return;

  /** @type {import("./appConfig.js").ConnectionProfile[]} */
  const open = lastConnections
    .filter((c) => openConnectionIds.has(c.id))
    .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));

  select.replaceChildren();

  if (open.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No open data source";
    opt.disabled = true;
    select.appendChild(opt);
    select.value = "";
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const c of open) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label || c.id;
    opt.title = `${c.host}:${c.port}/${c.database}`;
    select.appendChild(opt);
  }

  const activeTab =
    activeSqlQueryTabId &&
    sqlQueryTabs.find((t) => t.id === activeSqlQueryTabId);
  if (activeTab) {
    if (open.some((c) => c.id === activeTab.connectionId)) {
      select.value = activeTab.connectionId;
    } else if (open[0]) {
      activeTab.connectionId = open[0].id;
      select.value = open[0].id;
    }
    return;
  }

  const preferred =
    selectedConnectionId && open.some((c) => c.id === selectedConnectionId)
      ? selectedConnectionId
      : open[0].id;
  select.value = preferred;
}

function initSqlEditorConnectionRow() {
  const select = document.getElementById("sql-editor-connection-select");
  if (!select) return;
  select.addEventListener("change", () => {
    const id = select.value;
    if (!id) return;
    const tab =
      activeSqlQueryTabId &&
      sqlQueryTabs.find((t) => t.id === activeSqlQueryTabId);
    if (tab) {
      if (id === tab.connectionId) return;
      tab.connectionId = id;
      renderSqlEditorTabStrip();
      return;
    }
    if (selectedConnectionId !== id) {
      selectedConnectionId = id;
      renderConnections(lastConnections);
    }
  });
}

/**
 * Pointer-driven tab reorder (HTML5 DnD is unreliable in WKWebView when dragging from tab children).
 * @type {{
 *   tabId: string;
 *   startX: number;
 *   startY: number;
 *   dragging: boolean;
 *   sourceWrap: HTMLElement;
 *   grabOffsetX: number;
 *   grabOffsetY: number;
 *   ghostEl: HTMLElement | null;
 *   hoverTargetId: string | null;
 * } | null}
 */
let pointerTabDrag = null;

/** After a tab drag, suppress the synthetic click that would otherwise activate the tab. */
let skipTablePreviewTabClickAfterDrag = false;

/**
 * Removes floating ghost, placeholder styling, drop highlight, and cursor override.
 */
function cleanupTablePreviewTabDragVisuals() {
  if (pointerTabDrag?.ghostEl?.parentNode) {
    pointerTabDrag.ghostEl.remove();
  }
  if (pointerTabDrag?.sourceWrap) {
    pointerTabDrag.sourceWrap.classList.remove("opacity-25", "opacity-60");
  }
  const tabsStrip = document.getElementById("table-preview-tabs");
  if (tabsStrip) {
    for (const el of tabsStrip.querySelectorAll("[data-tab-id]")) {
      el.classList.remove(
        "ring-2",
        "ring-amber-400/70",
        "ring-offset-1",
        "ring-offset-[#f3efe6]",
      );
    }
  }
  document.body.style.cursor = "";
  if (pointerTabDrag) {
    pointerTabDrag.ghostEl = null;
    pointerTabDrag.hoverTargetId = null;
  }
}

/**
 * Find which tab row is under the pointer. Skips the drag ghost (WebKit can still
 * return it from elementFromPoint even with pointer-events: none).
 * @param {number} clientX
 * @param {number} clientY
 * @param {HTMLElement | null} ghostEl
 * @param {string} sourceTabId
 * @returns {string | null}
 */
function pickTablePreviewTabDropTarget(clientX, clientY, ghostEl, sourceTabId) {
  const stack = document.elementsFromPoint(clientX, clientY);
  if (!stack?.length) return null;
  for (const node of stack) {
    if (!(node instanceof Element)) continue;
    if (ghostEl && (node === ghostEl || ghostEl.contains(node))) continue;
    const tab = node.closest("[data-tab-id]");
    if (!tab?.dataset?.tabId) continue;
    const id = tab.dataset.tabId;
    if (id !== sourceTabId) return id;
  }
  return null;
}

function syncTablePreviewPanelsOrder() {
  const panelsRoot = document.getElementById("table-preview-panels");
  if (!panelsRoot) return;
  for (const t of tablePreviewTabs) {
    panelsRoot.appendChild(t.panelEl);
  }
}

/**
 * @param {string} fromId
 * @param {string} toId
 */
function swapTablePreviewTabsById(fromId, toId) {
  if (fromId === toId) return;
  const i = tablePreviewTabs.findIndex((t) => t.id === fromId);
  const j = tablePreviewTabs.findIndex((t) => t.id === toId);
  if (i === -1 || j === -1) return;
  const tmp = tablePreviewTabs[i];
  tablePreviewTabs[i] = tablePreviewTabs[j];
  tablePreviewTabs[j] = tmp;
  syncTablePreviewPanelsOrder();
  syncTabPanelVisibility();
  renderTabStrip();
}

function renderTabStrip() {
  const tabsStrip = document.getElementById("table-preview-tabs");
  if (!tabsStrip) return;
  tabsStrip.replaceChildren();

  const TAB_DRAG_THRESHOLD_PX = 5;

  for (const tab of tablePreviewTabs) {
    const isActive = tab.id === activeTablePreviewTabId;
    const wrap = document.createElement("div");
    wrap.dataset.tabId = tab.id;
    wrap.className = isActive
      ? "flex min-w-0 max-w-[14rem] shrink-0 touch-none cursor-grab select-none items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#faf8f4] px-1 pl-1.5 py-1 text-xs text-stone-800 ring-1 ring-stone-300/40 active:cursor-grabbing"
      : "flex min-w-0 max-w-[14rem] shrink-0 touch-none cursor-grab select-none items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#f0ebe3]/90 px-1 pl-1.5 py-1 text-xs text-stone-700 active:cursor-grabbing";

    const dot = document.createElement("span");
    dot.className = "shrink-0 text-emerald-600";
    dot.setAttribute("aria-hidden", "true");
    dot.textContent = "●";

    const tabBtn = document.createElement("div");
    tabBtn.setAttribute("role", "tab");
    tabBtn.id = `table-preview-tab-${tab.id}`;
    tabBtn.tabIndex = isActive ? 0 : -1;
    tabBtn.className =
      "min-w-0 flex-1 cursor-grab truncate text-left outline-none hover:text-stone-900 active:cursor-grabbing";
    tabBtn.setAttribute("aria-controls", `table-preview-panel-${tab.id}`);
    tabBtn.setAttribute("aria-selected", isActive ? "true" : "false");
    const label = `${tab.schemaName}.${tab.tableName}`;
    tabBtn.textContent = label;
    tabBtn.setAttribute("aria-label", `Preview ${label}`);
    tabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (skipTablePreviewTabClickAfterDrag) return;
      if (activeTablePreviewTabId !== tab.id) {
        activateTablePreviewTab(tab.id);
      }
    });
    tabBtn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (activeTablePreviewTabId !== tab.id) {
        activateTablePreviewTab(tab.id);
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "shrink-0 cursor-pointer rounded px-1 text-stone-500 hover:bg-stone-200/80 hover:text-stone-800";
    closeBtn.setAttribute("aria-label", "Close tab");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTablePreviewTab(tab.id);
    });
    closeBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (closeBtn.contains(/** @type {Node} */ (e.target))) return;
      pointerTabDrag = {
        tabId: tab.id,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        sourceWrap: wrap,
        grabOffsetX: 0,
        grabOffsetY: 0,
        ghostEl: null,
        hoverTargetId: null,
      };
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!pointerTabDrag || pointerTabDrag.tabId !== tab.id) return;
      const dx = e.clientX - pointerTabDrag.startX;
      const dy = e.clientY - pointerTabDrag.startY;
      if (
        !pointerTabDrag.dragging &&
        dx * dx + dy * dy > TAB_DRAG_THRESHOLD_PX * TAB_DRAG_THRESHOLD_PX
      ) {
        pointerTabDrag.dragging = true;
        const rect = wrap.getBoundingClientRect();
        pointerTabDrag.grabOffsetX = e.clientX - rect.left;
        pointerTabDrag.grabOffsetY = e.clientY - rect.top;
        document.body.style.cursor = "grabbing";

        const ghost = /** @type {HTMLElement} */ (wrap.cloneNode(true));
        ghost.removeAttribute("data-tab-id");
        for (const el of ghost.querySelectorAll("[id]")) {
          el.removeAttribute("id");
        }
        ghost.style.position = "fixed";
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.zIndex = "10000";
        ghost.style.pointerEvents = "none";
        ghost.style.boxShadow = "0 10px 28px rgba(0, 0, 0, 0.14)";
        document.body.appendChild(ghost);
        pointerTabDrag.ghostEl = ghost;

        wrap.classList.add("opacity-25");

        try {
          wrap.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
      }

      if (pointerTabDrag.dragging && pointerTabDrag.ghostEl) {
        pointerTabDrag.ghostEl.style.left = `${e.clientX - pointerTabDrag.grabOffsetX}px`;
        pointerTabDrag.ghostEl.style.top = `${e.clientY - pointerTabDrag.grabOffsetY}px`;

        const nextHover = pickTablePreviewTabDropTarget(
          e.clientX,
          e.clientY,
          pointerTabDrag.ghostEl,
          pointerTabDrag.tabId,
        );
        if (nextHover !== pointerTabDrag.hoverTargetId) {
          const strip = document.getElementById("table-preview-tabs");
          if (strip) {
            for (const node of strip.querySelectorAll("[data-tab-id]")) {
              node.classList.remove(
                "ring-2",
                "ring-amber-400/70",
                "ring-offset-1",
                "ring-offset-[#f3efe6]",
              );
            }
            if (nextHover) {
              const mark = strip.querySelector(
                `[data-tab-id="${CSS.escape(nextHover)}"]`,
              );
              if (mark) {
                mark.classList.add(
                  "ring-2",
                  "ring-amber-400/70",
                  "ring-offset-1",
                  "ring-offset-[#f3efe6]",
                );
              }
            }
          }
          pointerTabDrag.hoverTargetId = nextHover;
        }
      }
    });
    wrap.addEventListener("pointerup", (e) => {
      if (!pointerTabDrag || pointerTabDrag.tabId !== tab.id) return;
      const wasDrag = pointerTabDrag.dragging;
      const ghost = pointerTabDrag.ghostEl;
      const hoverFallback = pointerTabDrag.hoverTargetId;
      /** @type {string | null} */
      let dropTargetId = null;
      if (wasDrag) {
        dropTargetId =
          pickTablePreviewTabDropTarget(e.clientX, e.clientY, ghost, tab.id) ??
          hoverFallback;
      }
      cleanupTablePreviewTabDragVisuals();
      pointerTabDrag = null;
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (wasDrag) {
        skipTablePreviewTabClickAfterDrag = true;
        window.setTimeout(() => {
          skipTablePreviewTabClickAfterDrag = false;
        }, 0);
        if (dropTargetId && dropTargetId !== tab.id) {
          swapTablePreviewTabsById(tab.id, dropTargetId);
        }
      }
    });
    wrap.addEventListener("pointercancel", (e) => {
      if (!pointerTabDrag || pointerTabDrag.tabId !== tab.id) return;
      cleanupTablePreviewTabDragVisuals();
      pointerTabDrag = null;
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    });

    wrap.appendChild(dot);
    wrap.appendChild(tabBtn);
    wrap.appendChild(closeBtn);
    tabsStrip.appendChild(wrap);
  }
}

function renderSqlEditorTabStrip() {
  const tabsStrip = document.getElementById("sql-editor-tabs");
  if (!tabsStrip) return;
  tabsStrip.replaceChildren();

  for (const tab of sqlQueryTabs) {
    const isActive = tab.id === activeSqlQueryTabId;
    const wrap = document.createElement("div");
    wrap.dataset.sqlTabId = tab.id;
    wrap.className = isActive
      ? "flex min-w-0 max-w-[14rem] shrink-0 select-none items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#faf8f4] px-1 pl-1.5 py-1 text-xs text-stone-800 ring-1 ring-stone-300/40"
      : "flex min-w-0 max-w-[14rem] shrink-0 select-none items-center gap-0.5 rounded-t border border-b-0 border-stone-200/90 bg-[#f0ebe3]/90 px-1 pl-1.5 py-1 text-xs text-stone-700";

    const dot = document.createElement("span");
    dot.className = "shrink-0 text-sky-600";
    dot.setAttribute("aria-hidden", "true");
    dot.textContent = "●";

    const tabBtn = document.createElement("div");
    tabBtn.setAttribute("role", "tab");
    tabBtn.id = `sql-editor-tab-${tab.id}`;
    tabBtn.tabIndex = isActive ? 0 : -1;
    tabBtn.className =
      "min-w-0 flex-1 cursor-pointer truncate text-left outline-none hover:text-stone-900";
    tabBtn.setAttribute("aria-controls", `sql-editor-panel-${tab.id}`);
    tabBtn.setAttribute("aria-selected", isActive ? "true" : "false");
    tabBtn.textContent = tab.tabLabel;
    tabBtn.setAttribute("aria-label", `Query ${tab.tabLabel}`);
    tabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeSqlQueryTabId !== tab.id) {
        activateSqlQueryTab(tab.id);
      }
    });
    tabBtn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (activeSqlQueryTabId !== tab.id) {
        activateSqlQueryTab(tab.id);
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "shrink-0 cursor-pointer rounded px-1 text-stone-500 hover:bg-stone-200/80 hover:text-stone-800";
    closeBtn.setAttribute("aria-label", "Close tab");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSqlQueryTab(tab.id);
    });
    closeBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    wrap.appendChild(dot);
    wrap.appendChild(tabBtn);
    wrap.appendChild(closeBtn);
    tabsStrip.appendChild(wrap);
  }

  renderSqlConnectionRow();
}

/**
 * @param {string} tabId
 */
function activateSqlQueryTab(tabId) {
  if (!sqlQueryTabs.some((t) => t.id === tabId)) return;
  activeSqlQueryTabId = tabId;
  syncSqlQueryPanelVisibility();
  renderSqlEditorTabStrip();
  const t = sqlQueryTabs.find((x) => x.id === tabId);
  if (t) {
    window.requestAnimationFrame(() => {
      t.textareaEl.focus();
    });
  }
}

/**
 * @param {string} tabId
 */
function closeSqlQueryTab(tabId) {
  const idx = sqlQueryTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const wasActive = activeSqlQueryTabId === tabId;
  const tab = sqlQueryTabs[idx];
  tab.panelEl.remove();

  sqlQueryTabs.splice(idx, 1);

  if (sqlQueryTabs.length === 0) {
    activeSqlQueryTabId = null;
    updateSqlEditorAreaVisibility();
    renderSqlEditorTabStrip();
    return;
  }

  if (wasActive) {
    const nextIdx = idx < sqlQueryTabs.length ? idx : idx - 1;
    const nextTab = sqlQueryTabs[nextIdx];
    if (nextTab) {
      activeSqlQueryTabId = nextTab.id;
    }
  }

  syncSqlQueryPanelVisibility();
  updateSqlEditorAreaVisibility();
  renderSqlEditorTabStrip();
  if (wasActive && activeSqlQueryTabId) {
    const nt = sqlQueryTabs.find((x) => x.id === activeSqlQueryTabId);
    if (nt) {
      window.requestAnimationFrame(() => {
        nt.textareaEl.focus();
      });
    }
  }
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {{ tabLabel: string; initialSql: string }} opts
 */
function openNewSqlQueryTab(profile, opts) {
  const tabId = `sqlq-${nextSqlQueryTabSeq++}`;
  const { panelEl, textareaEl, runBtn, formatBtn, resultMetaEl, resultBodyEl } =
    createSqlQueryPanelElements(tabId);

  const panelsRoot = document.getElementById("sql-editor-panels");
  if (!panelsRoot) return;
  panelsRoot.appendChild(panelEl);

  textareaEl.value = opts.initialSql;

  /** @type {SqlQueryTab} */
  const tab = {
    id: tabId,
    connectionId: profile.id,
    tabLabel: opts.tabLabel,
    panelEl,
    textareaEl,
    runBtn,
    formatBtn,
    resultMetaEl,
    resultBodyEl,
  };
  sqlQueryTabs.push(tab);
  activeSqlQueryTabId = tabId;

  updateSqlEditorAreaVisibility();
  syncSqlQueryPanelVisibility();
  renderSqlEditorTabStrip();
  window.requestAnimationFrame(() => {
    textareaEl.focus();
    const len = textareaEl.value.length;
    textareaEl.setSelectionRange(len, len);
  });
}

/**
 * @param {string} connectionId
 */
function removeSqlQueryTabsForConnection(connectionId) {
  const toRemove = sqlQueryTabs.filter((t) => t.connectionId === connectionId);
  if (toRemove.length === 0) return;

  for (const t of toRemove) {
    t.panelEl.remove();
  }
  sqlQueryTabs = sqlQueryTabs.filter((t) => t.connectionId !== connectionId);

  if (sqlQueryTabs.length === 0) {
    activeSqlQueryTabId = null;
    const tabsStrip = document.getElementById("sql-editor-tabs");
    if (tabsStrip) tabsStrip.replaceChildren();
    updateSqlEditorAreaVisibility();
    return;
  }

  if (
    !activeSqlQueryTabId ||
    !sqlQueryTabs.some((t) => t.id === activeSqlQueryTabId)
  ) {
    const last = sqlQueryTabs[sqlQueryTabs.length - 1];
    activeSqlQueryTabId = last.id;
  }

  updateSqlEditorAreaVisibility();
  syncSqlQueryPanelVisibility();
  renderSqlEditorTabStrip();
}

/**
 * Resolves which connection profile to use for a new SQL tab from the toolbar.
 * @returns {import("./appConfig.js").ConnectionProfile | null}
 */
function getProfileForNewQueryFromToolbar() {
  if (selectedConnectionId && openConnectionIds.has(selectedConnectionId)) {
    const p = lastConnections.find((c) => c.id === selectedConnectionId);
    if (p) return p;
  }
  for (const c of lastConnections) {
    if (openConnectionIds.has(c.id)) return c;
  }
  return null;
}

/**
 * Opens an empty SQL tab for a saved connection (used by toolbar and connection context menu).
 * @param {string} connectionId
 */
function openEmptySqlQueryForConnection(connectionId) {
  const profile = lastConnections.find((c) => c.id === connectionId);
  if (!profile) return;
  if (!openConnectionIds.has(connectionId)) {
    setStatusMessage("Open the data source first.");
    return;
  }
  openNewSqlQueryTab(profile, {
    tabLabel: `Query ${nextSqlQueryTabSeq}`,
    initialSql: "",
  });
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
  const toRemove = tablePreviewTabs.filter(
    (t) => t.connectionId === connectionId,
  );
  if (toRemove.length > 0) {
    for (const t of toRemove) {
      t.panelEl.remove();
    }
    tablePreviewTabs = tablePreviewTabs.filter(
      (t) => t.connectionId !== connectionId,
    );
  }

  removeSqlQueryTabsForConnection(connectionId);

  if (tablePreviewTabs.length === 0) {
    activeTablePreviewTabId = null;
    selectedTablePreviewKey = null;
    const tabsStrip = document.getElementById("table-preview-tabs");
    if (tabsStrip) tabsStrip.replaceChildren();
    const area = document.getElementById("table-preview-area");
    if (area) area.classList.add("hidden");
    return;
  }

  if (
    !activeTablePreviewTabId ||
    !tablePreviewTabs.some((t) => t.id === activeTablePreviewTabId)
  ) {
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
 * After removing tabs in bulk, keep `keepId` active if the previous active tab was closed.
 * @param {string} keepId
 */
function finalizeActiveAfterBulkClose(keepId) {
  if (tablePreviewTabs.length === 0) {
    activeTablePreviewTabId = null;
    selectedTablePreviewKey = null;
    renderTablePreviewPlaceholder();
    renderConnections(lastConnections);
    return;
  }
  if (
    !activeTablePreviewTabId ||
    !tablePreviewTabs.some((t) => t.id === activeTablePreviewTabId)
  ) {
    activeTablePreviewTabId = keepId;
    const t = tablePreviewTabs.find((x) => x.id === keepId);
    selectedTablePreviewKey = t?.previewKey ?? null;
  } else {
    const t = tablePreviewTabs.find((x) => x.id === activeTablePreviewTabId);
    selectedTablePreviewKey = t?.previewKey ?? null;
  }
  const area = document.getElementById("table-preview-area");
  if (area) area.classList.remove("hidden");
  syncTabPanelVisibility();
  renderTabStrip();
  renderConnections(lastConnections);
}

/**
 * @param {string} tabId
 */
function closeTablePreviewTabsToLeftOf(tabId) {
  const idx = tablePreviewTabs.findIndex((t) => t.id === tabId);
  if (idx <= 0) return;

  const toRemove = tablePreviewTabs.slice(0, idx);
  for (const t of toRemove) {
    t.panelEl.remove();
  }
  tablePreviewTabs = tablePreviewTabs.slice(idx);
  finalizeActiveAfterBulkClose(tabId);
}

/**
 * @param {string} tabId
 */
function closeTablePreviewTabsToRightOf(tabId) {
  const idx = tablePreviewTabs.findIndex((t) => t.id === tabId);
  if (idx === -1 || idx >= tablePreviewTabs.length - 1) return;

  const toRemove = tablePreviewTabs.slice(idx + 1);
  for (const t of toRemove) {
    t.panelEl.remove();
  }
  tablePreviewTabs = tablePreviewTabs.slice(0, idx + 1);
  finalizeActiveAfterBulkClose(tabId);
}

function closeAllTablePreviewTabs() {
  renderTablePreviewPlaceholder();
  renderConnections(lastConnections);
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
function renderTablePreviewLoading(
  headingEl,
  metaEl,
  bodyEl,
  schemaName,
  tableName,
) {
  const label = `${schemaName}.${tableName}`;
  if (headingEl) headingEl.textContent = label;
  if (metaEl) metaEl.textContent = "Loading…";
  if (bodyEl) {
    bodyEl.className =
      "min-h-0 flex-1 overflow-auto p-3 text-sm text-stone-500 select-text";
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
 * @param {unknown} value
 * @returns {{ type: "null" } | { type: "text"; text: string }}
 */
function formatSqlResultCell(value) {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "object") {
    return { type: "text", text: JSON.stringify(value) };
  }
  return { type: "text", text: String(value) };
}

/**
 * @param {HTMLElement} container
 * @param {string[]} columns
 * @param {unknown[][]} rows
 */
function renderSqlRowsTable(container, columns, rows) {
  const table = document.createElement("table");
  table.className =
    "min-w-full w-max border-collapse text-left text-xs text-stone-800";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const col of columns) {
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
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-stone-100/90";
    for (let c = 0; c < columns.length; c++) {
      const td = document.createElement("td");
      td.className =
        "max-w-[24rem] whitespace-pre-wrap break-words px-2 py-1.5 align-top";
      const cell = formatSqlResultCell(row[c]);
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
  container.appendChild(table);
}

/**
 * @param {HTMLElement} bodyEl
 * @param {HTMLElement | null} metaEl
 * @param {string} message
 */
function renderSqlExecutionError(bodyEl, metaEl, message) {
  if (metaEl) metaEl.textContent = "";
  if (!bodyEl) return;
  bodyEl.className = "min-h-0 flex-1 overflow-auto p-3 text-xs select-text";
  bodyEl.replaceChildren();
  const p = document.createElement("p");
  p.className = "text-red-600 whitespace-pre-wrap";
  p.textContent = message;
  bodyEl.appendChild(p);
}

/**
 * @param {HTMLElement} bodyEl
 * @param {HTMLElement | null} metaEl
 * @param {{
 *   statements: Array<
 *     | { kind: "rows"; columns: string[]; rows: unknown[][] }
 *     | { kind: "command"; rowsAffected: number }
 *   >;
 * }} data
 */
function renderSqlExecutionResult(bodyEl, metaEl, data) {
  const n = data.statements.length;
  if (metaEl) {
    metaEl.textContent =
      n === 1 ? "1 statement completed" : `${n} statements completed`;
  }
  if (!bodyEl) return;
  bodyEl.className = "min-h-0 flex-1 overflow-auto p-3 text-xs select-text";
  bodyEl.replaceChildren();

  let idx = 0;
  for (const st of data.statements) {
    idx += 1;
    const sec = document.createElement("div");
    sec.className = idx > 1 ? "mt-6 border-t border-stone-200/80 pt-4" : "";

    if (st.kind === "command") {
      const p = document.createElement("p");
      p.className = "font-mono text-stone-700";
      p.textContent = `Statement ${idx}: ${st.rowsAffected} row(s) affected.`;
      sec.appendChild(p);
    } else {
      const h = document.createElement("div");
      h.className = "mb-2 text-stone-500";
      h.textContent = `Statement ${idx}: ${st.rows.length} row(s)`;
      sec.appendChild(h);
      renderSqlRowsTable(sec, st.columns, st.rows);
    }
    bodyEl.appendChild(sec);
  }
}

/**
 * If the user has a non-collapsed selection, returns that range (trimmed); otherwise the full editor text (trimmed).
 * @param {HTMLTextAreaElement} el
 * @returns {string}
 */
function getSqlToRunFromEditor(el) {
  const { selectionStart, selectionEnd, value } = el;
  if (selectionStart !== selectionEnd) {
    return value.slice(selectionStart, selectionEnd).trim();
  }
  return value.trim();
}

/**
 * Text to format: selection if non-empty, otherwise the whole editor (same idea as Run).
 * @param {HTMLTextAreaElement} el
 * @returns {{ mode: 'selection' | 'all'; start: number; end: number; text: string }}
 */
function getSqlSegmentToFormat(el) {
  const { selectionStart, selectionEnd, value } = el;
  if (selectionStart !== selectionEnd) {
    return {
      mode: "selection",
      start: selectionStart,
      end: selectionEnd,
      text: value.slice(selectionStart, selectionEnd),
    };
  }
  return {
    mode: "all",
    start: 0,
    end: value.length,
    text: value,
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatSqlFormatError(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return "Could not format SQL.";
}

/**
 * @param {string} tabId
 */
async function formatSqlForTab(tabId) {
  const tab = sqlQueryTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const el = tab.textareaEl;
  const seg = getSqlSegmentToFormat(el);
  if (!seg.text.trim()) {
    setStatusMessage("Nothing to format.");
    return;
  }
  tab.formatBtn.disabled = true;
  tab.formatBtn.setAttribute("aria-busy", "true");
  setStatusMessage("Formatting SQL…");
  try {
    const formatted = await formatSql(seg.text);
    if (seg.mode === "selection") {
      const before = el.value.slice(0, seg.start);
      const after = el.value.slice(seg.end);
      el.value = before + formatted + after;
      const pos = seg.start + formatted.length;
      el.setSelectionRange(pos, pos);
    } else {
      el.value = formatted;
      const pos = formatted.length;
      el.setSelectionRange(pos, pos);
    }
    setStatusMessage("Ready");
  } catch (e) {
    setStatusMessage(formatSqlFormatError(e));
  } finally {
    const still = sqlQueryTabs.find((t) => t.id === tabId);
    if (still) {
      still.formatBtn.disabled = false;
      still.formatBtn.removeAttribute("aria-busy");
    }
  }
}

/**
 * @param {string} tabId
 */
async function runSqlQueryForTab(tabId) {
  const tab = sqlQueryTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const profile = lastConnections.find((c) => c.id === tab.connectionId);
  if (!profile) {
    setStatusMessage("Connection not found.");
    return;
  }
  if (!openConnectionIds.has(tab.connectionId)) {
    setStatusMessage("Open the data source first.");
    return;
  }
  const sql = getSqlToRunFromEditor(tab.textareaEl);
  if (!sql) {
    setStatusMessage("Enter SQL to run.");
    return;
  }
  if (shouldPromptForSessionPassword(profile)) {
    const pw = await waitForSessionPassword(profile);
    if (pw === null) return;
    setSessionPassword(profile.id, pw);
  }

  tab.runBtn.disabled = true;
  tab.runBtn.setAttribute("aria-busy", "true");
  tab.resultMetaEl.textContent = "Running…";
  tab.resultBodyEl.replaceChildren();
  tab.resultBodyEl.appendChild(document.createTextNode("Running…"));
  setStatusMessage("Running SQL…");

  try {
    const result = await executePgSql(profile, sql);
    pruneCacheForConnection(profile.id);
    const still = sqlQueryTabs.find((t) => t.id === tabId);
    if (!still) return;
    renderSqlExecutionResult(still.resultBodyEl, still.resultMetaEl, result);
    setStatusMessage("Ready");
  } catch (e) {
    const still = sqlQueryTabs.find((t) => t.id === tabId);
    if (!still) return;
    const parsed = parsePgExecutionError(e);
    const msg = parsed
      ? formatPgExecutionErrorMessage(parsed)
      : formatConnectionFailureMessage(e);
    renderSqlExecutionError(still.resultBodyEl, still.resultMetaEl, msg);
    setStatusMessage(msg);
  } finally {
    const still = sqlQueryTabs.find((t) => t.id === tabId);
    if (still) {
      still.runBtn.disabled = false;
      still.runBtn.removeAttribute("aria-busy");
    }
  }
}

/**
 * @param {HTMLElement} bodyEl
 * @param {HTMLElement} metaEl
 * @param {{ columns: string[]; rows: unknown[]; metadata?: TablePreviewMetadata }} data
 * @param {string} previewTabId
 */
function renderTablePreviewTable(bodyEl, metaEl, data, previewTabId) {
  const metadata = data.metadata ?? emptyTablePreviewMetadata();
  if (metaEl) {
    metaEl.textContent = `${data.rows.length} rows (limit ${TABLE_PREVIEW_DEFAULT_LIMIT})`;
  }
  if (!bodyEl) return;

  bodyEl.className =
    "flex min-h-0 flex-1 flex-col overflow-hidden p-0 select-text";
  bodyEl.replaceChildren();

  const ids = {
    dataTab: `table-preview-${previewTabId}-subtab-data`,
    metaTab: `table-preview-${previewTabId}-subtab-metadata`,
    statsTab: `table-preview-${previewTabId}-subtab-statistics`,
    dataPanel: `table-preview-${previewTabId}-subpanel-data`,
    metaPanel: `table-preview-${previewTabId}-subpanel-metadata`,
    statsPanel: `table-preview-${previewTabId}-subpanel-statistics`,
  };

  const tabBar = document.createElement("div");
  tabBar.setAttribute("role", "tablist");
  tabBar.setAttribute("aria-label", "Table preview view");
  tabBar.className =
    "flex shrink-0 gap-0.5 border-b border-stone-200/90 bg-[#fffcf7]/90 px-2 pt-1";

  const tabActiveClass =
    "cursor-pointer shrink-0 rounded-t border border-b-0 border-stone-200/90 bg-[#fffcf7] px-2.5 py-1 text-xs font-medium text-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-stone-400/60";
  const tabInactiveClass =
    "cursor-pointer shrink-0 rounded-t border border-b-0 border-transparent px-2.5 py-1 text-xs font-medium text-stone-500 outline-none hover:bg-stone-200/50 hover:text-stone-800 focus-visible:ring-2 focus-visible:ring-stone-400/60";

  const dataTabBtn = document.createElement("button");
  dataTabBtn.type = "button";
  dataTabBtn.id = ids.dataTab;
  dataTabBtn.setAttribute("role", "tab");
  dataTabBtn.setAttribute("aria-selected", "true");
  dataTabBtn.setAttribute("aria-controls", ids.dataPanel);
  dataTabBtn.textContent = "Data";
  dataTabBtn.className = tabActiveClass;
  dataTabBtn.title = "Table rows";

  const metaTabBtn = document.createElement("button");
  metaTabBtn.type = "button";
  metaTabBtn.id = ids.metaTab;
  metaTabBtn.setAttribute("role", "tab");
  metaTabBtn.setAttribute("aria-selected", "false");
  metaTabBtn.setAttribute("aria-controls", ids.metaPanel);
  metaTabBtn.textContent = "Metadata";
  metaTabBtn.className = tabInactiveClass;
  metaTabBtn.title =
    "Primary key, foreign keys, unique constraints, indexes";

  const statsTabBtn = document.createElement("button");
  statsTabBtn.type = "button";
  statsTabBtn.id = ids.statsTab;
  statsTabBtn.setAttribute("role", "tab");
  statsTabBtn.setAttribute("aria-selected", "false");
  statsTabBtn.setAttribute("aria-controls", ids.statsPanel);
  statsTabBtn.textContent = "Statistics";
  statsTabBtn.className = tabInactiveClass;
  statsTabBtn.title =
    "Sizes, planner estimate, activity, vacuum and analyze history";

  tabBar.appendChild(dataTabBtn);
  tabBar.appendChild(metaTabBtn);
  tabBar.appendChild(statsTabBtn);

  const contentWrap = document.createElement("div");
  contentWrap.className = "flex min-h-0 flex-1 flex-col overflow-hidden";

  /** Tailwind `flex` overrides the HTML `hidden` attribute’s display; use `hidden` class to toggle. */
  const panelVisibleClass = "flex min-h-0 flex-1 flex-col overflow-hidden";
  const panelHiddenClass = "hidden";

  const dataPanel = document.createElement("div");
  dataPanel.id = ids.dataPanel;
  dataPanel.setAttribute("role", "tabpanel");
  dataPanel.setAttribute("aria-labelledby", ids.dataTab);
  dataPanel.className = panelVisibleClass;

  const metaPanel = document.createElement("div");
  metaPanel.id = ids.metaPanel;
  metaPanel.setAttribute("role", "tabpanel");
  metaPanel.setAttribute("aria-labelledby", ids.metaTab);
  metaPanel.className = panelHiddenClass;
  metaPanel.setAttribute("aria-hidden", "true");

  const statsPanel = document.createElement("div");
  statsPanel.id = ids.statsPanel;
  statsPanel.setAttribute("role", "tabpanel");
  statsPanel.setAttribute("aria-labelledby", ids.statsTab);
  statsPanel.className = panelHiddenClass;
  statsPanel.setAttribute("aria-hidden", "true");

  /**
   * @param {"data" | "metadata" | "statistics"} which
   */
  function applySubTab(which) {
    dataTabBtn.setAttribute(
      "aria-selected",
      which === "data" ? "true" : "false",
    );
    metaTabBtn.setAttribute(
      "aria-selected",
      which === "metadata" ? "true" : "false",
    );
    statsTabBtn.setAttribute(
      "aria-selected",
      which === "statistics" ? "true" : "false",
    );
    dataTabBtn.className =
      which === "data" ? tabActiveClass : tabInactiveClass;
    metaTabBtn.className =
      which === "metadata" ? tabActiveClass : tabInactiveClass;
    statsTabBtn.className =
      which === "statistics" ? tabActiveClass : tabInactiveClass;
    dataPanel.className =
      which === "data" ? panelVisibleClass : panelHiddenClass;
    metaPanel.className =
      which === "metadata" ? panelVisibleClass : panelHiddenClass;
    statsPanel.className =
      which === "statistics" ? panelVisibleClass : panelHiddenClass;
    dataPanel.setAttribute(
      "aria-hidden",
      which === "data" ? "false" : "true",
    );
    metaPanel.setAttribute(
      "aria-hidden",
      which === "metadata" ? "false" : "true",
    );
    statsPanel.setAttribute(
      "aria-hidden",
      which === "statistics" ? "false" : "true",
    );
  }

  dataTabBtn.addEventListener("click", () => applySubTab("data"));
  metaTabBtn.addEventListener("click", () => applySubTab("metadata"));
  statsTabBtn.addEventListener("click", () => applySubTab("statistics"));
  dataTabBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      applySubTab("metadata");
      metaTabBtn.focus();
    }
  });
  metaTabBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applySubTab("data");
      dataTabBtn.focus();
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      applySubTab("statistics");
      statsTabBtn.focus();
    }
  });
  statsTabBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applySubTab("metadata");
      metaTabBtn.focus();
    }
  });

  const tableScroll = document.createElement("div");
  tableScroll.className = "min-h-0 flex-1 overflow-auto";
  dataPanel.appendChild(tableScroll);

  const metaSection = document.createElement("div");
  renderTablePreviewMetadataSection(metadata, metaSection);
  metaPanel.appendChild(metaSection);

  const statsSection = document.createElement("div");
  renderTablePreviewStatisticsSection(metadata.statistics, statsSection);
  statsPanel.appendChild(statsSection);

  const table = document.createElement("table");
  table.className =
    "min-w-full w-max border-collapse text-left text-xs text-stone-800";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const badgeClass = {
    PK: "rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] text-amber-900",
    FK: "rounded bg-sky-100 px-1 py-0.5 font-mono text-[10px] text-sky-900",
    UK: "rounded bg-violet-100 px-1 py-0.5 font-mono text-[10px] text-violet-900",
  };
  const tagTitles = {
    PK: "Primary key column",
    FK: "Foreign key column",
    UK: "Unique constraint column",
  };
  for (const col of data.columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className =
      "sticky top-0 border-b border-stone-200/90 bg-[#fffcf7] px-2 py-2 align-top font-medium text-stone-700";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = col;
    th.appendChild(nameSpan);
    const tags = columnTagsForTablePreview(metadata, col);
    if (tags.length > 0) {
      const badgeRow = document.createElement("span");
      badgeRow.className = "mt-1 flex flex-wrap gap-0.5";
      for (const tag of tags) {
        const b = document.createElement("span");
        b.className = badgeClass[tag];
        b.textContent = tag;
        b.title = tagTitles[tag];
        badgeRow.appendChild(b);
      }
      th.appendChild(badgeRow);
    }
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
      td.className =
        "max-w-[24rem] whitespace-pre-wrap break-words px-2 py-1.5 align-top";
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
  tableScroll.appendChild(table);

  bodyEl.appendChild(tabBar);
  bodyEl.appendChild(contentWrap);
  contentWrap.appendChild(dataPanel);
  contentWrap.appendChild(metaPanel);
  contentWrap.appendChild(statsPanel);
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
  renderTablePreviewLoading(
    tab.headingEl,
    tab.metaEl,
    tab.bodyEl,
    schemaName,
    tableName,
  );
  setStatusMessage("Loading…");
  try {
    const data = await fetchTablePreview(profile, schemaName, tableName, {
      limit: TABLE_PREVIEW_DEFAULT_LIMIT,
    });
    const still = tablePreviewTabs.find((t) => t.id === tabId);
    if (!still) return;
    renderTablePreviewTable(still.bodyEl, still.metaEl, data, still.id);
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
 * @param {string} objectName
 * @param {"tables"|"views"|"materialized_views"} relationKind
 */
function createPreviewableRelationLeafRow(
  profile,
  schemaName,
  objectName,
  relationKind,
) {
  const key = tablePreviewKey(profile.id, schemaName, objectName);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "w-full rounded px-1 py-0.5 pl-6 text-left font-mono text-xs text-stone-600 hover:bg-stone-200/80";
  if (selectedTablePreviewKey === key) {
    btn.classList.add("bg-stone-200/80", "ring-1", "ring-stone-300/40");
  }
  btn.textContent = objectName;
  btn.setAttribute("data-preview-rel-leaf", "true");
  btn.dataset.connectionId = profile.id;
  btn.dataset.schemaName = schemaName;
  btn.dataset.tableName = objectName;
  btn.dataset.relationKind = relationKind;
  const ui = previewableRelationKindUi(relationKind);
  btn.title = ui.openHint;
  btn.setAttribute(
    "aria-label",
    `${ui.ariaPreview} ${schemaName}.${objectName}`,
  );
  const openPreview = () => {
    openNewTableTab(profile, schemaName, objectName);
  };
  btn.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openPreview();
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      openPreview();
    }
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

  const databasePath = `${prefix}database`;
  const databaseOpen = expandedTreePaths.has(databasePath);
  const liDb = document.createElement("li");
  liDb.appendChild(
    createTreeRow(
      profile.database,
      databaseOpen,
      true,
      () => void toggleTreePath(databasePath, profile),
    ),
  );
  if (databaseOpen) {
    const ulDb = document.createElement("ul");
    ulDb.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    ulDb.setAttribute("aria-label", "Database");
    if (loadingPaths.has(databasePath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
      li.textContent = "Loading…";
      ulDb.appendChild(li);
    } else if (errorsByPath.has(databasePath)) {
      const li = document.createElement("li");
      li.className = "rounded px-1 py-0.5 pl-6 text-xs text-red-600";
      li.textContent = errorsByPath.get(databasePath) ?? "";
      ulDb.appendChild(li);
    } else {
      const names = getCachedUserSchemas(id);
      if (names === undefined) {
        ensureExpandedPathMissingData(databasePath, profile);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no schemas)";
        ulDb.appendChild(li);
        scheduleSilentStaleRefreshIfNeeded(databasePath, profile);
      } else {
        for (const schemaName of names) {
          appendSchemaSubtree(ulDb, profile, schemaName, false);
        }
        scheduleSilentStaleRefreshIfNeeded(databasePath, profile);
      }
    }

    const systemPath = `${prefix}system`;
    const systemOpen = expandedTreePaths.has(systemPath);
    const liSys = document.createElement("li");
    liSys.appendChild(
      createTreeRow(
        "System schemas",
        systemOpen,
        true,
        () => void toggleTreePath(systemPath, profile),
      ),
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
        const sysNames = getCachedSystemSchemas(id);
        if (sysNames === undefined) {
          ensureExpandedPathMissingData(systemPath, profile);
        } else if (sysNames.length === 0) {
          const li = document.createElement("li");
          li.className =
            "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
          li.textContent = "(no items)";
          ul.appendChild(li);
          scheduleSilentStaleRefreshIfNeeded(systemPath, profile);
        } else {
          for (const schemaName of sysNames) {
            appendSchemaSubtree(ul, profile, schemaName, true);
          }
          scheduleSilentStaleRefreshIfNeeded(systemPath, profile);
        }
      }
      liSys.appendChild(ul);
    }
    ulDb.appendChild(liSys);

    const extPath = `${prefix}extensions`;
    const extOpen = expandedTreePaths.has(extPath);
    const liExt = document.createElement("li");
    liExt.appendChild(
      createTreeRow(
        "Extensions",
        extOpen,
        true,
        () => void toggleTreePath(extPath, profile),
      ),
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
        const extNames = getCachedExtensions(id);
        if (extNames === undefined) {
          ensureExpandedPathMissingData(extPath, profile);
        } else if (extNames.length === 0) {
          const li = document.createElement("li");
          li.className =
            "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
          li.textContent = "(no items)";
          ul.appendChild(li);
          scheduleSilentStaleRefreshIfNeeded(extPath, profile);
        } else {
          for (const name of extNames) {
            const li = document.createElement("li");
            li.appendChild(createLeafRow(name));
            ul.appendChild(li);
          }
          scheduleSilentStaleRefreshIfNeeded(extPath, profile);
        }
      }
      liExt.appendChild(ul);
    }
    ulDb.appendChild(liExt);

    liDb.appendChild(ulDb);
  }
  parentUl.appendChild(liDb);
}

/**
 * Rebuilds only the database object tree for one connection (avoids full `#connections-list` rebuild).
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @returns {boolean}
 */
function refreshConnectionObjectTree(profile) {
  const list = document.getElementById("connections-list");
  if (!list) return false;
  const li = list.querySelector(
    `li[data-connection-id="${CSS.escape(profile.id)}"]`,
  );
  if (!li) return false;
  if (!openConnectionIds.has(profile.id)) return false;
  if (objectTreeCollapsedByConnectionId.has(profile.id)) return false;
  const existing = li.querySelector('ul[aria-label="Database objects"]');
  const nested = document.createElement("ul");
  nested.className =
    "mt-0.5 ml-2 border-l border-stone-200/80 pl-2 [content-visibility:auto]";
  nested.setAttribute("aria-label", "Database objects");
  renderDbTreeInto(nested, profile);
  if (existing) existing.replaceWith(nested);
  else li.appendChild(nested);
  return true;
}

/**
 * @param {import("./appConfig.js").ConnectionProfile} profile
 */
function renderAfterTreeToggle(profile) {
  if (!refreshConnectionObjectTree(profile)) {
    renderConnections(lastConnections);
  }
}

/**
 * @param {HTMLUListElement} ulN
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} key
 * @param {string[]} objs
 * @param {number} start
 * @param {number} end
 */
function appendRelationLeafRange(
  ulN,
  profile,
  schemaName,
  key,
  objs,
  start,
  end,
) {
  for (let i = start; i < end; i++) {
    const n = objs[i];
    const liN = document.createElement("li");
    if (PREVIEWABLE_REL_KINDS.has(key)) {
      liN.appendChild(
        createPreviewableRelationLeafRow(
          profile,
          schemaName,
          n,
          /** @type {"tables"|"views"|"materialized_views"} */ (key),
        ),
      );
    } else {
      liN.appendChild(createLeafRow(n));
    }
    ulN.appendChild(liN);
  }
}

/**
 * @param {HTMLUListElement} ulN
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} key
 * @param {string[]} objs
 * @param {string} relationPath
 */
function fillRelationObjectListContinuation(
  ulN,
  profile,
  schemaName,
  key,
  objs,
  relationPath,
) {
  const total = objs.length;
  const firstEnd = Math.min(RELATION_LEAF_SYNC_FIRST, total);
  appendRelationLeafRange(ulN, profile, schemaName, key, objs, 0, firstEnd);
  let i = firstEnd;
  if (i >= total) {
    scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
    return;
  }
  const step = () => {
    const end = Math.min(i + RELATION_LEAF_RAF_CHUNK, total);
    appendRelationLeafRange(ulN, profile, schemaName, key, objs, i, end);
    i = end;
    if (i < total) requestAnimationFrame(step);
    else scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
  };
  requestAnimationFrame(step);
}

/**
 * @param {HTMLUListElement} ulN
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} key
 * @param {string[]} objs
 * @param {number} initial
 * @param {string} relationPath
 */
function appendShowMoreRelationRow(
  ulN,
  profile,
  schemaName,
  key,
  objs,
  initial,
  relationPath,
) {
  const remaining = objs.length - initial;
  const liBtn = document.createElement("li");
  liBtn.className = "rounded px-1 py-0.5 pl-2";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "rounded border border-stone-200/90 bg-[#f3efe6] px-2 py-0.5 text-xs text-stone-700 hover:bg-stone-200/80";
  btn.textContent = `Show more (${remaining} remaining)`;
  btn.setAttribute("aria-label", `Show ${remaining} more objects`);
  btn.addEventListener("click", () => {
    liBtn.remove();
    fillRelationObjectListContinuation(
      ulN,
      profile,
      schemaName,
      key,
      objs.slice(initial),
      relationPath,
    );
  });
  liBtn.appendChild(btn);
  ulN.appendChild(liBtn);
  scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
}

/**
 * @param {HTMLUListElement} ulN
 * @param {import("./appConfig.js").ConnectionProfile} profile
 * @param {string} schemaName
 * @param {string} key
 * @param {string[]} objs
 * @param {string} relationPath
 */
function fillRelationObjectList(
  ulN,
  profile,
  schemaName,
  key,
  objs,
  relationPath,
) {
  if (objs.length === 0) {
    const liL = document.createElement("li");
    liL.className =
      "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
    liL.textContent = "(no items)";
    ulN.appendChild(liL);
    scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
    return;
  }

  if (objs.length <= RELATION_LIST_SHOW_MORE_TOTAL) {
    const total = objs.length;
    const firstEnd = Math.min(RELATION_LEAF_SYNC_FIRST, total);
    appendRelationLeafRange(ulN, profile, schemaName, key, objs, 0, firstEnd);
    let i = firstEnd;
    if (i >= total) {
      scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
      return;
    }
    const step = () => {
      const end = Math.min(i + RELATION_LEAF_RAF_CHUNK, total);
      appendRelationLeafRange(ulN, profile, schemaName, key, objs, i, end);
      i = end;
      if (i < total) requestAnimationFrame(step);
      else scheduleSilentStaleRefreshIfNeeded(relationPath, profile);
    };
    requestAnimationFrame(step);
    return;
  }

  const initial = RELATION_SHOW_MORE_INITIAL_VISIBLE;
  const firstEnd = Math.min(RELATION_LEAF_SYNC_FIRST, initial);
  appendRelationLeafRange(ulN, profile, schemaName, key, objs, 0, firstEnd);
  let i = firstEnd;
  if (i >= initial) {
    appendShowMoreRelationRow(
      ulN,
      profile,
      schemaName,
      key,
      objs,
      initial,
      relationPath,
    );
    return;
  }
  const stepToInitial = () => {
    const end = Math.min(i + RELATION_LEAF_RAF_CHUNK, initial);
    appendRelationLeafRange(ulN, profile, schemaName, key, objs, i, end);
    i = end;
    if (i < initial) requestAnimationFrame(stepToInitial);
    else {
      appendShowMoreRelationRow(
        ulN,
        profile,
        schemaName,
        key,
        objs,
        initial,
        relationPath,
      );
    }
  };
  requestAnimationFrame(stepToInitial);
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
    createTreeRow(
      schemaName,
      open,
      true,
      () => void toggleTreePath(basePath, profile),
    ),
  );
  if (open) {
    const ulG = document.createElement("ul");
    ulG.className = "mt-0.5 border-l border-stone-200/80 pl-2";
    for (const { key, label } of KIND_GROUPS) {
      const p = `${basePath}::${key}`;
      const gOpen = expandedTreePaths.has(p);
      const liG = document.createElement("li");
      const relList = getCachedRelations(id, schemaName, key);
      const relCount = relList === undefined ? undefined : relList.length;
      liG.appendChild(
        createTreeRowWithRelationCount(
          label,
          relCount,
          gOpen,
          true,
          () => void toggleTreePath(p, profile),
        ),
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
            liL.className =
              "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
            liL.textContent = "(no items)";
            ulN.appendChild(liL);
            scheduleSilentStaleRefreshIfNeeded(p, profile);
          } else {
            fillRelationObjectList(ulN, profile, schemaName, key, objs, p);
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
      schemaNames.flatMap((schemaName) =>
        KIND_GROUPS.map(({ key }) =>
          fetchRelationObjects(profile, schemaName, key),
        ),
      ),
    );
  } catch (e) {
    setStatusMessage(formatConnectionFailureMessage(e));
    clearSessionPassword(id);
    return;
  }

  expandedTreePaths.add(`${id}::database`);

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

async function toggleSidebarPersisted() {
  const next = await updateAppConfig((c) => {
    c.ui.sidebarOpen = !c.ui.sidebarOpen;
  });
  setSidebarOpen(next.ui.sidebarOpen);
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
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function isKeyboardEventFromEditableTarget(e) {
  const el = eventTargetElement(e);
  if (!el) return false;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  ) {
    return true;
  }
  return Boolean(
    el.closest("input, textarea, select, [contenteditable='true']"),
  );
}

/**
 * @returns {boolean}
 */
function hasExplorerExpandTargets() {
  for (const c of lastConnections) {
    if (
      openConnectionIds.has(c.id) &&
      !objectTreeCollapsedByConnectionId.has(c.id)
    ) {
      return true;
    }
  }
  return false;
}

function syncExplorerTreeActionButtons() {
  const expandBtn = document.getElementById("explorer-expand-all-btn");
  const collapseBtn = document.getElementById("explorer-collapse-all-btn");
  const noConnections = lastConnections.length === 0;
  const canExpand =
    !noConnections &&
    hasExplorerExpandTargets() &&
    !explorerExpandAllInFlight;
  const canCollapse =
    !noConnections &&
    expandedTreePaths.size > 0 &&
    !explorerExpandAllInFlight;
  if (expandBtn instanceof HTMLButtonElement) {
    expandBtn.disabled = !canExpand;
  }
  if (collapseBtn instanceof HTMLButtonElement) {
    collapseBtn.disabled = !canCollapse;
  }
}

function collapseAllExplorerPaths() {
  for (const c of lastConnections) {
    pruneExpandedPathsForConnection(c.id);
  }
  setStatusMessage("Ready");
  renderConnections(lastConnections);
}

/**
 * Expands every lazy node for open, visible connection trees (may trigger many metadata requests).
 */
async function expandAllExplorerTree() {
  const targets = lastConnections.filter(
    (c) =>
      openConnectionIds.has(c.id) &&
      !objectTreeCollapsedByConnectionId.has(c.id),
  );
  if (targets.length === 0) {
    setStatusMessage("Open a data source and show its tree first.");
    return;
  }
  if (explorerExpandAllInFlight) return;
  explorerExpandAllInFlight = true;
  syncExplorerTreeActionButtons();
  setStatusMessage("Expanding tree…");
  try {
    for (const profile of targets) {
      const id = profile.id;
      expandedTreePaths.add(`${id}::database`);
      expandedTreePaths.add(`${id}::system`);
      expandedTreePaths.add(`${id}::extensions`);
      try {
        await Promise.all([
          fetchUserSchemas(profile),
          fetchSystemSchemaNames(profile),
          fetchExtensions(profile),
        ]);
      } catch (e) {
        const msg = formatConnectionFailureMessage(e);
        errorsByPath.set(`${id}::database`, msg);
        errorsByPath.set(`${id}::system`, msg);
        errorsByPath.set(`${id}::extensions`, msg);
        continue;
      }
      const userNames = getCachedUserSchemas(id);
      const sysNames = getCachedSystemSchemas(id);
      if (userNames !== undefined) {
        for (const schemaName of userNames) {
          const basePath = `${id}::schema::${schemaName}`;
          expandedTreePaths.add(basePath);
          for (const { key } of KIND_GROUPS) {
            expandedTreePaths.add(`${basePath}::${key}`);
          }
        }
      }
      if (sysNames !== undefined) {
        for (const schemaName of sysNames) {
          const basePath = `${id}::system::${schemaName}`;
          expandedTreePaths.add(basePath);
          for (const { key } of KIND_GROUPS) {
            expandedTreePaths.add(`${basePath}::${key}`);
          }
        }
      }
      const fetches = [];
      if (userNames !== undefined) {
        for (const schemaName of userNames) {
          for (const { key } of KIND_GROUPS) {
            fetches.push(
              fetchRelationObjects(
                profile,
                schemaName,
                /** @type {"tables"|"views"|"materialized_views"|"functions"|"sequences"} */ (
                  key
                ),
              ).catch(() => undefined),
            );
          }
        }
      }
      if (sysNames !== undefined) {
        for (const schemaName of sysNames) {
          for (const { key } of KIND_GROUPS) {
            fetches.push(
              fetchRelationObjects(
                profile,
                schemaName,
                /** @type {"tables"|"views"|"materialized_views"|"functions"|"sequences"} */ (
                  key
                ),
              ).catch(() => undefined),
            );
          }
        }
      }
      await Promise.all(fetches);
    }
    setStatusMessage("Ready");
  } catch (e) {
    setStatusMessage(
      e instanceof Error ? e.message : "Could not expand the tree.",
    );
  } finally {
    explorerExpandAllInFlight = false;
    syncExplorerTreeActionButtons();
    renderConnections(lastConnections);
  }
}

/**
 * Applies platform-specific shortcut labels to static controls (sidebar, explorer).
 */
function applyShortcutHintsToStaticUi() {
  const toggle = document.getElementById("sidebar-toggle");
  if (toggle instanceof HTMLButtonElement) {
    toggle.title = toggleDatabaseExplorerTitle();
    toggle.setAttribute("aria-keyshortcuts", ariaModDigit("1"));
  }
  const addBtn = document.getElementById("add-connection-btn");
  if (addBtn instanceof HTMLButtonElement) {
    addBtn.title = addDataSourceTitle();
    addBtn.setAttribute("aria-keyshortcuts", ariaModLetter("N"));
  }
}

/**
 * @param {import("./appConfig.js").ConnectionProfile[]} connections
 */
function renderConnections(connections) {
  lastConnections = connections;
  if (connectionsUiFlushScheduled) return;
  connectionsUiFlushScheduled = true;
  queueMicrotask(() => {
    connectionsUiFlushScheduled = false;
    flushConnectionsUi();
  });
}

/**
 * Rebuilds the sidebar connection list and object tree. Prefer {@link renderConnections} so
 * multiple updates in one turn coalesce and do not block the main thread back-to-back.
 * Long tasks here (large `replaceChildren` + relation lists) block pointer input until complete; use Performance to verify.
 */
function flushConnectionsUi() {
  const connections = lastConnections;
  const list = document.getElementById("connections-list");
  const emptyState = document.getElementById("connections-empty-state");
  if (!list) return;

  if (emptyState) {
    const isEmpty = connections.length === 0;
    emptyState.classList.toggle("hidden", !isEmpty);
    list.classList.toggle("hidden", isEmpty);
  }

  cancelAnimationFrame(pendingSelectionRafId);
  pendingSelectionRafId = 0;

  for (const id of [...openConnectionIds]) {
    if (!connections.some((c) => c.id === id)) {
      openConnectionIds.delete(id);
      objectTreeCollapsedByConnectionId.delete(id);
      pruneExpandedPathsForConnection(id);
      pruneCacheForConnection(id);
      clearSessionPassword(id);
    }
  }

  if (
    selectedConnectionId &&
    !connections.some((c) => c.id === selectedConnectionId)
  ) {
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
    row.setAttribute(
      "aria-selected",
      selectedConnectionId === c.id ? "true" : "false",
    );

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
      nested.className =
        "mt-0.5 ml-2 border-l border-stone-200/80 pl-2 [content-visibility:auto]";
      nested.setAttribute("aria-label", "Database objects");
      renderDbTreeInto(nested, c);
      li.appendChild(nested);
    }

    list.appendChild(li);
  }

  syncConnectionActionButtons();
  syncExplorerTreeActionButtons();

  renderSqlConnectionRow();
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
      status.textContent =
        err instanceof Error ? err.message : "Failed to remove data source.";
    }
  }
}

function initTableLeafContextMenu() {
  const menu = document.getElementById("table-leaf-context-menu");
  const openBtn = document.getElementById("context-table-open");
  const newQueryBtn = document.getElementById("context-table-new-query");
  const list = document.getElementById("connections-list");
  if (!menu || !openBtn || !newQueryBtn || !list) return;

  /** @type {{ connectionId: string; schemaName: string; tableName: string } | null} */
  let tableLeafContextTarget = null;
  let ignoreClosePointerUntil = 0;

  function hideMenu() {
    menu.classList.add("hidden");
    tableLeafContextTarget = null;
  }

  /**
   * @param {MouseEvent} e
   * @param {string} connectionId
   * @param {string} schemaName
   * @param {string} tableName
   */
  function showMenu(e, connectionId, schemaName, tableName) {
    e.preventDefault();
    e.stopPropagation();
    tableLeafContextTarget = { connectionId, schemaName, tableName };
    menu.classList.remove("hidden");
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    ignoreClosePointerUntil = performance.now() + 400;
  }

  list.addEventListener("contextmenu", (e) => {
    const leaf = eventTargetElement(e)?.closest("[data-preview-rel-leaf]");
    if (!leaf || !(leaf instanceof HTMLButtonElement)) return;
    const connectionId = leaf.dataset.connectionId;
    const schemaName = leaf.dataset.schemaName;
    const tableName = leaf.dataset.tableName;
    if (!connectionId || schemaName === undefined || tableName === undefined)
      return;
    showMenu(e, connectionId, schemaName, tableName);
  });

  openBtn.addEventListener("click", () => {
    const ctx = tableLeafContextTarget;
    hideMenu();
    if (!ctx) return;
    const profile = lastConnections.find((c) => c.id === ctx.connectionId);
    if (!profile) return;
    openNewTableTab(profile, ctx.schemaName, ctx.tableName);
  });

  newQueryBtn.addEventListener("click", () => {
    const ctx = tableLeafContextTarget;
    hideMenu();
    if (!ctx) return;
    const profile = lastConnections.find((c) => c.id === ctx.connectionId);
    if (!profile) return;
    if (!openConnectionIds.has(profile.id)) {
      setStatusMessage("Open the data source first.");
      return;
    }
    const label = `${ctx.schemaName}.${ctx.tableName}`;
    openNewSqlQueryTab(profile, {
      tabLabel: label,
      initialSql: defaultSelectSqlForTable(ctx.schemaName, ctx.tableName),
    });
  });

  document.addEventListener(
    "mousedown",
    (e) => {
      if (menu.classList.contains("hidden")) return;
      if (performance.now() < ignoreClosePointerUntil) return;
      if (e.button !== 0) return;
      const t = e.target;
      if (t instanceof Node && menu.contains(t)) return;
      hideMenu();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });
}

function initTablePreviewTabContextMenu() {
  const menu = document.getElementById("table-preview-tab-context-menu");
  const tabsStrip = document.getElementById("table-preview-tabs");
  const btnRight = document.getElementById("context-tab-close-right");
  const btnLeft = document.getElementById("context-tab-close-left");
  const btnAll = document.getElementById("context-tab-close-all");
  const btnClose = document.getElementById("context-tab-close");
  if (!menu || !tabsStrip || !btnRight || !btnLeft || !btnAll || !btnClose)
    return;

  /** @type {string | null} */
  let tablePreviewTabContextMenuTargetId = null;
  let ignoreClosePointerUntil = 0;

  function hideMenu() {
    menu.classList.add("hidden");
    tablePreviewTabContextMenuTargetId = null;
  }

  /**
   * @param {MouseEvent} e
   * @param {string} tabId
   */
  function showMenu(e, tabId) {
    e.preventDefault();
    const idx = tablePreviewTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    tablePreviewTabContextMenuTargetId = tabId;
    btnLeft.disabled = idx === 0;
    btnRight.disabled = idx >= tablePreviewTabs.length - 1;
    btnAll.disabled = tablePreviewTabs.length === 0;
    btnClose.disabled = false;

    menu.classList.remove("hidden");
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    ignoreClosePointerUntil = performance.now() + 400;
  }

  tabsStrip.addEventListener("contextmenu", (e) => {
    const t = e.target;
    const row = t instanceof Element ? t.closest("[data-tab-id]") : null;
    const id = row?.dataset?.tabId ?? null;
    if (!id) return;
    showMenu(e, id);
  });

  btnRight.addEventListener("click", () => {
    const id = tablePreviewTabContextMenuTargetId;
    hideMenu();
    if (id) closeTablePreviewTabsToRightOf(id);
  });

  btnLeft.addEventListener("click", () => {
    const id = tablePreviewTabContextMenuTargetId;
    hideMenu();
    if (id) closeTablePreviewTabsToLeftOf(id);
  });

  btnAll.addEventListener("click", () => {
    hideMenu();
    closeAllTablePreviewTabs();
  });

  btnClose.addEventListener("click", () => {
    const id = tablePreviewTabContextMenuTargetId;
    hideMenu();
    if (id) closeTablePreviewTab(id);
  });

  document.addEventListener(
    "mousedown",
    (e) => {
      if (menu.classList.contains("hidden")) return;
      if (performance.now() < ignoreClosePointerUntil) return;
      if (e.button !== 0) return;
      const t = e.target;
      if (t instanceof Node && menu.contains(t)) return;
      hideMenu();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  installPlainTextInputDefaults();
  initSqlEditorConnectionRow();

  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;

  const config = await getAppConfig();

  sidebarWidthPx = clampSidebarWidth(
    typeof config.ui.sidebarWidthPx === "number"
      ? config.ui.sidebarWidthPx
      : SIDEBAR_DEFAULT_WIDTH_PX,
  );
  setSidebarOpen(config.ui.sidebarOpen);
  initSidebarResize();
  renderConnections(config.connections);
  initTableLeafContextMenu();
  initTablePreviewTabContextMenu();
  applyShortcutHintsToStaticUi();

  const newQueryBtn = document.getElementById("new-query-btn");
  newQueryBtn?.addEventListener("click", () => {
    const profile = getProfileForNewQueryFromToolbar();
    if (!profile) {
      setStatusMessage("Open a data source first.");
      return;
    }
    openEmptySqlQueryForConnection(profile.id);
  });

  const wizard = initConnectionWizard({
    onConfigUpdated: (next) => {
      renderConnections(next.connections);
    },
    onDeleteConnection: removeConnectionAfterConfirm,
    isConnectionOpen,
    onOpenConnection: openConnection,
    onCloseConnection: closeConnection,
    onNewQueryFromConnection: openEmptySqlQueryForConnection,
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

  const addConnectionBtn = document.getElementById("add-connection-btn");
  const emptyCreateBtn = document.getElementById("connections-empty-create-btn");
  emptyCreateBtn?.addEventListener("click", () => {
    addConnectionBtn?.click();
  });

  document.getElementById("explorer-expand-all-btn")?.addEventListener(
    "click",
    () => {
      void expandAllExplorerTree();
    },
  );
  document.getElementById("explorer-collapse-all-btn")?.addEventListener(
    "click",
    () => {
      collapseAllExplorerPaths();
    },
  );

  toggle.addEventListener("click", () => {
    void toggleSidebarPersisted();
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (isKeyboardEventFromEditableTarget(e)) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.repeat) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        addConnectionBtn?.click();
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        void toggleSidebarPersisted();
      }
    },
    true,
  );
});

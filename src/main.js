import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { initConnectionWizard } from "./connectionWizard.js";
import { installPlainTextInputDefaults } from "./inputBehavior.js";
import {
  pruneCacheForConnection,
  fetchUserSchemas,
  fetchSystemSchemaNames,
  fetchExtensions,
  fetchRelationObjects,
  getCachedUserSchemas,
  getCachedSystemSchemas,
  getCachedExtensions,
  getCachedRelations,
} from "./dbMetadata.js";

const SIDEBAR_OPEN = ["w-64", "opacity-100", "border-r"];
const SIDEBAR_CLOSED = ["w-0", "opacity-0", "border-r-0", "pointer-events-none"];

/** @type {string | null} */
let selectedConnectionId = null;

/** Connection profiles whose database node is expanded in the tree. */
const openConnectionIds = new Set();

/**
 * Expanded paths under a connection (lazy-loaded from PostgreSQL).
 * @type {Set<string>}
 */
const expandedTreePaths = new Set();

/** Paths currently awaiting metadata (show loading row). @type {Set<string>} */
const loadingPaths = new Set();

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
      errorsByPath.set(path, e instanceof Error ? e.message : String(e));
    } finally {
      loadingPaths.delete(path);
    }
    renderConnections(lastConnections);
    return;
  }
  renderConnections(lastConnections);
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
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
        li.textContent = "Expand to load.";
        ul.appendChild(li);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
      } else {
        for (const schemaName of names) {
          appendSchemaSubtree(ul, profile, schemaName, false);
        }
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
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
        li.textContent = "Expand to load.";
        ul.appendChild(li);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
      } else {
        for (const schemaName of names) {
          appendSchemaSubtree(ul, profile, schemaName, true);
        }
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
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
        li.textContent = "Expand to load.";
        ul.appendChild(li);
      } else if (names.length === 0) {
        const li = document.createElement("li");
        li.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
        li.textContent = "(no items)";
        ul.appendChild(li);
      } else {
        for (const name of names) {
          const li = document.createElement("li");
          li.appendChild(createLeafRow(name));
          ul.appendChild(li);
        }
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
            const liL = document.createElement("li");
            liL.className = "rounded px-1 py-0.5 pl-6 text-xs text-stone-500";
            liL.textContent = "Expand to load.";
            ulN.appendChild(liL);
          } else if (objs.length === 0) {
            const liL = document.createElement("li");
            liL.className = "rounded px-1 py-0.5 pl-6 text-xs italic text-stone-400";
            liL.textContent = "(no items)";
            ulN.appendChild(liL);
          } else {
            for (const n of objs) {
              const liN = document.createElement("li");
              liN.appendChild(createLeafRow(n));
              ulN.appendChild(liN);
            }
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
 * @param {string} id
 */
function openConnection(id) {
  openConnectionIds.add(id);
  renderConnections(lastConnections);
}

/**
 * @param {string} id
 */
function closeConnection(id) {
  openConnectionIds.delete(id);
  pruneExpandedPathsForConnection(id);
  pruneCacheForConnection(id);
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

  lastConnections = connections;

  for (const id of [...openConnectionIds]) {
    if (!connections.some((c) => c.id === id)) {
      openConnectionIds.delete(id);
      pruneExpandedPathsForConnection(id);
      pruneCacheForConnection(id);
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
    row.setAttribute("aria-expanded", dbOpen ? "true" : "false");

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedConnectionId = c.id;
      renderConnections(connections);
    });

    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openConnection(c.id);
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

    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = c.label || c.id;

    row.appendChild(icon);
    row.appendChild(label);
    li.appendChild(row);

    if (dbOpen) {
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
    pruneExpandedPathsForConnection(id);
    pruneCacheForConnection(id);
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

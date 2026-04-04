import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { initConnectionWizard } from "./connectionWizard.js";
import { installPlainTextInputDefaults } from "./inputBehavior.js";

const SIDEBAR_OPEN = ["w-64", "opacity-100", "border-r"];
const SIDEBAR_CLOSED = ["w-0", "opacity-0", "border-r-0", "pointer-events-none"];

/** @type {string | null} */
let selectedConnectionId = null;

/** Connection profiles whose database node is expanded in the tree (no real DB connection yet). */
const openConnectionIds = new Set();

/** @type {import("./appConfig.js").ConnectionProfile[]} */
let lastConnections = [];

/**
 * @param {string} id
 */
function isConnectionOpen(id) {
  return openConnectionIds.has(id);
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
      const schemaLi = document.createElement("li");
      schemaLi.className = "rounded px-1 py-0.5 text-stone-700";
      schemaLi.textContent = "Schemas";
      nested.appendChild(schemaLi);
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

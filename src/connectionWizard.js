import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { getSessionPassword, testPgConnection } from "./dbMetadata.js";

/**
 * @param {{
 *   onConfigUpdated: (config: import("./appConfig.js").AppConfig) => void;
 *   onDeleteConnection?: (id: string) => void | Promise<void>;
 *   isConnectionOpen?: (id: string) => boolean;
 *   onOpenConnection?: (id: string) => void;
 *   onCloseConnection?: (id: string) => void;
 * }} options
 */
export function initConnectionWizard({
  onConfigUpdated,
  onDeleteConnection,
  isConnectionOpen = () => false,
  onOpenConnection = () => {},
  onCloseConnection = () => {},
}) {
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("connection-wizard-dialog"));
  const form = document.getElementById("connection-wizard-form");
  const addBtn = document.getElementById("add-connection-btn");
  const cancelBtn = document.getElementById("wizard-cancel");
  const dialogTitle = document.getElementById("wizard-dialog-title");
  const submitLabel = document.getElementById("wizard-submit-label");
  const savePasswordCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById("wizard-save-password")
  );
  const passwordInput = /** @type {HTMLInputElement | null} */ (document.getElementById("wizard-password"));
  const errorEl = document.getElementById("wizard-error");
  const successEl = document.getElementById("wizard-success");
  const testBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("wizard-test-connection")
  );
  const testLabel = document.getElementById("wizard-test-connection-label");
  const menu = document.getElementById("connection-tree-context-menu");
  const contextAdd = document.getElementById("context-add-connection");
  const contextEdit = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("context-edit-connection")
  );
  const contextDelete = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("context-delete-connection")
  );
  const contextOpen = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("context-open-connection")
  );
  const contextClose = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("context-close-connection")
  );
  const treeNav = document.getElementById("connection-tree-nav");

  if (
    !dialog ||
    !form ||
    !addBtn ||
    !cancelBtn ||
    !dialogTitle ||
    !submitLabel ||
    !savePasswordCheckbox ||
    !passwordInput ||
    !errorEl ||
    !successEl ||
    !testBtn ||
    !testLabel ||
    !menu ||
    !contextAdd ||
    !contextOpen ||
    !contextClose ||
    !contextEdit ||
    !contextDelete
  ) {
    return undefined;
  }

  /** @type {string | null} */
  let contextMenuConnectionId = null;

  /** @type {string | null} */
  let editingConnectionId = null;

  function setWizardMode(mode) {
    if (mode === "edit") {
      dialogTitle.textContent = "Edit database connection";
      submitLabel.textContent = "Save";
    } else {
      dialogTitle.textContent = "Add database connection";
      submitLabel.textContent = "Add";
    }
  }

  function showError(msg) {
    successEl.textContent = "";
    successEl.classList.add("hidden");
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  function showSuccess(msg) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
    successEl.textContent = msg;
    successEl.classList.remove("hidden");
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
    successEl.textContent = "";
    successEl.classList.add("hidden");
  }

  function openWizard() {
    editingConnectionId = null;
    setWizardMode("add");
    form.reset();
    savePasswordCheckbox.checked = false;
    const portInput = form.querySelector('[name="port"]');
    if (portInput instanceof HTMLInputElement) {
      portInput.value = "5432";
    }
    clearError();
    dialog.showModal();
  }

  /**
   * @param {import("./appConfig.js").ConnectionProfile} profile
   */
  function applyProfileToForm(profile) {
    const labelInput = form.querySelector('[name="label"]');
    const hostInput = form.querySelector('[name="host"]');
    const portInput = form.querySelector('[name="port"]');
    const databaseInput = form.querySelector('[name="database"]');
    const userInput = form.querySelector('[name="user"]');
    if (labelInput instanceof HTMLInputElement) labelInput.value = profile.label;
    if (hostInput instanceof HTMLInputElement) hostInput.value = profile.host;
    if (portInput instanceof HTMLInputElement) portInput.value = String(profile.port);
    if (databaseInput instanceof HTMLInputElement) databaseInput.value = profile.database;
    if (userInput instanceof HTMLInputElement) userInput.value = profile.user;
    savePasswordCheckbox.checked = profile.savePasswordInProfile;
    passwordInput.value = profile.savePasswordInProfile ? profile.password : "";
  }

  async function openEditWizard(id) {
    const config = await getAppConfig();
    const profile = config.connections.find((p) => p.id === id);
    if (!profile) return;
    editingConnectionId = id;
    setWizardMode("edit");
    applyProfileToForm(profile);
    clearError();
    dialog.showModal();
  }

  function closeWizard() {
    dialog.close();
  }

  dialog.addEventListener("close", () => {
    editingConnectionId = null;
    setWizardMode("add");
  });

  addBtn.addEventListener("click", openWizard);
  cancelBtn.addEventListener("click", closeWizard);

  async function runConnectionTest() {
    clearError();

    const fd = new FormData(form);
    const label = String(fd.get("label") ?? "").trim();
    const host = String(fd.get("host") ?? "").trim();
    const database = String(fd.get("database") ?? "").trim();
    const user = String(fd.get("user") ?? "").trim();
    const portRaw = String(fd.get("port") ?? "").trim();
    const savePassword = savePasswordCheckbox.checked;
    const passwordFromForm = String(fd.get("password") ?? "");

    if (!label || !host || !database || !user) {
      showError("Display name, host, database, and user are required.");
      return;
    }

    const port = parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      showError("Port must be a number between 1 and 65535.");
      return;
    }

    let passwordForTest = passwordFromForm;
    if (!savePassword && passwordForTest === "" && editingConnectionId) {
      passwordForTest = getSessionPassword(editingConnectionId) ?? "";
    }

    testBtn.disabled = true;
    testBtn.setAttribute("aria-busy", "true");
    testLabel.textContent = "Testing...";

    try {
      await testPgConnection({
        host,
        port,
        database,
        user,
        password: passwordForTest,
      });
      showSuccess("Connection succeeded.");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Connection test failed.");
    } finally {
      testBtn.disabled = false;
      testBtn.removeAttribute("aria-busy");
      testLabel.textContent = "Test connection";
    }
  }

  testBtn.addEventListener("click", () => {
    void runConnectionTest();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    const fd = new FormData(form);
    const label = String(fd.get("label") ?? "").trim();
    const host = String(fd.get("host") ?? "").trim();
    const database = String(fd.get("database") ?? "").trim();
    const user = String(fd.get("user") ?? "").trim();
    const portRaw = String(fd.get("port") ?? "").trim();
    const savePassword = savePasswordCheckbox.checked;
    const passwordRaw = savePassword ? String(fd.get("password") ?? "") : "";

    if (!label || !host || !database || !user) {
      showError("Display name, host, database, and user are required.");
      return;
    }

    const port = parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      showError("Port must be a number between 1 and 65535.");
      return;
    }

    const id = editingConnectionId ?? crypto.randomUUID();
    const profile = {
      id,
      label,
      host,
      port,
      database,
      user,
      password: savePassword ? passwordRaw : "",
      savePasswordInProfile: savePassword,
    };

    try {
      const next = await updateAppConfig((c) => {
        if (editingConnectionId) {
          const idx = c.connections.findIndex((p) => p.id === editingConnectionId);
          if (idx >= 0) {
            c.connections[idx] = profile;
          }
        } else {
          c.connections.push(profile);
        }
      });
      onConfigUpdated(next);
      closeWizard();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save.");
    }
  });

  /** Ignore left-button down / click right after opening (WebKit etc. can synthesize events). */
  let ignoreClosePointerUntil = 0;

  function showContextMenu(e) {
    e.preventDefault();
    const t = e.target;
    const row =
      t instanceof Element ? t.closest("[data-connection-id]") : null;
    contextMenuConnectionId = row?.dataset.connectionId ?? null;
    const hasRow = contextMenuConnectionId != null;
    const id = contextMenuConnectionId;
    const open = id != null && isConnectionOpen(id);
    contextOpen.disabled = !hasRow || open;
    contextClose.disabled = !hasRow || !open;
    contextEdit.disabled = !hasRow;
    contextDelete.disabled = !hasRow;
    menu.classList.remove("hidden");
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    ignoreClosePointerUntil = performance.now() + 400;
  }

  function hideContextMenu() {
    menu.classList.add("hidden");
  }

  treeNav?.addEventListener("contextmenu", showContextMenu);

  contextAdd.addEventListener("click", () => {
    hideContextMenu();
    openWizard();
  });

  contextOpen.addEventListener("click", () => {
    hideContextMenu();
    const id = contextMenuConnectionId;
    if (id && !isConnectionOpen(id)) {
      void Promise.resolve(onOpenConnection(id));
    }
  });

  contextClose.addEventListener("click", () => {
    hideContextMenu();
    const id = contextMenuConnectionId;
    if (id && isConnectionOpen(id)) {
      onCloseConnection(id);
    }
  });

  contextEdit.addEventListener("click", () => {
    hideContextMenu();
    const id = contextMenuConnectionId;
    if (id) {
      void openEditWizard(id);
    }
  });

  contextDelete.addEventListener("click", () => {
    hideContextMenu();
    const id = contextMenuConnectionId;
    if (id && onDeleteConnection) {
      void Promise.resolve(onDeleteConnection(id));
    }
  });

  /** Close on left-button mousedown outside the menu (not `click` — avoids closing on the opener gesture). */
  document.addEventListener(
    "mousedown",
    (e) => {
      if (menu.classList.contains("hidden")) return;
      if (performance.now() < ignoreClosePointerUntil) return;
      if (e.button !== 0) return;
      const t = e.target;
      if (t instanceof Node && menu.contains(t)) return;
      hideContextMenu();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });

  return { openEditWizard };
}

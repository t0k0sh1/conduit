import { updateAppConfig } from "./appConfig.js";

/**
 * @param {{
 *   onConfigUpdated: (config: import("./appConfig.js").AppConfig) => void;
 *   onDeleteConnection?: (id: string) => void | Promise<void>;
 * }} options
 */
export function initConnectionWizard({ onConfigUpdated, onDeleteConnection }) {
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("connection-wizard-dialog"));
  const form = document.getElementById("connection-wizard-form");
  const addBtn = document.getElementById("add-connection-btn");
  const cancelBtn = document.getElementById("wizard-cancel");
  const savePasswordCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById("wizard-save-password")
  );
  const passwordInput = /** @type {HTMLInputElement | null} */ (document.getElementById("wizard-password"));
  const errorEl = document.getElementById("wizard-error");
  const menu = document.getElementById("connection-tree-context-menu");
  const contextAdd = document.getElementById("context-add-connection");
  const contextDelete = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("context-delete-connection")
  );
  const treeNav = document.getElementById("connection-tree-nav");

  if (
    !dialog ||
    !form ||
    !addBtn ||
    !cancelBtn ||
    !savePasswordCheckbox ||
    !passwordInput ||
    !errorEl ||
    !menu ||
    !contextAdd ||
    !contextDelete
  ) {
    return;
  }

  /** @type {string | null} */
  let contextMenuConnectionId = null;

  function syncPasswordField() {
    const save = savePasswordCheckbox.checked;
    passwordInput.disabled = !save;
    if (!save) passwordInput.value = "";
  }

  savePasswordCheckbox.addEventListener("change", syncPasswordField);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  function openWizard() {
    form.reset();
    savePasswordCheckbox.checked = false;
    const portInput = form.querySelector('[name="port"]');
    if (portInput instanceof HTMLInputElement) {
      portInput.value = "5432";
    }
    syncPasswordField();
    clearError();
    dialog.showModal();
  }

  function closeWizard() {
    dialog.close();
  }

  addBtn.addEventListener("click", openWizard);
  cancelBtn.addEventListener("click", closeWizard);

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

    const profile = {
      id: crypto.randomUUID(),
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
        c.connections.push(profile);
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
    contextDelete.disabled = contextMenuConnectionId == null;
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
}

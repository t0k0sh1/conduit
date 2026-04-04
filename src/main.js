import { getAppConfig, updateAppConfig } from "./appConfig.js";
import { initConnectionWizard } from "./connectionWizard.js";
import { installPlainTextInputDefaults } from "./inputBehavior.js";

const SIDEBAR_OPEN = ["w-64", "opacity-100", "border-r"];
const SIDEBAR_CLOSED = ["w-0", "opacity-0", "border-r-0", "pointer-events-none"];

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

function renderConnections(connections) {
  const list = document.getElementById("connections-list");
  if (!list) return;

  list.replaceChildren();

  for (const c of connections) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "flex items-center gap-1 rounded px-1 py-0.5 text-stone-800";
    row.title = `${c.host}:${c.port}/${c.database}`;

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
    list.appendChild(li);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  installPlainTextInputDefaults();

  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;

  const config = await getAppConfig();

  setSidebarOpen(config.ui.sidebarOpen);
  renderConnections(config.connections);

  initConnectionWizard({
    onConfigUpdated: (next) => {
      renderConnections(next.connections);
    },
  });

  toggle.addEventListener("click", async () => {
    const next = await updateAppConfig((c) => {
      c.ui.sidebarOpen = !c.ui.sidebarOpen;
    });
    setSidebarOpen(next.ui.sidebarOpen);
  });
});

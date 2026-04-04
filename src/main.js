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

window.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;

  let open = true;
  toggle.addEventListener("click", () => {
    open = !open;
    setSidebarOpen(open);
  });
});

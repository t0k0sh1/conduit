/**
 * Disables spellcheck, autocorrect, autocapitalization, and browser autofill suggestions
 * on text-like controls so keystrokes map 1:1 to input value. Applies to existing DOM
 * and any inputs added later.
 */
const SKIP_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "file",
  "button",
  "submit",
  "reset",
  "hidden",
  "image",
]);

function applyPlainTextAttributes(el) {
  if (el instanceof HTMLInputElement) {
    if (SKIP_INPUT_TYPES.has(el.type)) return;
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
    return;
  }
  if (el instanceof HTMLTextAreaElement) {
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
    return;
  }
  if (el instanceof HTMLElement && el.getAttribute("contenteditable") === "true") {
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
  }
}

function touchSubtree(root) {
  if (!(root instanceof Element)) return;
  if (root.matches("input, textarea, [contenteditable='true']")) {
    applyPlainTextAttributes(/** @type {HTMLElement} */ (root));
  }
  root.querySelectorAll("input, textarea, [contenteditable='true']").forEach((el) => {
    if (el instanceof HTMLElement) applyPlainTextAttributes(el);
  });
}

/** Call once at app startup. */
export function installPlainTextInputDefaults() {
  touchSubtree(document.body);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n instanceof Element) touchSubtree(n);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

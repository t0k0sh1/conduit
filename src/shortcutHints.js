/**
 * User-visible keyboard shortcut hints (platform-aware: ⌘ vs Ctrl).
 */

/**
 * @returns {boolean}
 */
export function isApplePlatform() {
  return (
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ||
    navigator.userAgent.includes("Mac OS")
  );
}

/**
 * Modifier key label for shortcuts (⌘ on Apple, Ctrl elsewhere).
 * @returns {string}
 */
export function modKeyLabel() {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/**
 * @param {string} letterOrDigit Single key after modifier, e.g. "N", "1", or "Enter"
 * @returns {string}
 */
export function modShortcutDisplay(letterOrDigit) {
  const mod = modKeyLabel();
  if (letterOrDigit === "Enter") {
    return isApplePlatform() ? `${mod}Enter` : `${mod}+Enter`;
  }
  const k =
    letterOrDigit.length === 1 ? letterOrDigit.toUpperCase() : letterOrDigit;
  return isApplePlatform() ? `${mod}${k}` : `${mod}+${k}`;
}

/**
 * @returns {string} W3C `aria-keyshortcuts` token for modifier+digit
 */
export function ariaModDigit(digit) {
  return isApplePlatform() ? `Meta+Digit${digit}` : `Control+Digit${digit}`;
}

/**
 * @param {string} letter e.g. "N"
 * @returns {string}
 */
export function ariaModLetter(letter) {
  const L = letter.length === 1 ? letter.toUpperCase() : letter;
  return isApplePlatform() ? `Meta+${L}` : `Control+${L}`;
}

/**
 * @returns {string}
 */
export function ariaRunSqlShortcut() {
  return isApplePlatform() ? "Meta+Enter" : "Control+Enter";
}

/** Shift+Alt+F is consistent across platforms for format in this app. */
export const ARIA_FORMAT_SQL_SHORTCUT = "Shift+Alt+KeyF";

/**
 * @returns {string}
 */
export function runSqlButtonTitle() {
  return `Run SQL (${modShortcutDisplay("Enter")}): selected text if highlighted, otherwise the whole console`;
}

/**
 * @returns {string}
 */
export function formatSqlButtonTitle() {
  return "Format SQL (Shift+Alt+F): selected text if highlighted, otherwise the whole console";
}

/**
 * @returns {string}
 */
export function toggleDatabaseExplorerTitle() {
  return `Toggle Database Explorer (${modShortcutDisplay("1")})`;
}

/**
 * @returns {string}
 */
export function addDataSourceTitle() {
  return `Add data source (${modShortcutDisplay("N")})`;
}

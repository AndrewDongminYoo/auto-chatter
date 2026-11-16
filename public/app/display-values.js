// @ts-check
// Display guards for caught errors and API values, so browser-generated English error text, NaN and Invalid Date do
// not reach the screen. Pure functions only: src/app/display-values.test.ts runs this classic script in a node:vm
// context.
const displayErrorFallback = "화면을 처리하는 중 문제가 생겼습니다. 새로고침한 뒤 다시 시도해 주세요.";
const displayEmptyValue = "–";

/**
 * The dashboard's own errors are plain Error objects with Korean text (api() in app.js and the feature scripts). Any
 * other thrown value (a TypeError, a DOMException, a subclass or a non-error) is logged and replaced.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.constructor === Error && typeof error.message === "string" && error.message) return error.message;
  console.error(error);
  return displayErrorFallback;
}

/**
 * @param {unknown} value
 * @param {{ useGrouping?: boolean }} [options]
 * @returns {string}
 */
function formatCount(value, options) {
  // PostgreSQL counts can be decimal strings larger than Number.MAX_SAFE_INTEGER.
  if (typeof value === "string" && /^\d+$/.test(value)) return options?.useGrouping === false ? value : BigInt(value).toLocaleString("ko-KR");
  if (typeof value !== "number" || !Number.isFinite(value)) return displayEmptyValue;
  return options?.useGrouping === false ? String(value) : value.toLocaleString("ko-KR");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatText(value) {
  return typeof value === "string" && value.length > 0 ? value : displayEmptyValue;
}

// A Date, an ISO string or epoch milliseconds; null and booleans are rejected although new Date() accepts them.
function displayDate(value) {
  if (!(value instanceof Date) && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * @param {unknown} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
function formatDateTime(value, options) {
  return displayDate(value)?.toLocaleString("ko-KR", options) ?? displayEmptyValue;
}

/**
 * @param {unknown} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
function formatDate(value, options) {
  return displayDate(value)?.toLocaleDateString("ko-KR", options) ?? displayEmptyValue;
}

/**
 * @param {unknown} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
function formatTime(value, options) {
  return displayDate(value)?.toLocaleTimeString("ko-KR", options) ?? displayEmptyValue;
}

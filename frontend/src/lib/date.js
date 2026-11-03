/**
 * Shared date formatting helpers — English (dd/mm/yyyy) display format.
 * The API always sends/receives ISO dates (yyyy-mm-dd) or ISO datetimes;
 * these helpers are purely for how dates are *displayed* in the UI.
 */

/**
 * Format an ISO date string (yyyy-mm-dd) or ISO datetime string as dd/mm/yyyy.
 * Returns an empty string for null/undefined/invalid input, so it's safe to
 * use directly in JSX without extra guards.
 */
export function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Format an ISO datetime string as dd/mm/yyyy, HH:MM (24-hour, local time) —
 * for timestamps where the time-of-day matters (notifications, audit log,
 * fault reports, comments, etc.). Falls back to date-only if there's no time
 * component in the input.
 */
export function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year}, ${hours}:${minutes}`;
}
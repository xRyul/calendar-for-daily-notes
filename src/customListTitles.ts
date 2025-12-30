export type CustomListTitles = Record<string, string>;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function collapseWhitespace(s: string): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeCustomListTitleInput(args: {
  dateStr: string;
  input: string;
  maxLen?: number;
}): string {
  const dateStr = args.dateStr;
  const maxLen = typeof args.maxLen === "number" && args.maxLen > 0 ? args.maxLen : 240;

  let s = collapseWhitespace(args.input ?? "");
  if (!s) {
    return "";
  }

  // If the user pasted the full label, strip the date prefix.
  if (dateStr && s.startsWith(dateStr)) {
    s = s.slice(dateStr.length);
    s = s.replace(/^[\s\-–—:|]+/g, "");
    s = s.trim();
  }

  if (!s) {
    return "";
  }

  if (s.length > maxLen) {
    s = s.slice(0, maxLen).trim();
  }

  return s;
}

export function formatCustomListTitleLabel(dateStr: string, suffix: string): string {
  const cleanSuffix = collapseWhitespace(suffix ?? "");
  return cleanSuffix ? `${dateStr} - ${cleanSuffix}` : dateStr;
}

export function sanitizeCustomListTitles(value: unknown): CustomListTitles {
  if (!value || typeof value !== "object") {
    return {};
  }

  const obj = value as Record<string, unknown>;
  const out: CustomListTitles = {};

  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key || !DATE_KEY_RE.test(key)) {
      continue;
    }

    if (typeof rawVal !== "string") {
      continue;
    }

    const suffix = normalizeCustomListTitleInput({ dateStr: key, input: rawVal });
    if (!suffix) {
      continue;
    }

    out[key] = suffix;
  }

  return out;
}

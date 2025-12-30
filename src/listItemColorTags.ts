export type ListItemColorTags = Record<string, string>;

const DAY_KEY_RE = /^day:\d{4}-\d{2}-\d{2}$/;
const FILE_KEY_RE = /^file:.+$/;

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function expandHex3ToHex6(hex3: string): string {
  // Input is validated to match /^#[0-9a-fA-F]{3}$/
  const r = hex3[1];
  const g = hex3[2];
  const b = hex3[3];
  return `#${r}${r}${g}${g}${b}${b}`;
}

export function normalizeListItemColor(input: string): string {
  const s = (input ?? "").trim();
  if (!HEX_COLOR_RE.test(s)) {
    return "";
  }

  const normalized = s.length === 4 ? expandHex3ToHex6(s) : s;
  return normalized.toLowerCase();
}

export function sanitizeListItemColorTags(value: unknown): ListItemColorTags {
  if (!value || typeof value !== "object") {
    return {};
  }

  const obj = value as Record<string, unknown>;
  const out: ListItemColorTags = {};

  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) {
      continue;
    }

    const isValidKey = DAY_KEY_RE.test(key) || FILE_KEY_RE.test(key);
    if (!isValidKey) {
      continue;
    }

    if (typeof rawVal !== "string") {
      continue;
    }

    const color = normalizeListItemColor(rawVal);
    if (!color) {
      continue;
    }

    out[key] = color;
  }

  return out;
}

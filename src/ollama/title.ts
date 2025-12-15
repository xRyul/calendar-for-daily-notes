export type DailyTitleParts = {
  keywords: string[];
  description: string;
};

// JSON Schema for Ollama's structured output (when supported).
export const DAILY_TITLE_SCHEMA: unknown = {
  type: "object",
  additionalProperties: false,
  required: ["keywords", "description"],
  properties: {
    keywords: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string" },
    },
    description: { type: "string" },
  },
};

export function stripYamlFrontmatter(text: string): string {
  if (!text) {
    return "";
  }

  // Only strip if it begins with a frontmatter fence.
  const lines = text.split(/\r?\n/);
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return text;
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }

  // No closing fence; leave untouched.
  return text;
}

export function prepareNoteTextForOllama(text: string, maxChars: number): string {
  const stripped = stripYamlFrontmatter(text);
  const collapsed = stripped.replace(/\s+/g, " ").trim();

  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return collapsed;
  }

  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

export function buildDailyTitlePrompt(args: {
  dateStr: string;
  noteText: string;
}): string {
  const dateStr = args.dateStr;
  const note = args.noteText;

  return [
    "You are generating a short label for an Obsidian daily note list view.",
    "Return ONLY valid JSON that matches the provided schema.",
    "Rules:",
    "- keywords: exactly 3 single words, lowercase if reasonable, no punctuation.",
    "- description: exactly 1 short sentence describing the note. Keep it under ~120 characters.",
    "- Do not mention 'Obsidian', 'note', or the date in the description.",
    "",
    `DATE: ${dateStr}`,
    "NOTE CONTENT:",
    note,
  ].join("\n");
}

function sanitizeWord(word: string): string {
  // Keep letters/numbers, collapse internal whitespace, drop punctuation.
  const cleaned = word
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ");

  // Enforce single token by taking the first segment.
  return cleaned.split(" ")[0] ?? "";
}

function sanitizeDescription(desc: string): string {
  let s = (desc ?? "").replace(/[\r\n\t]+/g, " ").trim();
  s = s.replace(/\s+/g, " ");

  // Keep it short.
  const MAX = 120;
  if (s.length > MAX) {
    s = s.slice(0, MAX).trim();
  }

  // Avoid trailing punctuation spam.
  s = s.replace(/[.!?]{2,}$/g, ".");

  return s;
}

export function parseDailyTitleParts(value: unknown): DailyTitleParts | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const rawKeywords = obj.keywords;
  const rawDescription = obj.description;

  if (!Array.isArray(rawKeywords) || typeof rawDescription !== "string") {
    return null;
  }

  const words = rawKeywords
    .map((k) => (typeof k === "string" ? sanitizeWord(k) : ""))
    .filter(Boolean);

  if (words.length < 3) {
    return null;
  }

  const keywords = words.slice(0, 3);
  const description = sanitizeDescription(rawDescription);
  if (!description) {
    return null;
  }

  return { keywords, description };
}

export function formatDailyTitleLabel(
  dateStr: string,
  parts: DailyTitleParts
): string {
  return `${dateStr} - ${parts.keywords.join(" ")} - ${parts.description}`;
}

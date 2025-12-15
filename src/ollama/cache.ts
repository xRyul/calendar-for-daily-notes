export type OllamaTitleCacheEntry = {
  mtime: number;
  title: string;
  lastUsed?: number;
};

export type OllamaTitleCache = Record<string, OllamaTitleCacheEntry>;

export function sanitizeOllamaTitleCache(value: unknown): OllamaTitleCache {
  if (!value || typeof value !== "object") {
    return {};
  }

  const obj = value as Record<string, unknown>;
  const out: OllamaTitleCache = {};

  for (const [key, raw] of Object.entries(obj)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const entry = raw as Partial<OllamaTitleCacheEntry>;
    if (typeof entry.title !== "string" || !entry.title.trim()) {
      continue;
    }

    const mtime = typeof entry.mtime === "number" ? entry.mtime : NaN;
    if (!Number.isFinite(mtime) || mtime < 0) {
      continue;
    }

    const lastUsed =
      typeof entry.lastUsed === "number" && Number.isFinite(entry.lastUsed)
        ? entry.lastUsed
        : undefined;

    out[key] = {
      mtime,
      title: entry.title,
      lastUsed,
    };
  }

  return out;
}

export function upsertOllamaTitleCacheEntry(args: {
  cache: OllamaTitleCache;
  filePath: string;
  entry: { mtime: number; title: string };
  maxEntries?: number;
  nowMs?: number;
}): OllamaTitleCache {
  const now = args.nowMs ?? Date.now();
  const next: OllamaTitleCache = {
    ...(args.cache ?? {}),
    [args.filePath]: {
      mtime: args.entry.mtime,
      title: args.entry.title,
      lastUsed: now,
    },
  };

  return pruneOllamaTitleCache(next, args.maxEntries);
}

export function pruneOllamaTitleCache(
  cache: OllamaTitleCache,
  maxEntries?: number
): OllamaTitleCache {
  const max = typeof maxEntries === "number" ? maxEntries : undefined;
  if (!max || max <= 0) {
    return cache;
  }

  const keys = Object.keys(cache);
  if (keys.length <= max) {
    return cache;
  }

  // Evict least recently used (or oldest) entries.
  const sortable = keys.map((k) => {
    const lastUsed = cache[k]?.lastUsed;
    return {
      key: k,
      lastUsed: typeof lastUsed === "number" && Number.isFinite(lastUsed)
        ? lastUsed
        : 0,
    };
  });

  sortable.sort((a, b) => a.lastUsed - b.lastUsed);

  const toDelete = sortable.slice(0, Math.max(0, keys.length - max));
  if (toDelete.length === 0) {
    return cache;
  }

  const next = { ...cache };
  for (const { key } of toDelete) {
    delete next[key];
  }
  return next;
}

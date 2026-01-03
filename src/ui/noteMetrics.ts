import type { TFile } from "obsidian";

import { getWordCount as getWordCountFromText } from "./utils";

export type NoteMetrics = {
  wordCount: number;
  openTaskCount: number;
};

type CacheEntry = {
  mtime: number;
  value: NoteMetrics;
};

// Bound memory usage: keep only the most recently used metrics.
// Tuned for large vaults but still safe in long-running sessions.
const MAX_ENTRIES = 2000;

const OPEN_TASK_PATTERN = /(-|\*) \[ \]/g;

// LRU via Map insertion order.
const cache = new Map<string, CacheEntry>();

// Avoid duplicate reads/parses for the same file+mtime during bursts.
const inFlight = new Map<string, { mtime: number; promise: Promise<NoteMetrics> }>();

function touch(key: string, entry: CacheEntry): void {
  // Refresh recency by reinserting.
  cache.delete(key);
  cache.set(key, entry);
}

function prune(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
  }
}

async function computeMetrics(file: TFile): Promise<NoteMetrics> {
  const vault = window.app?.vault;
  if (!vault?.cachedRead) {
    return { wordCount: 0, openTaskCount: 0 };
  }

  const text = await vault.cachedRead(file);
  return {
    wordCount: getWordCountFromText(text),
    openTaskCount: (text.match(OPEN_TASK_PATTERN) || []).length,
  };
}

export async function getNoteMetrics(
  file: TFile | null | undefined
): Promise<NoteMetrics> {
  if (!file) {
    return { wordCount: 0, openTaskCount: 0 };
  }

  const key = file.path ?? "";
  const mtime = file.stat?.mtime ?? 0;

  if (!key) {
    // Extremely defensive: a file without a path can't be cached safely.
    return computeMetrics(file);
  }

  const cached = cache.get(key);
  if (cached && cached.mtime === mtime) {
    touch(key, cached);
    return cached.value;
  }

  const inflight = inFlight.get(key);
  if (inflight && inflight.mtime === mtime) {
    return inflight.promise;
  }

  const promise = computeMetrics(file).then((value) => {
    const entry: CacheEntry = { mtime, value };
    cache.set(key, entry);
    prune();
    return value;
  });

  inFlight.set(key, { mtime, promise });

  try {
    return await promise;
  } finally {
    // Only clear if we are still the current in-flight computation.
    const cur = inFlight.get(key);
    if (cur?.mtime === mtime && cur.promise === promise) {
      inFlight.delete(key);
    }
  }
}

export async function getWordCount(file: TFile | null | undefined): Promise<number> {
  return (await getNoteMetrics(file)).wordCount;
}

export async function getOpenTaskCount(
  file: TFile | null | undefined
): Promise<number> {
  return (await getNoteMetrics(file)).openTaskCount;
}

import type { TFile } from "obsidian";
import {
  getAllDailyNotes,
  getAllWeeklyNotes,
  getDateFromFile,
  getDateUID,
} from "obsidian-daily-notes-interface";
import { writable } from "svelte/store";

import type { CustomListTitles } from "src/customListTitles";
import type { ListItemColorTags } from "src/listItemColorTags";
import type { OllamaTitleCache } from "src/ollama/cache";
import { defaultSettings, type ISettings } from "src/settings";

function createDailyNotesStore() {
  let hasError = false;
  let initialized = false;
  let pathSet = new Set<string>();

  const store = writable<Record<string, TFile>>({});
  return {
    reindex: () => {
      try {
        const dailyNotes = getAllDailyNotes();
        store.set(dailyNotes);
        pathSet = new Set(
          Object.values(dailyNotes)
            .filter(Boolean)
            .map((f) => f.path)
        );
        hasError = false;
      } catch (err) {
        if (!hasError) {
          // Avoid error being shown multiple times
          console.warn("[Calendar] Failed to find daily notes folder", err);
        }
        store.set({});
        pathSet = new Set();
        hasError = true;
      } finally {
        initialized = true;
      }
    },
    hasPath: (path: string | null | undefined): boolean => {
      return !!path && pathSet.has(path);
    },
    isInitialized: (): boolean => initialized,
    ...store,
  };
}

function createWeeklyNotesStore() {
  let hasError = false;
  let initialized = false;
  let pathSet = new Set<string>();

  const store = writable<Record<string, TFile>>({});
  return {
    reindex: () => {
      try {
        const weeklyNotes = getAllWeeklyNotes();
        store.set(weeklyNotes);
        pathSet = new Set(
          Object.values(weeklyNotes)
            .filter(Boolean)
            .map((f) => f.path)
        );
        hasError = false;
      } catch (err) {
        if (!hasError) {
          // Avoid error being shown multiple times
          console.warn("[Calendar] Failed to find weekly notes folder", err);
        }
        store.set({});
        pathSet = new Set();
        hasError = true;
      } finally {
        initialized = true;
      }
    },
    hasPath: (path: string | null | undefined): boolean => {
      return !!path && pathSet.has(path);
    },
    isInitialized: (): boolean => initialized,
    ...store,
  };
}

export const settings = writable<ISettings>(defaultSettings);
export const dailyNotes = createDailyNotesStore();
export const weeklyNotes = createWeeklyNotesStore();

export const ollamaTitleCache = writable<OllamaTitleCache>({});
export const customListTitles = writable<CustomListTitles>({});
export const listItemColorTags = writable<ListItemColorTags>({});

function createSelectedFileStore() {
  const store = writable<string | null>(null);

  return {
    setFile: (file: TFile | null) => {
      if (!file) {
        store.set(null);
        return;
      }

      const path = file.path;
      const strictMode = dailyNotes.isInitialized() || weeklyNotes.isInitialized();

      if (strictMode) {
        if (dailyNotes.hasPath(path)) {
          const date = getDateFromFile(file, "day");
          store.set(date ? getDateUID(date, "day") : null);
          return;
        }

        if (weeklyNotes.hasPath(path)) {
          const date = getDateFromFile(file, "week");
          store.set(date ? getDateUID(date, "week") : null);
          return;
        }

        store.set(null);
        return;
      }

      // Before indexes are available, fall back to best-effort parsing.
      let date = getDateFromFile(file, "day");
      if (date) {
        store.set(getDateUID(date, "day"));
        return;
      }

      date = getDateFromFile(file, "week");
      if (date) {
        store.set(getDateUID(date, "week"));
        return;
      }

      store.set(null);
    },
    ...store,
  };
}

function createActiveFilePathStore() {
  const store = writable<string | null>(null);

  return {
    setFile: (file: TFile | null) => {
      store.set(file?.path ?? null);
    },
    ...store,
  };
}

export const activeFilePath = createActiveFilePathStore();
export const activeFile = createSelectedFileStore();

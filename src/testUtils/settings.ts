import type { ISettings } from "src/settings";

export function getDefaultSettings(
  overrides: Partial<ISettings> = {}
): ISettings {
  return Object.assign(
    {},
    {
      weekStart: "sunday",
      shouldConfirmBeforeCreate: false,
      wordsPerDot: 50,

      listViewMinWords: 0,
      listViewIncludeCreatedDays: true,
      listViewGroupingPreset: "year",

      showWeeklyNote: false,
      weeklyNoteFolder: "",
      weeklyNoteFormat: "",
      weeklyNoteTemplate: "",
      localeOverride: "system-default",

      ollamaTitlesEnabled: false,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "gemma3:4b",
      ollamaMaxChars: 8000,
      ollamaRequestTimeoutMs: 15000,
      ollamaTitleCacheMaxEntries: 1000,
    },
    overrides
  );
}

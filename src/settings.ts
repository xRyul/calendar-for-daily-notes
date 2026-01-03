import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import { appHasDailyNotesPluginLoaded } from "obsidian-daily-notes-interface";
import type { ILocaleOverride, IWeekStartOption } from "obsidian-calendar-ui";

import { DEFAULT_WEEK_FORMAT, DEFAULT_WORDS_PER_DOT } from "src/constants";

import type CalendarPlugin from "./main";
import type { ListViewGroupingPreset, ListViewSortOrder } from "./ui/listViewModel";

export interface ISettings {
  wordsPerDot: number;
  weekStart: IWeekStartOption;
  shouldConfirmBeforeCreate: boolean;

  // UI state
  rememberViewState: boolean;

  // UI sizing
  calendarZoom: number;
  listViewZoom: number;

  // List view settings
  listViewMinWords: number;
  listViewIncludeCreatedDays: boolean;
  listViewGroupingPreset: ListViewGroupingPreset;
  listViewSortOrder: ListViewSortOrder;
  listViewShowCounts: boolean;

  // Weekly Note settings
  showWeeklyNote: boolean;
  weeklyNoteFormat: string;
  weeklyNoteTemplate: string;
  weeklyNoteFolder: string;

  localeOverride: ILocaleOverride;

  // Ollama (local) generated list titles
  ollamaTitlesEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaMaxChars: number;
  ollamaRequestTimeoutMs: number;
  ollamaTitleCacheMaxEntries: number;
}

const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const defaultSettings = Object.freeze({
  shouldConfirmBeforeCreate: true,
  weekStart: "locale" as IWeekStartOption,

  // Persist UI state across restarts (list view open, displayed month, list toggles)
  rememberViewState: true,

  // UI sizing (100 = 100%, 80 = 80%, etc.)
  calendarZoom: 130,
  listViewZoom: 95,

  wordsPerDot: DEFAULT_WORDS_PER_DOT,

  listViewMinWords: 0,
  listViewIncludeCreatedDays: true,
  listViewGroupingPreset: "year" as ListViewGroupingPreset,
  listViewSortOrder: "desc" as ListViewSortOrder,
  listViewShowCounts: false,

  showWeeklyNote: false,
  weeklyNoteFormat: "",
  weeklyNoteTemplate: "",
  weeklyNoteFolder: "",

  localeOverride: "system-default",

  ollamaTitlesEnabled: false,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "gemma3:4b",
  ollamaMaxChars: 8000,
  ollamaRequestTimeoutMs: 15000,
  ollamaTitleCacheMaxEntries: 1000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type PluginsLike = {
  getPlugin: (id: string) => unknown;
};

function isPluginsLike(value: unknown): value is PluginsLike {
  return isRecord(value) && typeof value["getPlugin"] === "function";
}

export function appHasPeriodicNotesPluginLoaded(app: App): boolean {
  const appRecord = app as unknown;
  if (!isRecord(appRecord)) {
    return false;
  }

  const plugins = appRecord["plugins"];
  if (!isPluginsLike(plugins)) {
    return false;
  }

  const plugin = plugins.getPlugin("periodic-notes");
  if (!isRecord(plugin)) {
    return false;
  }

  const settings = plugin["settings"];
  if (!isRecord(settings)) {
    return false;
  }

  const weekly = settings["weekly"];
  if (!isRecord(weekly)) {
    return false;
  }

  return weekly["enabled"] === true;
}
export class CalendarSettingsTab extends PluginSettingTab {
  private plugin: CalendarPlugin;

  constructor(app: App, plugin: CalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();

    if (!appHasDailyNotesPluginLoaded()) {
      this.containerEl.createDiv("settings-banner", (banner) => {
        new Setting(banner)
          .setName("Daily notes plugin is not enabled")
          .setDesc(
            "The calendar is best used in conjunction with either the daily notes plugin or the periodic notes plugin (available in the community plugins catalog)."
          )
          .setHeading();
      });
    }

    new Setting(this.containerEl).setName("Basic configuration").setHeading();
    this.addDotThresholdSetting();
    this.addWeekStartSetting();
    this.addConfirmCreateSetting();
    this.addRememberViewStateSetting();
    this.addShowWeeklyNoteSetting();

    new Setting(this.containerEl).setName("UI sizing").setHeading();
    this.addCalendarZoomSetting();
    this.addListViewZoomSetting();

    if (
      this.plugin.options.showWeeklyNote &&
      !appHasPeriodicNotesPluginLoaded(this.app)
    ) {
      new Setting(this.containerEl)
        .setName("Weekly notes")
        .setHeading();
      this.containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Weekly note settings are moving. Install the 'periodic notes' plugin to keep this functionality in the future.",
      });
      this.addWeeklyNoteFormatSetting();
      this.addWeeklyNoteTemplateSetting();
      this.addWeeklyNoteFolderSetting();
    }

    new Setting(this.containerEl).setName("Advanced").setHeading();
    this.addLocaleOverrideSetting();

  }

  addDotThresholdSetting(): void {
    new Setting(this.containerEl)
      .setName("Words per dot")
      .setDesc("How many words should be represented by a single dot?")
      .addText((textfield) => {
        textfield.setPlaceholder(String(DEFAULT_WORDS_PER_DOT));
        textfield.inputEl.type = "number";
        textfield.setValue(String(this.plugin.options.wordsPerDot));
        textfield.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({
              wordsPerDot: value !== "" ? Number(value) : undefined,
            }))
            .catch((err) =>
              console.error("[Calendar] Failed to update words per dot", err)
            );
        });
      });
  }

  addWeekStartSetting(): void {
    const { moment } = window;

    const localizedWeekdays = moment.weekdays();
    const localeWeekStartNum = window._bundledLocaleWeekSpec.dow;
    const localeWeekStart = moment.weekdays()[localeWeekStartNum];

    new Setting(this.containerEl)
      .setName("Start week on:")
      .setDesc(
        "Choose what day of the week to start. Select 'locale default' to use the default specified by moment.js"
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("locale", `Locale default (${localeWeekStart})`);
        localizedWeekdays.forEach((day, i) => {
          dropdown.addOption(weekdays[i], day);
        });
        dropdown.setValue(this.plugin.options.weekStart);
        dropdown.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({
              weekStart: value as IWeekStartOption,
            }))
            .catch((err) =>
              console.error("[Calendar] Failed to update week start", err)
            );
        });
      });
  }

  addConfirmCreateSetting(): void {
    new Setting(this.containerEl)
      .setName("Confirm before creating new note")
      .setDesc("Show a confirmation modal before creating a new note")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.shouldConfirmBeforeCreate);
        toggle.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({
              shouldConfirmBeforeCreate: value,
            }))
            .catch((err) =>
              console.error(
                "[Calendar] Failed to update confirm-before-create setting",
                err
              )
            );
        });
      });
  }

  addRememberViewStateSetting(): void {
    new Setting(this.containerEl)
      .setName("Remember view state")
      .setDesc(
        "Restore the calendar UI across restarts (e.g., displayed month, list view open state, and list toggles)."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.rememberViewState);
        toggle.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({
              rememberViewState: value,
            }))
            .catch((err) =>
              console.error("[Calendar] Failed to update view state persistence", err)
            );
        });
      });
  }

  addShowWeeklyNoteSetting(): void {
    new Setting(this.containerEl)
      .setName("Show week number")
      .setDesc("Enable this to add a column with the week number")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.showWeeklyNote);
        toggle.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({ showWeeklyNote: value }))
            .catch((err) =>
              console.error("[Calendar] Failed to update show week number setting", err)
            );
          this.display(); // show/hide weekly settings
        });
      });
  }

  addWeeklyNoteFormatSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note format")
      .setDesc("For more syntax help, refer to format reference")
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteFormat);
        textfield.setPlaceholder(DEFAULT_WEEK_FORMAT);
        textfield.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({ weeklyNoteFormat: value }))
            .catch((err) =>
              console.error("[Calendar] Failed to update weekly note format", err)
            );
        });
      });
  }

  addWeeklyNoteTemplateSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note template")
      .setDesc(
        "Choose the file you want to use as the template for your weekly notes"
      )
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteTemplate);
        textfield.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({ weeklyNoteTemplate: value }))
            .catch((err) =>
              console.error("[Calendar] Failed to update weekly note template", err)
            );
        });
      });
  }

  addWeeklyNoteFolderSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note folder")
      .setDesc("New weekly notes will be placed here")
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteFolder);
        textfield.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({ weeklyNoteFolder: value }))
            .catch((err) =>
              console.error("[Calendar] Failed to update weekly note folder", err)
            );
        });
      });
  }

  addCalendarZoomSetting(): void {
    new Setting(this.containerEl)
      .setName("Calendar zoom")
      .setDesc("Adjust calendar size (50-200%, default 130%)")
      .addSlider((slider) => {
        slider
          .setLimits(50, 200, 5)
          .setValue(this.plugin.options.calendarZoom)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin
              .writeOptions(() => ({ calendarZoom: value }))
              .catch((err) =>
                console.error("[Calendar] Failed to update calendar zoom", err)
              );
          });
      });
  }

  addListViewZoomSetting(): void {
    new Setting(this.containerEl)
      .setName("List view zoom")
      .setDesc("Adjust list view text size (50-200%, default 95%)")
      .addSlider((slider) => {
        slider
          .setLimits(50, 200, 5)
          .setValue(this.plugin.options.listViewZoom)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin
              .writeOptions(() => ({ listViewZoom: value }))
              .catch((err) =>
                console.error("[Calendar] Failed to update list view zoom", err)
              );
          });
      });
  }

  addLocaleOverrideSetting(): void {
    const { moment } = window;

    const sysLocale = navigator.language?.toLowerCase();

    new Setting(this.containerEl)
      .setName("Override locale:")
      .setDesc(
        "Set this if you want to use a locale different from the default"
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("system-default", `Same as system (${sysLocale})`);
        moment.locales().forEach((locale) => {
          dropdown.addOption(locale, locale);
        });
        dropdown.setValue(this.plugin.options.localeOverride);
        dropdown.onChange((value) => {
          void this.plugin
            .writeOptions(() => ({
              localeOverride: value,
            }))
            .catch((err) =>
              console.error("[Calendar] Failed to update locale override", err)
            );
        });
      });
  }

}

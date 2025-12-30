import type { Moment, WeekSpec } from "moment";
import { App, Plugin, WorkspaceLeaf } from "obsidian";

import type { CustomListTitles } from "src/customListTitles";
import { sanitizeCustomListTitles } from "src/customListTitles";

import type { ListItemColorTags } from "src/listItemColorTags";
import { sanitizeListItemColorTags } from "src/listItemColorTags";

import type { OllamaTitleCache } from "src/ollama/cache";
import { pruneOllamaTitleCache, sanitizeOllamaTitleCache } from "src/ollama/cache";

import { VIEW_TYPE_CALENDAR } from "./constants";
import { customListTitles, listItemColorTags, ollamaTitleCache, settings } from "./ui/stores";
import {
  appHasPeriodicNotesPluginLoaded,
  CalendarSettingsTab,
  defaultSettings,
  ISettings,
} from "./settings";
import CalendarView from "./view";

declare global {
  interface Window {
    app: App;
    moment: () => Moment;
    _bundledLocaleWeekSpec: WeekSpec;
  }
}

type PluginDataV2 = {
  settings: ISettings;
  ollamaTitleCache: OllamaTitleCache;
  customListTitles: CustomListTitles;
  listItemColorTags: ListItemColorTags;
};

export default class CalendarPlugin extends Plugin {
  public options: ISettings;
  private view: CalendarView;

  private isLoadingData = false;
  private saveDataTimer: number | null = null;
  private data: PluginDataV2 = {
    settings: { ...defaultSettings } as ISettings,
    ollamaTitleCache: {},
    customListTitles: {},
    listItemColorTags: {},
  };

  onunload(): void {
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
      this.saveDataTimer = null;
    }

    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CALENDAR)
      .forEach((leaf) => leaf.detach());
  }

  async onload(): Promise<void> {
    this.isLoadingData = true;

    this.register(
      settings.subscribe((value) => {
        this.options = value;
        this.data = { ...this.data, settings: value };
      })
    );

    this.register(
      ollamaTitleCache.subscribe((cache) => {
        this.data = { ...this.data, ollamaTitleCache: cache };
        if (!this.isLoadingData) {
          this.scheduleSaveData();
        }
      })
    );

    this.register(
      customListTitles.subscribe((titles) => {
        this.data = { ...this.data, customListTitles: titles };
        if (!this.isLoadingData) {
          this.scheduleSaveData();
        }
      })
    );

    this.register(
      listItemColorTags.subscribe((tags) => {
        this.data = { ...this.data, listItemColorTags: tags };
        if (!this.isLoadingData) {
          this.scheduleSaveData();
        }
      })
    );

    this.registerView(
      VIEW_TYPE_CALENDAR,
      (leaf: WorkspaceLeaf) => (this.view = new CalendarView(leaf))
    );

    this.addCommand({
      id: "show-calendar-view",
      name: "Open view",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (
            this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length === 0
          );
        }
        this.initLeaf();
      },
    });

    this.addCommand({
      id: "open-weekly-note",
      name: "Open Weekly Note",
      checkCallback: (checking) => {
        if (checking) {
          return !appHasPeriodicNotesPluginLoaded();
        }
        this.view.openOrCreateWeeklyNote(window.moment(), false);
      },
    });

    this.addCommand({
      id: "reveal-active-note",
      name: "Reveal active note",
      callback: () => this.view.revealActiveNote(),
    });

    await this.loadOptions();

    this.addSettingTab(new CalendarSettingsTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeaf();
    } else {
      this.app.workspace.onLayoutReady(this.initLeaf.bind(this));
    }
  }

  initLeaf(): void {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length) {
      return;
    }
    this.app.workspace.getRightLeaf(false).setViewState({
      type: VIEW_TYPE_CALENDAR,
    });
  }

  private scheduleSaveData(): void {
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
    }
    this.saveDataTimer = window.setTimeout(() => {
      this.saveDataTimer = null;
      void this.savePluginData();
    }, 500);
  }

  private async savePluginData(): Promise<void> {
    const maxEntries = this.options?.ollamaTitleCacheMaxEntries;
    const prunedCache = pruneOllamaTitleCache(
      this.data.ollamaTitleCache,
      maxEntries
    );

    // Keep the in-memory store aligned with what we persist.
    if (prunedCache !== this.data.ollamaTitleCache) {
      this.data = { ...this.data, ollamaTitleCache: prunedCache };
      ollamaTitleCache.set(prunedCache);
    }

    await this.saveData({
      settings: this.options,
      ollamaTitleCache: prunedCache,
      customListTitles: this.data.customListTitles,
      listItemColorTags: this.data.listItemColorTags,
    } as PluginDataV2);
  }

  public async clearGeneratedTitles(): Promise<void> {
    ollamaTitleCache.set({});
    await this.savePluginData();
  }

  async loadOptions(): Promise<void> {
    const raw = await this.loadData();

    const isV2 =
      !!raw &&
      typeof raw === "object" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (raw as any).settings === "object";

    // Legacy data was just the settings object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settingsData = (isV2 ? (raw as any).settings : raw) as
      | Partial<ISettings>
      | null
      | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheData = isV2 ? (raw as any).ollamaTitleCache : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customTitlesData = isV2 ? (raw as any).customListTitles : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listItemColorTagsData = isV2 ? (raw as any).listItemColorTags : undefined;

    const mergedSettings = {
      ...defaultSettings,
      ...(settingsData || {}),
    } as ISettings;

    settings.set(mergedSettings);

    const sanitizedCache = pruneOllamaTitleCache(
      sanitizeOllamaTitleCache(cacheData),
      mergedSettings.ollamaTitleCacheMaxEntries
    );
    ollamaTitleCache.set(sanitizedCache);

    const sanitizedCustomTitles = sanitizeCustomListTitles(customTitlesData);
    customListTitles.set(sanitizedCustomTitles);

    const sanitizedListItemColorTags = sanitizeListItemColorTags(
      listItemColorTagsData
    );
    listItemColorTags.set(sanitizedListItemColorTags);

    this.isLoadingData = false;

    // Write back immediately to migrate legacy data shape.
    await this.savePluginData();
  }

  async writeOptions(
    changeOpts: (settings: ISettings) => Partial<ISettings>
  ): Promise<void> {
    settings.update((old) => ({ ...old, ...changeOpts(old) }));
    await this.savePluginData();
  }
}

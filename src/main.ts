import { addIcon, Plugin, type App, type WorkspaceLeaf } from "obsidian";
import type { moment } from "obsidian";

import type { CustomListTitles } from "src/customListTitles";
import { sanitizeCustomListTitles } from "src/customListTitles";

import type { ListItemColorTags } from "src/listItemColorTags";
import { sanitizeListItemColorTags } from "src/listItemColorTags";

import type { OllamaTitleCache } from "src/ollama/cache";
import { pruneOllamaTitleCache, sanitizeOllamaTitleCache } from "src/ollama/cache";

import type { CalendarViewState } from "src/viewState";
import { defaultViewState, sanitizeCalendarViewState } from "src/viewState";

import { VIEW_TYPE_CALENDAR } from "./constants";
import { customListTitles, listItemColorTags, ollamaTitleCache, settings } from "./ui/stores";
import {
  appHasPeriodicNotesPluginLoaded,
  CalendarSettingsTab,
  defaultSettings,
  type ISettings,
} from "./settings";
import CalendarView from "./view";
import {
  buildListItemTagColorSwatchSvg,
  LIST_ITEM_TAG_COLORS,
} from "./ui/listItemColorTagMenu";

type WeekSpec = {
  dow: number;
  doy?: number;
};

type MomentStatic = ((...args: unknown[]) => moment.Moment) & {
  locale: (...args: unknown[]) => string;
  locales: (...args: unknown[]) => string[];
  weekdays: (...args: unknown[]) => string[];
  updateLocale: (...args: unknown[]) => unknown;
};

declare global {
  interface Window {
    app: App;
    moment: MomentStatic;
    _bundledLocaleWeekSpec: WeekSpec;
  }
}

type PluginDataV3 = {
  settings: ISettings;
  ollamaTitleCache: OllamaTitleCache;
  customListTitles: CustomListTitles;
  listItemColorTags: ListItemColorTags;
  viewState: CalendarViewState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function registerListItemColorTagSwatchIcons(): void {
  for (const opt of LIST_ITEM_TAG_COLORS) {
    addIcon(opt.iconId, buildListItemTagColorSwatchSvg(opt.color));
  }
}

export default class CalendarPlugin extends Plugin {
  public options: ISettings = { ...defaultSettings };

  private isLoadingData = false;
  private saveDataTimer: number | null = null;
  private data: PluginDataV3 = {
    settings: { ...defaultSettings } as ISettings,
    ollamaTitleCache: {},
    customListTitles: {},
    listItemColorTags: {},
    viewState: { ...defaultViewState },
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

    registerListItemColorTagSwatchIcons();

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

    this.registerView(VIEW_TYPE_CALENDAR, (leaf: WorkspaceLeaf) => new CalendarView(leaf));

    this.addCommand({
      id: "show-calendar-view",
      name: "Open view",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (
            this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length === 0
          );
        }
        void this.initLeaf();
      },
    });

    this.addCommand({
      id: "open-weekly-note",
      name: "Open weekly note",
      checkCallback: (checking) => {
        if (checking) {
          return !appHasPeriodicNotesPluginLoaded(this.app);
        }

        void this.withCalendarView((view) => {
          view.openOrCreateWeeklyNote(window.moment(), false);
        });
      },
    });

    this.addCommand({
      id: "reveal-active-note",
      name: "Reveal active note",
      callback: () =>
        void this.withCalendarView((view) => {
          view.revealActiveNote();
        }),
    });

    await this.loadOptions();

    this.addSettingTab(new CalendarSettingsTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      void this.initLeaf();
    } else {
      this.app.workspace.onLayoutReady(() => void this.initLeaf());
    }
  }

  private getCalendarView(): CalendarView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
    const view = leaf?.view;

    return view instanceof CalendarView ? view : null;
  }

  private async withCalendarView(
    fn: (view: CalendarView) => void | Promise<void>
  ): Promise<void> {
    await this.initLeaf();

    const view = this.getCalendarView();
    if (!view) {
      console.warn("[Calendar] Calendar view is not available");
      return;
    }

    try {
      await fn(view);
    } catch (err) {
      console.error("[Calendar] Failed to run calendar command", err);
    }
  }

  private async initLeaf(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length) {
      return;
    }

    try {
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        console.warn("[Calendar] Failed to open calendar view: no right leaf available");
        return;
      }

      await leaf.setViewState({
        type: VIEW_TYPE_CALENDAR,
      });
    } catch (err) {
      console.error("[Calendar] Failed to open calendar view", err);
    }
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

    const viewStateToSave = this.options?.rememberViewState
      ? this.data.viewState
      : defaultViewState;

    await this.saveData({
      settings: this.options,
      ollamaTitleCache: prunedCache,
      customListTitles: this.data.customListTitles,
      listItemColorTags: this.data.listItemColorTags,
      viewState: viewStateToSave,
    } as PluginDataV3);
  }

  public async clearGeneratedTitles(): Promise<void> {
    ollamaTitleCache.set({});
    await this.savePluginData();
  }

  async loadOptions(): Promise<void> {
    const raw = (await this.loadData()) as unknown;

    const rawRecord = isRecord(raw) ? raw : null;
    const settingsValue = rawRecord ? rawRecord["settings"] : undefined;

    const isV2 = isRecord(settingsValue);

    // Legacy data was just the settings object.
    const settingsData = (isV2 ? settingsValue : raw) as
      | Partial<ISettings>
      | null
      | undefined;

    const cacheData = isV2 ? rawRecord?.["ollamaTitleCache"] : undefined;
    const customTitlesData = isV2 ? rawRecord?.["customListTitles"] : undefined;
    const listItemColorTagsData = isV2 ? rawRecord?.["listItemColorTags"] : undefined;
    const viewStateData = isV2 ? rawRecord?.["viewState"] : undefined;

    const settingsObj: Partial<ISettings> =
      settingsData && typeof settingsData === "object" ? settingsData : {};

    const mergedSettings: ISettings = {
      ...defaultSettings,
      ...settingsObj,
    };

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

    this.data = {
      ...this.data,
      viewState: sanitizeCalendarViewState(viewStateData),
    };

    this.isLoadingData = false;

    // Write back immediately to migrate legacy data shape.
    await this.savePluginData();
  }

  /**
   * Read the persisted UI state for the calendar view.
   * This is used by the Svelte UI to restore the last session (when enabled).
   */
  public getViewState(): CalendarViewState {
    const vs = this.data.viewState ?? defaultViewState;
    return {
      showList: !!vs.showList,
      displayedMonth: vs.displayedMonth ?? null,
      groupOpenState: { ...(vs.groupOpenState ?? {}) },
      dayOpenState: { ...(vs.dayOpenState ?? {}) },
      dayChildOpenState: { ...(vs.dayChildOpenState ?? {}) },
    };
  }

  /**
   * Update the persisted UI state.
   * This is intentionally fire-and-forget; persistence is debounced by the plugin.
   */
  public updateViewState(partial: Partial<CalendarViewState>): void {
    const merged = sanitizeCalendarViewState({
      ...(this.data.viewState ?? defaultViewState),
      ...(partial ?? {}),
    });

    this.data = { ...this.data, viewState: merged };

    if (!this.isLoadingData && this.options?.rememberViewState) {
      this.scheduleSaveData();
    }
  }

  async writeOptions(
    changeOpts: (settings: ISettings) => Partial<ISettings>
  ): Promise<void> {
    settings.update((old) => ({ ...old, ...changeOpts(old) }));
    await this.savePluginData();
  }
}

import type { moment } from "obsidian";
import type { ICalendarSource } from "obsidian-calendar-ui";
import {
  getDailyNote,
  getDailyNoteSettings,
  getDateFromFile,
  getWeeklyNote,
  getWeeklyNoteSettings,
} from "obsidian-daily-notes-interface";
import { FileView, TFile, ItemView } from "obsidian";
import type { Events, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { mount, unmount, type ComponentProps } from "svelte";
import { get } from "svelte/store";

import { TRIGGER_ON_OPEN, VIEW_TYPE_CALENDAR } from "src/constants";
import { tryToCreateDailyNote } from "src/io/dailyNotes";
import { tryToCreateWeeklyNote } from "src/io/weeklyNotes";
import type { ISettings } from "src/settings";

import Calendar from "./ui/Calendar.svelte";
import { showFileMenu } from "./ui/fileMenu";

type CalendarProps = ComponentProps<typeof Calendar>;

type CalendarExports = {
  tick: () => void;
  requestListRefresh?: () => void;
  setDisplayedMonth?: (month: moment.Moment) => void;
};
import {
  activeFile,
  activeFilePath,
  dailyNotes,
  weeklyNotes,
  settings,
} from "./ui/stores";
import {
  customTagsSource,
  streakSource,
  tasksSource,
  wordCountSource,
} from "./ui/sources";

type Moment = moment.Moment;

function isPerfDebugEnabled(): boolean {
  try {
    return window.localStorage?.getItem("calendar-debug-perf") === "1";
  } catch {
    return false;
  }
}

function perfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

type MetadataPerfState = {
  inFlight: number;
  burstId: number;
  burstStart: number;
  calls: number;
  dailyCalls: number;
  weeklyCalls: number;
  perSourceMs: Record<string, number>;
  perSourceCalls: Record<string, number>;
};

function instrumentSourcesForPerf(sources: ICalendarSource[]): ICalendarSource[] {
  if (!isPerfDebugEnabled()) {
    return sources;
  }

  // Keep perf state scoped to this particular Calendar view instance.
  const perf: MetadataPerfState = {
    inFlight: 0,
    burstId: 0,
    burstStart: 0,
    calls: 0,
    dailyCalls: 0,
    weeklyCalls: 0,
    perSourceMs: {},
    perSourceCalls: {},
  };

  const knownNames = new Map<ICalendarSource, string>([
    [customTagsSource, "tags"],
    [streakSource, "streak"],
    [wordCountSource, "wordCount"],
    [tasksSource, "tasks"],
  ]);

  const startOp = (sourceName: string, kind: "daily" | "weekly"): number => {
    const now = perfNow();

    if (perf.inFlight === 0) {
      perf.burstId += 1;
      perf.burstStart = now;
      perf.calls = 0;
      perf.dailyCalls = 0;
      perf.weeklyCalls = 0;
      perf.perSourceMs = {};
      perf.perSourceCalls = {};
    }

    perf.inFlight += 1;
    perf.calls += 1;
    if (kind === "daily") {
      perf.dailyCalls += 1;
    } else {
      perf.weeklyCalls += 1;
    }

    perf.perSourceCalls[sourceName] = (perf.perSourceCalls[sourceName] ?? 0) + 1;
    return now;
  };

  const endOp = (sourceName: string, startedAt: number): void => {
    const now = perfNow();
    perf.perSourceMs[sourceName] = (perf.perSourceMs[sourceName] ?? 0) + (now - startedAt);

    perf.inFlight -= 1;
    if (perf.inFlight !== 0) {
      return;
    }

    const wall = now - perf.burstStart;
    const top = Object.entries(perf.perSourceMs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, ms]) => {
        const calls = perf.perSourceCalls[name] ?? 0;
        return `${name}=${ms.toFixed(1)}ms(${calls})`;
      })
      .join(", ");

    console.debug(
      `[Calendar][perf] metadata burst #${perf.burstId}: wall=${wall.toFixed(
        1
      )}ms calls=${perf.calls} (daily=${perf.dailyCalls}, weekly=${perf.weeklyCalls}) top: ${top}`
    );
  };

  return sources.map((source, i) => {
    const maybeNamed = source as unknown as { name?: unknown };
    const nameFromProp =
      typeof maybeNamed?.name === "string" && maybeNamed.name.trim()
        ? maybeNamed.name.trim()
        : null;

    const name = knownNames.get(source) ?? nameFromProp ?? `source#${i + 1}`;

    const wrap = <T>(
      kind: "daily" | "weekly",
      fn: ((date: Moment) => Promise<T>) | undefined
    ): ((date: Moment) => Promise<T>) | undefined => {
      if (typeof fn !== "function") {
        return fn;
      }

      return async (date: Moment) => {
        const startedAt = startOp(name, kind);
        try {
          // Preserve `this` just in case a source relies on it.
          return await (fn as (this: unknown, date: Moment) => Promise<T>).call(
            source,
            date
          );
        } finally {
          endOp(name, startedAt);
        }
      };
    };

    return {
      ...source,
      getDailyMetadata: wrap("daily", source.getDailyMetadata),
      getWeeklyMetadata: wrap("weekly", source.getWeeklyMetadata),
    };
  });
}

export default class CalendarView extends ItemView {
  private calendar: CalendarExports | null = null;
  private settings: ISettings = get(settings);

  // Coalesce refresh bursts from vault events (save storms, batch ops, etc.)
  private calendarTickTimer: number | null = null;
  private listRefreshTimer: number | null = null;

  private isMetaPressed = false;

  private static readonly CALENDAR_REFRESH_DEBOUNCE_MS = 200;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);

    // Track whether the user is holding Ctrl/Cmd so we can match Obsidian's hover-preview behavior.
    this.registerDomEvent(window, "keydown", (event) => {
      this.isMetaPressed = event.metaKey || event.ctrlKey;
    });
    this.registerDomEvent(window, "keyup", (event) => {
      this.isMetaPressed = event.metaKey || event.ctrlKey;
    });
    this.registerDomEvent(window, "blur", () => {
      this.isMetaPressed = false;
    });

    // Periodic Notes doesn't expose typed events in the Obsidian API; use the generic Events API.
    this.registerEvent(
      (this.app.workspace as unknown as Events).on(
        "periodic-notes:settings-updated",
        () => this.onNoteSettingsUpdate()
      )
    );

    this.registerEvent(this.app.vault.on("create", (file) => this.onFileCreated(file)));
    this.registerEvent(
      this.app.vault.on("delete", (file) => void this.onFileDeleted(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => void this.onFileModified(file))
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpen(file))
    );

    this.register(
      settings.subscribe((val) => {
        this.settings = val;

        // Refresh the calendar if settings change.
        this.scheduleCalendarTick();
      })
    );
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR;
  }

  getDisplayText(): string {
    return "Calendar";
  }

  getIcon(): string {
    return "calendar-with-checkmark";
  }

  async onClose(): Promise<void> {
    if (this.calendarTickTimer !== null) {
      window.clearTimeout(this.calendarTickTimer);
      this.calendarTickTimer = null;
    }
    if (this.listRefreshTimer !== null) {
      window.clearTimeout(this.listRefreshTimer);
      this.listRefreshTimer = null;
    }

    if (this.calendar) {
      await unmount(this.calendar);
      this.calendar = null;
    }
  }

  async onOpen(): Promise<void> {
    // Integration point: external plugins can listen for `calendar:open`
    // to feed in additional sources.
    const sources: ICalendarSource[] = [
      customTagsSource,
      streakSource,
      wordCountSource,
      tasksSource,
    ];
    this.app.workspace.trigger(TRIGGER_ON_OPEN, sources);

    const instrumentedSources = instrumentSourcesForPerf(sources);

    this.calendar = mount<CalendarProps, CalendarExports>(Calendar, {
      target: this.contentEl,
      props: {
        onClickDay: (date: Moment, isMetaPressed: boolean) =>
          this.openOrCreateDailyNote(date, isMetaPressed),
        onClickWeek: (date: Moment, isMetaPressed: boolean) =>
          this.openOrCreateWeeklyNote(date, isMetaPressed),
        onHoverDay: (date: Moment, targetEl: EventTarget) =>
          this.onHoverDay(date, targetEl),
        onHoverWeek: (date: Moment, targetEl: EventTarget) =>
          this.onHoverWeek(date, targetEl),
        onContextMenuDay: (date: Moment, event: MouseEvent) =>
          this.onContextMenuDay(date, event),
        onContextMenuWeek: (date: Moment, event: MouseEvent) =>
          this.onContextMenuWeek(date, event),
        sources: instrumentedSources,
      },
    });
  }

  onHoverDay(date: Moment, targetEl: EventTarget): void {
    if (!this.isMetaPressed) {
      return;
    }
    const { format } = getDailyNoteSettings();
    const note = getDailyNote(date, get(dailyNotes));
    this.app.workspace.trigger(
      "link-hover",
      this,
      targetEl,
      date.format(format),
      note?.path
    );
  }

  onHoverWeek(date: Moment, targetEl: EventTarget): void {
    if (!this.isMetaPressed) {
      return;
    }
    const note = getWeeklyNote(date, get(weeklyNotes));
    const { format } = getWeeklyNoteSettings();
    this.app.workspace.trigger(
      "link-hover",
      this,
      targetEl,
      date.format(format),
      note?.path
    );
  }

  private onContextMenuDay(date: Moment, event: MouseEvent): boolean {
    const note = getDailyNote(date, get(dailyNotes));
    if (!note) {
      // If no file exists for a given day, show nothing.
      return false;
    }
    showFileMenu(this.app, note, {
      x: event.pageX,
      y: event.pageY,
    });
    return true;
  }

  private onContextMenuWeek(date: Moment, event: MouseEvent): boolean {
    const note = getWeeklyNote(date, get(weeklyNotes));
    if (!note) {
      // If no file exists for a given day, show nothing.
      return false;
    }
    showFileMenu(this.app, note, {
      x: event.pageX,
      y: event.pageY,
    });
    return true;
  }

  private onNoteSettingsUpdate(): void {
    dailyNotes.reindex();
    weeklyNotes.reindex();
    this.updateActiveFile();
    this.scheduleCalendarTick();
  }

  private async onFileDeleted(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) {
      return;
    }

    if (getDateFromFile(file, "day")) {
      dailyNotes.reindex();
      this.updateActiveFile();
      this.scheduleCalendarTick();
    }
    if (getDateFromFile(file, "week")) {
      weeklyNotes.reindex();
      this.updateActiveFile();
      this.scheduleCalendarTick();
    }
  }

  private async onFileModified(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) {
      return;
    }

    const dailyDate = getDateFromFile(file, "day");
    const date = dailyDate || getDateFromFile(file, "week");

    if (date) {
      this.scheduleCalendarTick();
    }

    // List view filtering depends on file contents (word count), so refresh it
    // when a daily note changes.
    if (dailyDate) {
      this.scheduleListRefresh();
    }
  }

  private onFileCreated(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    if (this.app.workspace.layoutReady && this.calendar) {
      if (getDateFromFile(file, "day")) {
        dailyNotes.reindex();
        this.scheduleCalendarTick();
      }
      if (getDateFromFile(file, "week")) {
        weeklyNotes.reindex();
        this.scheduleCalendarTick();
      }
    }
  }

  public onFileOpen(_file: TFile | null): void {
    if (this.app.workspace.layoutReady) {
      this.updateActiveFile();
    }
  }

  private updateActiveFile(): void {
    const view = this.app.workspace.getActiveViewOfType(FileView);
    const file = view?.file ?? null;

    activeFile.setFile(file);
    activeFilePath.setFile(file);
  }

  private scheduleCalendarTick(): void {
    if (!this.calendar) {
      return;
    }

    if (this.calendarTickTimer !== null) {
      window.clearTimeout(this.calendarTickTimer);
    }

    this.calendarTickTimer = window.setTimeout(() => {
      this.calendarTickTimer = null;
      this.calendar?.tick();
    }, CalendarView.CALENDAR_REFRESH_DEBOUNCE_MS);
  }

  private scheduleListRefresh(): void {
    if (!this.calendar) {
      return;
    }

    const refreshList = this.calendar.requestListRefresh;
    if (typeof refreshList !== "function") {
      return;
    }

    if (this.listRefreshTimer !== null) {
      window.clearTimeout(this.listRefreshTimer);
    }

    this.listRefreshTimer = window.setTimeout(() => {
      this.listRefreshTimer = null;
      const fn = this.calendar?.requestListRefresh;
      if (typeof fn === "function") {
        fn();
      }
    }, CalendarView.CALENDAR_REFRESH_DEBOUNCE_MS);
  }

  public revealActiveNote(): void {
    const { moment } = window;

    if (!this.calendar || typeof this.calendar.setDisplayedMonth !== "function") {
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(FileView);
    const file = view?.file;
    if (!file) {
      return;
    }

    // Check to see if the active note is a daily-note
    let date = getDateFromFile(file, "day");
    if (date) {
      this.calendar.setDisplayedMonth(date);
      return;
    }

    // Check to see if the active note is a weekly-note
    const { format } = getWeeklyNoteSettings();
    date = moment(file.basename, format, true);
    if (date.isValid()) {
      this.calendar.setDisplayedMonth(date);
    }
  }

  openOrCreateWeeklyNote(date: Moment, inNewSplit: boolean): void {
    void this.openOrCreateWeeklyNoteAsync(date, inNewSplit).catch((err) =>
      console.error("[Calendar] Failed to open or create weekly note", err)
    );
  }

  private async openOrCreateWeeklyNoteAsync(
    date: Moment,
    inNewSplit: boolean
  ): Promise<void> {
    const { workspace } = this.app;

    const startOfWeek = date.clone().startOf("week");

    const existingFile = getWeeklyNote(date, get(weeklyNotes));

    if (!existingFile) {
      // File doesn't exist
      await tryToCreateWeeklyNote(startOfWeek, inNewSplit, this.settings, (file) => {
        activeFile.setFile(file);
        activeFilePath.setFile(file);
      });
      return;
    }

    const leaf = inNewSplit
      ? workspace.getLeaf(true)
      : workspace.getLeaf(false);
    await leaf.openFile(existingFile);

    activeFile.setFile(existingFile);
    activeFilePath.setFile(existingFile);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  openOrCreateDailyNote(date: Moment, inNewSplit: boolean): void {
    void this.openOrCreateDailyNoteAsync(date, inNewSplit).catch((err) =>
      console.error("[Calendar] Failed to open or create daily note", err)
    );
  }

  private async openOrCreateDailyNoteAsync(
    date: Moment,
    inNewSplit: boolean
  ): Promise<void> {
    const { workspace } = this.app;
    const existingFile = getDailyNote(date, get(dailyNotes));
    if (!existingFile) {
      // File doesn't exist
      await tryToCreateDailyNote(
        date,
        inNewSplit,
        this.settings,
        (dailyNote: TFile) => {
          activeFile.setFile(dailyNote);
          activeFilePath.setFile(dailyNote);
        }
      );
      return;
    }

    const leaf = inNewSplit
      ? workspace.getLeaf(true)
      : workspace.getLeaf(false);
    await leaf.openFile(existingFile, { active: true });

    activeFile.setFile(existingFile);
    activeFilePath.setFile(existingFile);
  }
}

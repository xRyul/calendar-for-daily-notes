<svelte:options immutable />

<script lang="ts">
  import type { Moment } from "moment";
  import {
    Calendar as CalendarBase,
    configureGlobalMomentLocale,
  } from "obsidian-calendar-ui";
  import type { ICalendarSource } from "obsidian-calendar-ui";
  import { onDestroy, onMount, tick as svelteTick } from "svelte";
  import { slide } from "svelte/transition";
  import { Menu, Notice, TFile } from "obsidian";
  import type { EventRef } from "obsidian";
  import { getDateFromFile, getDateUID } from "obsidian-daily-notes-interface";

  import ListGroup from "./ListGroup.svelte";

  import {
    buildListGroups,
    buildListItems,
    getListGroupIdPathForDate,
    normalizeListViewGroupingPreset,
    normalizeListViewSortOrder,
  } from "./listViewModel";
  import type {
    CreatedOnDayBucket,
    DailyNoteCandidate,
    ListGroupNode,
    ListItem,
    ListViewGroupingPreset,
    ListViewSortOrder,
  } from "./listViewModel";
  import {
    createOllamaClient,
    isModelInstalled,
    normalizeOllamaBaseUrl,
    safeParseJson,
  } from "src/ollama/client";
  import type { OllamaGenerateResponse } from "src/ollama/client";
  import { upsertOllamaTitleCacheEntry } from "src/ollama/cache";
  import type { OllamaTitleCache } from "src/ollama/cache";
  import {
    buildDailyTitlePrompt,
    DAILY_TITLE_SCHEMA,
    formatDailyTitleLabel,
    parseDailyTitleParts,
    prepareNoteTextForOllama,
  } from "src/ollama/title";

  import type { CustomListTitles } from "src/customListTitles";
  import {
    formatCustomListTitleLabel,
    normalizeCustomListTitleInput,
  } from "src/customListTitles";

  import type { ISettings } from "src/settings";
  import type { CalendarViewState } from "src/viewState";
  import {
    activeFile,
    customListTitles,
    dailyNotes,
    listItemColorTags,
    ollamaTitleCache,
    settings,
    weeklyNotes,
  } from "./stores";
  import { getWordCount as getWordCountFromFile } from "./noteMetrics";

  let today: Moment;

  $: today = getToday($settings);

  export let displayedMonth: Moment = today;
  export let sources: ICalendarSource[];
  export let onHoverDay: (date: Moment, targetEl: EventTarget) => boolean;
  export let onHoverWeek: (date: Moment, targetEl: EventTarget) => boolean;
  export let onClickDay: (date: Moment, isMetaPressed: boolean) => boolean;
  export let onClickWeek: (date: Moment, isMetaPressed: boolean) => boolean;
  export let onContextMenuDay: (date: Moment, event: MouseEvent) => boolean;
  export let onContextMenuWeek: (date: Moment, event: MouseEvent) => boolean;

  let showList = false;
  let showListJustOpened = false;

  // Prevent initial reactive writes from clobbering the persisted state before we've restored it.
  let viewStateHydrated = false;

  let calendarBaseWrapperEl: HTMLDivElement | null = null;
  let listScrollEl: HTMLDivElement | null = null;

  // Inserted into the Calendar header (nav) after mount.
  let listControlsEl: HTMLDivElement | null = null;
  let listToggleButtonEl: HTMLButtonElement | null = null;

  let listTogglePositioned = false;

  let ollamaSettingsButtonEl: HTMLButtonElement | null = null;
  let ollamaMenuEl: HTMLDivElement | null = null;
  let showOllamaMenu = false;

  // When a dropdown/menu is inside a scrollable container, it can be clipped by ancestor overflow
  // (common in Obsidian panes). Portal the menu to <body> and position it with fixed coordinates.
  let ollamaMenuTop = 0;
  let ollamaMenuLeft = 0;
  let ollamaMenuMaxHeight = 0;

  function portalToBody(node: HTMLElement) {
    // Obsidian runs in a DOM environment; move the node so it isn't clipped by pane overflow.
    document.body.appendChild(node);

    return {
      // IMPORTANT: do not remove the node here. Svelte will detach it during teardown.
      destroy() {},
    };
  }

  function computeOllamaMenuPositionFromAnchor(
    anchorEl: HTMLElement,
    menuEl: HTMLElement
  ): { top: number; left: number; maxHeight: number } {
    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();

    const padding = 8;
    const gap = 6;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const spaceDown = viewportH - padding - (anchorRect.bottom + gap);
    const spaceUp = anchorRect.top - padding - gap;

    // Prefer opening down unless there is clearly more room above.
    const openUp = spaceDown < Math.min(220, menuRect.height) && spaceUp > spaceDown;

    let maxHeight = Math.max(140, Math.floor(openUp ? spaceUp : spaceDown));

    // Align menu right edge to the anchor right edge.
    let left = anchorRect.right - menuRect.width;
    left = Math.max(padding, Math.min(left, viewportW - menuRect.width - padding));

    let top: number;
    if (openUp) {
      // Place the menu so its bottom hugs the anchor.
      const desiredBottom = anchorRect.top - gap;
      top = Math.max(padding, desiredBottom - Math.min(menuRect.height, maxHeight));
      // Recompute maxHeight in case clamping changed available space.
      maxHeight = Math.max(140, Math.floor(desiredBottom - padding));
    } else {
      top = anchorRect.bottom + gap;
      maxHeight = Math.max(140, Math.floor(viewportH - padding - top));
    }

    return {
      top: Math.round(top),
      left: Math.round(left),
      maxHeight,
    };
  }

  function positionOllamaMenu(): void {
    if (!showOllamaMenu || !ollamaSettingsButtonEl || !ollamaMenuEl) {
      return;
    }

    const pos = computeOllamaMenuPositionFromAnchor(
      ollamaSettingsButtonEl,
      ollamaMenuEl
    );
    ollamaMenuTop = pos.top;
    ollamaMenuLeft = pos.left;
    ollamaMenuMaxHeight = pos.maxHeight;
  }

  // Floating tooltip (portaled to <body>) so it won't be clipped by the menu's scroll container.
  let tooltipEl: HTMLDivElement | null = null;
  let tooltipText = "";
  let showTooltip = false;
  let tooltipTop = 0;
  let tooltipLeft = 0;
  let tooltipAnchorEl: HTMLElement | null = null;

  function hideTooltip(): void {
    showTooltip = false;
    tooltipAnchorEl = null;
  }

  function positionTooltip(): void {
    if (!showTooltip || !tooltipAnchorEl || !tooltipEl) {
      return;
    }

    const anchorRect = tooltipAnchorEl.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();

    const padding = 8;
    const gap = 6;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const spaceUp = anchorRect.top - padding - gap;
    const spaceDown = viewportH - padding - (anchorRect.bottom + gap);
    const openUp = spaceUp >= tipRect.height || spaceUp > spaceDown;

    let top = openUp
      ? anchorRect.top - gap - tipRect.height
      : anchorRect.bottom + gap;

    // Center horizontally to the icon.
    let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;

    // Clamp within viewport.
    top = Math.max(padding, Math.min(top, viewportH - tipRect.height - padding));
    left = Math.max(padding, Math.min(left, viewportW - tipRect.width - padding));

    tooltipTop = Math.round(top);
    tooltipLeft = Math.round(left);
  }

  async function showTooltipFor(el: HTMLElement): Promise<void> {
    // NOTE: Obsidian core uses attributes like `data-tooltip` / `aria-label` to render its own tooltips.
    // Use a plugin-scoped attribute to avoid double-tooltips.
    const text =
      el.getAttribute("data-calendar-tooltip") ||
      el.getAttribute("data-tooltip") ||
      el.getAttribute("aria-label") ||
      "";
    if (!text) {
      hideTooltip();
      return;
    }

    tooltipText = text;
    tooltipAnchorEl = el;

    // Seed a reasonable initial position to avoid flashing at (0,0) before we can measure.
    const rect = el.getBoundingClientRect();
    const padding = 8;
    const gap = 6;
    tooltipTop = Math.round(rect.bottom + gap);
    tooltipLeft = Math.round(
      Math.max(padding, Math.min(rect.left, window.innerWidth - padding))
    );

    showTooltip = true;

    await svelteTick();
    positionTooltip();
  }

  function onTipEnter(event: Event): void {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) {
      return;
    }
    void showTooltipFor(el);
  }

  function onTipLeave(): void {
    hideTooltip();
  }

  const OLLAMA_PULL_MODEL = "gemma3:4b";

  // Unique IDs for menu fields (avoid collisions if multiple Calendar views are open).
  const ollamaIdPrefix = `calendar-ollama-${Math.random().toString(36).slice(2, 8)}`;
  const listGroupingPresetInputId = `${ollamaIdPrefix}-list-grouping`;
  const listSortOrderInputId = `${ollamaIdPrefix}-list-sort-order`;
  const listMinWordsInputId = `${ollamaIdPrefix}-list-minwords`;
  const listIncludeCreatedInputId = `${ollamaIdPrefix}-list-include-created`;
  const listShowCountsInputId = `${ollamaIdPrefix}-list-show-counts`;
  const ollamaUrlInputId = `${ollamaIdPrefix}-url`;
  const ollamaModelInputId = `${ollamaIdPrefix}-model`;
  const ollamaMaxCharsInputId = `${ollamaIdPrefix}-maxchars`;
  const ollamaTimeoutInputId = `${ollamaIdPrefix}-timeout`;
  const ollamaCacheInputId = `${ollamaIdPrefix}-cache`;

  let pullingModel = false;

  type OllamaStatusState = "idle" | "checking" | "ok" | "error";
  let ollamaStatusState: OllamaStatusState = "idle";
  let ollamaStatusLabel = "";
  let ollamaStatusDetails = "";

  function getCalendarPlugin(): any | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).app;
      return app?.plugins?.getPlugin?.("calendar") ?? null;
    } catch {
      return null;
    }
  }

  async function writeOptions(partial: Partial<ISettings>): Promise<void> {
    try {
      const plugin = getCalendarPlugin();
      if (plugin?.writeOptions) {
        await plugin.writeOptions(() => partial);
        return;
      }

      // Fallback: updates UI but won't persist.
      settings.update((old) => ({ ...old, ...partial }));
    } catch (err) {
      console.error("[Calendar] Failed to write options", err);
    }
  }

  function readViewState(): CalendarViewState | null {
    try {
      const plugin = getCalendarPlugin();
      const fn = plugin?.getViewState;
      return typeof fn === "function" ? (fn.call(plugin) as CalendarViewState) : null;
    } catch {
      return null;
    }
  }

  function writeViewState(partial: Partial<CalendarViewState>): void {
    try {
      const plugin = getCalendarPlugin();
      const fn = plugin?.updateViewState;
      if (typeof fn === "function") {
        fn.call(plugin, partial);
      }
    } catch (err) {
      console.error("[Calendar] Failed to update view state", err);
    }
  }

  let viewStateSaveTimer: number | null = null;
  let pendingViewState: Partial<CalendarViewState> = {};
  const VIEW_STATE_SAVE_DEBOUNCE_MS = 300;

  function schedulePersistViewState(partial: Partial<CalendarViewState>): void {
    if (!viewStateHydrated || !$settings.rememberViewState) {
      return;
    }

    pendingViewState = { ...(pendingViewState ?? {}), ...(partial ?? {}) };

    if (viewStateSaveTimer !== null) {
      window.clearTimeout(viewStateSaveTimer);
    }

    viewStateSaveTimer = window.setTimeout(() => {
      viewStateSaveTimer = null;
      const snapshot = pendingViewState;
      pendingViewState = {};
      writeViewState(snapshot);
    }, VIEW_STATE_SAVE_DEBOUNCE_MS);
  }

  function formatDisplayedMonthForStorage(month: Moment | null | undefined): string | null {
    try {
      if (!month || typeof month.isValid !== "function" || !month.isValid()) {
        return null;
      }
      return month.clone().startOf("month").format("YYYY-MM-DD");
    } catch {
      return null;
    }
  }

  async function clearGeneratedTitles(): Promise<void> {
    try {
      const plugin = getCalendarPlugin();
      if (plugin?.clearGeneratedTitles) {
        await plugin.clearGeneratedTitles();
        new Notice("Cleared generated titles.");
        return;
      }

      ollamaTitleCache.set({});
      new Notice("Cleared generated titles.");
    } catch (err) {
      console.error("[Calendar] Failed to clear generated titles", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to clear generated titles: ${msg}`);
    }
  }

  async function refreshOllamaStatus(): Promise<void> {
    const enabled = !!$settings.ollamaTitlesEnabled;
    const baseUrl = $settings.ollamaBaseUrl ?? "http://127.0.0.1:11434";
    const model = $settings.ollamaModel ?? "gemma3:4b";
    const timeoutMs = $settings.ollamaRequestTimeoutMs ?? 15000;

    if (!enabled) {
      ollamaStatusState = "idle";
      ollamaStatusLabel = "Off";
      ollamaStatusDetails = "";
      return;
    }

    ollamaStatusState = "checking";
    ollamaStatusLabel = "Checking…";
    ollamaStatusDetails = "";

    try {
      const client = createOllamaClient({ baseUrl, timeoutMs });
      const version = await client.getVersion();
      const tags = await client.listModels();

      const versionStr = version?.version ? `v${version.version}` : "v?";
      const installed = isModelInstalled(tags, model);

      ollamaStatusState = "ok";
      ollamaStatusLabel = `Reachable ${versionStr}`;
      ollamaStatusDetails = installed
        ? `Model ${model}: installed`
        : `Model ${model}: not installed`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ollamaStatusState = "error";
      ollamaStatusLabel = "Unreachable";
      ollamaStatusDetails = msg;
    }
  }

  async function onToggleOllamaEnabled(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    const enabled = !!el?.checked;
    await writeOptions({ ollamaTitlesEnabled: enabled });

    if (enabled) {
      void refreshOllamaStatus();
    } else {
      ollamaStatusState = "idle";
      ollamaStatusLabel = "Off";
      ollamaStatusDetails = "";
    }

    // Menu height changes when toggling on/off; reposition to avoid clipping.
    if (showOllamaMenu) {
      await svelteTick();
      positionOllamaMenu();
      positionTooltip();
    }
  }

  async function toggleOllamaMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    showOllamaMenu = !showOllamaMenu;

    if (showOllamaMenu) {
      // Seed a reasonable initial position to avoid a flash at (0,0) before we can measure.
      if (ollamaSettingsButtonEl) {
        const rect = ollamaSettingsButtonEl.getBoundingClientRect();
        const padding = 8;
        const gap = 6;
        const widthGuess = 310;

        ollamaMenuTop = Math.round(rect.bottom + gap);
        ollamaMenuLeft = Math.round(
          Math.max(
            padding,
            Math.min(rect.right - widthGuess, window.innerWidth - widthGuess - padding)
          )
        );
        ollamaMenuMaxHeight = Math.max(
          140,
          Math.floor(window.innerHeight - padding - ollamaMenuTop)
        );
      }

      await svelteTick();
      positionOllamaMenu();

      if ($settings.ollamaTitlesEnabled) {
        void refreshOllamaStatus();
      }
    }
  }

  function parseNumberOrUndef(input: string): number | undefined {
    const trimmed = (input ?? "").trim();
    if (!trimmed) {
      return undefined;
    }

    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }

  async function onChangeListViewGroupingPreset(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLSelectElement;
    const value = (el?.value ?? "").trim() as ListViewGroupingPreset;
    await writeOptions({ listViewGroupingPreset: value });
  }

  async function onChangeListViewSortOrder(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLSelectElement;
    const value = (el?.value ?? "").trim() as ListViewSortOrder;
    await writeOptions({ listViewSortOrder: value });
  }

  async function onChangeListViewMinWords(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    const raw = el?.value ?? "";

    const parsed = raw === "" ? 0 : Number(raw);
    const next = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    await writeOptions({ listViewMinWords: next });
  }

  async function onToggleListViewIncludeCreatedDays(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    await writeOptions({ listViewIncludeCreatedDays: !!el?.checked });
  }

  async function onToggleListViewShowCounts(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    await writeOptions({ listViewShowCounts: !!el?.checked });
  }

  async function onChangeOllamaBaseUrl(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    const next = normalizeOllamaBaseUrl(el?.value ?? "");
    await writeOptions({ ollamaBaseUrl: next });

    if (showOllamaMenu && $settings.ollamaTitlesEnabled) {
      void refreshOllamaStatus();
    }
  }

  async function onChangeOllamaModel(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    const next = (el?.value ?? "").trim();
    await writeOptions({ ollamaModel: next });

    if (showOllamaMenu && $settings.ollamaTitlesEnabled) {
      void refreshOllamaStatus();
    }
  }

  async function onChangeOllamaMaxChars(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    await writeOptions({
      ollamaMaxChars: parseNumberOrUndef(el?.value ?? ""),
    });
  }

  async function onChangeOllamaTimeout(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    await writeOptions({
      ollamaRequestTimeoutMs: parseNumberOrUndef(el?.value ?? ""),
    });

    if (showOllamaMenu && $settings.ollamaTitlesEnabled) {
      void refreshOllamaStatus();
    }
  }

  async function onChangeOllamaCacheSize(event: Event): Promise<void> {
    const el = event.currentTarget as HTMLInputElement;
    await writeOptions({
      ollamaTitleCacheMaxEntries: parseNumberOrUndef(el?.value ?? ""),
    });
  }

  async function onClickPullModel(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    if (pullingModel) {
      return;
    }

    pullingModel = true;
    try {
      const baseUrl = $settings.ollamaBaseUrl ?? "http://127.0.0.1:11434";
      const timeoutMs = $settings.ollamaRequestTimeoutMs ?? 15000;
      const client = createOllamaClient({ baseUrl, timeoutMs });

      new Notice(`Pulling ${OLLAMA_PULL_MODEL}…`);
      const res = await client.pullModel(OLLAMA_PULL_MODEL);
      if (res?.error) {
        throw new Error(res.error);
      }
      new Notice(`Pulled ${OLLAMA_PULL_MODEL}.`);

      void refreshOllamaStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Calendar] Failed to pull model", err);
      new Notice(`Failed to pull ${OLLAMA_PULL_MODEL}: ${msg}`);
    } finally {
      pullingModel = false;
    }
  }

  // Responsive scaling: when the view gets narrow, scale down the calendar (and header)
  // so we can still show all 7 day columns without horizontal scroll.
  // Tuned for the Obsidian right sidebar: ~273px is the minimum before the pane collapses.
  const CALENDAR_SCALE_FULL_WIDTH_PX = 398;
  const CALENDAR_SCALE_MIN_WIDTH_PX = 273;
  const CALENDAR_SCALE_MIN = CALENDAR_SCALE_MIN_WIDTH_PX / CALENDAR_SCALE_FULL_WIDTH_PX;

  function updateCalendarScale(): void {
    if (!calendarBaseWrapperEl) {
      return;
    }

    const width = calendarBaseWrapperEl.getBoundingClientRect().width;
    if (!Number.isFinite(width) || width <= 0) {
      return;
    }

    const raw = width / CALENDAR_SCALE_FULL_WIDTH_PX;
    const scale = width < CALENDAR_SCALE_FULL_WIDTH_PX
      ? Math.max(CALENDAR_SCALE_MIN, Math.min(1, raw))
      : 1;

    // Round a little to avoid thrashing on sub-pixel changes.
    const rounded = Math.round(scale * 1000) / 1000;
    calendarBaseWrapperEl.style.setProperty("--calendar-scale", String(rounded));
  }


  let listGroups: ListGroupNode[] = [];
  let listLoading = false;
  let listError: string | null = null;

  // Track open/closed state for each group, so user toggles persist across refreshes.
  let groupOpenState: Record<string, boolean> = {};

  // Track open/closed state for each day (nested under year).
  let dayOpenState: Record<string, boolean> = {};

  type DayChildKey = "files";
  type DayChildOpenState = { files?: boolean };
  let dayChildOpenState: Record<string, DayChildOpenState> = {};

  let createdOnDayIndex: Record<string, CreatedOnDayBucket> = {};
  let createdOnDayIndexLoading = false;
  let createdOnDayIndexError: string | null = null;

  let createdOnDayIndexBuildNonce = 0;
  let createdOnDayIndexBuiltOnce = false;

  type CreatedOnDayIndexOp =
    | { type: "create"; file: TFile }
    | { type: "delete"; path: string; ctime?: number }
    | { type: "rename"; file: TFile; oldPath: string; ctime?: number };

  let createdOnDayIndexPendingOps: CreatedOnDayIndexOp[] = [];

  let prevListViewIncludeCreatedDays: boolean | null = null;

  let titleInFlight: Record<string, boolean> = {};

  // Per-day custom list titles (manual overrides)
  let editingCustomTitleDateUID: string | null = null;
  let editingCustomTitleDateStr: string | null = null;
  let editingCustomTitleValue = "";
  let editingCustomTitleInputEl: HTMLInputElement | null = null;
  let suppressNextCustomTitleBlurSave = false;

  function getCustomTitleLabel(
    item: ListItem,
    titles: CustomListTitles | null | undefined
  ): string | null {
    const suffix = titles?.[item.dateStr];
    if (typeof suffix !== "string" || !suffix.trim()) {
      return null;
    }
    return formatCustomListTitleLabel(item.dateStr, suffix);
  }

  function clearCustomTitleEditState(): void {
    editingCustomTitleDateUID = null;
    editingCustomTitleDateStr = null;
    editingCustomTitleValue = "";
    suppressNextCustomTitleBlurSave = false;
  }

  function cancelCustomTitleEdit(): void {
    clearCustomTitleEditState();
  }

  function saveCustomTitleEdit(): void {
    const dateStr = editingCustomTitleDateStr;
    if (!dateStr) {
      clearCustomTitleEditState();
      return;
    }

    const normalized = normalizeCustomListTitleInput({
      dateStr,
      input: editingCustomTitleValue,
    });

    customListTitles.update((prev) => {
      const base = prev ?? {};
      const next: CustomListTitles = { ...base };

      if (normalized) {
        next[dateStr] = normalized;
      } else {
        delete next[dateStr];
      }

      return next;
    });

    clearCustomTitleEditState();
  }

  function onCustomTitleInputKeyDown(event: KeyboardEvent): void {
    // Prevent <summary> toggle while typing.
    event.stopPropagation();

    if (event.key === "Enter") {
      event.preventDefault();
      saveCustomTitleEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelCustomTitleEdit();
    }
  }

  function onCustomTitleInputBlur(): void {
    if (suppressNextCustomTitleBlurSave) {
      suppressNextCustomTitleBlurSave = false;
      return;
    }

    saveCustomTitleEdit();
  }

  async function onClickEditCustomTitle(
    item: ListItem,
    event: MouseEvent
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    // If the same row is already being edited, treat the pencil click as "done".
    if (editingCustomTitleDateUID === item.dateUID) {
      saveCustomTitleEdit();
      return;
    }

    // If another row is being edited, save it first.
    if (editingCustomTitleDateUID && editingCustomTitleDateUID !== item.dateUID) {
      saveCustomTitleEdit();
    }

    const existing = $customListTitles?.[item.dateStr] ?? "";
    editingCustomTitleDateUID = item.dateUID;
    editingCustomTitleDateStr = item.dateStr;
    editingCustomTitleValue = existing;

    await svelteTick();
    editingCustomTitleInputEl?.focus();
    editingCustomTitleInputEl?.select();
  }

  let listComputeNonce = 0;
  // Obsidian runs in an Electron (DOM) environment; window.setTimeout returns a numeric ID.
  // Avoid ReturnType<typeof setTimeout> because it can resolve to NodeJS.Timeout when Node types are included.
  let listComputeTimer: number | null = null;
  const LIST_RECOMPUTE_DEBOUNCE_MS = 750;

  function openList(): void {
    if (showList) {
      return;
    }

    showList = true;
    showListJustOpened = true;
    void computeList();
    if ($settings.listViewIncludeCreatedDays) {
      void ensureCreatedOnDayIndexBuilt();
    }

    schedulePersistViewState({ showList });
  }

  function closeList(): void {
    if (!showList) {
      return;
    }

    showList = false;
    schedulePersistViewState({ showList });
  }

  function toggleList(): void {
    if (showList) {
      closeList();
    } else {
      openList();
    }
  }

  function scheduleListRecompute(): void {
    if (!showList) {
      return;
    }

    if (listComputeTimer !== null) {
      window.clearTimeout(listComputeTimer);
    }
    listComputeTimer = window.setTimeout(() => {
      listComputeTimer = null;
      void computeList();
    }, LIST_RECOMPUTE_DEBOUNCE_MS);
  }

  export function requestListRefresh(): void {
    scheduleListRecompute();
  }

  function isNoteLikeFile(file: TFile): boolean {
    const ext = (file.extension ?? "").toLowerCase();
    return ext === "md" || ext === "canvas";
  }

  function shouldIndexFile(file: TFile): boolean {
    const p = file.path ?? "";

    // Avoid noise from Obsidian config, trash, etc.
    if (p.startsWith(".obsidian/")) {
      return false;
    }
    if (p.startsWith(".trash/")) {
      return false;
    }

    return true;
  }

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

  function pad2(num: number): string {
    return num < 10 ? `0${num}` : String(num);
  }

  function formatLocalDateYYYYMMDD(epochMs: number): string {
    const d = new Date(epochMs);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function upsertSortedByPath(arr: TFile[], file: TFile): TFile[] {
    const path = file.path;
    const without = (arr ?? []).filter((f) => f?.path !== path);

    // Insert into already-sorted list.
    let lo = 0;
    let hi = without.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (without[mid].path.localeCompare(path) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    without.splice(lo, 0, file);
    return without;
  }

  function removeByPath(arr: TFile[], path: string): TFile[] {
    const idx = (arr ?? []).findIndex((f) => f?.path === path);
    if (idx === -1) {
      return arr;
    }

    const next = arr.slice();
    next.splice(idx, 1);
    return next;
  }

  function addFileToCreatedOnDayIndex(
    index: Record<string, CreatedOnDayBucket>,
    file: TFile
  ): Record<string, CreatedOnDayBucket> {
    if (!shouldIndexFile(file)) {
      return index;
    }

    const ctime = file.stat?.ctime;
    if (!ctime) {
      return index;
    }

    const dateStr = formatLocalDateYYYYMMDD(ctime);
    const prev = index[dateStr] ?? { notes: [], files: [] };

    const nextBucket: CreatedOnDayBucket = {
      notes: [...(prev.notes ?? [])],
      files: [...(prev.files ?? [])],
    };

    if (isNoteLikeFile(file)) {
      nextBucket.notes = upsertSortedByPath(nextBucket.notes, file);
      nextBucket.files = nextBucket.files.filter((f) => f?.path !== file.path);
    } else {
      nextBucket.files = upsertSortedByPath(nextBucket.files, file);
      nextBucket.notes = nextBucket.notes.filter((f) => f?.path !== file.path);
    }

    return { ...index, [dateStr]: nextBucket };
  }

  function removeFileFromCreatedOnDayIndex(
    index: Record<string, CreatedOnDayBucket>,
    path: string,
    ctime?: number
  ): Record<string, CreatedOnDayBucket> {
    if (!path) {
      return index;
    }

    const dateStr = ctime ? formatLocalDateYYYYMMDD(ctime) : null;

    const removeFromBucket = (bucket: CreatedOnDayBucket): CreatedOnDayBucket => {
      return {
        notes: removeByPath(bucket.notes ?? [], path),
        files: removeByPath(bucket.files ?? [], path),
      };
    };

    if (dateStr && index[dateStr]) {
      const prev = index[dateStr];
      const nextBucket = removeFromBucket(prev);

      const changed =
        nextBucket.notes.length !== (prev.notes ?? []).length ||
        nextBucket.files.length !== (prev.files ?? []).length;

      if (!changed) {
        return index;
      }

      const nextIndex = { ...index };
      if (nextBucket.notes.length === 0 && nextBucket.files.length === 0) {
        delete nextIndex[dateStr];
      } else {
        nextIndex[dateStr] = nextBucket;
      }
      return nextIndex;
    }

    // Fallback: scan (rare; only when ctime is missing).
    let changedAny = false;
    const nextIndex: Record<string, CreatedOnDayBucket> = { ...index };

    for (const [k, bucket] of Object.entries(nextIndex)) {
      const nextBucket = removeFromBucket(bucket);
      const changed =
        nextBucket.notes.length !== (bucket.notes ?? []).length ||
        nextBucket.files.length !== (bucket.files ?? []).length;

      if (!changed) {
        continue;
      }

      changedAny = true;
      if (nextBucket.notes.length === 0 && nextBucket.files.length === 0) {
        delete nextIndex[k];
      } else {
        nextIndex[k] = nextBucket;
      }
    }

    return changedAny ? nextIndex : index;
  }

  function applyCreatedOnDayIndexOp(
    index: Record<string, CreatedOnDayBucket>,
    op: CreatedOnDayIndexOp
  ): Record<string, CreatedOnDayBucket> {
    if (op.type === "create") {
      return addFileToCreatedOnDayIndex(index, op.file);
    }

    if (op.type === "delete") {
      return removeFileFromCreatedOnDayIndex(index, op.path, op.ctime);
    }

    // rename
    const ctime = op.ctime ?? op.file.stat?.ctime;
    let next = removeFileFromCreatedOnDayIndex(index, op.oldPath, ctime);
    next = removeFileFromCreatedOnDayIndex(next, op.file.path, ctime);

    if (shouldIndexFile(op.file) && ctime) {
      next = addFileToCreatedOnDayIndex(next, op.file);
    }

    return next;
  }

  function handleCreatedOnDayIndexOp(op: CreatedOnDayIndexOp): void {
    if (!$settings.listViewIncludeCreatedDays) {
      return;
    }

    if (createdOnDayIndexLoading) {
      createdOnDayIndexPendingOps = [...createdOnDayIndexPendingOps, op];
      return;
    }

    if (!createdOnDayIndexBuiltOnce) {
      // We'll build the index when List view is opened / setting is enabled.
      return;
    }

    const next = applyCreatedOnDayIndexOp(createdOnDayIndex, op);
    if (next !== createdOnDayIndex) {
      createdOnDayIndex = next;
      scheduleListRecompute();
    }
  }

  function onVaultCreate(file: unknown): void {
    if (!(file instanceof TFile)) {
      return;
    }

    handleCreatedOnDayIndexOp({ type: "create", file });
  }

  function onVaultDelete(file: unknown): void {
    if (!(file instanceof TFile)) {
      return;
    }

    handleCreatedOnDayIndexOp({
      type: "delete",
      path: file.path,
      ctime: file.stat?.ctime,
    });
  }

  function onVaultRename(file: unknown, oldPath: unknown): void {
    if (!(file instanceof TFile)) {
      return;
    }

    const oldPathStr = typeof oldPath === "string" ? oldPath : "";

    handleCreatedOnDayIndexOp({
      type: "rename",
      file,
      oldPath: oldPathStr,
      ctime: file.stat?.ctime,
    });
  }

  async function ensureCreatedOnDayIndexBuilt(): Promise<void> {
    if (!$settings.listViewIncludeCreatedDays) {
      return;
    }
    if (createdOnDayIndexBuiltOnce || createdOnDayIndexLoading) {
      return;
    }

    await rebuildCreatedOnDayIndex();
  }

  async function rebuildCreatedOnDayIndex(): Promise<void> {
    if (!$settings.listViewIncludeCreatedDays) {
      createdOnDayIndexBuildNonce++;
      createdOnDayIndex = {};
      createdOnDayIndexBuiltOnce = false;
      createdOnDayIndexLoading = false;
      createdOnDayIndexError = null;
      createdOnDayIndexPendingOps = [];
      scheduleListRecompute();
      return;
    }

    if (createdOnDayIndexLoading) {
      return;
    }

    const nonce = ++createdOnDayIndexBuildNonce;
    createdOnDayIndexLoading = true;
    createdOnDayIndexError = null;
    createdOnDayIndexPendingOps = [];

    const t0 = perfNow();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).app;
      const vault = app?.vault;
      if (!vault?.getFiles) {
        createdOnDayIndex = {};
        createdOnDayIndexBuiltOnce = true;
        return;
      }

      const files = (vault.getFiles() ?? []) as TFile[];
      const next: Record<string, CreatedOnDayBucket> = {};

      const chunkSize = 2000;
      for (let i = 0; i < files.length; i += chunkSize) {
        if (nonce !== createdOnDayIndexBuildNonce) {
          return;
        }

        const chunk = files.slice(i, i + chunkSize);
        for (const file of chunk) {
          if (!shouldIndexFile(file)) {
            continue;
          }

          const ctime = file.stat?.ctime;
          if (!ctime) {
            continue;
          }

          const dateStr = formatLocalDateYYYYMMDD(ctime);
          const bucket = next[dateStr] ?? (next[dateStr] = { notes: [], files: [] });

          if (isNoteLikeFile(file)) {
            bucket.notes.push(file);
          } else {
            bucket.files.push(file);
          }
        }

        // Yield occasionally to keep the UI responsive on large vaults.
        await new Promise<void>((resolve) => {
          if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => resolve());
          } else {
            window.setTimeout(() => resolve(), 0);
          }
        });
      }

      for (const bucket of Object.values(next)) {
        bucket.notes.sort((a, b) => a.path.localeCompare(b.path));
        bucket.files.sort((a, b) => a.path.localeCompare(b.path));
      }

      if (nonce !== createdOnDayIndexBuildNonce) {
        return;
      }

      let nextIndex: Record<string, CreatedOnDayBucket> = next;
      if (createdOnDayIndexPendingOps.length) {
        for (const op of createdOnDayIndexPendingOps) {
          nextIndex = applyCreatedOnDayIndexOp(nextIndex, op);
        }
      }

      createdOnDayIndex = nextIndex;
      createdOnDayIndexBuiltOnce = true;

      if (isPerfDebugEnabled()) {
        const dt = perfNow() - t0;
        const bucketCount = Object.keys(nextIndex).length;
        console.debug(
          `[Calendar][perf] createdOnDayIndex build: files=${files.length}, buckets=${bucketCount}, ${dt.toFixed(
            1
          )}ms`
        );
      }

      // Updating index may require list recompute to surface days without daily notes.
      scheduleListRecompute();
    } catch (err) {
      console.error("[Calendar] Failed to build created-on-day index", err);
      if (nonce !== createdOnDayIndexBuildNonce) {
        return;
      }

      createdOnDayIndexError = err instanceof Error ? err.message : String(err);
      createdOnDayIndex = {};
      createdOnDayIndexBuiltOnce = true;
    } finally {
      if (nonce === createdOnDayIndexBuildNonce) {
        createdOnDayIndexLoading = false;
        createdOnDayIndexPendingOps = [];
      }
    }
  }

  function getCachedOllamaTitle(
    item: ListItem,
    enabled: boolean,
    cache: OllamaTitleCache | null | undefined
  ): string | null {
    if (!enabled || !item.filePath) {
      return null;
    }

    const entry = cache?.[item.filePath];
    if (entry && entry.mtime === item.mtime && entry.title) {
      return entry.title;
    }

    return null;
  }

  async function onClickGenerateTitle(item: ListItem, event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    if (!$settings.ollamaTitlesEnabled) {
      return;
    }

    const key = item.filePath;
    if (titleInFlight[key]) {
      return;
    }

    titleInFlight = { ...titleInFlight, [key]: true };

    try {
      const baseUrl = $settings.ollamaBaseUrl ?? "http://127.0.0.1:11434";
      const model = $settings.ollamaModel ?? "gemma3:4b";
      const maxChars = $settings.ollamaMaxChars ?? 8000;
      const timeoutMs = $settings.ollamaRequestTimeoutMs ?? 15000;
      const maxEntries = $settings.ollamaTitleCacheMaxEntries ?? 1000;

      if (!item.file) { return; }
      const noteTextRaw = await window.app.vault.cachedRead(item.file);
      const noteText = prepareNoteTextForOllama(noteTextRaw, maxChars);
      const prompt = buildDailyTitlePrompt({
        dateStr: item.dateStr,
        noteText,
      });

      const client = createOllamaClient({ baseUrl, timeoutMs });

      let res: OllamaGenerateResponse;
      try {
        res = await client.generate(
          {
            model,
            prompt,
            format: DAILY_TITLE_SCHEMA,
            options: {
              temperature: 0.2,
              num_predict: 120,
            },
          },
          { timeoutMs }
        );
      } catch (_err) {
        // Some Ollama versions don’t support JSON Schema format; retry with plain JSON.
        res = await client.generate(
          {
            model,
            prompt,
            format: "json",
            options: {
              temperature: 0.2,
              num_predict: 120,
            },
          },
          { timeoutMs }
        );
      }

      if (res?.error) {
        throw new Error(res.error);
      }

      const parsed = safeParseJson(res?.response ?? "");
      const parts = parseDailyTitleParts(parsed);
      if (!parts) {
        throw new Error("Model output was not valid JSON for a title.");
      }

      const title = formatDailyTitleLabel(item.dateStr, parts);

      ollamaTitleCache.update((cache) => {
        return upsertOllamaTitleCacheEntry({
          cache,
          filePath: item.filePath,
          entry: {
            mtime: item.mtime,
            title,
          },
          maxEntries,
        });
      });
    } catch (err) {
      console.error("[Calendar] Failed to generate title", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Ollama title generation failed: ${msg}`);
    } finally {
      titleInFlight = { ...titleInFlight, [key]: false };
    }
  }

  async function computeList(): Promise<void> {
    const nonce = ++listComputeNonce;
    const debugPerf = isPerfDebugEnabled();
    const t0 = debugPerf ? perfNow() : 0;

    let dailyFileCount = 0;
    let itemCount = 0;
    let groupCount = 0;

    listLoading = true;
    listError = null;

    try {
      const dailyNotesRecord = $dailyNotes ?? {};
      const files = Object.values(dailyNotesRecord).filter(Boolean) as TFile[];
      dailyFileCount = files.length;

      const listViewMinWords = $settings.listViewMinWords ?? 0;
      const includeAll = listViewMinWords <= 0;
      const includeCreatedDays = $settings.listViewIncludeCreatedDays ?? true;

      const candidates: DailyNoteCandidate[] = [];
      const concurrency = 10;

      for (let i = 0; i < files.length; i += concurrency) {
        const chunk = files.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (file) => {
            const date = getDateFromFile(file, "day");
            if (!date) {
              return null;
            }

            let qualifies = true;
            if (!includeAll) {
              const wordCount = await getWordCountFromFile(file);
              qualifies = wordCount >= listViewMinWords;
            }

            return {
              date,
              dateUID: getDateUID(date, "day"),
              dateStr: date.format("YYYY-MM-DD"),
              epoch: date.valueOf(),
              year: date.year(),

              file,
              filePath: file.path,
              mtime: file.stat?.mtime ?? 0,

              qualifies,
            } as DailyNoteCandidate;
          })
        );

        if (nonce !== listComputeNonce) {
          return;
        }

        for (const cand of chunkResults) {
          if (cand) {
            candidates.push(cand);
          }
        }
      }

      const groupingPreset = normalizeListViewGroupingPreset(
        $settings.listViewGroupingPreset
      );
      const sortOrder = normalizeListViewSortOrder($settings.listViewSortOrder);

      const items = buildListItems({
        dailyNoteCandidates: candidates,
        createdOnDayIndex: includeCreatedDays ? createdOnDayIndex : {},
        includeCreatedDays,
        sortOrder,
        parseDateStr: (dateStr) => window.moment(dateStr, "YYYY-MM-DD"),
        getDayDateUID: (date) => getDateUID(date, "day"),
      });
      itemCount = items.length;

      const groups = buildListGroups(items, groupingPreset, sortOrder);
      groupCount = groups.length;

      // Default: expand groups along today's path for the selected preset; others collapsed.
      const todayPath = getListGroupIdPathForDate(today ?? window.moment(), groupingPreset);
      const defaultOpenSet = new Set(todayPath);

      const groupIdSet = new Set<string>();
      const collectIds = (nodes: ListGroupNode[]): void => {
        for (const node of nodes) {
          groupIdSet.add(node.id);
          if (node.groups?.length) {
            collectIds(node.groups);
          }
        }
      };
      collectIds(groups);

      const nextOpenState: Record<string, boolean> = { ...groupOpenState };

      for (const id of groupIdSet) {
        if (nextOpenState[id] === undefined) {
          nextOpenState[id] = defaultOpenSet.has(id);
        }
      }

      for (const key of Object.keys(nextOpenState)) {
        if (!groupIdSet.has(key)) {
          delete nextOpenState[key];
        }
      }

      groupOpenState = nextOpenState;

      // Maintain per-day open state (and sub-toggle open state) across refreshes.
      // Keep these maps sparse (only true entries) to avoid large persisted blobs on big vaults.
      const dayUIDSet = new Set(items.map((i) => i.dateUID));

      const nextDayOpenState: Record<string, boolean> = { ...dayOpenState };
      for (const key of Object.keys(nextDayOpenState)) {
        if (!dayUIDSet.has(key)) {
          delete nextDayOpenState[key];
        }
      }

      const nextDayChildOpenState: Record<string, DayChildOpenState> = {};
      for (const [dateUID, childState] of Object.entries(dayChildOpenState)) {
        if (!dayUIDSet.has(dateUID)) {
          continue;
        }
        if (childState?.files) {
          nextDayChildOpenState[dateUID] = { files: true };
        }
      }

      dayOpenState = nextDayOpenState;
      dayChildOpenState = nextDayChildOpenState;

      listGroups = groups;
    } catch (err) {
      console.error("[Calendar] Failed to build list view", err);
      if (nonce !== listComputeNonce) {
        return;
      }
      listError = err instanceof Error ? err.message : String(err);
      listGroups = [];
    } finally {
      if (nonce === listComputeNonce) {
        if (debugPerf) {
          const dt = perfNow() - t0;
          console.debug(
            `[Calendar][perf] list recompute: dailyNotes=${dailyFileCount}, items=${itemCount}, groups=${groupCount}, ${dt.toFixed(
              1
            )}ms`
          );
        }

        listLoading = false;
      }
    }
  }

  function onToggleGroup(id: string, event: Event): void {
    const el = event.currentTarget as HTMLDetailsElement;
    groupOpenState = { ...groupOpenState, [id]: el.open };
    schedulePersistViewState({ groupOpenState });
  }

  function onToggleDay(dateUID: string, event: Event): void {
    const el = event.currentTarget as HTMLDetailsElement;
    const isOpen = !!el.open;

    if (isOpen) {
      dayOpenState = { ...dayOpenState, [dateUID]: true };
    } else {
      const next = { ...dayOpenState };
      delete next[dateUID];
      dayOpenState = next;
    }

    schedulePersistViewState({ dayOpenState });
  }

  function onToggleDayChild(
    dateUID: string,
    child: DayChildKey,
    event: Event
  ): void {
    const el = event.currentTarget as HTMLDetailsElement;
    const isOpen = !!el.open;

    if (isOpen) {
      const prev = dayChildOpenState[dateUID] ?? {};
      dayChildOpenState = {
        ...dayChildOpenState,
        [dateUID]: { ...prev, [child]: true },
      };
    } else {
      const next = { ...dayChildOpenState };
      const entry: DayChildOpenState = { ...(next[dateUID] ?? {}) };
      delete entry[child];

      if (!entry.files) {
        delete next[dateUID];
      } else {
        next[dateUID] = entry;
      }

      dayChildOpenState = next;
    }

    schedulePersistViewState({ dayChildOpenState });
  }

  function getCreatedNotesForItem(item: ListItem): TFile[] {
    if (!$settings.listViewIncludeCreatedDays) {
      return [];
    }

    const bucket = createdOnDayIndex[item.dateStr];
    if (!bucket?.notes?.length) {
      return [];
    }
    return bucket.notes.filter((f) => f.path !== item.filePath);
  }

  function getCreatedFilesForItem(item: ListItem): TFile[] {
    if (!$settings.listViewIncludeCreatedDays) {
      return [];
    }

    const bucket = createdOnDayIndex[item.dateStr];
    return bucket?.files ?? [];
  }

  function hasDayChildren(item: ListItem): boolean {
    if (!$settings.listViewIncludeCreatedDays) {
      return false;
    }

    const notes = getCreatedNotesForItem(item);
    const files = getCreatedFilesForItem(item);
    return (notes && notes.length > 0) || (files && files.length > 0);
  }

  function getFileExtension(file: TFile): string {
    const ext = (file.extension ?? "").toLowerCase();
    return ext;
  }

  function onKeyOpenFile(file: TFile, event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // Cast to MouseEvent-like for reuse
      onClickOpenFile(file, (event as unknown) as MouseEvent);
    }
  }

  async function onClickOpenFile(file: TFile, event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    try {
      const isMetaPressed = event.metaKey || event.ctrlKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = (window as any).app?.workspace;
      if (!workspace) {
        return;
      }

      const leaf = isMetaPressed
        ? workspace.splitActiveLeaf()
        : workspace.getUnpinnedLeaf();
      await leaf.openFile(file, { active: true });
      workspace.setActiveLeaf(leaf, true, true);
    } catch (err) {
      console.error("[Calendar] Failed to open file", err);
    }
  }

  function onClickListDay(date: Moment, event: MouseEvent): void {
    // The day label remains a normal button; prevent <summary> from toggling when opening the note.
    event.preventDefault();
    event.stopPropagation();

    const isMetaPressed = event.metaKey || event.ctrlKey;
    onClickDay(date, isMetaPressed);
  }

  type ListItemTagColor = { label: string; color: string };

  const LIST_ITEM_TAG_COLORS: ListItemTagColor[] = [
    { label: "Red", color: "#ef4444" },
    { label: "Orange", color: "#f97316" },
    { label: "Yellow", color: "#eab308" },
    { label: "Green", color: "#22c55e" },
    { label: "Blue", color: "#3b82f6" },
    { label: "Purple", color: "#a855f7" },
    { label: "Pink", color: "#ec4899" },
    { label: "Gray", color: "#64748b" },
  ];

  function getListItemTagKeyForDay(item: ListItem): string {
    return `day:${item.dateStr}`;
  }

  function getListItemTagKeyForFile(file: TFile): string {
    const path = file?.path ?? "";
    return path ? `file:${path}` : "";
  }

  function setListItemColorTag(key: string, color: string | null): void {
    if (!key) {
      return;
    }

    listItemColorTags.update((prev) => {
      const base = prev ?? {};
      const next = { ...base };

      if (!color) {
        delete next[key];
      } else {
        next[key] = color;
      }

      return next;
    });
  }

  function getListItemColorTagFrom(
    tags: Record<string, string> | null | undefined,
    key: string
  ): string | null {
    if (!key) {
      return null;
    }

    const map = (tags ?? {}) as Record<string, unknown>;
    const value = map[key];
    return typeof value === "string" && value ? value : null;
  }

  function isEditableContextMenuTarget(event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return false;
    }

    const el = target.closest(
      "input, textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']"
    );
    return !!el;
  }

  function showListItemColorTagMenu(args: {
    key: string;
    event: MouseEvent;
  }): void {
    const { key, event } = args;
    if (!key) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const current = getListItemColorTagFrom($listItemColorTags, key) ?? "";

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Color tag").setIsLabel(true));

    menu.addItem((item) => {
      item.setTitle("None");
      item.setChecked(!current);
      item.onClick(() => setListItemColorTag(key, null));
    });

    for (const opt of LIST_ITEM_TAG_COLORS) {
      menu.addItem((item) => {
        item.setTitle(opt.label);
        item.setChecked(current === opt.color);
        item.onClick(() => setListItemColorTag(key, opt.color));
      });
    }

    menu.showAtMouseEvent(event);
  }

  function onContextMenuListDay(item: ListItem, event: MouseEvent): void {
    // Allow normal text context menu for the inline custom title editor.
    if (isEditableContextMenuTarget(event)) {
      return;
    }

    const key = getListItemTagKeyForDay(item);
    showListItemColorTagMenu({ key, event });
  }

  function onContextMenuListFile(file: TFile, event: MouseEvent): void {
    const key = getListItemTagKeyForFile(file);
    showListItemColorTagMenu({ key, event });
  }

  function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const s = (hex ?? "").trim();
    const m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (!m) {
      return null;
    }

    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;

    return { r, g, b };
  }

  function rgbaFromHex(hex: string, alpha: number): string | null {
    const rgb = hexToRgb(hex);
    if (!rgb) {
      return null;
    }

    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
  }

  function getListItemTagStyle(
    tags: Record<string, string> | null | undefined,
    key: string
  ): string {
    const color = getListItemColorTagFrom(tags, key);
    if (!color) {
      return "";
    }

    // Subtle tint; should feel like a highlight, not a block.
    const bg = rgbaFromHex(color, 0.14) ?? color;
    const bgHover = rgbaFromHex(color, 0.2) ?? color;

    return `--calendar-list-tag-color: ${color}; --calendar-list-tag-bg: ${bg}; --calendar-list-tag-bg-hover: ${bgHover};`;
  }

  function isListItemTagged(
    tags: Record<string, string> | null | undefined,
    key: string
  ): boolean {
    return !!getListItemColorTagFrom(tags, key);
  }

  $: {
    const includeCreatedDays = $settings.listViewIncludeCreatedDays ?? true;

    // If the user enables created-on-day while List view is open, kick off a build.
    if (showList && includeCreatedDays && prevListViewIncludeCreatedDays === false) {
      void ensureCreatedOnDayIndexBuilt();
    }

    // If the user disables it, clear index-derived UI immediately.
    if (!includeCreatedDays && prevListViewIncludeCreatedDays === true) {
      createdOnDayIndexBuildNonce++;
      createdOnDayIndex = {};
      createdOnDayIndexBuiltOnce = false;
      createdOnDayIndexLoading = false;
      createdOnDayIndexError = null;
      createdOnDayIndexPendingOps = [];
      scheduleListRecompute();
    }

    prevListViewIncludeCreatedDays = includeCreatedDays;
  }

  $: if (showList) {
    // Recompute when daily note index or list settings change.
    $dailyNotes;
    $settings.listViewMinWords;
    $settings.listViewIncludeCreatedDays;
    $settings.listViewGroupingPreset;
    $settings.listViewSortOrder;

    // Avoid double-recompute when the user just opened the list view and we already ran computeList().
    if (showListJustOpened) {
      showListJustOpened = false;
    } else {
      scheduleListRecompute();
    }
  }

  export function tick() {
    today = window.moment();
  }

  function getToday(settings: ISettings) {
    configureGlobalMomentLocale(settings.localeOverride, settings.weekStart);
    dailyNotes.reindex();
    weeklyNotes.reindex();
    return window.moment();
  }

  // 1 minute heartbeat to keep `today` reflecting the current day
  let heartbeat = setInterval(() => {
    tick();

    const isViewingCurrentMonth = displayedMonth.isSame(today, "day");
    if (isViewingCurrentMonth) {
      // if it's midnight on the last day of the month, this will
      // update the display to show the new month.
      displayedMonth = today;
    }
  }, 1000 * 60);

  // Persist the displayed month after hydration.
  $: if (viewStateHydrated && $settings.rememberViewState) {
    schedulePersistViewState({
      displayedMonth: formatDisplayedMonthForStorage(displayedMonth),
    });
  }

  // When the user enables persistence, store a snapshot once so the next restart matches
  // the current UI even if they don't interact with the calendar after toggling the option.
  let didPersistViewStateOnEnable = false;

  function persistFullViewStateSnapshot(): void {
    schedulePersistViewState({
      showList,
      displayedMonth: formatDisplayedMonthForStorage(displayedMonth),
      groupOpenState,
      dayOpenState,
      dayChildOpenState,
    });
  }

  $: if (viewStateHydrated && $settings.rememberViewState && !didPersistViewStateOnEnable) {
    didPersistViewStateOnEnable = true;
    persistFullViewStateSnapshot();
  }

  $: if (viewStateHydrated && !$settings.rememberViewState) {
    didPersistViewStateOnEnable = false;
  }

  function updateListTogglePosition(): void {
    if (!calendarBaseWrapperEl || !listControlsEl) {
      return;
    }

    const navEl = calendarBaseWrapperEl.querySelector(
      "#calendar-container .nav"
    ) as HTMLElement | null;
    const rightNavEl = calendarBaseWrapperEl.querySelector(
      "#calendar-container .nav .right-nav"
    ) as HTMLElement | null;

    if (!navEl || !rightNavEl) {
      listTogglePositioned = false;
      return;
    }

    // Put the list controls into the header DOM flow so layout stays robust at tiny widths.
    // This avoids overlaps (title vs buttons vs arrows) and lets CSS handle truncation/scroll.
    if (listControlsEl.parentElement !== navEl) {
      navEl.insertBefore(listControlsEl, rightNavEl);
    }

    listTogglePositioned = true;
  }

  onMount(() => {
    // Restore persisted state (if enabled) before any reactive persistence runs.
    try {
      const vs = readViewState();

      if ($settings.rememberViewState && vs) {
        if (vs.displayedMonth) {
          const strict = window.moment(vs.displayedMonth, "YYYY-MM-DD", true);
          if (strict?.isValid?.()) {
            displayedMonth = strict;
          } else {
            const loose = window.moment(vs.displayedMonth);
            if (loose?.isValid?.()) {
              displayedMonth = loose;
            }
          }
        }

        if (vs.groupOpenState && typeof vs.groupOpenState === "object") {
          groupOpenState = vs.groupOpenState;
        }
        if (vs.dayOpenState && typeof vs.dayOpenState === "object") {
          dayOpenState = vs.dayOpenState;
        }
        if (vs.dayChildOpenState && typeof vs.dayChildOpenState === "object") {
          dayChildOpenState = vs.dayChildOpenState;
        }

        if (vs.showList) {
          openList();
        }
      }
    } catch (err) {
      console.error("[Calendar] Failed to restore view state", err);
    } finally {
      viewStateHydrated = true;
    }

    const schedule = () => {
      // CalendarBase mounts inside this component; wait a frame so its DOM is ready.
      window.requestAnimationFrame(() => {
        updateCalendarScale();
        updateListTogglePosition();

        // If the menu is open, keep it aligned to the anchor on resizes/layout changes.
        positionOllamaMenu();
        positionTooltip();
      });
    };

    // Refresh "created on this day" data when vault files change.
    const vaultEventRefs: EventRef[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = (window as any).app?.vault;
    if (vault?.on && vault?.offref) {
      vaultEventRefs.push(vault.on("create", onVaultCreate));
      vaultEventRefs.push(vault.on("delete", onVaultDelete));
      vaultEventRefs.push(vault.on("rename", onVaultRename));
    }

    schedule();

    window.addEventListener("resize", schedule, { passive: true });

    const ro = new ResizeObserver(schedule);
    if (calendarBaseWrapperEl) {
      ro.observe(calendarBaseWrapperEl);
    }

    // Observe nav + title + right-nav changes (locale, font size, etc.).
    const navEl = calendarBaseWrapperEl?.querySelector(
      "#calendar-container .nav"
    ) as HTMLElement | null;
    const rightNavEl = calendarBaseWrapperEl?.querySelector(
      "#calendar-container .nav .right-nav"
    ) as HTMLElement | null;
    const titleEl = calendarBaseWrapperEl?.querySelector(
      "#calendar-container .nav .title"
    ) as HTMLElement | null;

    if (navEl) {
      ro.observe(navEl);
    }
    if (rightNavEl) {
      ro.observe(rightNavEl);
    }
    if (titleEl) {
      ro.observe(titleEl);
    }

    return () => {
      window.removeEventListener("resize", schedule);
      ro.disconnect();

      if (vault?.offref) {
        for (const ref of vaultEventRefs) {
          vault.offref(ref);
        }
      }
    };
  });

  $: if (!showList) {
    showOllamaMenu = false;
  }

  $: if (!showOllamaMenu) {
    hideTooltip();
  }

  onMount(() => {
    const onMouseDownCapture = (event: MouseEvent) => {
      if (!showOllamaMenu) {
        return;
      }

      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      const isInsideMenu = !!ollamaMenuEl?.contains(target);
      const isOnButton = !!ollamaSettingsButtonEl?.contains(target);
      if (isInsideMenu || isOnButton) {
        return;
      }

      showOllamaMenu = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showOllamaMenu) {
        showOllamaMenu = false;
      }
    };

    // Capture to close the menu even if a click handler stops propagation.
    window.addEventListener("mousedown", onMouseDownCapture, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousedown", onMouseDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  onDestroy(() => {
    clearInterval(heartbeat);
    if (listComputeTimer !== null) {
      window.clearTimeout(listComputeTimer);
    }
    if (viewStateSaveTimer !== null) {
      window.clearTimeout(viewStateSaveTimer);
    }
  });
</script>

<div class="calendar-view">
  <div class="calendar-pane">
    <div class="calendar-base-wrapper" bind:this={calendarBaseWrapperEl}>
      <CalendarBase
        {sources}
        {today}
        {onHoverDay}
        {onHoverWeek}
        {onContextMenuDay}
        {onContextMenuWeek}
        {onClickDay}
        {onClickWeek}
        bind:displayedMonth
        localeData={today.localeData()}
        selectedId={$activeFile}
        showWeekNums={$settings.showWeeklyNote}
      />

      <div
        class="calendar-list-controls"
        class:is-positioned={listTogglePositioned}
        bind:this={listControlsEl}
      >
        <button
          class="calendar-list-toggle"
          class:is-active={showList}
          type="button"
          aria-label={showList ? "Hide list" : "Show list"}
          aria-pressed={showList}
          bind:this={listToggleButtonEl}
          on:click={toggleList}
        >
          <svg
            focusable="false"
            role="img"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"
            />
          </svg>
        </button>

        {#if showList}
          <button
            class="calendar-ollama-settings-toggle"
            class:is-active={showOllamaMenu}
            type="button"
            aria-label="List view settings"
            aria-haspopup="menu"
            aria-expanded={showOllamaMenu}
            bind:this={ollamaSettingsButtonEl}
            on:click={toggleOllamaMenu}
          >
            <svg
              focusable="false"
              role="img"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.11-.2-.36-.28-.57-.2l-2.39.96c-.49-.38-1.04-.69-1.62-.92L14.4 2.5a.488.488 0 0 0-.48-.4h-3.84c-.24 0-.44.17-.48.4l-.36 2.54c-.58.23-1.12.54-1.62.92l-2.39-.96c-.21-.08-.46 0-.57.2L2.74 8.02c-.11.2-.06.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.11.2.36.28.57.2l2.39-.96c.49.38 1.04.69 1.62.92l.36 2.54c.04.23.24.4.48.4h3.84c.24 0 .44-.17.48-.4l.36-2.54c.58-.23 1.12-.54 1.62-.92l2.39.96c.21.08.46 0 .57-.2l1.92-3.32c.11-.2.06-.47-.12-.61l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"
              />
            </svg>

            {#if $settings.ollamaTitlesEnabled}
              <span
                class="calendar-ollama-status-dot"
                class:is-ok={ollamaStatusState === "ok"}
                class:is-error={ollamaStatusState === "error"}
                class:is-checking={ollamaStatusState === "checking"}
                aria-hidden="true"
              ></span>
            {/if}
          </button>

          {#if showOllamaMenu}
            <div
              class="calendar-ollama-menu"
              role="menu"
              bind:this={ollamaMenuEl}
              use:portalToBody
              style={`top: ${ollamaMenuTop}px; left: ${ollamaMenuLeft}px; max-height: ${ollamaMenuMaxHeight}px;`}
              on:scroll={() => hideTooltip()}
              transition:slide={{ duration: 120 }}
            >
              <div class="calendar-ollama-menu-row calendar-ollama-menu-row--top">
                <div class="calendar-ollama-menu-title">
                  <span>List view</span>
                </div>
              </div>

              <div class="calendar-ollama-menu-section">
                <div class="calendar-ollama-field">
                  <label for={listGroupingPresetInputId}>
                    Grouping
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Choose how list items are grouped (e.g., Year → Month)."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      ?
                    </span>
                  </label>
                  <div class="calendar-select">
                    <select
                      id={listGroupingPresetInputId}
                      value={normalizeListViewGroupingPreset($settings.listViewGroupingPreset)}
                      on:input={onChangeListViewGroupingPreset}
                    >
                      <option value="year">Year (YYYY)</option>
                      <option value="year_month">Year → Month (YYYY/MM)</option>
                      <option value="year_month_name">Year → Month Name (YYYY/MMMM)</option>
                      <option value="year_month_num_name">Year → Month # - Name (YYYY/MM-MMMM)</option>
                      <option value="year_quarter">Year → Quarter (YYYY/Q#)</option>
                      <option value="year_week">ISO Year → ISO Week (GGGG/WW)</option>
                    </select>

                    <span class="calendar-select-chevron" aria-hidden="true">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="currentColor"
                      >
                        <path d="M7 10l5 5 5-5z" />
                      </svg>
                    </span>
                  </div>
                </div>

                <div class="calendar-ollama-field">
                  <label for={listSortOrderInputId}>
                    Order
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Choose whether groups/days are shown newest-first or oldest-first."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      ?
                    </span>
                  </label>
                  <div class="calendar-select">
                    <select
                      id={listSortOrderInputId}
                      value={normalizeListViewSortOrder($settings.listViewSortOrder)}
                      on:input={onChangeListViewSortOrder}
                    >
                      <option value="desc">Newest → Oldest</option>
                      <option value="asc">Oldest → Newest</option>
                    </select>

                    <span class="calendar-select-chevron" aria-hidden="true">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="currentColor"
                      >
                        <path d="M7 10l5 5 5-5z" />
                      </svg>
                    </span>
                  </div>
                </div>

                <div class="calendar-ollama-field">
                  <label for={listMinWordsInputId}>
                    Min words
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Hide days whose daily note has fewer than this many words (0 = show all)."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      ?
                    </span>
                  </label>
                  <input
                    id={listMinWordsInputId}
                    type="number"
                    value={String($settings.listViewMinWords ?? 0)}
                    placeholder="0"
                    on:change={onChangeListViewMinWords}
                  />
                </div>

                <div class="calendar-ollama-field">
                  <label for={listIncludeCreatedInputId}>
                    Created items
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Include notes & attachments created on that date (by file creation time), even if there is no daily note."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      ?
                    </span>
                  </label>

                  <label class="calendar-ollama-toggle" title="Include created-on-day items">
                    <input
                      id={listIncludeCreatedInputId}
                      type="checkbox"
                      checked={$settings.listViewIncludeCreatedDays}
                      on:change={onToggleListViewIncludeCreatedDays}
                    />
                    <span class="calendar-ollama-toggle-track" aria-hidden="true"></span>
                  </label>
                </div>

                <div class="calendar-ollama-field">
                  <label for={listShowCountsInputId}>
                    Counts
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Show daily note totals on group headers, plus created notes/attachments counts on each day row."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      ?
                    </span>
                  </label>

                  <label class="calendar-ollama-toggle" title="Show counts">
                    <input
                      id={listShowCountsInputId}
                      type="checkbox"
                      checked={$settings.listViewShowCounts}
                      on:change={onToggleListViewShowCounts}
                    />
                    <span class="calendar-ollama-toggle-track" aria-hidden="true"></span>
                  </label>
                </div>
              </div>

              <div class="calendar-ollama-menu-section">
                <div class="calendar-ollama-menu-row">
                  <div class="calendar-ollama-menu-title">
                    <span>Ollama</span>
                    <span
                      class="calendar-tip"
                      data-calendar-tooltip="Toggle on to enable local Ollama for list title generation (no file renames)."
                      tabindex="0"
                      on:mouseenter={onTipEnter}
                      on:mouseleave={onTipLeave}
                      on:focus={onTipEnter}
                      on:blur={onTipLeave}
                    >
                      i
                    </span>
                  </div>

                  <label class="calendar-ollama-toggle" title="Enable / disable">
                    <input
                      type="checkbox"
                      checked={$settings.ollamaTitlesEnabled}
                      on:change={onToggleOllamaEnabled}
                    />
                    <span class="calendar-ollama-toggle-track" aria-hidden="true"></span>
                  </label>
                </div>

                {#if $settings.ollamaTitlesEnabled}
                  <div class="calendar-ollama-menu-fields">
                    <div class="calendar-ollama-field">
                      <label for={ollamaUrlInputId}>
                        URL
                        <span
                          class="calendar-tip"
                          data-calendar-tooltip="Usually http://127.0.0.1:11434"
                          tabindex="0"
                          on:mouseenter={onTipEnter}
                          on:mouseleave={onTipLeave}
                          on:focus={onTipEnter}
                          on:blur={onTipLeave}
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id={ollamaUrlInputId}
                        type="text"
                        value={$settings.ollamaBaseUrl}
                        placeholder="http://127.0.0.1:11434"
                        on:change={onChangeOllamaBaseUrl}
                      />
                    </div>

                    <div class="calendar-ollama-field">
                      <label for={ollamaModelInputId}>
                        Model
                        <span
                          class="calendar-tip"
                          data-calendar-tooltip="e.g. gemma3:4b"
                          tabindex="0"
                          on:mouseenter={onTipEnter}
                          on:mouseleave={onTipLeave}
                          on:focus={onTipEnter}
                          on:blur={onTipLeave}
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id={ollamaModelInputId}
                        type="text"
                        value={$settings.ollamaModel}
                        placeholder="gemma3:4b"
                        on:change={onChangeOllamaModel}
                      />
                    </div>

                    <div class="calendar-ollama-field">
                      <label for={ollamaMaxCharsInputId}>
                        Max chars
                        <span
                          class="calendar-tip"
                          data-calendar-tooltip="Truncates note text"
                          tabindex="0"
                          on:mouseenter={onTipEnter}
                          on:mouseleave={onTipLeave}
                          on:focus={onTipEnter}
                          on:blur={onTipLeave}
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id={ollamaMaxCharsInputId}
                        type="number"
                        value={String($settings.ollamaMaxChars ?? "")}
                        placeholder="8000"
                        on:change={onChangeOllamaMaxChars}
                      />
                    </div>

                    <div class="calendar-ollama-field">
                      <label for={ollamaTimeoutInputId}>
                        Timeout
                        <span
                          class="calendar-tip"
                          data-calendar-tooltip="ms (status + generate)"
                          tabindex="0"
                          on:mouseenter={onTipEnter}
                          on:mouseleave={onTipLeave}
                          on:focus={onTipEnter}
                          on:blur={onTipLeave}
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id={ollamaTimeoutInputId}
                        type="number"
                        value={String($settings.ollamaRequestTimeoutMs ?? "")}
                        placeholder="15000"
                        on:change={onChangeOllamaTimeout}
                      />
                    </div>

                    <div class="calendar-ollama-field">
                      <label for={ollamaCacheInputId}>
                        Cache
                        <span
                          class="calendar-tip"
                          data-calendar-tooltip="Max saved titles"
                          tabindex="0"
                          on:mouseenter={onTipEnter}
                          on:mouseleave={onTipLeave}
                          on:focus={onTipEnter}
                          on:blur={onTipLeave}
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id={ollamaCacheInputId}
                        type="number"
                        value={String($settings.ollamaTitleCacheMaxEntries ?? "")}
                        placeholder="1000"
                        on:change={onChangeOllamaCacheSize}
                      />
                    </div>
                  </div>

                  <div class="calendar-ollama-menu-actions">
                    <button
                      class="calendar-ollama-action"
                      type="button"
                      disabled={ollamaStatusState === "checking"}
                      title="Check status"
                      on:click={() => void refreshOllamaStatus()}
                    >
                      Check
                    </button>

                    <button
                      class="calendar-ollama-action"
                      type="button"
                      disabled={pullingModel}
                      title={`Pull ${OLLAMA_PULL_MODEL}`}
                      on:click={onClickPullModel}
                    >
                      {pullingModel ? "Pulling…" : "Pull"}
                    </button>

                    <button
                      class="calendar-ollama-action calendar-ollama-action--danger"
                      type="button"
                      title="Clear cached titles"
                      on:click={() => void clearGeneratedTitles()}
                    >
                      Clear
                    </button>
                  </div>

                  <div
                    class="calendar-ollama-menu-status"
                    class:is-error={ollamaStatusState === "error"}
                    title={ollamaStatusDetails || undefined}
                  >
                    <span
                      class="calendar-ollama-status-dot"
                      class:is-ok={ollamaStatusState === "ok"}
                      class:is-error={ollamaStatusState === "error"}
                      class:is-checking={ollamaStatusState === "checking"}
                      aria-hidden="true"
                    ></span>
                    <div class="calendar-ollama-menu-status-text">
                      <div class="calendar-ollama-menu-status-label">{ollamaStatusLabel}</div>
                      {#if ollamaStatusDetails}
                        <div class="calendar-ollama-menu-status-details">{ollamaStatusDetails}</div>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            </div>

            {#if showTooltip}
              <div
                class="calendar-tooltip"
                role="tooltip"
                bind:this={tooltipEl}
                use:portalToBody
                style={`top: ${tooltipTop}px; left: ${tooltipLeft}px;`}
              >
                {tooltipText}
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </div>

  {#if showList}
    <div
      class="calendar-pane calendar-list-view"
      bind:this={listScrollEl}
      transition:slide={{ duration: 140 }}
    >
      {#if listLoading}
        <div class="calendar-list-status">Loading…</div>
      {:else if listError}
        <div class="calendar-list-error">{listError}</div>
      {:else if listGroups.length === 0}
        <div class="calendar-list-empty">
          {$settings.listViewIncludeCreatedDays
            ? "No daily notes or created items."
            : "No daily notes."}
        </div>
      {/if}

      {#each listGroups as group (group.id)}
        <ListGroup
          node={group}
          openState={groupOpenState}
          onToggle={onToggleGroup}
          showCounts={$settings.listViewShowCounts}
          scrollParent={listScrollEl}
          dayOpenState={dayOpenState}
          let:items
        >
          {#each items as item (item.dateUID)}
            <details
              class="calendar-list-day-details"
              class:is-empty={!hasDayChildren(item)}
              open={dayOpenState[item.dateUID]}
              on:toggle={(e) => onToggleDay(item.dateUID, e)}
            >
              <summary
                class:is-color-tagged={isListItemTagged($listItemColorTags, getListItemTagKeyForDay(item))}
                style={getListItemTagStyle($listItemColorTags, getListItemTagKeyForDay(item))}
                on:contextmenu={(e) => onContextMenuListDay(item, e)}
              >
                <span class="calendar-chevron" aria-hidden="true">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M8 5v14l11-7-11-7z"></path>
                  </svg>
                </span>
                <div class="calendar-list-row">
                  {#if editingCustomTitleDateUID === item.dateUID}
                    <div
                      class="calendar-list-day-editor"
                      on:click|stopPropagation
                      on:mousedown|stopPropagation
                    >
                      <span class="calendar-list-day-date">{item.dateStr}</span>
                      <span class="calendar-list-day-sep"> - </span>
                      <input
                        class="calendar-list-day-input"
                        type="text"
                        bind:this={editingCustomTitleInputEl}
                        bind:value={editingCustomTitleValue}
                        placeholder="Add title…"
                        aria-label={`Custom title for ${item.dateStr}`}
                        on:click|stopPropagation
                        on:mousedown|stopPropagation
                        on:keydown={onCustomTitleInputKeyDown}
                        on:blur={onCustomTitleInputBlur}
                      />
                    </div>
                  {:else}
                    <button
                      class="calendar-list-day"
                      class:is-active={item.dateUID === $activeFile}
                      class:is-missing-daily={!item.dailyNoteExists}
                      type="button"
                      on:click={(e) => onClickListDay(item.date, e)}
                    >
                      <span class="calendar-list-day-label">
                        {getCustomTitleLabel(item, $customListTitles) ??
                          getCachedOllamaTitle(
                            item,
                            $settings.ollamaTitlesEnabled,
                            $ollamaTitleCache
                          ) ??
                          item.dateStr}
                      </span>
                    </button>
                  {/if}

                  {#if $settings.listViewShowCounts && $settings.listViewIncludeCreatedDays}
                    {#if item.createdNotesCount || item.createdFilesCount}
                      <span class="calendar-list-counts">
                        {#if item.createdNotesCount}
                          <span
                            class="calendar-list-count"
                            title={`Notes: ${item.createdNotesCount}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              width="14"
                              height="14"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
                            </svg>
                            <span class="calendar-list-count-num">{item.createdNotesCount}</span>
                          </span>
                        {/if}

                        {#if item.createdFilesCount}
                          <span
                            class="calendar-list-count"
                            title={`Attachments: ${item.createdFilesCount}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              width="14"
                              height="14"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path d="M16.5 6.5v9.79c0 1.93-1.57 3.5-3.5 3.5s-3.5-1.57-3.5-3.5V5c0-1.38 1.12-2.5 2.5-2.5S14.5 3.62 14.5 5v9.5c0 .55-.45 1-1 1s-1-.45-1-1V6.5H11v8c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S8 2.79 8 5v11.29c0 2.76 2.24 5 5 5s5-2.24 5-5V6.5h-1.5z" />
                            </svg>
                            <span class="calendar-list-count-num">{item.createdFilesCount}</span>
                          </span>
                        {/if}
                      </span>
                    {/if}
                  {/if}

                  {#if $settings.ollamaTitlesEnabled && item.filePath}
                    <button
                      class="calendar-list-generate"
                      class:is-loading={titleInFlight[item.filePath]}
                      type="button"
                      aria-label="Generate / refresh title"
                      title="Generate / refresh title"
                      disabled={titleInFlight[item.filePath]}
                      on:click={(e) => onClickGenerateTitle(item, e)}
                    >
                      <svg
                        focusable="false"
                        role="img"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.9 9.4 1 1 0 1 0-1.97-.35A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L14 10h6V4l-2.35 2.35Z"
                        />
                      </svg>
                    </button>
                  {/if}

                  <button
                    class="calendar-list-edit-title"
                    class:is-editing={editingCustomTitleDateUID === item.dateUID}
                    type="button"
                    aria-label={editingCustomTitleDateUID === item.dateUID
                      ? "Save custom title"
                      : "Edit custom title"}
                    title={editingCustomTitleDateUID === item.dateUID
                      ? "Save custom title"
                      : "Edit custom title"}
                    on:mousedown={() => {
                      if (editingCustomTitleDateUID === item.dateUID) {
                        suppressNextCustomTitleBlurSave = true;
                      }
                    }}
                    on:click={(e) => onClickEditCustomTitle(item, e)}
                  >
                    {#if editingCustomTitleDateUID === item.dateUID}
                      <svg
                        focusable="false"
                        role="img"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
                        />
                      </svg>
                    {:else}
                      <svg
                        focusable="false"
                        role="img"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.33H5v-.92l9.06-9.06.92.92L5.92 19.58zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                        />
                      </svg>
                    {/if}
                  </button>
                </div>
              </summary>

              {#if dayOpenState[item.dateUID]}
                {#if $settings.listViewIncludeCreatedDays}
                  <div class="calendar-list-day-children">
                  <!-- Notes created on this day, shown directly without a subgroup -->
                  <div class="calendar-list-subitems">
                    {#if createdOnDayIndexLoading}
                      <div class="calendar-list-substatus">Indexing…</div>
                    {:else if createdOnDayIndexError}
                      <div class="calendar-list-suberror">
                        {createdOnDayIndexError}
                      </div>
                    {:else}
                      {#each getCreatedNotesForItem(item) as file (file.path)}
                        <div
                          class="calendar-list-entry"
                          class:is-color-tagged={isListItemTagged($listItemColorTags, getListItemTagKeyForFile(file))}
                          style={getListItemTagStyle($listItemColorTags, getListItemTagKeyForFile(file))}
                          role="button"
                          tabindex="0"
                          on:click={(e) => onClickOpenFile(file, e)}
                          on:keydown={(e) => onKeyOpenFile(file, e)}
                          on:contextmenu={(e) => onContextMenuListFile(file, e)}
                        >
                          <span class="calendar-list-entry-name" title={file.path}>
                            {file.basename}{#if getFileExtension(file)}.{getFileExtension(file)}{/if}
                          </span>
                          
                        </div>
                      {/each}
                    {/if}
                  </div>

                  {#if getCreatedFilesForItem(item).length}
                   <details
                     class="calendar-list-subgroup"
                     open={dayChildOpenState[item.dateUID]?.files}
                     on:toggle={(e) =>
                       onToggleDayChild(item.dateUID, "files", e)}
                   >
                    <summary>
                      <span class="calendar-chevron" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                          <path d="M8 5v14l11-7-11-7z"></path>
                        </svg>
                      </span>
                      Attachments
                    </summary>

                    {#if dayChildOpenState[item.dateUID]?.files}
                      <div class="calendar-list-subitems calendar-list-subitems--subgroup">
                        {#if createdOnDayIndexLoading}
                          <div class="calendar-list-substatus">Indexing…</div>
                        {:else if createdOnDayIndexError}
                          <div class="calendar-list-suberror">
                            {createdOnDayIndexError}
                          </div>
                        {:else}
                          {#each getCreatedFilesForItem(item) as file (file.path)}
                            <div
                              class="calendar-list-entry"
                              class:is-color-tagged={isListItemTagged($listItemColorTags, getListItemTagKeyForFile(file))}
                              style={getListItemTagStyle($listItemColorTags, getListItemTagKeyForFile(file))}
                              role="button"
                              tabindex="0"
                              on:click={(e) => onClickOpenFile(file, e)}
                              on:keydown={(e) => onKeyOpenFile(file, e)}
                              on:contextmenu={(e) => onContextMenuListFile(file, e)}
                            >
                              <span class="calendar-list-entry-name" title={file.path}>
                                {file.name}
                              </span>
                              
                            </div>
                          {/each}
                        {/if}
                      </div>
                    {/if}
                  </details>
                 {/if}
                  </div>
                {/if}
              {/if}
            </details>
          {/each}
        </ListGroup>
      {/each}
    </div>
  {/if}
</div>

<style>
  .calendar-list-day.is-missing-daily {
    color: var(--text-faint);
    opacity: 0.75;
  }
</style>

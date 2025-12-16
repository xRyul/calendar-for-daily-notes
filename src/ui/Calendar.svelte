<svelte:options immutable />

<script lang="ts">
  import type { Moment } from "moment";
  import {
    Calendar as CalendarBase,
    configureGlobalMomentLocale,
  } from "obsidian-calendar-ui";
  import type { ICalendarSource } from "obsidian-calendar-ui";
  import { onDestroy, onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { Notice } from "obsidian";
  import type { EventRef, TFile } from "obsidian";
  import { getDateFromFile, getDateUID } from "obsidian-daily-notes-interface";

  import { DEFAULT_WORDS_PER_DOT } from "src/constants";
  import { createOllamaClient, safeParseJson } from "src/ollama/client";
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

  import type { ISettings } from "src/settings";
  import {
    activeFile,
    dailyNotes,
    ollamaTitleCache,
    settings,
    weeklyNotes,
  } from "./stores";
  import { getWordCount } from "./utils";

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

  let calendarBaseWrapperEl: HTMLDivElement | null = null;
  let listToggleButtonEl: HTMLButtonElement | null = null;
  let listTogglePositioned = false;

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

  type ListItem = {
    date: Moment;
    dateUID: string;
    dateStr: string;
    epoch: number;
    year: number;

    file?: TFile;
    filePath: string;
    mtime: number;
  };
  type YearGroup = { year: number; items: ListItem[] };

  let listGroups: YearGroup[] = [];
  let listLoading = false;
  let listError: string | null = null;

  // Track open/closed state for each year, so user toggles persist across refreshes.
  let yearOpenState: Record<number, boolean> = {};

  // Track open/closed state for each day (nested under year).
  let dayOpenState: Record<string, boolean> = {};

  type DayChildKey = "notes" | "files";
  type DayChildOpenState = { notes: boolean; files: boolean };
  let dayChildOpenState: Record<string, DayChildOpenState> = {};

  type CreatedOnDayBucket = { notes: TFile[]; files: TFile[] };
  let createdOnDayIndex: Record<string, CreatedOnDayBucket> = {};
  let createdOnDayIndexLoading = false;
  let createdOnDayIndexError: string | null = null;

  let createdOnDayIndexNonce = 0;
  let createdOnDayIndexTimer: number | null = null;
  const CREATED_ON_DAY_RECOMPUTE_DEBOUNCE_MS = 1200;

  const wordCountCache = new Map<string, { mtime: number; wordCount: number }>();
  let titleInFlight: Record<string, boolean> = {};

  let listComputeNonce = 0;
  // Obsidian runs in an Electron (DOM) environment; window.setTimeout returns a numeric ID.
  // Avoid ReturnType<typeof setTimeout> because it can resolve to NodeJS.Timeout when Node types are included.
  let listComputeTimer: number | null = null;
  const LIST_RECOMPUTE_DEBOUNCE_MS = 750;

  function toggleList(): void {
    showList = !showList;
    if (showList) {
      showListJustOpened = true;
      void computeList();
      void rebuildCreatedOnDayIndex();
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

  async function rebuildCreatedOnDayIndex(): Promise<void> {
    const nonce = ++createdOnDayIndexNonce;
    createdOnDayIndexLoading = true;
    createdOnDayIndexError = null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).app;
      const vault = app?.vault;
      if (!vault?.getFiles) {
        createdOnDayIndex = {};
        return;
      }

      const files = (vault.getFiles() ?? []) as TFile[];
      const next: Record<string, CreatedOnDayBucket> = {};

      const chunkSize = 2000;
      for (let i = 0; i < files.length; i += chunkSize) {
        if (nonce !== createdOnDayIndexNonce) {
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

          const dateStr = window.moment(ctime).format("YYYY-MM-DD");
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

      if (nonce !== createdOnDayIndexNonce) {
        return;
      }

      createdOnDayIndex = next;
      // Updating index may require list recompute to surface days without daily notes
      scheduleListRecompute();
    } catch (err) {
      console.error("[Calendar] Failed to build created-on-day index", err);
      if (nonce !== createdOnDayIndexNonce) {
        return;
      }

      createdOnDayIndexError = err instanceof Error ? err.message : String(err);
      createdOnDayIndex = {};
    } finally {
      if (nonce === createdOnDayIndexNonce) {
        createdOnDayIndexLoading = false;
      }
    }
  }

  function scheduleCreatedOnDayIndexRebuild(): void {
    if (!showList) {
      return;
    }

    if (createdOnDayIndexTimer !== null) {
      window.clearTimeout(createdOnDayIndexTimer);
    }

    createdOnDayIndexTimer = window.setTimeout(() => {
      createdOnDayIndexTimer = null;
      void rebuildCreatedOnDayIndex();
    }, CREATED_ON_DAY_RECOMPUTE_DEBOUNCE_MS);
  }

  async function getCachedWordCount(file: TFile): Promise<number> {
    const mtime = file.stat?.mtime ?? 0;

    const cached = wordCountCache.get(file.path);
    if (cached && cached.mtime === mtime) {
      return cached.wordCount;
    }

    const fileContents = await window.app.vault.cachedRead(file);
    const wordCount = getWordCount(fileContents);

    wordCountCache.set(file.path, { mtime, wordCount });
    return wordCount;
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
    listLoading = true;
    listError = null;

    try {
      const dailyNotesRecord = $dailyNotes ?? {};
      const files = Object.values(dailyNotesRecord).filter(Boolean) as TFile[];

      const wordsPerDot = $settings.wordsPerDot ?? DEFAULT_WORDS_PER_DOT;
      const includeAll = wordsPerDot <= 0;

      const items: ListItem[] = [];
      const concurrency = 10;

      for (let i = 0; i < files.length; i += concurrency) {
        const chunk = files.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (file) => {
            const date = getDateFromFile(file, "day");
            if (!date) {
              return null;
            }

            if (!includeAll) {
              const wordCount = await getCachedWordCount(file);
              if (wordCount < wordsPerDot) {
                return null;
              }
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
            } as ListItem;
          })
        );

        if (nonce !== listComputeNonce) {
          return;
        }

        for (const item of chunkResults) {
          if (item) {
            items.push(item);
          }
        }
      }

      items.sort((a, b) => b.epoch - a.epoch);

      // Ensure days with created notes/files appear even without a qualifying daily note
      if (createdOnDayIndex && typeof createdOnDayIndex === "object") {
        for (const dateStr of Object.keys(createdOnDayIndex)) {
          const exists = items.some((it) => it.dateStr === dateStr);
          if (!exists) {
            const date = window.moment(dateStr, "YYYY-MM-DD");
            if (date?.isValid?.()) {
              items.push({
                date,
                dateUID: getDateUID(date, "day"),
                dateStr,
                epoch: date.valueOf(),
                year: date.year(),
                filePath: "",
                mtime: 0,
              } as ListItem);
            }
          }
        }
      }

      items.sort((a, b) => b.epoch - a.epoch);

      const yearToItems = new Map<number, ListItem[]>();
      for (const item of items) {
        const arr = yearToItems.get(item.year);
        if (arr) {
          arr.push(item);
        } else {
          yearToItems.set(item.year, [item]);
        }
      }

      const years = Array.from(yearToItems.keys()).sort((a, b) => b - a);
      const groups = years.map((year) => ({
        year,
        items: yearToItems.get(year) ?? [],
      }));

      // Default: current year expanded; others collapsed.
      const currentYear = today?.year?.() ?? window.moment().year();
      const nextOpenState: Record<number, boolean> = { ...yearOpenState };
      const yearSet = new Set(years);

      for (const year of years) {
        if (nextOpenState[year] === undefined) {
          nextOpenState[year] = year === currentYear;
        }
      }
      for (const key of Object.keys(nextOpenState)) {
        const year = Number(key);
        if (!yearSet.has(year)) {
          delete nextOpenState[year];
        }
      }

      yearOpenState = nextOpenState;

      // Maintain per-day open state (and sub-toggle open state) across refreshes.
      const dayUIDSet = new Set(items.map((i) => i.dateUID));
      const nextDayOpenState: Record<string, boolean> = { ...dayOpenState };
      const nextDayChildOpenState: Record<string, DayChildOpenState> = {
        ...dayChildOpenState,
      };

      for (const item of items) {
        if (nextDayOpenState[item.dateUID] === undefined) {
          nextDayOpenState[item.dateUID] = false;
        }

        const prevChild = nextDayChildOpenState[item.dateUID];
        nextDayChildOpenState[item.dateUID] = prevChild
          ? { notes: !!prevChild.notes, files: !!prevChild.files }
          : { notes: false, files: false };
      }

      for (const key of Object.keys(nextDayOpenState)) {
        if (!dayUIDSet.has(key)) {
          delete nextDayOpenState[key];
        }
      }
      for (const key of Object.keys(nextDayChildOpenState)) {
        if (!dayUIDSet.has(key)) {
          delete nextDayChildOpenState[key];
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
        listLoading = false;
      }
    }
  }

  function onToggleYear(year: number, event: Event): void {
    const el = event.currentTarget as HTMLDetailsElement;
    yearOpenState = { ...yearOpenState, [year]: el.open };
  }

  function onToggleDay(dateUID: string, event: Event): void {
    const el = event.currentTarget as HTMLDetailsElement;
    dayOpenState = { ...dayOpenState, [dateUID]: el.open };
  }

  function onToggleDayChild(
    dateUID: string,
    child: DayChildKey,
    event: Event
  ): void {
    const el = event.currentTarget as HTMLDetailsElement;
    const prev = dayChildOpenState[dateUID] ?? { notes: false, files: false };
    dayChildOpenState = {
      ...dayChildOpenState,
      [dateUID]: { ...prev, [child]: el.open },
    };
  }

  function getCreatedNotesForItem(item: ListItem): TFile[] {
    const bucket = createdOnDayIndex[item.dateStr];
    if (!bucket?.notes?.length) {
      return [];
    }
    return bucket.notes.filter((f) => f.path !== item.filePath);
  }

  function getCreatedFilesForItem(item: ListItem): TFile[] {
    const bucket = createdOnDayIndex[item.dateStr];
    return bucket?.files ?? [];
  }

  function hasDayChildren(item: ListItem): boolean {
    const notes = getCreatedNotesForItem(item);
    const files = getCreatedFilesForItem(item);
    return (notes && notes.length > 0) || (files && files.length > 0);
  }

  /* removed: getParentFolderName, no longer used */
  function getParentFolderName(file: TFile): string {
    try {
      const p = file.path ?? "";
      const idx = p.lastIndexOf("/");
      if (idx <= 0) return "";
      const dir = p.slice(0, idx);
      const didx = dir.lastIndexOf("/");
      return didx >= 0 ? dir.slice(didx + 1) : dir;
    } catch {
      return "";
    }
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

  $: if (showList) {
    // Recompute when daily note index or threshold changes.
    $dailyNotes;
    $settings.wordsPerDot;

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

  function updateListTogglePosition(): void {
    if (!calendarBaseWrapperEl || !listToggleButtonEl) {
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

    // Put the toggle into the header DOM flow so layout stays robust at tiny widths.
    // This avoids overlaps (title vs toggle vs arrows) and lets CSS handle truncation/scroll.
    if (listToggleButtonEl.parentElement !== navEl) {
      navEl.insertBefore(listToggleButtonEl, rightNavEl);
    }

    listTogglePositioned = true;
  }

  onMount(() => {
    const schedule = () => {
      // CalendarBase mounts inside this component; wait a frame so its DOM is ready.
      window.requestAnimationFrame(() => {
        updateCalendarScale();
        updateListTogglePosition();
      });
    };

    // Refresh "created on this day" data when vault files change.
    const vaultEventRefs: EventRef[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = (window as any).app?.vault;
    if (vault?.on && vault?.offref) {
      vaultEventRefs.push(vault.on("create", scheduleCreatedOnDayIndexRebuild));
      vaultEventRefs.push(vault.on("delete", scheduleCreatedOnDayIndexRebuild));
      vaultEventRefs.push(vault.on("rename", scheduleCreatedOnDayIndexRebuild));
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

  onDestroy(() => {
    clearInterval(heartbeat);
    if (listComputeTimer !== null) {
      window.clearTimeout(listComputeTimer);
    }
    if (createdOnDayIndexTimer !== null) {
      window.clearTimeout(createdOnDayIndexTimer);
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

      <button
        class="calendar-list-toggle"
        class:is-active={showList}
        class:is-positioned={listTogglePositioned}
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
    </div>
  </div>

  {#if showList}
    <div
      class="calendar-pane calendar-list-view"
      transition:slide={{ duration: 140 }}
    >
      {#if listLoading}
        <div class="calendar-list-status">Loading…</div>
      {:else if listError}
        <div class="calendar-list-error">{listError}</div>
      {:else if listGroups.length === 0}
        <div class="calendar-list-empty">No qualifying daily notes.</div>
      {/if}

      {#each listGroups as group (group.year)}
        <details
          class="calendar-list-year"
          open={yearOpenState[group.year]}
          on:toggle={(e) => onToggleYear(group.year, e)}
        >
          <summary>
            <span class="calendar-chevron" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M8 5v14l11-7-11-7z"></path>
              </svg>
            </span>
            {group.year}
          </summary>

          <div class="calendar-list-days">
            {#each group.items as item (item.dateUID)}
              <details
                class="calendar-list-day-details"
                class:is-empty={!hasDayChildren(item)}
                open={dayOpenState[item.dateUID]}
                on:toggle={(e) => onToggleDay(item.dateUID, e)}
              >
                <summary>
                  <span class="calendar-chevron" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M8 5v14l11-7-11-7z"></path>
                    </svg>
                  </span>
                  <div class="calendar-list-row">
                    <button
                      class="calendar-list-day"
                      class:is-active={item.dateUID === $activeFile}
                      type="button"
                      on:click={(e) => onClickListDay(item.date, e)}
                    >
                      <span class="calendar-list-day-label">
                        {getCachedOllamaTitle(
                          item,
                          $settings.ollamaTitlesEnabled,
                          $ollamaTitleCache
                        ) ?? item.dateStr}
                      </span>
                    </button>

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
                  </div>
                </summary>

                {#if dayOpenState[item.dateUID]}
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
                            role="button"
                            tabindex="0"
                            on:click={(e) => onClickOpenFile(file, e)} on:keydown={(e) => onKeyOpenFile(file, e)}
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
                                role="button"
                                tabindex="0"
                                on:click={(e) => onClickOpenFile(file, e)} on:keydown={(e) => onKeyOpenFile(file, e)}
                              >
                                <span class="calendar-list-entry-name" title={file.path}>
                                  {file.name}
                                </span>
                                
                              </div>
                            {:else}
                              <div class="calendar-list-subempty">
                                No attachments created on this day.
                              </div>
                            {/each}
                          {/if}
                        </div>
                      {/if}
                    </details>
                   {/if}
                  </div>
                {/if}
              </details>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  {/if}
</div>

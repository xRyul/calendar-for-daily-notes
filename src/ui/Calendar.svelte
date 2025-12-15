<svelte:options immutable />

<script lang="ts">
  import type { Moment } from "moment";
  import {
    Calendar as CalendarBase,
    configureGlobalMomentLocale,
  } from "obsidian-calendar-ui";
  import type { ICalendarSource } from "obsidian-calendar-ui";
  import { onDestroy } from "svelte";
  import type { TFile } from "obsidian";
  import { getDateFromFile, getDateUID } from "obsidian-daily-notes-interface";

  import { DEFAULT_WORDS_PER_DOT } from "src/constants";

  import type { ISettings } from "src/settings";
  import { activeFile, dailyNotes, settings, weeklyNotes } from "./stores";
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

  type ViewTab = "calendar" | "list";
  let activeTab: ViewTab = "calendar";

  type ListItem = {
    date: Moment;
    dateUID: string;
    dateStr: string;
    epoch: number;
    year: number;
  };
  type YearGroup = { year: number; items: ListItem[] };

  let listGroups: YearGroup[] = [];
  let listLoading = false;
  let listError: string | null = null;

  // Track open/closed state for each year, so user toggles persist across refreshes.
  let yearOpenState: Record<number, boolean> = {};

  const wordCountCache = new Map<string, { mtime: number; wordCount: number }>();

  let listComputeNonce = 0;
  // Obsidian runs in an Electron (DOM) environment; window.setTimeout returns a numeric ID.
  // Avoid ReturnType<typeof setTimeout> because it can resolve to NodeJS.Timeout when Node types are included.
  let listComputeTimer: number | null = null;
  const LIST_RECOMPUTE_DEBOUNCE_MS = 750;

  function setTab(tab: ViewTab): void {
    activeTab = tab;

    if (activeTab === "list") {
      void computeList();
    }
  }

  function scheduleListRecompute(): void {
    if (activeTab !== "list") {
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

  function onClickListDay(date: Moment, event: MouseEvent): void {
    const isMetaPressed = event.metaKey || event.ctrlKey;
    onClickDay(date, isMetaPressed);
  }

  $: if (activeTab === "list") {
    // Recompute when daily note index or threshold changes.
    $dailyNotes;
    $settings.wordsPerDot;
    scheduleListRecompute();
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

  onDestroy(() => {
    clearInterval(heartbeat);
    if (listComputeTimer) {
      window.clearTimeout(listComputeTimer);
    }
  });
</script>

<div class="calendar-view">
  <div class="calendar-tab-bar">
    <button
      class="calendar-tab"
      class:is-active={activeTab === "calendar"}
      type="button"
      on:click={() => setTab("calendar")}
    >
      Calendar
    </button>
    <button
      class="calendar-tab"
      class:is-active={activeTab === "list"}
      type="button"
      on:click={() => setTab("list")}
    >
      List
    </button>
  </div>

  <div class="calendar-pane" class:is-hidden={activeTab !== "calendar"}>
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
  </div>

  <div class="calendar-pane calendar-list-view" class:is-hidden={activeTab !== "list"}>
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
        <summary>{group.year}</summary>

        <div class="calendar-list-days">
          {#each group.items as item (item.dateUID)}
            <button
              class="calendar-list-day"
              class:is-active={item.dateUID === $activeFile}
              type="button"
              on:click={(e) => onClickListDay(item.date, e)}
            >
              {item.dateStr}
            </button>
          {/each}
        </div>
      </details>
    {/each}
  </div>
</div>

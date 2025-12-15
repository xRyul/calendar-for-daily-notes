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
  import type { TFile } from "obsidian";
  import { getDateFromFile, getDateUID } from "obsidian-daily-notes-interface";

  import { DEFAULT_WORDS_PER_DOT } from "src/constants";
  import { createOllamaClient, safeParseJson } from "src/ollama/client";
  import type { OllamaGenerateResponse } from "src/ollama/client";
  import { upsertOllamaTitleCacheEntry } from "src/ollama/cache";
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

    file: TFile;
    filePath: string;
    mtime: number;
  };
  type YearGroup = { year: number; items: ListItem[] };

  let listGroups: YearGroup[] = [];
  let listLoading = false;
  let listError: string | null = null;

  // Track open/closed state for each year, so user toggles persist across refreshes.
  let yearOpenState: Record<number, boolean> = {};

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

  function getCachedOllamaTitle(item: ListItem): string | null {
    const enabled = !!$settings.ollamaTitlesEnabled;
    if (!enabled) {
      return null;
    }

    const entry = $ollamaTitleCache?.[item.filePath];
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
    };
  });

  onDestroy(() => {
    clearInterval(heartbeat);
    if (listComputeTimer !== null) {
      window.clearTimeout(listComputeTimer);
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
          <summary>{group.year}</summary>

          <div class="calendar-list-days">
            {#each group.items as item (item.dateUID)}
              <div class="calendar-list-row">
                <button
                  class="calendar-list-day"
                  class:is-active={item.dateUID === $activeFile}
                  type="button"
                  on:click={(e) => onClickListDay(item.date, e)}
                >
                  <span class="calendar-list-day-label">
                    {getCachedOllamaTitle(item) ?? item.dateStr}
                  </span>
                </button>

                {#if $settings.ollamaTitlesEnabled}
                  <button
                    class="calendar-list-generate"
                    class:is-loading={titleInFlight[item.filePath]}
                    type="button"
                    aria-label="Generate title"
                    title="Generate title"
                    disabled={titleInFlight[item.filePath]}
                    on:click={(e) => onClickGenerateTitle(item, e)}
                  >
                    {titleInFlight[item.filePath] ? "…" : "Gen"}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  {/if}
</div>

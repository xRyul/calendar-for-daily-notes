<script lang="ts">
  import type { Locale, Moment } from "moment";
  import { Calendar as LegacyCalendar } from "obsidian-calendar-ui";
  import type { ICalendarSource } from "obsidian-calendar-ui";
  import { onMount } from "svelte";

  // Settings
  export let showWeekNums = false;
  export let localeData: Locale | undefined;

  // Event handlers
  export let onHoverDay: ((date: Moment, targetEl: EventTarget) => void) | undefined;
  export let onHoverWeek:
    | ((date: Moment, targetEl: EventTarget) => void)
    | undefined;
  export let onClickDay:
    | ((date: Moment, isMetaPressed: boolean) => void)
    | undefined;
  export let onClickWeek:
    | ((date: Moment, isMetaPressed: boolean) => void)
    | undefined;
  export let onContextMenuDay:
    | ((date: Moment, event: MouseEvent) => boolean)
    | undefined;
  export let onContextMenuWeek:
    | ((date: Moment, event: MouseEvent) => boolean)
    | undefined;

  // External sources
  export let selectedId: string | null | undefined;
  export let sources: ICalendarSource[] = [];

  // Override-able local state
  export let today: Moment | undefined;
  export let displayedMonth: Moment | undefined;

  let targetEl: HTMLDivElement | null = null;

  // The obsidian-calendar-ui Calendar is a legacy Svelte (v3) class component.
  // We mount it imperatively to avoid Svelte 5 treating it as a function component.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any = null;

  function getSafeToday(): Moment {
    // Obsidian exposes Moment.js via `window.moment`.
    return today ?? window.moment();
  }

  function getSafeDisplayedMonth(): Moment {
    return displayedMonth ?? getSafeToday();
  }

  function buildProps() {
    const safeToday = getSafeToday();
    const safeDisplayedMonth = displayedMonth ?? safeToday;

    return {
      showWeekNums,
      localeData,
      onHoverDay,
      onHoverWeek,
      onClickDay,
      onClickWeek,
      onContextMenuDay,
      onContextMenuWeek,
      selectedId,
      sources,
      // Never send undefined here — a legacy `$set({ displayedMonth: undefined })`
      // will clobber the component's internal default and crash in `getMonth()`.
      today: safeToday,
      displayedMonth: safeDisplayedMonth,
    };
  }

  // Keep the legacy component in sync with wrapper props.
  // NOTE: Don't wrap `buildProps()` in another function — we want the compiler to track
  // the individual reactive dependencies (showWeekNums, displayedMonth, etc.).
  $: if (instance) {
    instance.$set(buildProps());
  }

  onMount(() => {
    if (!targetEl) {
      return;
    }

    const initialProps = buildProps();

    instance = new LegacyCalendar({
      target: targetEl,
      props: initialProps,
    });

    // Preserve `bind:displayedMonth` by wiring the legacy component binding callback
    // to this wrapper's exported `displayedMonth` prop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybeBound = (instance as any)?.$$?.bound;
    if (maybeBound) {
      maybeBound.displayedMonth = (value: Moment) => {
        displayedMonth = value;
      };
    }

    // If the parent didn't provide a month yet, initialize it so bindings are stable.
    if (!displayedMonth) {
      displayedMonth = initialProps.displayedMonth;
    }

    return () => {
      instance?.$destroy();
      instance = null;
    };
  });
</script>

<div bind:this={targetEl}></div>

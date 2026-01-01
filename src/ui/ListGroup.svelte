<script lang="ts">
  import type { ListGroupNode, ListItem } from "./listViewModel";
  import { onDestroy, tick } from "svelte";

  export let node: ListGroupNode;
  export let openState: Record<string, boolean> = {};
  export let onToggle: (id: string, event: Event) => void = () => {};
  export let showCounts = false;

  // Virtualization (windowing) for leaf groups with many day rows.
  // This keeps DOM size bounded while scrolling large histories.
  export let scrollParent: HTMLElement | null = null;
  export let dayOpenState: Record<string, boolean> = {};
  export let virtualize = true;
  export let virtualMinItems = 200;
  export let virtualOverscan = 8;

  const DEFAULT_STRIDE_PX = 34;
  const INITIAL_WINDOW_MIN = 40;

  let virtualWindowEl: HTMLDivElement | null = null;
  let activeScrollParent: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;
  let raf = 0;

  let stridePx = DEFAULT_STRIDE_PX;

  let startIndex = 0;
  let endIndex = 0;
  let padTopPx = 0;
  let padBottomPx = 0;

  const clamp = (n: number, lo: number, hi: number): number => {
    return Math.max(lo, Math.min(hi, n));
  };

  const isLeaf = (n: ListGroupNode): boolean => {
    return !(n.groups?.length);
  };

  const hasAnyOpenDay = (items: ListItem[] | undefined): boolean => {
    if (!items?.length) {
      return false;
    }
    for (const item of items) {
      if (dayOpenState[item.dateUID]) {
        return true;
      }
    }
    return false;
  };

  $: opened = !!openState[node.id];
  $: leaf = isLeaf(node);
  $: total = node.items?.length ?? 0;

  // Expanded day rows have variable height; fall back to non-virtualized rendering for correctness.
  $: disableVirtualizeBecauseExpanded = leaf && hasAnyOpenDay(node.items);

  $: canVirtualize =
    virtualize &&
    leaf &&
    opened &&
    !!scrollParent &&
    total >= virtualMinItems &&
    !disableVirtualizeBecauseExpanded;

  $: visibleItems = canVirtualize
    ? (node.items ?? []).slice(startIndex, endIndex)
    : (node.items ?? []);

  function measureStride(): void {
    if (!virtualWindowEl) {
      return;
    }

    const rowEls = Array.from(virtualWindowEl.children).filter((el) =>
      (el as HTMLElement).classList?.contains("calendar-list-day-details")
    ) as HTMLElement[];

    if (rowEls.length >= 2) {
      const first = rowEls[0];
      const second = rowEls[1];
      const nextStride = second.offsetTop - first.offsetTop;
      if (Number.isFinite(nextStride) && nextStride > 8) {
        stridePx = nextStride;
        return;
      }
    }

    if (rowEls.length >= 1) {
      const h = rowEls[0].getBoundingClientRect().height;
      if (Number.isFinite(h) && h > 8) {
        // CSS uses a small gap between rows; add a tiny fudge factor.
        stridePx = Math.round(h) + 2;
      }
    }
  }

  function updateRange(): void {
    if (!canVirtualize || !scrollParent || !virtualWindowEl) {
      startIndex = 0;
      endIndex = total;
      padTopPx = 0;
      padBottomPx = 0;
      return;
    }

    measureStride();

    const stride = stridePx || DEFAULT_STRIDE_PX;
    const overscanPx = virtualOverscan * stride;

    const scrollTop = scrollParent.scrollTop;
    const scrollRect = scrollParent.getBoundingClientRect();
    const containerRect = virtualWindowEl.getBoundingClientRect();

    const containerTopInScroll = containerRect.top - scrollRect.top + scrollTop;

    const viewTop = scrollTop - containerTopInScroll;
    const viewBottom = viewTop + scrollParent.clientHeight;

    let start = Math.floor((viewTop - overscanPx) / stride);
    let end = Math.ceil((viewBottom + overscanPx) / stride);

    start = clamp(start, 0, total);
    end = clamp(end, start, total);

    startIndex = start;
    endIndex = end;

    padTopPx = start * stride;
    padBottomPx = (total - end) * stride;
  }

  function scheduleUpdate(): void {
    if (raf) {
      cancelAnimationFrame(raf);
    }
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateRange();
    });
  }

  function detachListeners(): void {
    if (activeScrollParent) {
      activeScrollParent.removeEventListener("scroll", scheduleUpdate);
      activeScrollParent = null;
    }
    window.removeEventListener("resize", scheduleUpdate);

    if (ro) {
      ro.disconnect();
      ro = null;
    }

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function attachListeners(): void {
    if (!scrollParent) {
      return;
    }

    activeScrollParent = scrollParent;
    activeScrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => scheduleUpdate());
      ro.observe(activeScrollParent);
      if (virtualWindowEl) {
        ro.observe(virtualWindowEl);
      }
    }

    void tick().then(() => {
      if (ro && virtualWindowEl) {
        ro.observe(virtualWindowEl);
      }
      scheduleUpdate();
    });
  }

  // Manage listeners reactively since `scrollParent` is passed in from the parent.
  $: {
    if (canVirtualize) {
      if (activeScrollParent !== scrollParent) {
        detachListeners();
        // Seed a small initial window to avoid a blank list while we measure.
        const initial = Math.min(
          total,
          Math.max(INITIAL_WINDOW_MIN, virtualOverscan * 4)
        );
        startIndex = 0;
        endIndex = initial;
        padTopPx = 0;
        padBottomPx = (total - initial) * (stridePx || DEFAULT_STRIDE_PX);
        attachListeners();
      } else {
        scheduleUpdate();
      }
    } else {
      detachListeners();
      startIndex = 0;
      endIndex = total;
      padTopPx = 0;
      padBottomPx = 0;
    }
  }

  onDestroy(() => {
    detachListeners();
  });
</script>

<details
  class="calendar-list-group"
  open={openState[node.id]}
  on:toggle={(e) => onToggle(node.id, e)}
>
  <summary>
    <span class="calendar-chevron" aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="currentColor"
      >
        <path d="M8 5v14l11-7-11-7z"></path>
      </svg>
    </span>
    <span class="calendar-list-group-label">{node.label}</span>
    {#if showCounts}
      <span
        class="calendar-list-group-count"
        title={`Daily notes: ${node.dailyNoteCount}`}
      >
        {node.dailyNoteCount}
      </span>
    {/if}
  </summary>

  {#if openState[node.id]}
    <div class="calendar-list-days">
      {#if node.groups?.length}
        {#each node.groups as child (child.id)}
            <svelte:self
              node={child}
              {openState}
              {onToggle}
              {showCounts}
              {scrollParent}
              {dayOpenState}
              {virtualize}
              {virtualMinItems}
              {virtualOverscan}
            >
            <svelte:fragment let:items>
              <slot {items} />
            </svelte:fragment>
          </svelte:self>
        {/each}
      {:else}
        {#if canVirtualize}
          <div
            class="calendar-virtual-window"
            bind:this={virtualWindowEl}
            style={`padding-top: ${padTopPx}px; padding-bottom: ${padBottomPx}px;`}
          >
            <slot items={visibleItems} />
          </div>
        {:else}
          <slot items={node.items} />
        {/if}
      {/if}
    </div>
  {/if}
</details>

import type { Moment } from "moment";
import type { TFile } from "obsidian";

export type ListViewGroupingPreset =
  | "year"
  | "year_month"
  | "year_month_name"
  | "year_quarter"
  | "year_week";

export type CreatedOnDayBucket = { notes: TFile[]; files: TFile[] };

export type DailyNoteCandidate = {
  date: Moment;
  dateUID: string;
  dateStr: string;
  epoch: number;
  year: number;

  file: TFile;
  filePath: string;
  mtime: number;

  qualifies: boolean;
};

export type ListItem = {
  date: Moment;
  dateUID: string;
  dateStr: string;
  epoch: number;
  year: number;

  // Daily note (if it exists)
  file?: TFile;
  filePath: string;
  mtime: number;
  dailyNoteExists: boolean;
};

export type ListGroupNode = {
  // Stable path-like key, e.g. `2025/12`
  id: string;
  // Display label for the group header
  label: string;
  // Child groups (empty for leaf groups)
  groups: ListGroupNode[];
  // Leaf group items (empty for non-leaf groups)
  items: ListItem[];
  // Internal: max descendant epoch for sorting by recency
  maxEpoch?: number;
};

export function buildListItems(params: {
  dailyNoteCandidates: DailyNoteCandidate[];
  createdOnDayIndex?: Record<string, CreatedOnDayBucket> | null;
  includeCreatedDays: boolean;
  parseDateStr: (dateStr: string) => Moment;
  getDayDateUID: (date: Moment) => string;
}): ListItem[] {
  const {
    dailyNoteCandidates,
    createdOnDayIndex,
    includeCreatedDays,
    parseDateStr,
    getDayDateUID,
  } = params;

  const byDate = new Map<string, DailyNoteCandidate>();
  for (const candidate of dailyNoteCandidates) {
    const prev = byDate.get(candidate.dateStr);
    // Prefer the most recently modified file if duplicates exist.
    if (!prev || (candidate.mtime ?? 0) > (prev.mtime ?? 0)) {
      byDate.set(candidate.dateStr, candidate);
    }
  }

  const includedDates = new Set<string>();

  // Include qualifying daily notes.
  for (const candidate of byDate.values()) {
    if (candidate.qualifies) {
      includedDates.add(candidate.dateStr);
    }
  }

  // Include days that have created-on-day items (even if the daily note doesn't qualify).
  if (includeCreatedDays && createdOnDayIndex && typeof createdOnDayIndex === "object") {
    for (const [dateStr, bucket] of Object.entries(createdOnDayIndex)) {
      const hasItems =
        (bucket?.notes?.length ?? 0) > 0 || (bucket?.files?.length ?? 0) > 0;
      if (hasItems) {
        includedDates.add(dateStr);
      }
    }
  }

  const items: ListItem[] = [];

  for (const dateStr of includedDates) {
    const candidate = byDate.get(dateStr);

    if (candidate) {
      items.push({
        date: candidate.date,
        dateUID: candidate.dateUID,
        dateStr: candidate.dateStr,
        epoch: candidate.epoch,
        year: candidate.year,

        file: candidate.file,
        filePath: candidate.filePath,
        mtime: candidate.mtime,
        dailyNoteExists: true,
      });
      continue;
    }

    // Created-only day: include a placeholder daily note entry.
    const date = parseDateStr(dateStr);
    if (!date?.isValid?.()) {
      continue;
    }

    items.push({
      date,
      dateUID: getDayDateUID(date),
      dateStr,
      epoch: date.valueOf(),
      year: date.year(),

      file: undefined,
      filePath: "",
      mtime: 0,
      dailyNoteExists: false,
    });
  }

  items.sort((a, b) => b.epoch - a.epoch);
  return items;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeListViewGroupingPreset(
  preset: unknown
): ListViewGroupingPreset {
  switch (preset) {
    case "year":
    case "year_month":
    case "year_month_name":
    case "year_quarter":
    case "year_week":
      return preset;
    default:
      return "year";
  }
}

type GroupSegment = { idPart: string; label: string };

function getSegmentsForDate(
  date: Moment,
  preset: ListViewGroupingPreset
): GroupSegment[] {
  switch (preset) {
    case "year": {
      const year = String(date.year());
      return [{ idPart: year, label: year }];
    }

    case "year_month": {
      const year = String(date.year());
      const month = pad2(date.month() + 1);
      return [
        { idPart: year, label: year },
        { idPart: month, label: month },
      ];
    }

    case "year_month_name": {
      const year = String(date.year());
      const monthId = pad2(date.month() + 1);
      const monthLabel = date.format("MMMM");
      return [
        { idPart: year, label: year },
        // Keep id numeric so open/closed state is stable across locale changes.
        { idPart: monthId, label: monthLabel },
      ];
    }

    case "year_quarter": {
      const year = String(date.year());
      const q = `Q${date.quarter()}`;
      return [
        { idPart: year, label: year },
        { idPart: q, label: q },
      ];
    }

    case "year_week": {
      const isoYear = String(date.isoWeekYear());
      const week = pad2(date.isoWeek());
      return [
        { idPart: isoYear, label: isoYear },
        { idPart: week, label: `W${week}` },
      ];
    }
  }
}

export function getListGroupIdPathForDate(
  date: Moment,
  preset: unknown
): string[] {
  const normalized = normalizeListViewGroupingPreset(preset);
  const segments = getSegmentsForDate(date, normalized);

  const path: string[] = [];
  const parts: string[] = [];
  for (const seg of segments) {
    parts.push(seg.idPart);
    path.push(parts.join("/"));
  }

  return path;
}

type ListGroupNodeInternal = Omit<ListGroupNode, "groups"> & {
  children: Map<string, ListGroupNodeInternal>;
};

export function buildListGroups(
  items: ListItem[],
  preset: unknown
): ListGroupNode[] {
  const normalized = normalizeListViewGroupingPreset(preset);

  const root = new Map<string, ListGroupNodeInternal>();

  for (const item of items) {
    const segs = getSegmentsForDate(item.date, normalized);

    let current = root;
    const parts: string[] = [];
    let leaf: ListGroupNodeInternal | null = null;

    for (const seg of segs) {
      parts.push(seg.idPart);
      const id = parts.join("/");

      let node = current.get(id);
      if (!node) {
        node = {
          id,
          label: seg.label,
          children: new Map(),
          items: [],
          maxEpoch: -Infinity,
        };
        current.set(id, node);
      } else if (node.label !== seg.label) {
        // Keep id stable and allow label to change (e.g., locale change for month names).
        node.label = seg.label;
      }

      node.maxEpoch = Math.max(node.maxEpoch ?? -Infinity, item.epoch);
      leaf = node;
      current = node.children;
    }

    if (leaf) {
      leaf.items.push(item);
    }
  }

  const finalize = (node: ListGroupNodeInternal): ListGroupNode => {
    const groups = Array.from(node.children.values())
      .sort((a, b) => (b.maxEpoch ?? 0) - (a.maxEpoch ?? 0))
      .map(finalize);

    return {
      id: node.id,
      label: node.label,
      groups,
      // Only leaf groups should carry items.
      items: groups.length ? [] : node.items,
      maxEpoch: node.maxEpoch,
    };
  };

  return Array.from(root.values())
    .sort((a, b) => (b.maxEpoch ?? 0) - (a.maxEpoch ?? 0))
    .map(finalize);
}

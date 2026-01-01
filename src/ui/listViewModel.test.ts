import moment from "moment";
import type { TFile } from "obsidian";

import { buildListGroups, buildListItems } from "./listViewModel";
import type { ListItem } from "./listViewModel";

describe("ui/listViewModel", () => {
  const parseDateStr = (dateStr: string) => moment(dateStr, "YYYY-MM-DD", true);
  const getDayDateUID = (date: moment.Moment) => date.format("YYYY-MM-DD");

  const mockFile = (path: string): TFile => ({ path } as unknown as TFile);

  const makeItem = (dateStr: string): ListItem => {
    const date = moment(dateStr, "YYYY-MM-DD", true);
    return {
      date,
      dateUID: dateStr,
      dateStr,
      epoch: date.valueOf(),
      year: date.year(),
      filePath: "",
      mtime: 0,
      dailyNoteExists: false,
      createdNotesCount: 0,
      createdFilesCount: 0,
    };
  };

  it("includes qualifying daily notes", () => {
    const date = moment("2025-12-15", "YYYY-MM-DD", true);

    const items = buildListItems({
      dailyNoteCandidates: [
        {
          date,
          dateUID: "2025-12-15",
          dateStr: "2025-12-15",
          epoch: date.valueOf(),
          year: 2025,
          file: mockFile("Daily/2025-12-15.md"),
          filePath: "Daily/2025-12-15.md",
          mtime: 1,
          qualifies: true,
        },
      ],
      createdOnDayIndex: {},
      includeCreatedDays: true,
      parseDateStr,
      getDayDateUID,
    });

    expect(items).toHaveLength(1);
    expect(items[0].dateStr).toBe("2025-12-15");
    expect(items[0].dailyNoteExists).toBe(true);
    expect(items[0].filePath).toBe("Daily/2025-12-15.md");
  });

  it("includes a grey placeholder daily note entry when created items exist but no daily note exists", () => {
    const items = buildListItems({
      dailyNoteCandidates: [],
      createdOnDayIndex: {
        "2025-12-14": { notes: [mockFile("Notes/x.md")], files: [] },
      },
      includeCreatedDays: true,
      parseDateStr,
      getDayDateUID,
    });

    expect(items.map((i) => i.dateStr)).toEqual(["2025-12-14"]);
    expect(items[0].dailyNoteExists).toBe(false);
    expect(items[0].filePath).toBe("");
  });

  it("supports ascending/descending sort order (buildListItems)", () => {
    const params = {
      dailyNoteCandidates: [],
      createdOnDayIndex: {
        "2025-12-14": { notes: [mockFile("Notes/x.md")], files: [] },
        "2025-12-15": { notes: [mockFile("Notes/y.md")], files: [] },
      },
      includeCreatedDays: true,
      parseDateStr,
      getDayDateUID,
    };

    const desc = buildListItems({ ...params, sortOrder: "desc" });
    expect(desc.map((i) => i.dateStr)).toEqual(["2025-12-15", "2025-12-14"]);

    const asc = buildListItems({ ...params, sortOrder: "asc" });
    expect(asc.map((i) => i.dateStr)).toEqual(["2025-12-14", "2025-12-15"]);
  });

  it("keeps the daily note filePath when the day is included via created items (prevents daily note appearing in created list)", () => {
    const date = moment("2025-12-13", "YYYY-MM-DD", true);

    const items = buildListItems({
      dailyNoteCandidates: [
        {
          date,
          dateUID: "2025-12-13",
          dateStr: "2025-12-13",
          epoch: date.valueOf(),
          year: 2025,
          file: mockFile("Daily/2025-12-13.md"),
          filePath: "Daily/2025-12-13.md",
          mtime: 2,
          qualifies: false,
        },
      ],
      createdOnDayIndex: {
        "2025-12-13": { notes: [mockFile("Daily/2025-12-13.md")], files: [] },
      },
      includeCreatedDays: true,
      parseDateStr,
      getDayDateUID,
    });

    expect(items).toHaveLength(1);
    expect(items[0].dateStr).toBe("2025-12-13");
    expect(items[0].dailyNoteExists).toBe(true);
    expect(items[0].filePath).toBe("Daily/2025-12-13.md");
  });

  it("excludes non-qualifying daily notes when there are no created items", () => {
    const date = moment("2025-12-12", "YYYY-MM-DD", true);

    const items = buildListItems({
      dailyNoteCandidates: [
        {
          date,
          dateUID: "2025-12-12",
          dateStr: "2025-12-12",
          epoch: date.valueOf(),
          year: 2025,
          file: mockFile("Daily/2025-12-12.md"),
          filePath: "Daily/2025-12-12.md",
          mtime: 3,
          qualifies: false,
        },
      ],
      createdOnDayIndex: {},
      includeCreatedDays: true,
      parseDateStr,
      getDayDateUID,
    });

    expect(items).toEqual([]);
  });

  describe("buildListGroups", () => {
    beforeEach(() => {
      moment.locale("en");
    });

    it("groups by year (current behavior)", () => {
      const items = [makeItem("2025-12-15"), makeItem("2025-01-01")];
      const groups = buildListGroups(items, "year");

      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("2025");
      expect(groups[0].label).toBe("2025");
      expect(groups[0].groups).toEqual([]);
      expect(groups[0].items.map((i) => i.dateStr)).toEqual([
        "2025-12-15",
        "2025-01-01",
      ]);
    });

    it("nests month groups under year (year_month)", () => {
      const items = [makeItem("2025-12-15"), makeItem("2025-11-30")];
      const groups = buildListGroups(items, "year_month");

      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("2025");
      expect(groups[0].items).toEqual([]);

      const months = groups[0].groups;
      expect(months.map((m) => m.id)).toEqual(["2025/12", "2025/11"]);
      expect(months.map((m) => m.label)).toEqual(["12", "11"]);

      expect(months[0].items.map((i) => i.dateStr)).toEqual(["2025-12-15"]);
      expect(months[1].items.map((i) => i.dateStr)).toEqual(["2025-11-30"]);
    });

    it("nests month groups under year and labels months using locale (year_month_name)", () => {
      const items = [makeItem("2025-12-15"), makeItem("2025-11-30")];
      const groups = buildListGroups(items, "year_month_name");

      expect(groups).toHaveLength(1);
      const months = groups[0].groups;

      // IDs should be numeric (stable across locale changes)
      expect(months.map((m) => m.id)).toEqual(["2025/12", "2025/11"]);
      expect(months.map((m) => m.label)).toEqual(["December", "November"]);
    });

    it("nests month groups under year and labels months as number-name (year_month_num_name)", () => {
      const items = [makeItem("2025-12-15"), makeItem("2025-11-30")];
      const groups = buildListGroups(items, "year_month_num_name");

      expect(groups).toHaveLength(1);
      const months = groups[0].groups;

      // IDs should be numeric (stable across locale changes)
      expect(months.map((m) => m.id)).toEqual(["2025/12", "2025/11"]);
      expect(months.map((m) => m.label)).toEqual(["12-December", "11-November"]);
    });

    it("nests quarter groups under year (year_quarter)", () => {
      const d1 = moment("2025-12-15", "YYYY-MM-DD", true);
      const q1 = `Q${d1.quarter()}`;

      const items = [makeItem("2025-12-15")];
      const groups = buildListGroups(items, "year_quarter");

      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("2025");
      expect(groups[0].groups).toHaveLength(1);
      expect(groups[0].groups[0].id).toBe(`2025/${q1}`);
      expect(groups[0].groups[0].label).toBe(q1);
      expect(groups[0].groups[0].items.map((i) => i.dateStr)).toEqual([
        "2025-12-15",
      ]);
    });

    it("groups by ISO year → ISO week (year_week)", () => {
      const d = moment("2025-12-15", "YYYY-MM-DD", true);
      const isoYear = String(d.isoWeekYear());
      const week = String(d.isoWeek()).padStart(2, "0");

      const items = [makeItem("2025-12-15")];
      const groups = buildListGroups(items, "year_week");

      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(isoYear);
      expect(groups[0].groups).toHaveLength(1);
      expect(groups[0].groups[0].id).toBe(`${isoYear}/${week}`);
      expect(groups[0].groups[0].label).toBe(`W${week}`);
    });

    it("sorts groups by most recent descendant epoch", () => {
      const items = [makeItem("2024-12-31"), makeItem("2025-01-01")];
      const groups = buildListGroups(items, "year");

      expect(groups.map((g) => g.id)).toEqual(["2025", "2024"]);
    });

    it("supports sorting groups/items oldest first (sortOrder=asc)", () => {
      const items = [
        makeItem("2025-12-15"),
        makeItem("2024-12-31"),
        makeItem("2025-01-01"),
      ];
      const groups = buildListGroups(items, "year", "asc");

      expect(groups.map((g) => g.id)).toEqual(["2024", "2025"]);
      expect(groups[1].items.map((i) => i.dateStr)).toEqual([
        "2025-01-01",
        "2025-12-15",
      ]);
    });
  });
});

import {
  formatCustomListTitleLabel,
  normalizeCustomListTitleInput,
  sanitizeCustomListTitles,
} from "./customListTitles";

describe("customListTitles", () => {
  describe("normalizeCustomListTitleInput", () => {
    test("trims and collapses whitespace", () => {
      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "  hello\n\tworld  ",
        })
      ).toBe("hello world");
    });

    test("strips leading date prefix and separators", () => {
      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "2025-12-15 - reflection ideas daily",
        })
      ).toBe("reflection ideas daily");

      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "2025-12-15—reflection ideas daily",
        })
      ).toBe("reflection ideas daily");

      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "2025-12-15: reflection ideas daily",
        })
      ).toBe("reflection ideas daily");
    });

    test("returns empty when input is empty or only date", () => {
      expect(
        normalizeCustomListTitleInput({ dateStr: "2025-12-15", input: "" })
      ).toBe("");

      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "2025-12-15",
        })
      ).toBe("");

      expect(
        normalizeCustomListTitleInput({
          dateStr: "2025-12-15",
          input: "2025-12-15 - ",
        })
      ).toBe("");
    });
  });

  describe("formatCustomListTitleLabel", () => {
    test("formats with date prefix", () => {
      expect(
        formatCustomListTitleLabel("2025-12-15", "reflection ideas")
      ).toBe("2025-12-15 - reflection ideas");
    });

    test("falls back to date when suffix is empty", () => {
      expect(formatCustomListTitleLabel("2025-12-15", " ")).toBe("2025-12-15");
    });
  });

  describe("sanitizeCustomListTitles", () => {
    test("keeps only YYYY-MM-DD keys and non-empty values", () => {
      const out = sanitizeCustomListTitles({
        "2025-12-15": "reflection ideas",
        "not-a-date": "x",
        "2025-12-16": "   ",
        "2025-12-17": 123,
      });

      expect(out).toEqual({ "2025-12-15": "reflection ideas" });
    });

    test("normalizes values that include the date prefix", () => {
      const out = sanitizeCustomListTitles({
        "2025-12-15": "2025-12-15 - reflection ideas",
      });

      expect(out).toEqual({ "2025-12-15": "reflection ideas" });
    });
  });
});

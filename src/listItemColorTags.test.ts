import {
  normalizeListItemColor,
  sanitizeListItemColorTags,
} from "./listItemColorTags";

describe("listItemColorTags", () => {
  describe("normalizeListItemColor", () => {
    test("accepts #rrggbb and normalizes to lowercase", () => {
      expect(normalizeListItemColor("#A1B2C3")).toBe("#a1b2c3");
    });

    test("expands #rgb into #rrggbb", () => {
      expect(normalizeListItemColor("#0F3")).toBe("#00ff33");
    });

    test("rejects invalid values", () => {
      expect(normalizeListItemColor("red")).toBe("");
      expect(normalizeListItemColor("#abcd")).toBe("");
      expect(normalizeListItemColor("#12345")).toBe("");
      expect(normalizeListItemColor("#1234567")).toBe("");
    });
  });

  describe("sanitizeListItemColorTags", () => {
    test("keeps only valid day/file keys and valid colors", () => {
      const out = sanitizeListItemColorTags({
        "day:2025-12-15": "#ff0000",
        "file:foo/bar.md": "#00ff00",
        "bad:2025-12-15": "#0000ff",
        "file:": "#0000ff",
        "file:valid": "not-a-color",
      });

      expect(out).toEqual({
        "day:2025-12-15": "#ff0000",
        "file:foo/bar.md": "#00ff00",
      });
    });

    test("trims keys and normalizes colors", () => {
      const out = sanitizeListItemColorTags({
        "  day:2025-12-15  ": "#ABC",
      });
      expect(out).toEqual({ "day:2025-12-15": "#aabbcc" });
    });
  });
});

import {
  formatDailyTitleLabel,
  parseDailyTitleParts,
  prepareNoteTextForOllama,
  stripYamlFrontmatter,
} from "src/ollama/title";

describe("ollama/title", () => {
  describe("stripYamlFrontmatter", () => {
    it("removes leading YAML frontmatter", () => {
      const input = [
        "---",
        "title: hello",
        "tags: [a]",
        "---",
        "# Heading",
        "Content",
      ].join("\n");

      expect(stripYamlFrontmatter(input)).toBe(["# Heading", "Content"].join("\n"));
    });

    it("does nothing when frontmatter fence is not at start", () => {
      const input = ["foo", "---", "bar", "---", "baz"].join("\n");
      expect(stripYamlFrontmatter(input)).toBe(input);
    });

    it("does nothing when frontmatter fence has no closing fence", () => {
      const input = ["---", "title: hello", "# Heading"].join("\n");
      expect(stripYamlFrontmatter(input)).toBe(input);
    });
  });

  describe("prepareNoteTextForOllama", () => {
    it("collapses whitespace and truncates to maxChars", () => {
      const input = "---\nfoo: bar\n---\nHello\n\nworld\t\t!";
      expect(prepareNoteTextForOllama(input, 999)).toBe("Hello world !");
      expect(prepareNoteTextForOllama(input, 5)).toBe("Hello");
    });
  });

  describe("parseDailyTitleParts", () => {
    it("sanitizes keywords and description", () => {
      const parsed = parseDailyTitleParts({
        keywords: ["Work,", "Deep\nFocus", "planning!"],
        description: "Did a lot.\nNewline!",
      });

      expect(parsed).toEqual({
        keywords: ["Work", "Deep", "planning"],
        description: "Did a lot. Newline!",
      });
    });

    it("returns null for invalid shapes", () => {
      expect(parseDailyTitleParts(null)).toBeNull();
      expect(parseDailyTitleParts({})).toBeNull();
      expect(
        parseDailyTitleParts({ keywords: ["a", "b", "c"], description: 1 })
      ).toBeNull();
      expect(
        parseDailyTitleParts({ keywords: ["a", "b"], description: "ok" })
      ).toBeNull();
    });
  });

  describe("formatDailyTitleLabel", () => {
    it("formats YYYY-MM-DD - <3 words> - <sentence>", () => {
      const label = formatDailyTitleLabel("2025-12-15", {
        keywords: ["work", "deep", "planning"],
        description: "Focused on the roadmap.",
      });

      expect(label).toBe("2025-12-15 - work deep planning - Focused on the roadmap.");
    });
  });
});

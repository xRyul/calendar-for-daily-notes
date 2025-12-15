import {
  pruneOllamaTitleCache,
  sanitizeOllamaTitleCache,
  upsertOllamaTitleCacheEntry,
} from "src/ollama/cache";

describe("ollama/cache", () => {
  describe("sanitizeOllamaTitleCache", () => {
    it("drops invalid entries", () => {
      const sanitized = sanitizeOllamaTitleCache({
        ok: { mtime: 123, title: "Hello" },
        bad1: { mtime: "nope", title: "x" },
        bad2: { mtime: 1, title: "" },
        bad3: null,
      });

      expect(sanitized).toEqual({
        ok: { mtime: 123, title: "Hello", lastUsed: undefined },
      });
    });
  });

  describe("pruneOllamaTitleCache", () => {
    it("evicts least recently used entries when exceeding maxEntries", () => {
      const pruned = pruneOllamaTitleCache(
        {
          a: { mtime: 1, title: "A", lastUsed: 10 },
          b: { mtime: 1, title: "B", lastUsed: 20 },
          c: { mtime: 1, title: "C", lastUsed: 30 },
        },
        2
      );

      expect(pruned).toEqual({
        b: { mtime: 1, title: "B", lastUsed: 20 },
        c: { mtime: 1, title: "C", lastUsed: 30 },
      });
    });

    it("treats missing lastUsed as oldest", () => {
      const pruned = pruneOllamaTitleCache(
        {
          a: { mtime: 1, title: "A" },
          b: { mtime: 1, title: "B", lastUsed: 5 },
        },
        1
      );

      expect(pruned).toEqual({
        b: { mtime: 1, title: "B", lastUsed: 5 },
      });
    });
  });

  describe("upsertOllamaTitleCacheEntry", () => {
    it("adds/updates an entry and prunes to maxEntries", () => {
      const next = upsertOllamaTitleCacheEntry({
        cache: {
          a: { mtime: 1, title: "A", lastUsed: 10 },
          b: { mtime: 1, title: "B", lastUsed: 20 },
        },
        filePath: "c.md",
        entry: { mtime: 2, title: "C" },
        maxEntries: 2,
        nowMs: 100,
      });

      expect(next).toEqual({
        b: { mtime: 1, title: "B", lastUsed: 20 },
        "c.md": { mtime: 2, title: "C", lastUsed: 100 },
      });
    });
  });
});

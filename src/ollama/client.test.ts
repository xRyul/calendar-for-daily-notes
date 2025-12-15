import { requestUrl } from "obsidian";

import {
  createOllamaClient,
  normalizeOllamaBaseUrl,
  safeParseJson,
} from "src/ollama/client";

jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}));

describe("ollama/client", () => {
  describe("normalizeOllamaBaseUrl", () => {
    it("defaults to localhost when empty", () => {
      expect(normalizeOllamaBaseUrl("")).toBe("http://127.0.0.1:11434");
      expect(normalizeOllamaBaseUrl(null as unknown as string)).toBe(
        "http://127.0.0.1:11434"
      );
      expect(normalizeOllamaBaseUrl(undefined as unknown as string)).toBe(
        "http://127.0.0.1:11434"
      );
    });

    it("strips trailing slashes and an optional /api suffix", () => {
      expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/")).toBe(
        "http://127.0.0.1:11434"
      );
      expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/api")).toBe(
        "http://127.0.0.1:11434"
      );
      expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/api/")).toBe(
        "http://127.0.0.1:11434"
      );
    });
  });

  describe("createOllamaClient", () => {
    const requestUrlMock = requestUrl as unknown as jest.Mock;

    beforeEach(() => {
      requestUrlMock.mockReset();
    });

    it("builds API URLs correctly (baseUrl can include /api)", async () => {
      requestUrlMock.mockResolvedValue({
        status: 200,
        json: { version: "0.0.0" },
      });

      const client = createOllamaClient({
        baseUrl: "http://127.0.0.1:11434/api",
        timeoutMs: 1000,
      });

      const res = await client.getVersion();
      expect(res).toEqual({ version: "0.0.0" });

      expect(requestUrlMock).toHaveBeenCalledTimes(1);
      expect(requestUrlMock.mock.calls[0][0]).toMatchObject({
        url: "http://127.0.0.1:11434/api/version",
        method: "GET",
      });
    });

    it("throws a helpful error on HTTP failure", async () => {
      requestUrlMock.mockResolvedValue({
        status: 500,
        text: "boom",
        json: null,
      });

      const client = createOllamaClient({
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 1000,
      });

      await expect(client.getVersion()).rejects.toThrow(
        "Ollama error (500) at /api/version: boom"
      );
    });
  });

  describe("safeParseJson", () => {
    it("parses valid JSON", () => {
      expect(safeParseJson("{\"a\":1}")).toEqual({ a: 1 });
    });

    it("recovers the first JSON object from surrounding text", () => {
      expect(safeParseJson("prefix {\"a\":1} suffix")).toEqual({ a: 1 });
    });

    it("returns null when no JSON is present", () => {
      expect(safeParseJson("not json")).toBeNull();
    });
  });
});

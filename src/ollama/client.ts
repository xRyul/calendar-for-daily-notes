import { requestUrl } from "obsidian";

export type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
  }>;
};

export type OllamaVersionResponse = {
  version?: string;
};

export type OllamaPullResponse = {
  status?: string;
  error?: string;
};

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  stream?: boolean;
  format?: unknown;
  options?: Record<string, unknown>;
};

export type OllamaGenerateResponse = {
  response?: string;
  done?: boolean;
  error?: string;
};

export type OllamaClient = {
  baseUrl: string;
  timeoutMs?: number;
  getVersion: () => Promise<OllamaVersionResponse>;
  listModels: () => Promise<OllamaTagsResponse>;
  pullModel: (model: string) => Promise<OllamaPullResponse>;
  generate: (
    req: OllamaGenerateRequest,
    opts?: { timeoutMs?: number }
  ) => Promise<OllamaGenerateResponse>;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  label = "request"
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // If the main promise resolves/rejects first, clear the timer.
      promise.finally(() => clearTimeout(timer));
    }),
  ]);
}

export function normalizeOllamaBaseUrl(input: string): string {
  let url = (input ?? "").trim();
  if (!url) {
    return "http://127.0.0.1:11434";
  }

  // Remove trailing slashes.
  url = url.replace(/\/+$/, "");

  // Accept both "http://host:11434" and "http://host:11434/api".
  url = url.replace(/\/api$/i, "");

  // Remove trailing slashes again after stripping /api.
  url = url.replace(/\/+$/, "");

  return url;
}

function buildApiUrl(baseUrl: string, apiPath: string): string {
  const normalized = normalizeOllamaBaseUrl(baseUrl);
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const fullPath = path.startsWith("/api/") || path === "/api"
    ? path
    : `/api${path}`;

  return `${normalized}${fullPath}`;
}

async function requestJson<T>(args: {
  baseUrl: string;
  apiPath: string;
  method: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const url = buildApiUrl(args.baseUrl, args.apiPath);

  const res = await withTimeout(
    requestUrl({
      url,
      method: args.method,
      headers: {
        accept: "application/json",
      },
      contentType: args.body !== undefined ? "application/json" : undefined,
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      throw: false,
    }),
    args.timeoutMs,
    `${args.method} ${url}`
  );

  if (res.status >= 400) {
    const msg = res.text
      ? res.text.slice(0, 300)
      : `HTTP ${res.status}`;
    throw new Error(`Ollama error (${res.status}) at ${args.apiPath}: ${msg}`);
  }

  return res.json as T;
}

export function createOllamaClient(config: {
  baseUrl: string;
  timeoutMs?: number;
}): OllamaClient {
  return {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,

    getVersion: async () => {
      return requestJson<OllamaVersionResponse>({
        baseUrl: config.baseUrl,
        apiPath: "/api/version",
        method: "GET",
        timeoutMs: config.timeoutMs,
      });
    },

    listModels: async () => {
      return requestJson<OllamaTagsResponse>({
        baseUrl: config.baseUrl,
        apiPath: "/api/tags",
        method: "GET",
        timeoutMs: config.timeoutMs,
      });
    },

    pullModel: async (model: string) => {
      return requestJson<OllamaPullResponse>({
        baseUrl: config.baseUrl,
        apiPath: "/api/pull",
        method: "POST",
        body: {
          model,
          stream: false,
        },
        // pulling a model can take a long time; callers should provide a timeout
        timeoutMs: undefined,
      });
    },

    generate: async (req: OllamaGenerateRequest, opts) => {
      return requestJson<OllamaGenerateResponse>({
        baseUrl: config.baseUrl,
        apiPath: "/api/generate",
        method: "POST",
        body: {
          ...req,
          stream: req.stream ?? false,
        },
        timeoutMs: opts?.timeoutMs ?? config.timeoutMs,
      });
    },
  };
}

export function isModelInstalled(tags: OllamaTagsResponse, model: string): boolean {
  const want = (model ?? "").trim().toLowerCase();
  if (!want) {
    return false;
  }

  const models = tags?.models ?? [];
  return models.some((m) => (m?.name ?? "").toLowerCase() === want);
}

export function safeParseJson<T = unknown>(text: string): T | null {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch (_err) {
    // Try to recover by extracting the first JSON object.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]) as T;
    } catch (_err2) {
      return null;
    }
  }
}

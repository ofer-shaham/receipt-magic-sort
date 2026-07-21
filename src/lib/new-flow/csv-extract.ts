import { loadImage } from "@/lib/receipt-utils";

export type TableResult = {
  columns: string[];
  rows: string[][];
};

const DEFAULT_OR_MODEL = "google/gemini-2.0-flash-lite-001";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export type TableExtractMeta = {
  provider: "openrouter" | "gemini";
  model: string;
  latencyMs: number;
};

export type TableExtractOutcome = TableResult & { meta: TableExtractMeta };

function readOpenRouterKeys(): string[] {
  try {
    const v2 = localStorage.getItem("openrouter-api-keys-v2");
    if (v2) {
      const parsed = JSON.parse(v2);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    }
    const v1 = localStorage.getItem("openrouter-api-keys");
    if (v1) {
      const parsed = JSON.parse(v1);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
      if (typeof parsed === "string" && parsed) return [parsed];
    }
    const single = localStorage.getItem("openrouter-api-key");
    if (single) return [single];
  } catch { /* ignore */ }
  return [];
}

function readAISettings() {
  try {
    const raw = JSON.parse(localStorage.getItem("receipt-settings-v1") || "{}");
    return {
      aiProvider: (raw.aiProvider ?? "auto") as "openrouter" | "gemini" | "auto",
      geminiApiKey: raw.geminiApiKey ?? "",
      geminiModel: raw.geminiModel ?? DEFAULT_GEMINI_MODEL,
    };
  } catch {
    return {
      aiProvider: "auto" as const,
      geminiApiKey: "",
      geminiModel: DEFAULT_GEMINI_MODEL,
    };
  }
}

function readORModel(): string {
  return localStorage.getItem("openrouter-model") || DEFAULT_OR_MODEL;
}

function dataUrlParts(dataUrl: string): { mime: string; b64: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mime: m[1], b64: m[2] } : { mime: "image/jpeg", b64: dataUrl };
}

function parseTableResult(txt: string): TableResult {
  const match = txt.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (Array.isArray(obj?.columns) && Array.isArray(obj?.rows)) {
        return {
          columns: obj.columns.map(String),
          rows: obj.rows.map((r: unknown) =>
            Array.isArray(r) ? r.map(String) : [],
          ),
        };
      }
    } catch { /* fall through */ }
  }
  return { columns: [], rows: [] };
}

function buildPrompt(columnsHint: string): string {
  const colsPart = columnsHint.trim()
    ? `The table columns are: ${columnsHint}. `
    : "";
  return `${colsPart}Extract the table from this image. Reply raw JSON only: {"columns":["col1",...],"rows":[["v1","v2",...],...]}.`;
}

async function extractTableViaOpenRouter(
  dataUrl: string,
  columnsHint: string,
  signal?: AbortSignal,
): Promise<TableExtractOutcome> {
  const keys = readOpenRouterKeys();
  if (!keys.length) throw new Error("No OpenRouter API key configured");
  const model = readORModel();
  const prompt = buildPrompt(columnsHint);
  const { mime, b64 } = dataUrlParts(dataUrl);
  const t0 = performance.now();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keys[0]}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as any)?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter: ${msg}`);
  }
  const txt: string = ((json as any).choices?.[0]?.message?.content ?? "").trim();
  return {
    ...parseTableResult(txt),
    meta: { provider: "openrouter", model, latencyMs: Math.round(performance.now() - t0) },
  };
}

async function extractTableViaGemini(
  apiKey: string,
  dataUrl: string,
  columnsHint: string,
  model: string,
  signal?: AbortSignal,
): Promise<TableExtractOutcome> {
  const prompt = buildPrompt(columnsHint);
  const t0 = performance.now();
  // Re-encode to JPEG to normalize the payload (matches extractDateWithGemini).
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const jpg = canvas.toDataURL("image/jpeg", 0.7);
  const { b64 } = dataUrlParts(jpg);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: b64 } },
          ],
        },
      ],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini: ${msg}`);
  }
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const txt = parts.map((p: any) => p?.text ?? "").join("").trim();
  return {
    ...parseTableResult(txt),
    meta: { provider: "gemini", model, latencyMs: Math.round(performance.now() - t0) },
  };
}

/**
 * Unified table extractor that respects the global AI provider setting from
 * the footer's AI Settings dialog. Falls back from OpenRouter to Gemini (or
 * vice-versa) when "auto" is selected and the primary provider is unavailable.
 */
export async function extractTableFromImage(
  dataUrl: string,
  columnsHint: string,
  signal?: AbortSignal,
): Promise<TableExtractOutcome> {
  const { aiProvider, geminiApiKey, geminiModel } = readAISettings();
  const hasOR = readOpenRouterKeys().length > 0;
  const hasGemini = !!geminiApiKey.trim();

  if (aiProvider === "gemini") {
    if (!hasGemini) throw new Error("No Gemini API key configured");
    return extractTableViaGemini(geminiApiKey.trim(), dataUrl, columnsHint, geminiModel, signal);
  }
  if (aiProvider === "openrouter") {
    if (!hasOR) throw new Error("No OpenRouter API key configured");
    return extractTableViaOpenRouter(dataUrl, columnsHint, signal);
  }
  // auto: prefer OpenRouter, fall back to Gemini on insufficient credits / no key
  if (hasOR) {
    try {
      return await extractTableViaOpenRouter(dataUrl, columnsHint, signal);
    } catch (e) {
      if (hasGemini && /insufficient credit|402|no key|no openrouter/i.test((e as Error).message)) {
        return extractTableViaGemini(geminiApiKey.trim(), dataUrl, columnsHint, geminiModel, signal);
      }
      throw e;
    }
  }
  if (hasGemini) {
    return extractTableViaGemini(geminiApiKey.trim(), dataUrl, columnsHint, geminiModel, signal);
  }
  throw new Error("Add an API key via the AI Settings button (footer ⚙)");
}

/**
 * Backwards-compatible helper: returns only the TableResult portion, matching
 * the old signature used by callers that don't yet read `meta`.
 */
export async function extractTableFromImageLegacy(
  dataUrl: string,
  columnsHint: string,
  signal?: AbortSignal,
): Promise<TableResult> {
  const { columns, rows } = await extractTableFromImage(dataUrl, columnsHint, signal);
  return { columns, rows };
}

/** Parse year and month from a filename. Looks for YYYY-MM or YYYY_MM. */
export function parseYearMonthFromFilename(name: string): {
  year?: string;
  month?: string;
} {
  const m = name.match(/(\d{4})[-_](\d{1,2})/);
  if (m) {
    return {
      year: m[1],
      month: String(Number(m[2])).padStart(2, "0"),
    };
  }
  return {};
}

/** Generate CSV string from columns + rows. */
export function toCsv(columns: string[], rows: string[][]): string {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\n");
}

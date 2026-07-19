export type TableResult = {
  columns: string[];
  rows: string[][];
};

const CSV_EXTRACT_MODEL = "google/gemini-2.0-flash-lite-001";

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

export async function extractTableFromImage(
  dataUrl: string,
  columnsHint: string,
  signal?: AbortSignal,
): Promise<TableResult> {
  const keys = readOpenRouterKeys();
  if (!keys.length) throw new Error("No OpenRouter API key configured");

  const colsPart = columnsHint.trim()
    ? `The table columns are: ${columnsHint}. `
    : "";
  const prompt =
    `${colsPart}Extract the table from this image. Reply raw JSON only: {"columns":["col1",...],"rows":[["v1","v2",...],...]}.`;

  const { mime, b64 } = dataUrlParts(dataUrl);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keys[0]}`,
    },
    body: JSON.stringify({
      model: CSV_EXTRACT_MODEL,
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
  return parseTableResult(txt);
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

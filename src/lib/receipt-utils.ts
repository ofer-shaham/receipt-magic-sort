import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
export async function extractImagesFromArchive(file: File): Promise<File[]> {
  const zip = await JSZip.loadAsync(file);
  const out: File[] = [];
  const entries = Object.values(zip.files).filter(
    (e) => !e.dir && IMAGE_EXT.test(e.name) && !e.name.startsWith("__MACOSX/"),
  );
  for (const e of entries) {
    const blob = await e.async("blob");
    const ext = e.name.match(IMAGE_EXT)?.[1].toLowerCase() ?? "jpg";
    const mime =
      ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    out.push(
      new File([blob], e.name.split("/").pop() || e.name, { type: mime }),
    );
  }
  return out;
}

export type PdfItem = {
  blob: Blob;
  width: number;
  height: number;
  label?: string;
};

export type BuildPdfOptions = {
  showLabel?: boolean;
  grid?: boolean;
  gridCols?: number;
};

export async function buildPdf(
  items: PdfItem[],
  opts: BuildPdfOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font =
    opts.showLabel || opts.grid
      ? await pdf.embedFont(StandardFonts.Helvetica)
      : null;

  if (opts.grid) {
    const cols = Math.max(1, opts.gridCols ?? 3);
    const pageW = 595;
    const pageH = 842;
    const margin = 18;
    const gap = 8;
    const cellW = (pageW - margin * 2 - gap * (cols - 1)) / cols;
    const labelH = opts.showLabel ? 12 : 0;
    const rowH = cellW + labelH + gap;
    const rowsPerPage = Math.max(1, Math.floor((pageH - margin * 2) / rowH));
    const perPage = rowsPerPage * cols;

    for (let i = 0; i < items.length; i += perPage) {
      const page = pdf.addPage([pageW, pageH]);
      const slice = items.slice(i, i + perPage);
      for (let j = 0; j < slice.length; j++) {
        const it = slice[j];
        const col = j % cols;
        const row = Math.floor(j / cols);
        const x = margin + col * (cellW + gap);
        const yTop = pageH - margin - row * rowH;
        const bytes = new Uint8Array(await it.blob.arrayBuffer());
        const img = await pdf.embedJpg(bytes);
        const scale = Math.min(cellW / it.width, cellW / it.height);
        const w = it.width * scale;
        const h = it.height * scale;
        page.drawImage(img, {
          x: x + (cellW - w) / 2,
          y: yTop - h - (cellW - h) / 2,
          width: w,
          height: h,
        });
        if (opts.showLabel && font && it.label) {
          page.drawText(it.label.slice(0, 40), {
            x: x + 2,
            y: yTop - cellW - 10,
            size: 8,
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
        }
      }
    }
    return await pdf.save();
  }

  for (const item of items) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    const img = await pdf.embedJpg(bytes);
    const showLbl = opts.showLabel && !!item.label;
    const labelH = showLbl ? 22 : 0;
    const page = pdf.addPage([item.width, item.height + labelH]);
    page.drawImage(img, {
      x: 0,
      y: labelH,
      width: item.width,
      height: item.height,
    });
    if (showLbl && font) {
      page.drawText(item.label!, {
        x: 8,
        y: 6,
        size: 11,
        font,
        color: rgb(0.15, 0.15, 0.15),
      });
    }
  }
  return await pdf.save();
}

export async function buildPdfsWithLimit(
  items: PdfItem[],
  maxBytes: number,
  opts: BuildPdfOptions = {},
): Promise<{ bytes: Uint8Array; pageCount: number; size: number }[]> {
  const PER_PAGE_OVERHEAD = 1200;
  const HEADER_OVERHEAD = 2000;
  const results: { bytes: Uint8Array; pageCount: number; size: number }[] = [];
  let batch: PdfItem[] = [];
  let estimated = HEADER_OVERHEAD;
  const flush = async () => {
    if (!batch.length) return;
    const bytes = await buildPdf(batch, opts);
    const pageCount = opts.grid
      ? Math.ceil(
          batch.length /
            Math.max(1, (opts.gridCols ?? 3) * Math.floor((842 - 36) / ((595 - 36 - 8 * ((opts.gridCols ?? 3) - 1)) / (opts.gridCols ?? 3) + (opts.showLabel ? 12 : 0) + 8))),
        )
      : batch.length;
    results.push({ bytes, pageCount, size: bytes.byteLength });
    batch = [];
    estimated = HEADER_OVERHEAD;
  };
  for (const it of items) {
    const cost = it.blob.size + PER_PAGE_OVERHEAD;
    if (batch.length && estimated + cost > maxBytes) await flush();
    batch.push(it);
    estimated += cost;
  }
  await flush();
  return results;
}

export async function buildRenamedArchive(
  items: { blob: Blob; name: string }[],
): Promise<Blob> {
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const it of items) {
    let name = it.name;
    const n = used.get(name) ?? 0;
    if (n > 0) {
      const dot = name.lastIndexOf(".");
      name =
        dot > 0
          ? `${name.slice(0, dot)}_${n}${name.slice(dot)}`
          : `${name}_${n}`;
    }
    used.set(it.name, n + 1);
    zip.file(name, await it.blob.arrayBuffer());
  }
  return await zip.generateAsync({ type: "blob" });
}

export async function sha256(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function compressImage(
  file: File,
  quality: number,
  maxDim = 2400,
): Promise<{ blob: Blob; dataUrl: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    let { width, height } = img;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const q = Math.max(0.05, Math.min(1, quality / 100));
    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", q),
    );
    const dataUrl = canvas.toDataURL("image/jpeg", q);
    return { blob, dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Built-in fallback list (free OpenRouter vision models).
export const FREE_VISION_MODELS = [
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "openrouter/auto:free"
] as const;

// Fetch fresh list of free vision-capable models from OpenRouter.
export async function fetchFreeVisionModelsList(): Promise<string[]> {
  const url =
    "https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards&input_modalities=image&max_price=0&order=pricing-low-to-high&output_modalities=text";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Models fetch: HTTP ${res.status}`);
  const j: any = await res.json().catch(() => ({}));
  const arr: any[] =
    j?.data?.models ?? j?.models ?? j?.data ?? (Array.isArray(j) ? j : []);
  const slugs: string[] = [];
  for (const m of arr) {
    const slug =
      m?.slug ||
      m?.id ||
      m?.endpoint?.model_variant_slug ||
      m?.permaslug ||
      m?.short_name;
    if (typeof slug === "string" && slug.length) slugs.push(slug);
  }
  // Filter out non-vision "safety/guard/moderation/embedding" models that
  // sometimes leak into image-input listings and always return
  // "No endpoints found" or refuse image reasoning.
  const BAD = /(safety|guard|moderation|shield|embed|rerank|tts|whisper|speech)/i;
  return Array.from(new Set(slugs)).filter((s) => !BAD.test(s));
}

// Normalized bounding box (0..1) around a receipt in the original image.
export type BBox = { x: number; y: number; w: number; h: number };
export type AIDateEntry = {
  iso: string | null;
  raw: string | null;
  bbox?: BBox | null;
};
export type AIDateResult = {
  iso: string | null;
  raw: string | null;
  dates: AIDateEntry[];
};

export class RateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InsufficientCreditsError";
  }
}

export const RECEIPT_PROMPT =
  'Receipt photo with date on 3rd line: (day/month/year order). Reply JSON only: {"iso":"YYYY-MM-DD"} or NONE.';

export function parseReceiptDatesText(txt: string): AIDateResult {
  const trimmed = (txt ?? "").trim();
  if (!trimmed || /^NONE/i.test(trimmed)) return { iso: null, raw: null, dates: [] };
  const normalize = (obj: any): AIDateEntry => {
    const iso =
      typeof obj?.iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.iso)
        ? obj.iso
        : null;
    const raw = typeof obj?.raw === "string" ? obj.raw : null;
    let bbox: BBox | null = null;
    const b = obj?.bbox;
    if (b && typeof b === "object") {
      const nx = Number(b.x), ny = Number(b.y), nw = Number(b.w), nh = Number(b.h);
      if ([nx, ny, nw, nh].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
        bbox = { x: nx, y: ny, w: Math.min(nw, 1 - nx), h: Math.min(nh, 1 - ny) };
      }
    }
    return { iso, raw: raw ?? iso, bbox };
  };
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      if (Array.isArray(obj?.dates) && obj.dates.length) {
        const dates: AIDateEntry[] = obj.dates
          .map(normalize)
          .filter((d: AIDateEntry) => d.iso || d.raw);
        if (dates.length)
          return { iso: dates[0].iso, raw: dates[0].raw, dates };
      }
      if (obj?.iso || obj?.raw) {
        const single = normalize(obj);
        return { iso: single.iso, raw: single.raw, dates: [single] };
      }
    } catch {
      /* ignore */
    }
  }
  const iso = trimmed.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  return { iso, raw: iso, dates: iso ? [{ iso, raw: iso }] : [] };
}

function dataUrlToBase64(dataUrl: string): { mime: string; b64: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { mime: "image/jpeg", b64: dataUrl };
  return { mime: m[1], b64: m[2] };
}

export type AICallMeta = {
  provider: "openrouter" | "gemini";
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs: number;
  rawText: string;
  promptText?: string;
};

export type AIDateResultWithMeta = AIDateResult & { meta: AICallMeta };

// Rough certainty heuristic (0..1) for a date result.
// Primary signal: a valid ISO date (YYYY-MM-DD). Bonus points for richer
// responses (DD/MM/YY raw text, bbox) preserved for backward-compat with
// older cached results that were produced by the verbose prompt.
export function estimateCertainty(r: AIDateResult): number {
  if (!r.dates?.length && !r.iso && !r.raw) return 0;
  const first = r.dates?.[0];
  const isoOk = !!(first?.iso || r.iso);
  const rawOk = !!(first?.raw || r.raw);
  const dmyOk = rawOk && /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(first?.raw || r.raw || "");
  const bboxOk = !!first?.bbox;
  let score = 0;
  if (isoOk) score += 0.8;  // ISO alone is the primary confidence signal
  if (dmyOk) score += 0.1;  // bonus: explicit DD/MM/YY raw (old-prompt responses)
  if (bboxOk) score += 0.05; // bonus: bbox present (old-prompt responses)
  if ((r.dates?.length ?? 0) >= 1) score += 0.05;
  return Math.min(1, score);
}

export async function extractDateWithGemini(
  apiKey: string,
  dataUrl: string,
  model = "gemini-2.0-flash",
  { prompt, signal }: { prompt?: string; signal?: AbortSignal } = {},
): Promise<AIDateResultWithMeta> {
  const activePrompt = prompt ?? RECEIPT_PROMPT;
  const t0 = performance.now();
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const jpg = canvas.toDataURL("image/jpeg", 0.7);
  const { b64 } = dataUrlToBase64(jpg);
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
            { text: activePrompt },
            { inline_data: { mime_type: "image/jpeg", data: b64 } },
          ],
        },
      ],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429 || /rate.?limit|quota/i.test(msg))
      throw new RateLimitError(msg);
    throw new Error(`Gemini: ${msg}`);
  }
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const txt = parts.map((p: any) => p?.text ?? "").join("").trim();
  const parsed = parseReceiptDatesText(txt);
  const usage = json?.usageMetadata ?? {};
  const promptTokens = Number(usage.promptTokenCount ?? 0) || undefined;
  const completionTokens = Number(usage.candidatesTokenCount ?? 0) || undefined;
  return {
    ...parsed,
    meta: {
      provider: "gemini",
      model,
      promptTokens,
      completionTokens,
      totalTokens: Number(usage.totalTokenCount ?? 0) || undefined,
      costUsd: undefined,
      latencyMs: Math.round(performance.now() - t0),
      rawText: txt,
      promptText: activePrompt,
    },
  };
}

export async function extractDateWithAI(
  apiKey: string,
  dataUrl: string,
  model: string,
  { prompt, signal }: { prompt?: string; signal?: AbortSignal } = {},
): Promise<AIDateResultWithMeta> {
  const activePrompt = prompt ?? RECEIPT_PROMPT;
  const t0 = performance.now();
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const cropped = canvas.toDataURL("image/jpeg", 0.7);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      usage: { include: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: activePrompt },
            { type: "image_url", image_url: { url: cropped } },
          ],
        },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const code = json?.error?.code;
    if (res.status === 402 || code === 402 || /insufficient credit/i.test(msg))
      throw new InsufficientCreditsError(`OpenRouter: ${msg}`);
    if (res.status === 429 || /rate.?limit/i.test(msg))
      throw new RateLimitError(msg);
    throw new Error(`OpenRouter: ${msg}`);
  }
  const txt: string = (json.choices?.[0]?.message?.content ?? "").trim();
  const parsed = parseReceiptDatesText(txt);
  const usage = json?.usage ?? {};
  return {
    ...parsed,
    meta: {
      provider: "openrouter",
      model,
      promptTokens: Number(usage.prompt_tokens ?? 0) || undefined,
      completionTokens: Number(usage.completion_tokens ?? 0) || undefined,
      totalTokens: Number(usage.total_tokens ?? 0) || undefined,
      costUsd: typeof usage.cost === "number" ? usage.cost : undefined,
      latencyMs: Math.round(performance.now() - t0),
      rawText: txt,
      promptText: activePrompt,
    },
  };
}

// Rotate an image (Blob or File) by 0/90/180/270 degrees, returning a JPEG
// blob with matching (possibly swapped) width/height.
export async function rotateImageBlob(
  input: Blob,
  degrees: number,
  quality = 0.92,
): Promise<{ blob: Blob; width: number; height: number }> {
  const norm = ((degrees % 360) + 360) % 360;
  const url = URL.createObjectURL(input);
  try {
    const img = await loadImage(url);
    const swap = norm === 90 || norm === 270;
    const w = swap ? img.height : img.width;
    const h = swap ? img.width : img.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((norm * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", quality),
    );
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Split a single image into N horizontal slices (top-to-bottom) for the
// "multi-receipt → split" workflow.
export async function splitImageVertically(
  file: File,
  parts: number,
): Promise<File[]> {
  if (parts <= 1) return [file];
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const out: File[] = [];
    const sliceH = Math.floor(img.height / parts);
    for (let i = 0; i < parts; i++) {
      const h = i === parts - 1 ? img.height - sliceH * i : sliceH;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, img.width, h);
      ctx.drawImage(img, 0, -sliceH * i);
      const blob: Blob = await new Promise((res) =>
        canvas.toBlob((b) => res(b!), "image/jpeg", 0.92),
      );
      const base = file.name.replace(/\.[^.]+$/, "");
      out.push(
        new File([blob], `${base}_part${i + 1}.jpg`, { type: "image/jpeg" }),
      );
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Crop an arbitrary rectangular region (normalized 0..1) out of an image and
// return a new File named "<originalBase>.part.<idx>.jpg".
export async function cropImageRegion(
  file: File,
  bbox: BBox,
  idx: number,
): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const x = Math.max(0, Math.floor(bbox.x * img.width));
    const y = Math.max(0, Math.floor(bbox.y * img.height));
    const w = Math.max(1, Math.min(img.width - x, Math.floor(bbox.w * img.width)));
    const h = Math.max(1, Math.min(img.height - y, Math.floor(bbox.h * img.height)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.92),
    );
    const base = file.name.replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.part.${idx}.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type KeyStatus = {
  failures: number;
  cooldownUntil: number;
  lastUsedAt: number;
};

export type RoundRobinOptions = {
  minIntervalMs?: number; // throttle between uses of same key
  cooldownAfterFailures?: number; // after N consecutive failures
  cooldownMs?: number; // pause that key for this long
};

export async function extractDateRoundRobin(
  keys: string[],
  state: Record<string, KeyStatus>,
  startIndex: number,
  dataUrl: string,
  model: string,
  options: RoundRobinOptions & { prompt?: string; signal?: AbortSignal } = {},
): Promise<{ result: AIDateResultWithMeta; nextIndex: number; usedKeyIndex: number }> {
  if (!keys.length) throw new Error("No API key configured");
  const minInterval = options.minIntervalMs ?? 0;
  const failThreshold = options.cooldownAfterFailures ?? 3;
  const cooldownMs = options.cooldownMs ?? 65_000;

  const getState = (k: string): KeyStatus => {
    let s = state[k];
    if (!s) {
      s = { failures: 0, cooldownUntil: 0, lastUsedAt: 0 };
      state[k] = s;
    }
    return s;
  };

  let i = ((startIndex % keys.length) + keys.length) % keys.length;
  let lastErr: Error | null = null;

  for (let pass = 0; pass < 2; pass++) {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const keyIndex = i;
      const key = keys[keyIndex];
      const s = getState(key);
      const now = Date.now();
      if (s.cooldownUntil > now) {
        i = (i + 1) % keys.length;
        continue;
      }
      const wait = s.lastUsedAt + minInterval - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      s.lastUsedAt = Date.now();
      try {
        const result = await extractDateWithAI(key, dataUrl, model, { prompt: options.prompt, signal: options.signal });
        s.failures = 0;
        return {
          result,
          nextIndex: (keyIndex + 1) % keys.length,
          usedKeyIndex: keyIndex,
        };
      } catch (e) {
        lastErr = e as Error;
        s.failures += 1;
        if (e instanceof RateLimitError) {
          s.cooldownUntil = Date.now() + cooldownMs;
          s.failures = 0;
        } else if (s.failures >= failThreshold) {
          s.cooldownUntil = Date.now() + cooldownMs;
          s.failures = 0;
        }
        i = (i + 1) % keys.length;
      }
    }
    // all in cooldown? wait for soonest among currently-configured keys
    const now2 = Date.now();
    const soonest = Math.min(
      ...keys.map((k) => {
        const c = state[k]?.cooldownUntil ?? 0;
        return c > now2 ? c - now2 : Infinity;
      }),
    );
    if (!isFinite(soonest)) break;
    await new Promise((r) => setTimeout(r, soonest + 50));
  }
  throw lastErr ?? new Error("All keys unavailable");
}

export type OpenRouterCredits = {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
};

export async function fetchOpenRouterCredits(
  apiKey: string,
): Promise<OpenRouterCredits> {
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Credits fetch: ${msg}`);
  }
  const totalCredits = Number(json?.data?.total_credits ?? 0);
  const totalUsage = Number(json?.data?.total_usage ?? 0);
  return {
    totalCredits,
    totalUsage,
    remaining: Math.max(0, totalCredits - totalUsage),
  };
}

// Filename-safe slug
export function safeSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

// Build a "YYYYMMDD-HHMMSS" timestamp.
export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

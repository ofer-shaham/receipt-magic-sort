import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

// Extract image files from a zip archive (does not persist anything).
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

// Build multiple PDFs respecting a max byte size per PDF (greedy packing).
export async function buildPdfsWithLimit(
  items: { blob: Blob; width: number; height: number }[],
  maxBytes: number,
): Promise<{ bytes: Uint8Array; pageCount: number; size: number }[]> {
  const PER_PAGE_OVERHEAD = 1200;
  const HEADER_OVERHEAD = 2000;
  const results: { bytes: Uint8Array; pageCount: number; size: number }[] = [];
  let batch: typeof items = [];
  let estimated = HEADER_OVERHEAD;
  const flush = async () => {
    if (!batch.length) return;
    const bytes = await buildPdf(batch);
    results.push({ bytes, pageCount: batch.length, size: bytes.byteLength });
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

export async function buildPdf(
  items: { blob: Blob; width: number; height: number }[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const item of items) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    const img = await pdf.embedJpg(bytes);
    const page = pdf.addPage([item.width, item.height]);
    page.drawImage(img, { x: 0, y: 0, width: item.width, height: item.height });
  }
  return await pdf.save();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Free vision-capable models on OpenRouter (no cost). Ordered by preference.
export const FREE_VISION_MODELS = [
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
] as const;

export async function extractDateWithAI(
  apiKey: string,
  dataUrl: string,
  model: string = FREE_VISION_MODELS[0],
): Promise<string | null> {
  // Crop top 35% to save tokens
  const img = await loadImage(dataUrl);
  const cropH = Math.round(img.height * 0.35);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const cropped = canvas.toDataURL("image/jpeg", 0.7);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Extract the receipt date. Reply ONLY with ISO date YYYY-MM-DD. If no date, reply "NONE".',
            },
            { type: "image_url", image_url: { url: cropped } },
          ],
        },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter: ${msg}`);
  }
  const txt = (json.choices?.[0]?.message?.content ?? "").trim();
  const match = txt.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
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

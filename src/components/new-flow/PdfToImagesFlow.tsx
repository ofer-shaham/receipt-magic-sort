import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { CropWizardPanel } from "@/components/CropWizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Scissors, Sparkles, X, FileArchive, Loader2, ChevronUp } from "lucide-react";
import { pdfToStitchedJpeg } from "@/lib/new-flow/pdf-to-image";
import { parseYearMonthFromFilename } from "@/lib/new-flow/csv-extract";
import { appendAILog } from "@/lib/new-flow/logging";
import {
  extractDateWithAI,
  buildPdfsWithLimit,
  cropImageRegion,
  fmtTag,
  RECEIPT_PROMPT,
  type BBox,
  type PdfItem,
} from "@/lib/receipt-utils";

// ── helpers ──────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => String(CURRENT_YEAR - i));
const MONTHS = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const CACHE_KEY = "receiptforge-new-date-cache-v1";
const AI_MODEL = "google/gemini-2.0-flash-lite-001";

function readORKeys(): string[] {
  try {
    const v2 = localStorage.getItem("openrouter-api-keys-v2");
    if (v2) { const p = JSON.parse(v2); if (Array.isArray(p)) return p.filter(Boolean); }
    const v1 = localStorage.getItem("openrouter-api-keys");
    if (v1) { const p = JSON.parse(v1); if (Array.isArray(p)) return p.filter(Boolean); if (typeof p === "string" && p) return [p]; }
    const s = localStorage.getItem("openrouter-api-key");
    if (s) return [s];
  } catch { /* ignore */ }
  return [];
}

function loadDateCache(): Record<string, { year: string; month: string }> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveDateCache(c: Record<string, { year: string; month: string }>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
function fileCacheKey(f: File) { return `${f.name}::${f.size}`; }

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(file);
  });
}

async function imgDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ width: i.width, height: i.height });
    i.src = src;
  });
}

function triggerDownload(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
}

// ── types ─────────────────────────────────────────────────────────────────────

type ImgItem = {
  id: string;
  file: File;
  dataUrl: string;
  name: string;
  year: string;
  month: string;
  part: string; // default "1"
  aiState: "idle" | "loading" | "done" | "error";
  aiError?: string;
};

// ── component ─────────────────────────────────────────────────────────────────

export function PdfToImagesFlow() {
  const [items, setItems] = useState<ImgItem[]>([]);
  const [rendering, setRendering] = useState(false);
  const [cropTargetId, setCropTargetId] = useState<string | null>(null);
  const [includePdf, setIncludePdf] = useState(false);
  const [generating, setGenerating] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uid = () => Math.random().toString(36).slice(2, 9);

  const addPdfs = useCallback(async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) { toast.error("Please drop PDF files."); return; }
    setRendering(true);
    const cache = loadDateCache();
    const newItems: ImgItem[] = [];
    for (const pdf of pdfs) {
      try {
        const stitched = await pdfToStitchedJpeg(pdf);
        const dataUrl = await fileToDataUrl(stitched);
        const ck = fileCacheKey(stitched);
        const cached = cache[ck];
        const fromFilename = parseYearMonthFromFilename(stitched.name);
        newItems.push({
          id: uid(),
          file: stitched,
          dataUrl,
          name: stitched.name,
          year: cached?.year ?? fromFilename.year ?? String(CURRENT_YEAR),
          month: cached?.month ?? fromFilename.month ?? "01",
          part: "1",
          aiState: cached ? "done" : "idle",
        });
      } catch (e: any) {
        toast.error(`Failed to render ${pdf.name}: ${e?.message ?? e}`);
      }
    }
    setItems((prev) => [...prev, ...newItems]);
    setRendering(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      addPdfs(Array.from(e.dataTransfer.files));
    },
    [addPdfs],
  );

  const updateTag = (id: string, field: "year" | "month" | "part", val: string) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: val } : it)));

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (cropTargetId === id) setCropTargetId(null);
  };

  const toggleCrop = (id: string) =>
    setCropTargetId((prev) => (prev === id ? null : id));

  const handleCropExtract = useCallback(
    async (boxes: BBox[], removeOriginal: boolean) => {
      if (!cropTargetId) return;
      const original = items.find((it) => it.id === cropTargetId);
      if (!original) { setCropTargetId(null); return; }
      const croppedFiles = await Promise.all(
        boxes.map((box, idx) => cropImageRegion(original.file, box, idx)),
      );
      const cache = loadDateCache();
      const newParts: ImgItem[] = await Promise.all(
        croppedFiles.map(async (f, idx) => {
          const dataUrl = await fileToDataUrl(f);
          const ck = fileCacheKey(f);
          const cached = cache[ck];
          return {
            id: uid(),
            file: f,
            dataUrl,
            name: f.name,
            year: cached?.year ?? original.year,
            month: cached?.month ?? original.month,
            part: String(idx + 1),
            aiState: (cached ? "done" : "idle") as ImgItem["aiState"],
          };
        }),
      );
      setItems((prev) => {
        const idx = prev.findIndex((it) => it.id === cropTargetId);
        if (idx === -1) return [...prev, ...newParts];
        const next = [...prev];
        if (removeOriginal) next.splice(idx, 1, ...newParts);
        else next.splice(idx + 1, 0, ...newParts);
        return next;
      });
      setCropTargetId(null);
    },
    [cropTargetId, items],
  );

  const runAI = useCallback(async (id: string) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    const keys = readORKeys();
    if (!keys.length) { toast.error("Add an OpenRouter API key in the Old tab first."); return; }
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, aiState: "loading" } : it));
    try {
      const result = await extractDateWithAI(keys[0], item.dataUrl, AI_MODEL, { prompt: RECEIPT_PROMPT });
      appendAILog({ ts: Date.now(), filename: item.name, model: AI_MODEL, provider: "openrouter", byteSize: item.file.size, origin: "pdf-to-images" });
      const year = result.iso ? result.iso.slice(0, 4) : item.year;
      const month = result.iso ? result.iso.slice(5, 7) : item.month;
      const cache = loadDateCache();
      cache[fileCacheKey(item.file)] = { year, month };
      saveDateCache(cache);
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, year, month, aiState: "done" } : it));
      if (!result.iso) toast.warning(`No date found in ${item.name}`);
    } catch (e: any) {
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, aiState: "error", aiError: e?.message ?? "AI error" } : it));
      toast.error(`AI failed for ${item.name}: ${e?.message ?? e}`);
    }
  }, [items]);

  const runBatchAI = useCallback(async () => {
    const untagged = items.filter((it) => it.aiState === "idle");
    if (!untagged.length) { toast.info("All images have tags."); return; }
    for (const item of untagged) await runAI(item.id);
  }, [items, runAI]);

  const handleGenerate = useCallback(async () => {
    if (!items.length) { toast.error("No images to export."); return; }
    const untagged = items.filter((it) => !it.year || !it.month);
    if (untagged.length) { toast.error("All images must have a year and month."); return; }
    setGenerating(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const it of items) {
        const renamedName = `${it.year}-${it.month}.part${it.part}.${it.name}`;
        zip.file(renamedName, await it.file.arrayBuffer());
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      triggerDownload(zipBlob, `receiptforge-${Date.now()}.zip`);

      if (includePdf) {
        const pdfItems: PdfItem[] = await Promise.all(
          items.map(async (it) => {
            const dims = await imgDimensions(it.dataUrl);
            const iso = `${it.year}-${it.month}-01`;
            return { blob: it.file, width: dims.width, height: dims.height, label: `${fmtTag(iso)} p.${it.part}` };
          }),
        );
        const maxBytes = 10 * 1024 * 1024;
        const parts = await buildPdfsWithLimit(pdfItems, maxBytes, { showLabel: true });
        parts.forEach((p, i) => {
          triggerDownload(new Blob([p], { type: "application/pdf" }), `receipts-part${i + 1}.pdf`);
        });
      }
      toast.success("Files generated!");
    } catch (e: any) {
      toast.error(`Generate failed: ${e?.message ?? e}`);
    }
    setGenerating(false);
  }, [items, includePdf]);

  return (
    <div className="space-y-6 p-4">
      {/* Drop zone */}
      <div
        ref={dropRef}
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-10 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        <FileArchive className="h-8 w-8 opacity-60" />
        <span>Drop PDF files here, or click to browse</span>
        {rendering && <Loader2 className="h-4 w-4 animate-spin" />}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => addPdfs(Array.from(e.target.files ?? []))}
        />
      </div>

      {/* Image list */}
      {items.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{items.length} image{items.length !== 1 ? "s" : ""}</span>
            <Button size="sm" variant="outline" onClick={runBatchAI}>
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              Analyse all (AI)
            </Button>
          </div>

          <div className="space-y-2">
            {items.map((item) => {
              const isCropping = cropTargetId === item.id;
              return (
                <div key={item.id} className="rounded-lg border border-border">
                  {/* Item row */}
                  <div className="flex gap-3 p-3">
                    {/* Thumbnail */}
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="h-20 w-16 flex-shrink-0 rounded object-cover"
                    />
                    {/* Controls */}
                    <div className="flex flex-1 flex-col gap-2">
                      <p className="truncate text-xs font-medium text-foreground" title={item.name}>{item.name}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Year */}
                        <Select value={item.year} onValueChange={(v) => updateTag(item.id, "year", v)}>
                          <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
                        </Select>
                        {/* Month */}
                        <Select value={item.month} onValueChange={(v) => updateTag(item.id, "month", v)}>
                          <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                        </Select>
                        {/* Part */}
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">p.</span>
                          <input
                            type="number"
                            min={1}
                            max={99}
                            value={item.part}
                            onChange={(e) => {
                              const v = String(Math.max(1, Math.min(99, Number(e.target.value) || 1)));
                              updateTag(item.id, "part", v);
                            }}
                            className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                        {/* Crop toggle */}
                        <Button
                          size="sm"
                          variant={isCropping ? "default" : "outline"}
                          className="h-7 text-xs"
                          onClick={() => toggleCrop(item.id)}
                        >
                          {isCropping
                            ? <><ChevronUp className="mr-1 h-3 w-3" />Close crop</>
                            : <><Scissors className="mr-1 h-3 w-3" />Crop</>}
                        </Button>
                        {/* AI */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => runAI(item.id)}
                          disabled={item.aiState === "loading"}
                        >
                          {item.aiState === "loading"
                            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            : <Sparkles className="mr-1 h-3 w-3" />}
                          Image analysis
                        </Button>
                        {item.aiState === "error" && (
                          <span className="text-xs text-destructive" title={item.aiError}>⚠ AI error</span>
                        )}
                        {/* Remove */}
                        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => removeItem(item.id)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Tag: {item.year}-{item.month} p.{item.part} → {fmtTag(`${item.year}-${item.month}-01`)} part {item.part}
                      </p>
                    </div>
                  </div>

                  {/* Inline crop panel */}
                  {isCropping && (
                    <div className="border-t border-border bg-muted/10 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Scissors className="h-4 w-4 text-primary" />
                        <span className="text-sm font-medium">Crop receipts from image</span>
                      </div>
                      <CropWizardPanel
                        imageSrc={item.dataUrl}
                        imageName={item.name}
                        onExtract={handleCropExtract}
                        onCancel={() => setCropTargetId(null)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Generate */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="include-pdf"
                checked={includePdf}
                onCheckedChange={(v) => setIncludePdf(!!v)}
              />
              <Label htmlFor="include-pdf" className="text-sm">Also build PDF</Label>
            </div>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate files
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

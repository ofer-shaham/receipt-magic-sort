import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { CropWizardPanel, type TaggedCrop } from "@/components/CropWizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Sparkles, X, FileArchive, Loader2, Scissors, ChevronDown, ChevronUp } from "lucide-react";
import { pdfToStitchedJpeg } from "@/lib/new-flow/pdf-to-image";
import { parseYearMonthFromFilename } from "@/lib/new-flow/csv-extract";
import { appendAILog } from "@/lib/new-flow/logging";
import {
  extractDateWithAI,
  buildPdfsWithLimit,
  cropImageRegion,
  fmtTag,
  RECEIPT_PROMPT,
  type PdfItem,
} from "@/lib/receipt-utils";

// ── constants ─────────────────────────────────────────────────────────────────

const CACHE_KEY  = "receiptforge-new-date-cache-v1";
const AI_MODEL   = "google/gemini-2.0-flash-lite-001";
const CURR_YEAR  = String(new Date().getFullYear());

// ── helpers ───────────────────────────────────────────────────────────────────

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
const uid = () => Math.random().toString(36).slice(2, 9);

// ── item model ────────────────────────────────────────────────────────────────

/** A rendered PDF waiting to be cropped. Crop panel is shown inline. */
type SourceItem = {
  kind: "source";
  id: string;
  file: File;       // the stitched JPEG rendered from the PDF
  dataUrl: string;
  name: string;
  defaultYear: string;
  defaultMonth: string;
  cropOpen: boolean;
  aiState: "idle" | "loading" | "done" | "error";
  aiError?: string;
};

/** A cropped + tagged piece ready for export. */
type ExtractedItem = {
  kind: "extracted";
  id: string;
  file: File;
  dataUrl: string;
  name: string;
  year: string;
  month: string;
  part: string;
};

type FlowItem = SourceItem | ExtractedItem;

// ── component ─────────────────────────────────────────────────────────────────

export function PdfToImagesFlow() {
  const [items, setItems]       = useState<FlowItem[]>([]);
  const [rendering, setRendering] = useState(false);
  const [includePdf, setIncludePdf] = useState(false);
  const [generating, setGenerating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── add PDFs ────────────────────────────────────────────────────────────────

  const addPdfs = useCallback(async (files: File[]) => {
    const pdfs = files.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (!pdfs.length) { toast.error("Please drop PDF files."); return; }
    setRendering(true);
    const cache = loadDateCache();
    const newItems: SourceItem[] = [];
    for (const pdf of pdfs) {
      try {
        const { file: stitched } = await pdfToStitchedJpeg(pdf);
        const dataUrl  = await fileToDataUrl(stitched);
        const ck       = fileCacheKey(stitched);
        const cached   = cache[ck];
        const fromName = parseYearMonthFromFilename(stitched.name);
        newItems.push({
          kind: "source",
          id:   uid(),
          file: stitched,
          dataUrl,
          name: stitched.name,
          defaultYear:  cached?.year  ?? fromName.year  ?? CURR_YEAR,
          defaultMonth: cached?.month ?? fromName.month ?? "01",
          cropOpen: true,   // open the crop panel immediately
          aiState: cached ? "done" : "idle",
        });
      } catch (e: any) {
        toast.error(`Failed to render ${pdf.name}: ${e?.message ?? e}`);
      }
    }
    setItems((prev) => [...prev, ...newItems]);
    setRendering(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addPdfs(Array.from(e.dataTransfer.files));
  }, [addPdfs]);

  // ── AI date extraction ───────────────────────────────────────────────────────

  const runAI = useCallback(async (id: string) => {
    const item = items.find((it) => it.id === id && it.kind === "source") as SourceItem | undefined;
    if (!item) return;
    const keys = readORKeys();
    if (!keys.length) { toast.error("Add an OpenRouter API key in the Old tab first."); return; }

    setItems((prev) =>
      prev.map((it) => it.id === id ? { ...it, aiState: "loading" } as SourceItem : it),
    );
    try {
      const result = await extractDateWithAI(keys[0], item.dataUrl, AI_MODEL, { prompt: RECEIPT_PROMPT });
      appendAILog({ ts: Date.now(), filename: item.name, model: AI_MODEL, provider: "openrouter",
                    byteSize: item.file.size, origin: "pdf-to-images" });
      const year  = result.iso ? result.iso.slice(0, 4) : item.defaultYear;
      const month = result.iso ? result.iso.slice(5, 7) : item.defaultMonth;
      const cache = loadDateCache();
      cache[fileCacheKey(item.file)] = { year, month };
      saveDateCache(cache);
      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? { ...it, defaultYear: year, defaultMonth: month, aiState: "done" } as SourceItem
            : it,
        ),
      );
      if (!result.iso) toast.warning(`No date found in ${item.name}`);
    } catch (e: any) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, aiState: "error", aiError: e?.message ?? "AI error" } as SourceItem : it,
        ),
      );
      toast.error(`AI failed for ${item.name}: ${e?.message ?? e}`);
    }
  }, [items]);

  // ── crop extraction ──────────────────────────────────────────────────────────

  const handleExtract = useCallback(
    async (sourceId: string, crops: TaggedCrop[], removeOriginal: boolean) => {
      const source = items.find((it) => it.id === sourceId && it.kind === "source") as SourceItem | undefined;
      if (!source) return;

      const newExtracted: ExtractedItem[] = await Promise.all(
        crops.map(async (crop, idx) => {
          const croppedFile = await cropImageRegion(source.file, crop, idx);
          const dataUrl     = await fileToDataUrl(croppedFile);
          return {
            kind: "extracted" as const,
            id:   uid(),
            file: croppedFile,
            dataUrl,
            name: croppedFile.name,
            year:  crop.year,
            month: crop.month,
            part:  crop.part,
          };
        }),
      );

      setItems((prev) => {
        const idx = prev.findIndex((it) => it.id === sourceId);
        if (idx === -1) return [...prev, ...newExtracted];
        const next = [...prev];
        if (removeOriginal) next.splice(idx, 1, ...newExtracted);
        else next.splice(idx + 1, 0, ...newExtracted);
        return next;
      });
    },
    [items],
  );

  // ── generate ─────────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    const extracted = items.filter((it): it is ExtractedItem => it.kind === "extracted");
    if (!extracted.length) { toast.error("No extracted images to export. Crop and extract from each PDF first."); return; }
    setGenerating(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      for (const it of extracted) {
        const renamedName = `y${it.year}_m${it.month}__p${it.part}.jpeg`;
        zip.file(renamedName, await it.file.arrayBuffer());
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      triggerDownload(zipBlob, `receiptforge-${Date.now()}.zip`);

      if (includePdf) {
        const pdfItems: PdfItem[] = await Promise.all(
          extracted.map(async (it) => {
            const dims = await imgDimensions(it.dataUrl);
            const iso  = `${it.year}-${it.month}-01`;
            return { blob: it.file, width: dims.width, height: dims.height,
                     label: `${fmtTag(iso)} p.${it.part}` };
          }),
        );
        const parts = await buildPdfsWithLimit(pdfItems, 10 * 1024 * 1024, { showLabel: true });
        parts.forEach((p, i) =>
          triggerDownload(new Blob([p.bytes as BlobPart], { type: "application/pdf" }), `receipts-part${i + 1}.pdf`),
        );
      }
      toast.success("Files generated!");
    } catch (e: any) {
      toast.error(`Generate failed: ${e?.message ?? e}`);
    }
    setGenerating(false);
  }, [items, includePdf]);

  // ── helpers ──────────────────────────────────────────────────────────────────

  const toggleCrop = (id: string) =>
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && it.kind === "source"
          ? { ...it, cropOpen: !it.cropOpen }
          : it,
      ),
    );

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((it) => it.id !== id));

  const extractedCount = items.filter((it) => it.kind === "extracted").length;

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-4">
      {/* Drop zone */}
      <div
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

      {/* Items */}
      {items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => {
            // ── Extracted (compact) ──
            if (item.kind === "extracted") {
              return (
                <div key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <img src={item.dataUrl} alt={item.name}
                    className="h-12 w-10 flex-shrink-0 rounded object-cover" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {fmtTag(`${item.year}-${item.month}-01`)} · p.{item.part}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0"
                    onClick={() => removeItem(item.id)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            }

            // ── Source (crop panel) ──
            return (
              <div key={item.id} className="rounded-lg border border-border">
                {/* Header row */}
                <div className="flex items-center gap-3 p-3">
                  <img src={item.dataUrl} alt={item.name}
                    className="h-14 w-11 flex-shrink-0 rounded object-cover" />
                  <div className="flex flex-1 flex-col gap-1.5 min-w-0">
                    <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {/* AI button */}
                      <Button size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => runAI(item.id)}
                        disabled={item.aiState === "loading"}>
                        {item.aiState === "loading"
                          ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          : <Sparkles className="mr-1 h-3 w-3" />}
                        {item.aiState === "done" ? "Re-analyse" : "AI date"}
                      </Button>
                      {item.aiState === "done" && (
                        <span className="text-[11px] text-muted-foreground">
                          {fmtTag(`${item.defaultYear}-${item.defaultMonth}-01`)}
                        </span>
                      )}
                      {item.aiState === "error" && (
                        <span className="text-xs text-destructive" title={item.aiError}>⚠ AI error</span>
                      )}
                      {/* Crop toggle */}
                      <Button size="sm"
                        variant={item.cropOpen ? "default" : "outline"}
                        className="ml-auto h-7 text-xs"
                        onClick={() => toggleCrop(item.id)}>
                        <Scissors className="mr-1 h-3 w-3" />
                        {item.cropOpen
                          ? <><ChevronUp className="ml-0.5 h-3 w-3" />Close</>
                          : <><ChevronDown className="ml-0.5 h-3 w-3" />Crop</>}
                      </Button>
                      {/* Remove */}
                      <Button size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => removeItem(item.id)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Inline crop panel */}
                {item.cropOpen && (
                  <div className="border-t border-border p-4">
                    <CropWizardPanel
                      imageSrc={item.dataUrl}
                      imageName={item.name}
                      showTagInputs
                      defaultYear={item.defaultYear}
                      defaultMonth={item.defaultMonth}
                      onTaggedExtract={(crops, removeOriginal) =>
                        handleExtract(item.id, crops, removeOriginal)
                      }
                      onCancel={() => toggleCrop(item.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* Generate bar */}
          {extractedCount > 0 && (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/30 p-4">
              <span className="text-sm text-muted-foreground">
                {extractedCount} image{extractedCount !== 1 ? "s" : ""} ready
              </span>
              <div className="flex items-center gap-2">
                <Checkbox id="include-pdf" checked={includePdf}
                  onCheckedChange={(v) => setIncludePdf(!!v)} />
                <Label htmlFor="include-pdf" className="text-sm">Also build PDF</Label>
              </div>
              <Button onClick={handleGenerate} disabled={generating} className="ml-auto">
                {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate files
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

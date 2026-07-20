/**
 * NewReceiptFlow — unified /new page.
 *
 * Internal tabs:
 *   • Crop & Tag — upload images/PDFs/ZIPs → multi-crop → tagged preview grid → export ZIP
 *   • Image → CSV — upload table images (or use cropped images) → AI extract → editable table → export CSV / batch ZIP
 *
 * State lives in AppStoreProvider (root) so it survives /old ↔ /new navigation.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useAppStore,
  type StoreTaggedItem,
  type StoreCsvItem,
  DEFAULT_COLUMNS_HINT,
} from "@/contexts/AppStore";
import { CropModal } from "@/components/CropModal";
import { CsvTable } from "@/components/new-flow/CsvTable";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ImageIcon, FileArchive, FileText, Loader2, X, Scissors, Eye,
  Download, Pencil, Check, Sparkles, TableProperties, Plus, ChevronDown, ChevronUp,
} from "lucide-react";
import type { TaggedCrop } from "@/components/CropWizard";
import { pdfToStitchedJpeg } from "@/lib/new-flow/pdf-to-image";
import { extractTableFromImage, toCsv } from "@/lib/new-flow/csv-extract";
import { appendAILog } from "@/lib/new-flow/logging";
import { cropImageRegion, extractImagesFromArchive } from "@/lib/receipt-utils";

// ── constants ─────────────────────────────────────────────────────────────────

const CURR_YEAR   = String(new Date().getFullYear());
const YEARS       = Array.from({ length: 6 }, (_, i) => String(Number(CURR_YEAR) - i));
const MONTHS      = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const TAG_CACHE_K = "receiptforge-new-tags-v1";

// ── Year-based thumbnail colors (modulo) ─────────────────────────────────────

const YEAR_PALETTE = [
  { border: "#10b981", bg: "rgba(16,185,129,0.12)"  }, // emerald  → e.g. 2024
  { border: "#3b82f6", bg: "rgba(59,130,246,0.12)"  }, // blue     → e.g. 2023
  { border: "#f59e0b", bg: "rgba(245,158,11,0.12)"  }, // amber    → e.g. 2022
  { border: "#f43f5e", bg: "rgba(244,63,94,0.12)"   }, // rose     → e.g. 2021
  { border: "#8b5cf6", bg: "rgba(139,92,246,0.12)"  }, // violet   → e.g. 2020
  { border: "#06b6d4", bg: "rgba(6,182,212,0.12)"   }, // cyan     → e.g. 2019
] as const;

function yearPalette(year: string) {
  const y = parseInt(year, 10) || 2024;
  return YEAR_PALETTE[y % YEAR_PALETTE.length];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);
const ck  = (f: File) => `${f.name}::${f.size}`;

function loadTagCache(): Record<string, { year: string; month: string; part: string }> {
  try { return JSON.parse(localStorage.getItem(TAG_CACHE_K) || "{}"); } catch { return {}; }
}
function saveTagCache(c: Record<string, { year: string; month: string; part: string }>) {
  try { localStorage.setItem(TAG_CACHE_K, JSON.stringify(c)); } catch { /* ignore */ }
}
function readORModel() {
  return localStorage.getItem("openrouter-model") || "google/gemini-2.0-flash-lite-001";
}
function readORKeys(): string[] {
  try {
    const v2 = localStorage.getItem("openrouter-api-keys-v2");
    if (v2) { const p = JSON.parse(v2); if (Array.isArray(p)) return p.filter(Boolean); }
    const v1 = localStorage.getItem("openrouter-api-keys");
    if (v1) { const p = JSON.parse(v1); if (Array.isArray(p)) return p.filter(Boolean); }
    const s  = localStorage.getItem("openrouter-api-key");
    if (s) return [s];
  } catch { /* ignore */ }
  return [];
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(file);
  });
}

function triggerDownload(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
}

const isImage   = (f: File) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
const isPDF     = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isArchive = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip"
                             || f.type === "application/x-zip-compressed";

/** Parse year + month from a filename, e.g. "2023-02", "02_2023", "2023_02" */
function parseYMFromName(name: string): { year: string; month: string } {
  // YYYY-MM or YYYY_MM
  const m1 = name.match(/(\d{4})[-_](\d{2})/);
  if (m1) return { year: m1[1], month: m1[2] };
  // MM-YYYY or MM_YYYY
  const m2 = name.match(/(\d{2})[-_](\d{4})/);
  if (m2) return { year: m2[2], month: m2[1] };
  return { year: CURR_YEAR, month: "01" };
}

// ── crop-modal state type ────────────────────────────────────────────────────

type CropCtx = {
  imageSrc:      string;
  imageName:     string;
  sourceId?:     string;
  taggedId?:     string;
  defaultYear?:  string;
  defaultMonth?: string;
  pageCount?:    number;
};

// ── inline tab button ─────────────────────────────────────────────────────────

function InlineTab({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium transition-colors
        ${active
          ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:rounded-t after:bg-primary"
          : "text-muted-foreground hover:text-foreground"
        }`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function NewReceiptFlow() {
  const {
    pdfs, setPdfs,
    sources, setSources,
    tagged, setTagged,
    csvItems, setCsvItems,
    csvColumnsHint, setCsvColumnsHint,
    newTab, setNewTab,
  } = useAppStore();

  // ── local UI state ──────────────────────────────────────────────────────────
  const [cropCtx,        setCropCtx]        = useState<CropCtx | null>(null);
  const [pdfPreview,     setPdfPreview]     = useState<string | null>(null);
  const [pdfBusy,        setPdfBusy]        = useState<string | null>(null);
  const [pdfProgress,    setPdfProgress]    = useState<{ cur: number; total: number } | null>(null);
  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [exporting,      setExporting]      = useState(false);
  const [csvExporting,   setCsvExporting]   = useState(false);
  const [csvPreviewUrl,  setCsvPreviewUrl]  = useState<string | null>(null);
  const [selectedCsvIds, setSelectedCsvIds] = useState<Set<string>>(new Set());
  const [showTaggedBank, setShowTaggedBank] = useState(true);

  const cropInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef  = useRef<HTMLInputElement>(null);

  // ── file ingestion (Crop & Tag) ─────────────────────────────────────────────

  const addCropFiles = useCallback(async (rawFiles: File[]) => {
    setLoading(true);
    const cache = loadTagCache();

    const processImage = async (img: File) => {
      const key     = ck(img);
      const dataUrl = await fileToDataUrl(img);
      const hit     = cache[key];
      if (hit) {
        setTagged((p) => [...p, {
          kind: "tagged", id: uid(), file: img, dataUrl,
          name: img.name, year: hit.year, month: hit.month, part: hit.part, ck: key,
        }]);
      } else {
        setSources((p) => [...p, {
          kind: "source", id: uid(), file: img, dataUrl, name: img.name,
        }]);
      }
    };

    for (const file of rawFiles) {
      try {
        if (isArchive(file)) {
          const imgs = await extractImagesFromArchive(file);
          for (const img of imgs) await processImage(img);
        } else if (isPDF(file)) {
          setPdfs((p) => [...p, { kind: "pdf", id: uid(), file, name: file.name }]);
        } else if (isImage(file)) {
          await processImage(file);
        }
      } catch (e: any) {
        toast.error(`Failed to load ${file.name}: ${e?.message ?? e}`);
      }
    }
    setLoading(false);
  }, [setTagged, setSources, setPdfs]);

  const onCropDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addCropFiles(Array.from(e.dataTransfer.files));
  }, [addCropFiles]);

  // ── PDF actions ─────────────────────────────────────────────────────────────

  const handlePdfCrop = useCallback(async (pdfId: string, pdfFile: File) => {
    setPdfBusy(pdfId);
    setPdfProgress(null);
    try {
      const { file: stitched, pageCount } = await pdfToStitchedJpeg(
        pdfFile,
        150,
        (cur, total) => setPdfProgress({ cur, total }),
      );
      const dataUrl = await fileToDataUrl(stitched);
      const srcId   = uid();
      setSources((p) => [...p, { kind: "source", id: srcId, file: stitched, dataUrl, name: stitched.name }]);
      setPdfs((p) => p.filter((x) => x.id !== pdfId));
      setCropCtx({ imageSrc: dataUrl, imageName: stitched.name, sourceId: srcId, pageCount });
    } catch (e: any) {
      toast.error(`PDF render failed: ${e?.message ?? e}`);
    }
    setPdfBusy(null);
    setPdfProgress(null);
  }, [setSources, setPdfs]);

  const handlePdfPreview = useCallback(async (pdfId: string, pdfFile: File) => {
    setPdfBusy(pdfId);
    setPdfProgress(null);
    try {
      const { file: stitched } = await pdfToStitchedJpeg(
        pdfFile,
        150,
        (cur, total) => setPdfProgress({ cur, total }),
      );
      setPdfPreview(await fileToDataUrl(stitched));
    } catch (e: any) {
      toast.error(`PDF preview failed: ${e?.message ?? e}`);
    }
    setPdfBusy(null);
    setPdfProgress(null);
  }, []);

  // ── crop modal extract ──────────────────────────────────────────────────────

  const handleCropExtract = useCallback(async (crops: TaggedCrop[], removeOriginal: boolean) => {
    if (!cropCtx) return;

    const srcFile =
      cropCtx.sourceId ? sources.find((s) => s.id === cropCtx.sourceId)?.file
      : cropCtx.taggedId ? tagged.find((t) => t.id === cropCtx.taggedId)?.file
      : null;

    if (!srcFile) { setCropCtx(null); return; }

    const cache = loadTagCache();
    const newTagged: StoreTaggedItem[] = [];

    for (let i = 0; i < crops.length; i++) {
      const crop       = crops[i];
      const croppedFile = await cropImageRegion(srcFile, crop, i);
      const dataUrl    = await fileToDataUrl(croppedFile);
      const key        = ck(croppedFile);
      cache[key] = { year: crop.year, month: crop.month, part: crop.part };
      newTagged.push({
        kind: "tagged", id: uid(), file: croppedFile, dataUrl,
        name: croppedFile.name, year: crop.year, month: crop.month, part: crop.part, ck: key,
      });
    }

    saveTagCache(cache);

    // Atomically remove old + add new (avoid double setTagged)
    const removedId = removeOriginal ? cropCtx.taggedId : undefined;
    setTagged((p) => {
      const filtered = removedId ? p.filter((t) => t.id !== removedId) : p;
      return [...filtered, ...newTagged];
    });
    if (removedId) setSelectedId((id) => id === removedId ? null : id);

    if (removeOriginal && cropCtx.sourceId) {
      setSources((p) => p.filter((s) => s.id !== cropCtx.sourceId));
    }

    setCropCtx(null);
  }, [cropCtx, sources, tagged, setSources, setTagged]);

  // ── tag editing ─────────────────────────────────────────────────────────────

  const updateTag = (id: string, field: "year" | "month" | "part", val: string) => {
    setTagged((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const updated = { ...it, [field]: val };
        const cache = loadTagCache();
        cache[it.ck] = { year: updated.year, month: updated.month, part: updated.part };
        saveTagCache(cache);
        return updated;
      }),
    );
  };

  const removeTagged = (id: string) => {
    setTagged((p) => p.filter((it) => it.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // ── export ZIP (images) ─────────────────────────────────────────────────────
  // Export name format: {month}_{year}__{part}.jpeg

  const exportZip = useCallback(async () => {
    if (!tagged.length) return;
    setExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      const seen  = new Map<string, number>();

      for (const it of tagged) {
        // Canonical name: MM_YYYY__part.jpeg
        const base    = `${it.month}_${it.year}__${it.part}`;
        const count   = seen.get(base) ?? 0;
        const renamed = count === 0 ? `${base}.jpeg` : `${base}__${count + 1}.jpeg`;
        seen.set(base, count + 1);
        zip.file(renamed, await it.file.arrayBuffer());
      }

      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `receipts-${Date.now()}.zip`);
      toast.success(`Exported ${tagged.length} image${tagged.length !== 1 ? "s" : ""}.`);
    } catch (e: any) {
      toast.error(`Export failed: ${e?.message ?? e}`);
    }
    setExporting(false);
  }, [tagged]);

  // ── CSV section: file ingestion ─────────────────────────────────────────────

  const makeCsvItem = (file: File, dataUrl: string, overrideYM?: { year: string; month: string }): StoreCsvItem => {
    const { year, month } = overrideYM ?? parseYMFromName(file.name);
    return {
      id: uid(), file, dataUrl, name: file.name,
      year, month, part: "1", ck: ck(file),
      extraction: null, editedRows: null, extractState: "idle",
    };
  };

  const addCsvFiles = useCallback(async (rawFiles: File[]) => {
    setLoading(true);
    for (const file of rawFiles) {
      try {
        if (isImage(file)) {
          const dataUrl = await fileToDataUrl(file);
          setCsvItems((p) => [...p, makeCsvItem(file, dataUrl)]);
        } else if (isArchive(file)) {
          const imgs = await extractImagesFromArchive(file);
          for (const img of imgs) {
            const dataUrl = await fileToDataUrl(img);
            setCsvItems((p) => [...p, makeCsvItem(img, dataUrl)]);
          }
        }
      } catch (e: any) {
        toast.error(`Failed to load ${file.name}: ${e?.message ?? e}`);
      }
    }
    setLoading(false);
  }, [setCsvItems]);

  const onCsvDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addCsvFiles(Array.from(e.dataTransfer.files));
  }, [addCsvFiles]);

  /** Import a tagged (cropped) image directly into the CSV queue */
  const addTaggedToCsv = useCallback((item: StoreTaggedItem) => {
    const alreadyIn = csvItems.some((it) => it.ck === item.ck);
    if (alreadyIn) { toast.info(`${item.name} is already in the CSV queue.`); return; }
    setCsvItems((p) => [...p, {
      id: uid(), file: item.file, dataUrl: item.dataUrl, name: item.name,
      year: item.year, month: item.month, part: item.part, ck: item.ck,
      extraction: null, editedRows: null, extractState: "idle",
    }]);
  }, [csvItems, setCsvItems]);

  const addAllTaggedToCsv = useCallback(() => {
    const existing = new Set(csvItems.map((it) => it.ck));
    const toAdd = tagged.filter((t) => !existing.has(t.ck));
    if (!toAdd.length) { toast.info("All cropped images are already in the CSV queue."); return; }
    setCsvItems((p) => [
      ...p,
      ...toAdd.map((item) => ({
        id: uid(), file: item.file, dataUrl: item.dataUrl, name: item.name,
        year: item.year, month: item.month, part: item.part, ck: item.ck,
        extraction: null, editedRows: null, extractState: "idle" as const,
      })),
    ]);
    toast.success(`Added ${toAdd.length} image${toAdd.length !== 1 ? "s" : ""} to the CSV queue.`);
  }, [tagged, csvItems, setCsvItems]);

  // ── CSV extraction ──────────────────────────────────────────────────────────

  const runExtract = useCallback(async (id: string) => {
    const item = csvItems.find((it) => it.id === id);
    if (!item) return;
    const keys = readORKeys();
    if (!keys.length) {
      toast.error("Add an OpenRouter API key in AI Settings (footer ⚙ button).");
      return;
    }
    setCsvItems((p) => p.map((it) => it.id === id ? { ...it, extractState: "loading" } : it));
    try {
      const result = await extractTableFromImage(item.dataUrl, csvColumnsHint);
      const model  = readORModel();
      appendAILog({
        ts: Date.now(), filename: item.name,
        model, provider: "openrouter",
        byteSize: item.file.size, origin: "images-to-csv",
      });
      setCsvItems((p) =>
        p.map((it) =>
          it.id === id
            ? { ...it, extraction: result, editedRows: result.rows.map((r) => [...r]), extractState: "done" }
            : it,
        ),
      );
    } catch (e: any) {
      setCsvItems((p) =>
        p.map((it) => it.id === id ? { ...it, extractState: "error", extractError: e?.message ?? "error" } : it),
      );
      toast.error(`Extract failed for ${item.name}: ${e?.message ?? e}`);
    }
  }, [csvItems, csvColumnsHint, setCsvItems]);

  const runBatchExtract = useCallback(async (ids?: string[]) => {
    const pending = csvItems.filter((it) =>
      (ids ? ids.includes(it.id) : true) && (it.extractState === "idle" || it.extractState === "error"),
    );
    if (!pending.length) { toast.info("All selected images already processed."); return; }
    for (const it of pending) await runExtract(it.id);
  }, [csvItems, runExtract]);

  // ── CSV multi-select helpers ────────────────────────────────────────────────

  const toggleCsvSelect = (id: string) =>
    setSelectedCsvIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allCsvSelected = csvItems.length > 0 && csvItems.every((it) => selectedCsvIds.has(it.id));
  const toggleAllCsv = () => {
    if (allCsvSelected) setSelectedCsvIds(new Set());
    else setSelectedCsvIds(new Set(csvItems.map((it) => it.id)));
  };

  // ── CSV export ──────────────────────────────────────────────────────────────

  // Export CSV name: {month}_{year}__{part}.csv
  const csvExportName = (item: StoreCsvItem) =>
    `${item.month}_${item.year}__${item.part}.csv`;

  const exportSingleCsv = (item: StoreCsvItem) => {
    const columns = item.extraction?.columns ?? [];
    const rows    = item.editedRows ?? item.extraction?.rows ?? [];
    if (!columns.length) { toast.info("Nothing to export yet — run extraction first."); return; }
    const csv = toCsv(columns, rows);
    triggerDownload(new Blob([csv], { type: "text/csv" }), csvExportName(item));
  };

  const exportAllCsvZip = useCallback(async () => {
    const ready = csvItems.filter(
      (it) => it.extractState === "done" && (it.extraction?.columns.length ?? 0) > 0,
    );
    if (!ready.length) { toast.info("No extracted tables to export."); return; }
    setCsvExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      for (const it of ready) {
        const columns = it.extraction?.columns ?? [];
        const rows    = it.editedRows ?? it.extraction?.rows ?? [];
        zip.file(csvExportName(it), toCsv(columns, rows));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `tables-${Date.now()}.zip`);
      toast.success(`Exported ${ready.length} CSV file${ready.length !== 1 ? "s" : ""}.`);
    } catch (e: any) {
      toast.error(`Export failed: ${e?.message ?? e}`);
    }
    setCsvExporting(false);
  }, [csvItems]);

  // ── helpers ─────────────────────────────────────────────────────────────────

  const selectedItem = tagged.find((it) => it.id === selectedId) ?? null;

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-[calc(100vh-6.5rem)] flex-col">

      {/* ── Internal tab strip ── */}
      <div className="flex border-b border-border px-4">
        <InlineTab active={newTab === "crop"} onClick={() => setNewTab("crop")}>
          Crop &amp; Tag
        </InlineTab>
        <InlineTab active={newTab === "csv"}  onClick={() => setNewTab("csv")}>
          Image → CSV
        </InlineTab>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 1: Crop & Tag
         ══════════════════════════════════════════════════════════════════════ */}
      {newTab === "crop" && (
        <div className="flex flex-1 flex-col">

          {/* Drop zone */}
          <DropZone
            onDrop={onCropDrop}
            onClick={() => cropInputRef.current?.click()}
            loading={loading}
            hint="Drop images, PDFs, or ZIP archives — or click to browse"
          >
            <input ref={cropInputRef} type="file" multiple className="hidden"
              accept="image/*,application/pdf,.pdf,.zip,application/zip,application/x-zip-compressed"
              onChange={(e) => addCropFiles(Array.from(e.target.files ?? []))} />
          </DropZone>

          {/* Content */}
          {(pdfs.length > 0 || sources.length > 0 || tagged.length > 0) && (
            <div className="mt-4 grid gap-6 px-4 pb-4 lg:grid-cols-2">

              {/* ── Left: PDFs + sources ── */}
              {(pdfs.length > 0 || sources.length > 0) && (
                <div className="space-y-4">

                  {/* PDF list */}
                  {pdfs.length > 0 && (
                    <section className="space-y-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        PDFs ({pdfs.length})
                      </h2>
                      {pdfs.map((pdf) => (
                        <div key={pdf.id}
                          className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                          <FileText className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
                          <p className="flex-1 truncate text-sm font-medium" title={pdf.name}>
                            {pdf.name}
                          </p>
                          {pdfBusy === pdf.id
                            ? (
                              <div className="flex items-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                {pdfProgress && (
                                  <span className="text-xs text-muted-foreground">
                                    Page {pdfProgress.cur}/{pdfProgress.total}
                                  </span>
                                )}
                              </div>
                            )
                            : (
                              <div className="flex gap-1">
                                <Button size="icon" variant="ghost" className="h-7 w-7"
                                  title="Preview PDF"
                                  onClick={() => handlePdfPreview(pdf.id, pdf.file)}>
                                  <Eye className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7"
                                  title="Crop this PDF"
                                  onClick={() => handlePdfCrop(pdf.id, pdf.file)}>
                                  <Scissors className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                                  onClick={() => setPdfs((p) => p.filter((x) => x.id !== pdf.id))}>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            )}
                        </div>
                      ))}
                    </section>
                  )}

                  {/* Source images list */}
                  {sources.length > 0 && (
                    <section className="space-y-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        To Crop ({sources.length})
                      </h2>
                      {sources.map((src) => (
                        <div key={src.id}
                          className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                          <img src={src.dataUrl} alt={src.name}
                            className="h-12 w-10 flex-shrink-0 rounded object-cover" />
                          <p className="flex-1 truncate text-sm font-medium" title={src.name}>
                            {src.name}
                          </p>
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7"
                              title="Crop this image"
                              onClick={() => setCropCtx({
                                imageSrc: src.dataUrl, imageName: src.name, sourceId: src.id,
                              })}>
                              <Scissors className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                              onClick={() => setSources((p) => p.filter((s) => s.id !== src.id))}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>
                  )}
                </div>
              )}

              {/* ── Right: tagged preview grid ── */}
              {tagged.length > 0 && (
                <div className="space-y-3">
                  {/* Header + export */}
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Preview ({tagged.length})
                    </h2>
                    <Button size="sm" onClick={exportZip} disabled={exporting}>
                      {exporting
                        ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        : <Download className="mr-1.5 h-3.5 w-3.5" />}
                      Export ZIP
                    </Button>
                  </div>

                  {/* Tag editor for selected item */}
                  {selectedItem && (
                    <div className="flex items-start gap-3 rounded-lg border border-primary bg-primary/5 p-3">
                      <img src={selectedItem.dataUrl} alt={selectedItem.name}
                        className="h-16 w-12 flex-shrink-0 rounded object-cover" />
                      <div className="flex flex-1 flex-col gap-2 min-w-0">
                        <p className="truncate text-xs font-medium" title={selectedItem.name}>
                          {selectedItem.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={selectedItem.year}
                            onValueChange={(v) => updateTag(selectedItem.id, "year", v)}>
                            <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Select value={selectedItem.month}
                            onValueChange={(v) => updateTag(selectedItem.id, "month", v)}>
                            <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">p.</span>
                            <input type="number" min={1} max={99}
                              value={selectedItem.part}
                              onChange={(e) =>
                                updateTag(selectedItem.id, "part",
                                  String(Math.max(1, Math.min(99, Number(e.target.value) || 1))))}
                              className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                          </div>
                          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7"
                            title="Re-crop"
                            onClick={() => {
                              setCropCtx({
                                imageSrc: selectedItem.dataUrl, imageName: selectedItem.name,
                                taggedId: selectedItem.id,
                                defaultYear: selectedItem.year, defaultMonth: selectedItem.month,
                              });
                            }}>
                            <Scissors className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs"
                            onClick={() => setSelectedId(null)}>
                            <Check className="mr-1 h-3 w-3" />Done
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Thumbnail grid — colored by year */}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {tagged.map((item) => {
                      const isSel = item.id === selectedId;
                      const col   = yearPalette(item.year);
                      return (
                        <div key={item.id}
                          className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 transition-all ${
                            isSel ? "shadow-md" : "hover:opacity-90"
                          }`}
                          style={{
                            borderColor: isSel ? col.border : `${col.border}88`,
                            backgroundColor: col.bg,
                          }}
                          onClick={() => setSelectedId(isSel ? null : item.id)}>
                          <img src={item.dataUrl} alt={item.name}
                            className="aspect-[3/4] w-full object-cover" />

                          {/* Tag chip */}
                          <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1"
                            style={{ background: `${col.border}cc` }}>
                            <p className="truncate text-[11px] font-semibold leading-tight text-white">
                              {item.month}/{item.year}
                            </p>
                            <p className="text-[10px] leading-tight text-white/85">p.{item.part}</p>
                          </div>

                          {/* Edit badge */}
                          <div className={`absolute right-1 top-1 rounded-full p-1 shadow transition-opacity ${
                            isSel ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                          }`}
                            style={{ background: col.border }}>
                            <Pencil className="h-2.5 w-2.5 text-white" />
                          </div>

                          {/* Re-crop icon */}
                          <button
                            className="absolute left-1 bottom-8 rounded-full bg-black/50 p-1 opacity-0 shadow transition-opacity group-hover:opacity-100"
                            title="Re-crop"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCropCtx({
                                imageSrc: item.dataUrl, imageName: item.name,
                                taggedId: item.id,
                                defaultYear: item.year, defaultMonth: item.month,
                              });
                            }}>
                            <Scissors className="h-2.5 w-2.5 text-white" />
                          </button>

                          {/* Remove */}
                          <button
                            className="absolute left-1 top-1 rounded-full bg-black/50 p-1 opacity-0 shadow transition-opacity group-hover:opacity-100"
                            onClick={(e) => { e.stopPropagation(); removeTagged(item.id); }}>
                            <X className="h-2.5 w-2.5 text-white" />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    Click an image to edit its tag. Hover for scissors to re-crop. Colors = year.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 2: Image → CSV
         ══════════════════════════════════════════════════════════════════════ */}
      {newTab === "csv" && (
        <div className="flex flex-1 flex-col">

          {/* ── Cropped images bank ── */}
          {tagged.length > 0 && (
            <div className="mx-4 mt-4 rounded-lg border border-border bg-muted/20 p-3">
              <button
                className="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                onClick={() => setShowTaggedBank((v) => !v)}
              >
                <ImageIcon className="h-3.5 w-3.5" />
                Cropped images ({tagged.length})
                {showTaggedBank ? <ChevronUp className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
              </button>
              {showTaggedBank && (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {tagged.map((item) => {
                      const col      = yearPalette(item.year);
                      const alreadyIn = csvItems.some((it) => it.ck === item.ck);
                      return (
                        <div key={item.id}
                          className="relative flex h-16 w-14 flex-shrink-0 cursor-pointer flex-col overflow-hidden rounded border-2 transition-all"
                          style={{ borderColor: col.border, backgroundColor: col.bg }}
                          title={item.name}
                          onClick={() => !alreadyIn && addTaggedToCsv(item)}
                        >
                          <img src={item.dataUrl} alt={item.name}
                            className="h-10 w-full object-cover" />
                          <div className="flex-1 px-0.5 text-center"
                            style={{ background: `${col.border}bb` }}>
                            <p className="truncate text-[9px] font-semibold text-white leading-tight">
                              {item.month}/{item.year}
                            </p>
                          </div>
                          {alreadyIn && (
                            <div className="absolute inset-0 flex items-center justify-center rounded bg-black/40">
                              <Check className="h-4 w-4 text-white" />
                            </div>
                          )}
                          {!alreadyIn && (
                            <div className="absolute right-0.5 top-0.5 rounded-full bg-black/50 p-0.5">
                              <Plus className="h-2.5 w-2.5 text-white" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={addAllTaggedToCsv}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add all to CSV queue
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Drop zone for more uploads */}
          <DropZone
            onDrop={onCsvDrop}
            onClick={() => csvInputRef.current?.click()}
            loading={loading}
            hint="Drop images or ZIP archives to add more — or click to browse"
          >
            <input ref={csvInputRef} type="file" multiple className="hidden"
              accept="image/*,.zip,application/zip,application/x-zip-compressed"
              onChange={(e) => addCsvFiles(Array.from(e.target.files ?? []))} />
          </DropZone>

          {csvItems.length > 0 && (
            <div className="space-y-4 px-4 pb-4 mt-4">

              {/* Batch controls */}
              <div className="flex flex-wrap items-start gap-2">
                {/* Global columns hint */}
                <div className="flex-1 min-w-52">
                  <Label className="text-[11px] text-muted-foreground mb-0.5 block">
                    Columns (global default for all extractions):
                  </Label>
                  <Textarea
                    placeholder={DEFAULT_COLUMNS_HINT}
                    value={csvColumnsHint}
                    onChange={(e) => setCsvColumnsHint(e.target.value)}
                    className="h-8 resize-none text-xs"
                    rows={1}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 self-end">
                  {/* Select all toggle */}
                  <button
                    onClick={toggleAllCsv}
                    className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition ${
                      allCsvSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                      allCsvSelected ? "border-primary bg-primary" : "border-muted-foreground"
                    }`}>
                      {allCsvSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </span>
                    All
                  </button>

                  <span className="text-sm text-muted-foreground">
                    {csvItems.length} image{csvItems.length !== 1 ? "s" : ""}
                    {selectedCsvIds.size > 0 && ` · ${selectedCsvIds.size} selected`}
                  </span>

                  {selectedCsvIds.size > 0 && (
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => runBatchExtract([...selectedCsvIds])}>
                      <TableProperties className="mr-1.5 h-3.5 w-3.5" />
                      Extract selected ({selectedCsvIds.size})
                    </Button>
                  )}

                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => runBatchExtract()}>
                    <TableProperties className="mr-1.5 h-3.5 w-3.5" />
                    Extract all
                  </Button>

                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={exportAllCsvZip} disabled={csvExporting}>
                    {csvExporting
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <Download className="mr-1.5 h-3.5 w-3.5" />}
                    Export all ZIP
                  </Button>

                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive"
                    onClick={() => { setCsvItems([]); setSelectedCsvIds(new Set()); }}>
                    <X className="mr-1 h-3.5 w-3.5" />Clear
                  </Button>
                </div>
              </div>

              {/* Item list */}
              <div className="space-y-4">
                {csvItems.map((item) => {
                  const displayRows = item.editedRows ?? item.extraction?.rows ?? [];
                  const columns     = item.extraction?.columns ?? [];
                  const isSel       = selectedCsvIds.has(item.id);
                  return (
                    <div key={item.id}
                      className={`rounded-lg border p-3 space-y-3 transition-colors ${
                        isSel ? "border-primary bg-primary/5" : "border-border"
                      }`}>

                      {/* Top row: checkbox + thumb + controls */}
                      <div className="flex gap-3">
                        {/* Checkbox */}
                        <button
                          onClick={() => toggleCsvSelect(item.id)}
                          className={`mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition ${
                            isSel ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"
                          }`}
                        >
                          {isSel && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                        </button>

                        {/* Thumbnail — click to preview */}
                        <img
                          src={item.dataUrl}
                          alt={item.name}
                          className="h-24 w-20 flex-shrink-0 cursor-zoom-in rounded object-cover ring-1 ring-border hover:ring-primary"
                          title="Click to preview"
                          onClick={() => setCsvPreviewUrl(item.dataUrl)}
                        />

                        <div className="flex flex-1 flex-col gap-2 min-w-0">
                          <p className="truncate text-xs font-medium" title={item.name}>
                            {item.name}
                          </p>

                          {/* Tag row */}
                          <div className="flex flex-wrap items-center gap-2">
                            <Select value={item.year}
                              onValueChange={(v) =>
                                setCsvItems((p) => p.map((it) =>
                                  it.id === item.id ? { ...it, year: v } : it))}>
                              <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Select value={item.month}
                              onValueChange={(v) =>
                                setCsvItems((p) => p.map((it) =>
                                  it.id === item.id ? { ...it, month: v } : it))}>
                              <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-muted-foreground">p.</span>
                              <input type="number" min={1} max={99}
                                value={item.part}
                                onChange={(e) =>
                                  setCsvItems((p) => p.map((it) =>
                                    it.id === item.id
                                      ? { ...it, part: String(Math.max(1, Math.min(99, Number(e.target.value) || 1))) }
                                      : it))}
                                className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                              />
                            </div>
                          </div>

                          {/* Action row */}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" className="h-7 text-xs"
                              disabled={item.extractState === "loading"}
                              onClick={() => runExtract(item.id)}>
                              {item.extractState === "loading"
                                ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                : <TableProperties className="mr-1 h-3 w-3" />}
                              {item.extractState === "done" ? "Re-extract" : "Extract table"}
                            </Button>

                            {item.extractState === "done" && columns.length > 0 && (
                              <Button size="sm" variant="outline" className="h-7 text-xs"
                                onClick={() => exportSingleCsv(item)}>
                                <Download className="mr-1 h-3 w-3" />Export CSV
                              </Button>
                            )}

                            {item.extractState === "error" && (
                              <span className="text-xs text-destructive">
                                ⚠ {item.extractError ?? "error"}
                              </span>
                            )}

                            <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 text-muted-foreground"
                              onClick={() => {
                                setCsvItems((p) => p.filter((it) => it.id !== item.id));
                                setSelectedCsvIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(item.id);
                                  return next;
                                });
                              }}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Editable CSV table */}
                      {columns.length > 0 && (
                        <CsvTable
                          filename={csvExportName(item)}
                          columns={columns}
                          rows={displayRows}
                          onRowsChange={(rows) =>
                            setCsvItems((p) =>
                              p.map((it) => it.id === item.id ? { ...it, editedRows: rows } : it))}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Full-screen crop modal ── */}
      {cropCtx && (
        <CropModal
          imageSrc={cropCtx.imageSrc}
          imageName={cropCtx.imageName}
          defaultYear={cropCtx.defaultYear}
          defaultMonth={cropCtx.defaultMonth}
          pageCount={cropCtx.pageCount}
          onExtract={handleCropExtract}
          onClose={() => setCropCtx(null)}
        />
      )}

      {/* ── PDF preview overlay ── */}
      {pdfPreview && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85"
          onClick={() => setPdfPreview(null)}>
          <button
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPdfPreview(null)}>
            <X className="h-5 w-5" />
          </button>
          <img
            src={pdfPreview}
            alt="PDF preview"
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* ── CSV image preview overlay ── */}
      {csvPreviewUrl && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85"
          onClick={() => setCsvPreviewUrl(null)}>
          <button
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setCsvPreviewUrl(null)}>
            <X className="h-5 w-5" />
          </button>
          <img
            src={csvPreviewUrl}
            alt="Image preview"
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

// ── DropZone helper ──────────────────────────────────────────────────────────

function DropZone({
  onDrop, onClick, loading, hint, children,
}: {
  onDrop: (e: React.DragEvent) => void;
  onClick: () => void;
  loading: boolean;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={onClick}
      className="mx-4 mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-5 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
    >
      <div className="flex items-center gap-3 opacity-60">
        <ImageIcon className="h-5 w-5" />
        <FileArchive className="h-5 w-5" />
      </div>
      <span className="text-center text-xs">{hint}</span>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </div>
  );
}

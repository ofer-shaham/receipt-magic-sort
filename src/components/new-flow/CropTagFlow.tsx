/**
 * CropTagFlow — Crop & Tag tab (/new/crop-tag).
 * Extracted from the original NewReceiptFlow monolith.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useAppStore,
  type StoreTaggedItem,
} from "@/contexts/AppStore";
import { CropModal } from "@/components/CropModal";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  FileArchive, FileText, Loader as Loader2, X,
  Scissors, Eye, Download, Pencil, Check,
  Image as ImageIcon,
} from "lucide-react";
import type { TaggedCrop } from "@/components/CropWizard";
import { pdfToStitchedJpeg } from "@/lib/new-flow/pdf-to-image";
import { cropImageRegion, extractImagesFromArchive } from "@/lib/receipt-utils";

// ── constants ─────────────────────────────────────────────────────────────────

const CURR_YEAR = String(new Date().getFullYear());
const YEARS     = Array.from({ length: 6 }, (_, i) => String(Number(CURR_YEAR) - i));
const MONTHS    = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const TAG_CACHE_K = "receiptforge-new-tags-v1";

const YEAR_PALETTE = [
  { border: "#10b981", bg: "rgba(16,185,129,0.12)"  },
  { border: "#3b82f6", bg: "rgba(59,130,246,0.12)"  },
  { border: "#f59e0b", bg: "rgba(245,158,11,0.12)"  },
  { border: "#f43f5e", bg: "rgba(244,63,94,0.12)"   },
  { border: "#8b5cf6", bg: "rgba(139,92,246,0.12)"  },
  { border: "#06b6d4", bg: "rgba(6,182,212,0.12)"   },
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

// ── crop-modal state type ─────────────────────────────────────────────────────

type CropCtx = {
  imageSrc:      string;
  imageName:     string;
  sourceId?:     string;
  taggedId?:     string;
  defaultYear?:  string;
  defaultMonth?: string;
  pageCount?:    number;
};

// ── DropZone ──────────────────────────────────────────────────────────────────

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

// ── Component ─────────────────────────────────────────────────────────────────

export function CropTagFlow() {
  const { pdfs, setPdfs, sources, setSources, tagged, setTagged } = useAppStore();

  const [cropCtx,     setCropCtx]     = useState<CropCtx | null>(null);
  const [pdfPreview,  setPdfPreview]  = useState<string | null>(null);
  const [pdfBusy,     setPdfBusy]     = useState<string | null>(null);
  const [pdfProgress, setPdfProgress] = useState<{ cur: number; total: number } | null>(null);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [exporting,   setExporting]   = useState(false);

  const cropInputRef = useRef<HTMLInputElement>(null);

  // ── file ingestion ──────────────────────────────────────────────────────────

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

  // ── PDF actions ──────────────────────────────────────────────────────────────

  const handlePdfCrop = useCallback(async (pdfId: string, pdfFile: File) => {
    setPdfBusy(pdfId);
    setPdfProgress(null);
    try {
      const { file: stitched, pageCount } = await pdfToStitchedJpeg(
        pdfFile, 150,
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
        pdfFile, 150,
        (cur, total) => setPdfProgress({ cur, total }),
      );
      setPdfPreview(await fileToDataUrl(stitched));
    } catch (e: any) {
      toast.error(`PDF preview failed: ${e?.message ?? e}`);
    }
    setPdfBusy(null);
    setPdfProgress(null);
  }, []);

  // ── crop modal extract ────────────────────────────────────────────────────────

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
      const crop        = crops[i];
      const croppedFile = await cropImageRegion(srcFile, crop, i);
      const dataUrl     = await fileToDataUrl(croppedFile);
      const key         = ck(croppedFile);
      cache[key] = { year: crop.year, month: crop.month, part: crop.part };
      newTagged.push({
        kind: "tagged", id: uid(), file: croppedFile, dataUrl,
        name: croppedFile.name, year: crop.year, month: crop.month, part: crop.part, ck: key,
      });
    }

    saveTagCache(cache);

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

  // ── tag editing ───────────────────────────────────────────────────────────────

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

  // ── export ZIP ───────────────────────────────────────────────────────────────

  const exportZip = useCallback(async () => {
    if (!tagged.length) return;
    setExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      for (const it of tagged) {
        const renamed = `y${it.year}_m${it.month}__p${it.part}.jpeg`;
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

  const selectedItem = tagged.find((it) => it.id === selectedId) ?? null;

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col">

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

      {(pdfs.length > 0 || sources.length > 0 || tagged.length > 0) && (
        <div className="mt-4 grid gap-6 px-4 pb-4 lg:grid-cols-2">

          {/* ── Left: PDFs + sources ── */}
          {(pdfs.length > 0 || sources.length > 0) && (
            <div className="space-y-4">

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
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Preview PDF"
                              onClick={() => handlePdfPreview(pdf.id, pdf.file)}>
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Crop this PDF"
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
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Crop this image"
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
                      <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" title="Re-crop"
                        onClick={() => setCropCtx({
                          imageSrc: selectedItem.dataUrl, imageName: selectedItem.name,
                          taggedId: selectedItem.id,
                          defaultYear: selectedItem.year, defaultMonth: selectedItem.month,
                        })}>
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
                      <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1"
                        style={{ background: `${col.border}cc` }}>
                        <p className="truncate text-[11px] font-semibold leading-tight text-white">
                          {item.month}/{item.year}
                        </p>
                        <p className="text-[10px] leading-tight text-white/85">p.{item.part}</p>
                      </div>
                      <div className={`absolute right-1 top-1 rounded-full p-1 shadow transition-opacity ${
                        isSel ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`} style={{ background: col.border }}>
                        <Pencil className="h-2.5 w-2.5 text-white" />
                      </div>
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
            src={pdfPreview} alt="PDF preview"
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

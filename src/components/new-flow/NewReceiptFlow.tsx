import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { CropWizardPanel, type TaggedCrop } from "@/components/CropWizard";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ImageIcon, FileArchive, Loader2, X, Scissors, ChevronDown, ChevronUp,
  Download, Pencil, Check,
} from "lucide-react";
import { pdfToStitchedJpeg } from "@/lib/new-flow/pdf-to-image";
import { extractImagesFromArchive, cropImageRegion, fmtTag } from "@/lib/receipt-utils";

// ── constants ─────────────────────────────────────────────────────────────────

const CURR_YEAR   = String(new Date().getFullYear());
const YEARS       = Array.from({ length: 6 }, (_, i) => String(Number(CURR_YEAR) - i));
const MONTHS      = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const TAG_CACHE_K = "receiptforge-new-tags-v1";

// ── helpers ───────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);

function cacheKey(file: File) { return `${file.name}::${file.size}`; }

function loadTagCache(): Record<string, { year: string; month: string; part: string }> {
  try { return JSON.parse(localStorage.getItem(TAG_CACHE_K) || "{}"); }
  catch { return {}; }
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
const isArchive = (f: File) => /\.(zip)$/i.test(f.name) || f.type === "application/zip"
                             || f.type === "application/x-zip-compressed";

// ── types ─────────────────────────────────────────────────────────────────────

/** A raw image waiting to be cropped — shows inline crop panel */
type SourceItem = {
  kind:     "source";
  id:       string;
  file:     File;
  dataUrl:  string;
  name:     string;
  cropOpen: boolean;
};

/** A cropped + tagged image in the preview */
type TaggedItem = {
  kind:     "tagged";
  id:       string;
  file:     File;
  dataUrl:  string;
  name:     string;   // cropped filename (before rename)
  year:     string;
  month:    string;
  part:     string;
  ck:       string;   // cache key = name::size
};

// ── component ─────────────────────────────────────────────────────────────────

export function NewReceiptFlow() {
  const [sources,    setSources]    = useState<SourceItem[]>([]);
  const [tagged,     setTagged]     = useState<TaggedItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [exporting,  setExporting]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── file ingestion ──────────────────────────────────────────────────────────

  const addFiles = useCallback(async (rawFiles: File[]) => {
    setLoading(true);
    const newSources: SourceItem[] = [];
    const newTagged:  TaggedItem[]  = [];
    const cache = loadTagCache();

    const processImage = async (img: File) => {
      const ck = cacheKey(img);
      const dataUrl = await fileToDataUrl(img);
      const hit = cache[ck];
      if (hit) {
        newTagged.push({ kind: "tagged", id: uid(), file: img, dataUrl,
                         name: img.name, year: hit.year, month: hit.month,
                         part: hit.part, ck });
      } else {
        newSources.push({ kind: "source", id: uid(), file: img, dataUrl,
                          name: img.name, cropOpen: true });
      }
    };

    for (const file of rawFiles) {
      try {
        if (isArchive(file)) {
          const imgs = await extractImagesFromArchive(file);
          for (const img of imgs) await processImage(img);
        } else if (isPDF(file)) {
          const stitched = await pdfToStitchedJpeg(file);
          newSources.push({
            kind: "source", id: uid(), file: stitched,
            dataUrl: await fileToDataUrl(stitched),
            name: stitched.name, cropOpen: true,
          });
        } else if (isImage(file)) {
          await processImage(file);
        }
      } catch (e: any) {
        toast.error(`Failed to load ${file.name}: ${e?.message ?? e}`);
      }
    }

    setSources((p) => [...p, ...newSources]);
    setTagged((p)  => [...p, ...newTagged]);
    setLoading(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  // ── crop extract ─────────────────────────────────────────────────────────────

  const handleExtract = useCallback(async (
    sourceId: string,
    crops: TaggedCrop[],
    removeOriginal: boolean,
  ) => {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;

    const cache = loadTagCache();
    const newTagged: TaggedItem[] = [];

    for (let i = 0; i < crops.length; i++) {
      const crop = crops[i];
      const croppedFile = await cropImageRegion(source.file, crop, i);
      const dataUrl     = await fileToDataUrl(croppedFile);
      const ck          = cacheKey(croppedFile);
      cache[ck] = { year: crop.year, month: crop.month, part: crop.part };
      newTagged.push({
        kind: "tagged", id: uid(), file: croppedFile, dataUrl,
        name: croppedFile.name, year: crop.year, month: crop.month,
        part: crop.part, ck,
      });
    }

    saveTagCache(cache);
    if (removeOriginal) setSources((p) => p.filter((s) => s.id !== sourceId));
    setTagged((p) => [...p, ...newTagged]);
  }, [sources]);

  // ── tag editing ──────────────────────────────────────────────────────────────

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

  const removeSource = (id: string) => setSources((p) => p.filter((s) => s.id !== id));

  const toggleCrop = (id: string) =>
    setSources((p) => p.map((s) => s.id === id ? { ...s, cropOpen: !s.cropOpen } : s));

  // ── export ZIP ───────────────────────────────────────────────────────────────

  const exportZip = useCallback(async () => {
    if (!tagged.length) return;
    setExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      const cache = loadTagCache();

      for (const it of tagged) {
        const renamed = `${it.year}-${it.month}.part${it.part}.${it.name}`;
        zip.file(renamed, await it.file.arrayBuffer());
        // Also cache under renamed name so reimport restores tags
        cache[`${renamed}::${it.file.size}`] = { year: it.year, month: it.month, part: it.part };
      }

      saveTagCache(cache);
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `receipts-${Date.now()}.zip`);
      toast.success(`Exported ${tagged.length} image${tagged.length !== 1 ? "s" : ""}.`);
    } catch (e: any) {
      toast.error(`Export failed: ${e?.message ?? e}`);
    }
    setExporting(false);
  }, [tagged]);

  // ── render ────────────────────────────────────────────────────────────────────

  const selectedItem = tagged.find((it) => it.id === selectedId) ?? null;

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col">
      {/* ── Drop zone ── */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="mx-4 mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-6 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        <div className="flex items-center gap-3 opacity-70">
          <ImageIcon className="h-6 w-6" />
          <FileArchive className="h-6 w-6" />
        </div>
        <span>Drop images, PDFs, or ZIP archives — or click to browse</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.pdf,.zip,application/zip,application/x-zip-compressed"
          className="hidden"
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
        />
      </div>

      {/* ── Main 2-col layout ── */}
      {(sources.length > 0 || tagged.length > 0) && (
        <div className="mt-4 grid flex-1 gap-4 px-4 pb-4 lg:grid-cols-2">

          {/* ── Left: source items to crop ── */}
          {sources.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">
                To crop <span className="text-muted-foreground font-normal">({sources.length})</span>
              </h2>

              {sources.map((item) => (
                <div key={item.id} className="rounded-lg border border-border">
                  {/* Header */}
                  <div className="flex items-center gap-3 p-3">
                    <img src={item.dataUrl} alt={item.name}
                      className="h-14 w-11 flex-shrink-0 rounded object-cover" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant={item.cropOpen ? "default" : "outline"}
                          className="h-7 text-xs"
                          onClick={() => toggleCrop(item.id)}
                        >
                          <Scissors className="mr-1 h-3 w-3" />
                          {item.cropOpen
                            ? <><ChevronUp className="ml-0.5 h-3 w-3" />Close</>
                            : <><ChevronDown className="ml-0.5 h-3 w-3" />Crop</>}
                        </Button>
                        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7"
                          onClick={() => removeSource(item.id)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Inline crop panel */}
                  {item.cropOpen && (
                    <div className="border-t border-border p-3">
                      <CropWizardPanel
                        imageSrc={item.dataUrl}
                        imageName={item.name}
                        showTagInputs
                        onTaggedExtract={(crops, removeOriginal) =>
                          handleExtract(item.id, crops, removeOriginal)
                        }
                        onCancel={() => toggleCrop(item.id)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Right: preview grid ── */}
          {tagged.length > 0 && (
            <div className="space-y-3">
              {/* Header + export */}
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  Preview <span className="text-muted-foreground font-normal">({tagged.length})</span>
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
                <div className="flex items-center gap-3 rounded-lg border border-primary bg-primary/5 p-3">
                  <img src={selectedItem.dataUrl} alt={selectedItem.name}
                    className="h-16 w-12 flex-shrink-0 rounded object-cover" />
                  <div className="flex flex-1 flex-col gap-2">
                    <p className="truncate text-xs font-medium" title={selectedItem.name}>
                      {selectedItem.name}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={selectedItem.year}
                        onValueChange={(v) => updateTag(selectedItem.id, "year", v)}>
                        <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select value={selectedItem.month}
                        onValueChange={(v) => updateTag(selectedItem.id, "month", v)}>
                        <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                      </Select>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">p.</span>
                        <input
                          type="number" min={1} max={99}
                          value={selectedItem.part}
                          onChange={(e) =>
                            updateTag(selectedItem.id, "part",
                              String(Math.max(1, Math.min(99, Number(e.target.value) || 1))))
                          }
                          className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                      <Button size="sm" variant="outline" className="h-7 text-xs ml-auto"
                        onClick={() => setSelectedId(null)}>
                        <Check className="mr-1 h-3 w-3" />Done
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Grid */}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {tagged.map((item) => {
                  const isSelected = item.id === selectedId;
                  return (
                    <div
                      key={item.id}
                      className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 transition-all ${
                        isSelected ? "border-primary shadow-md" : "border-border hover:border-primary/50"
                      }`}
                      onClick={() => setSelectedId(isSelected ? null : item.id)}
                    >
                      <img
                        src={item.dataUrl}
                        alt={item.name}
                        className="aspect-[3/4] w-full object-cover"
                      />
                      {/* Tag chip */}
                      <div className="absolute bottom-0 left-0 right-0 bg-black/65 px-1.5 py-1">
                        <p className="truncate text-[11px] font-semibold leading-tight text-white">
                          {fmtTag(`${item.year}-${item.month}-01`)}
                        </p>
                        <p className="text-[10px] leading-tight text-white/75">p.{item.part}</p>
                      </div>
                      {/* Edit badge */}
                      <div className={`absolute right-1 top-1 rounded-full p-1 shadow transition-opacity ${
                        isSelected ? "bg-primary opacity-100" : "bg-black/50 opacity-0 group-hover:opacity-100"
                      }`}>
                        <Pencil className="h-2.5 w-2.5 text-white" />
                      </div>
                      {/* Remove */}
                      <button
                        className="absolute left-1 top-1 rounded-full bg-black/50 p-1 opacity-0 shadow transition-opacity group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); removeTagged(item.id); }}
                      >
                        <X className="h-2.5 w-2.5 text-white" />
                      </button>
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-muted-foreground">
                Click an image to edit its tag. Imported ZIPs automatically restore saved tags.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ImageCsvFlow — Image → CSV tab (/new/image-csv).
 * Extracted from the original NewReceiptFlow monolith.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useAppStore,
  type StoreCsvItem,
  DEFAULT_COLUMNS_HINT,
} from "@/contexts/AppStore";
import { CsvTable } from "@/components/new-flow/CsvTable";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  FileArchive, Loader as Loader2, X,
  Download, Check, TableProperties, Plus,
  ChevronDown, ChevronUp, Image as ImageIcon,
} from "lucide-react";
import { extractTableFromImage, toCsv } from "@/lib/new-flow/csv-extract";
import { appendAILog } from "@/lib/new-flow/logging";
import { extractImagesFromArchive } from "@/lib/receipt-utils";

// ── constants ─────────────────────────────────────────────────────────────────

const CURR_YEAR = String(new Date().getFullYear());
const YEARS     = Array.from({ length: 6 }, (_, i) => String(Number(CURR_YEAR) - i));
const MONTHS    = ["01","02","03","04","05","06","07","08","09","10","11","12"];

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
const isArchive = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip"
                             || f.type === "application/x-zip-compressed";

function parseYMFromName(name: string): { year: string; month: string } {
  const m1 = name.match(/(\d{4})[-_](\d{2})/);
  if (m1) return { year: m1[1], month: m1[2] };
  const m2 = name.match(/(\d{2})[-_](\d{4})/);
  if (m2) return { year: m2[2], month: m2[1] };
  return { year: CURR_YEAR, month: "01" };
}

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

export function ImageCsvFlow() {
  const { tagged, csvItems, setCsvItems, csvColumnsHint, setCsvColumnsHint } = useAppStore();

  const [csvExporting,   setCsvExporting]   = useState(false);
  const [csvPreviewUrl,  setCsvPreviewUrl]  = useState<string | null>(null);
  const [selectedCsvIds, setSelectedCsvIds] = useState<Set<string>>(new Set());
  const [showTaggedBank, setShowTaggedBank] = useState(true);
  const [loading,        setLoading]        = useState(false);

  const csvInputRef = useRef<HTMLInputElement>(null);

  // ── helpers ─────────────────────────────────────────────────────────────────

  const makeCsvItem = (file: File, dataUrl: string, overrideYM?: { year: string; month: string }): StoreCsvItem => {
    const { year, month } = overrideYM ?? parseYMFromName(file.name);
    return {
      id: uid(), file, dataUrl, name: file.name,
      year, month, part: "1", ck: ck(file),
      extraction: null, editedRows: null, extractState: "idle",
    };
  };

  const csvExportName = (item: StoreCsvItem) =>
    `y${item.year}_m${item.month}__p${item.part}.csv`;

  // ── file ingestion ───────────────────────────────────────────────────────────

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

  const addTaggedToCsv = useCallback((item: typeof tagged[0]) => {
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

  // ── extraction ───────────────────────────────────────────────────────────────

  const runExtract = useCallback(async (id: string) => {
    const item = csvItems.find((it) => it.id === id);
    if (!item) return;
    setCsvItems((p) => p.map((it) => it.id === id ? { ...it, extractState: "loading" } : it));
    try {
      const outcome = await extractTableFromImage(item.dataUrl, csvColumnsHint);
      appendAILog({
        ts: Date.now(), filename: item.name,
        model: outcome.meta.model, provider: outcome.meta.provider,
        byteSize: item.file.size, origin: "images-to-csv",
      });
      setCsvItems((p) =>
        p.map((it) =>
          it.id === id
            ? { ...it, extraction: { columns: outcome.columns, rows: outcome.rows }, editedRows: outcome.rows.map((r) => [...r]), extractState: "done" }
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

  // ── multi-select ─────────────────────────────────────────────────────────────

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

  // ── export ───────────────────────────────────────────────────────────────────

  const exportSingleCsv = (item: StoreCsvItem) => {
    const columns = item.extraction?.columns ?? [];
    const rows    = item.editedRows ?? item.extraction?.rows ?? [];
    if (!columns.length) { toast.info("Nothing to export yet — run extraction first."); return; }
    triggerDownload(new Blob([toCsv(columns, rows)], { type: "text/csv" }), csvExportName(item));
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

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col">

      {/* Cropped images bank */}
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
                  const col       = yearPalette(item.year);
                  const alreadyIn = csvItems.some((it) => it.ck === item.ck);
                  return (
                    <div key={item.id}
                      className="relative flex h-16 w-14 flex-shrink-0 cursor-pointer flex-col overflow-hidden rounded border-2 transition-all"
                      style={{ borderColor: col.border, backgroundColor: col.bg }}
                      title={item.name}
                      onClick={() => !alreadyIn && addTaggedToCsv(item)}
                    >
                      <img src={item.dataUrl} alt={item.name} className="h-10 w-full object-cover" />
                      <div className="flex-1 px-0.5 text-center" style={{ background: `${col.border}bb` }}>
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
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addAllTaggedToCsv}>
                <Plus className="mr-1 h-3.5 w-3.5" />Add all to CSV queue
              </Button>
            </div>
          )}
        </div>
      )}

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

                  <div className="flex gap-3">
                    <button
                      onClick={() => toggleCsvSelect(item.id)}
                      className={`mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition ${
                        isSel ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"
                      }`}
                    >
                      {isSel && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </button>

                    <img
                      src={item.dataUrl} alt={item.name}
                      className="h-24 w-20 flex-shrink-0 cursor-zoom-in rounded object-cover ring-1 ring-border hover:ring-primary"
                      title="Click to preview"
                      onClick={() => setCsvPreviewUrl(item.dataUrl)}
                    />

                    <div className="flex flex-1 flex-col gap-2 min-w-0">
                      <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>

                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={item.year}
                          onValueChange={(v) =>
                            setCsvItems((p) => p.map((it) => it.id === item.id ? { ...it, year: v } : it))}>
                          <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Select value={item.month}
                          onValueChange={(v) =>
                            setCsvItems((p) => p.map((it) => it.id === item.id ? { ...it, month: v } : it))}>
                          <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">p.</span>
                          <input type="number" min={1} max={99} value={item.part}
                            onChange={(e) =>
                              setCsvItems((p) => p.map((it) =>
                                it.id === item.id
                                  ? { ...it, part: String(Math.max(1, Math.min(99, Number(e.target.value) || 1))) }
                                  : it))}
                            className="h-7 w-14 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      </div>

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
  );
}
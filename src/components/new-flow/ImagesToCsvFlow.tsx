import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, X, FileArchive, Loader2, TableProperties } from "lucide-react";
import { CsvTable } from "@/components/new-flow/CsvTable";
import { extractTableFromImage, parseYearMonthFromFilename, type TableResult } from "@/lib/new-flow/csv-extract";
import { appendAILog } from "@/lib/new-flow/logging";
import { extractImagesFromArchive, extractDateWithAI, RECEIPT_PROMPT } from "@/lib/receipt-utils";

// ── helpers ──────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => String(CURRENT_YEAR - i));
const MONTHS = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const DATE_CACHE_KEY = "receiptforge-new-date-cache-v1";
const TABLE_CACHE_KEY = "receiptforge-new-table-cache-v1";
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
  try { return JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveDateCache(c: Record<string, { year: string; month: string }>) {
  try { localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
function loadTableCache(): Record<string, TableResult> {
  try { return JSON.parse(localStorage.getItem(TABLE_CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveTableCache(c: Record<string, TableResult>) {
  try { localStorage.setItem(TABLE_CACHE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
function fileCacheKey(f: File) { return `${f.name}::${f.size}`; }

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(file);
  });
}

// ── types ─────────────────────────────────────────────────────────────────────

type ImgItem = {
  id: string;
  file: File;
  dataUrl: string;
  name: string;
  year: string;
  month: string;
  aiState: "idle" | "loading" | "done" | "error";
  aiError?: string;
  extraction: TableResult | null;
  editedRows: string[][] | null;
  extractState: "idle" | "loading" | "done" | "error";
  extractError?: string;
};

// ── component ─────────────────────────────────────────────────────────────────

export function ImagesToCsvFlow() {
  const [items, setItems] = useState<ImgItem[]>([]);
  const [columnsHint, setColumnsHint] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = () => Math.random().toString(36).slice(2, 9);

  const loadArchive = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip") && file.type !== "application/zip") {
      toast.error("Please drop a ZIP archive.");
      return;
    }
    setLoading(true);
    try {
      const images = await extractImagesFromArchive(file);
      if (!images.length) { toast.error("No images found in archive."); setLoading(false); return; }
      const dateCache = loadDateCache();
      const tableCache = loadTableCache();
      const newItems: ImgItem[] = await Promise.all(
        images.map(async (f) => {
          const dataUrl = await fileToDataUrl(f);
          const ck = fileCacheKey(f);
          const cachedDate = dateCache[ck];
          const cachedTable = tableCache[ck] ?? null;
          const fromFilename = parseYearMonthFromFilename(f.name);
          return {
            id: uid(),
            file: f,
            dataUrl,
            name: f.name,
            year: cachedDate?.year ?? fromFilename.year ?? String(CURRENT_YEAR),
            month: cachedDate?.month ?? fromFilename.month ?? "01",
            aiState: (cachedDate ? "done" : "idle") as ImgItem["aiState"],
            extraction: cachedTable,
            editedRows: cachedTable ? [...cachedTable.rows.map((r) => [...r])] : null,
            extractState: (cachedTable ? "done" : "idle") as ImgItem["extractState"],
          };
        }),
      );
      setItems((prev) => [...prev, ...newItems]);
      toast.success(`Loaded ${newItems.length} image${newItems.length !== 1 ? "s" : ""}.`);
    } catch (e: any) {
      toast.error(`Failed to load archive: ${e?.message ?? e}`);
    }
    setLoading(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = Array.from(e.dataTransfer.files)[0];
      if (file) loadArchive(file);
    },
    [loadArchive],
  );

  const updateTag = (id: string, field: "year" | "month", val: string) =>
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, [field]: val } : it));

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((it) => it.id !== id));

  const setEditedRows = (id: string, rows: string[][]) =>
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, editedRows: rows } : it));

  const runAI = useCallback(async (id: string) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    const keys = readORKeys();
    if (!keys.length) { toast.error("Add an OpenRouter API key in the Old tab first."); return; }
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, aiState: "loading" } : it));
    try {
      const result = await extractDateWithAI(keys[0], item.dataUrl, AI_MODEL, { prompt: RECEIPT_PROMPT });
      appendAILog({ ts: Date.now(), filename: item.name, model: AI_MODEL, provider: "openrouter", byteSize: item.file.size, origin: "images-to-csv" });
      const year = result.iso ? result.iso.slice(0, 4) : item.year;
      const month = result.iso ? result.iso.slice(5, 7) : item.month;
      const cache = loadDateCache();
      cache[fileCacheKey(item.file)] = { year, month };
      saveDateCache(cache);
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, year, month, aiState: "done" } : it));
      if (!result.iso) toast.warning(`No date found in ${item.name}`);
    } catch (e: any) {
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, aiState: "error", aiError: e?.message ?? "AI error" } : it));
      toast.error(`AI date failed for ${item.name}: ${e?.message ?? e}`);
    }
  }, [items]);

  const runBatchAI = useCallback(async () => {
    const untagged = items.filter((it) => it.aiState === "idle");
    if (!untagged.length) { toast.info("All images already have dates."); return; }
    for (const item of untagged) await runAI(item.id);
  }, [items, runAI]);

  const runExtract = useCallback(async (id: string) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, extractState: "loading" } : it));
    try {
      const result = await extractTableFromImage(item.dataUrl, columnsHint);
      appendAILog({ ts: Date.now(), filename: item.name, model: AI_MODEL, provider: "openrouter", byteSize: item.file.size, origin: "images-to-csv" });
      const tableCache = loadTableCache();
      tableCache[fileCacheKey(item.file)] = result;
      saveTableCache(tableCache);
      setItems((prev) => prev.map((it) =>
        it.id === id
          ? { ...it, extraction: result, editedRows: result.rows.map((r) => [...r]), extractState: "done" }
          : it,
      ));
    } catch (e: any) {
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, extractState: "error", extractError: e?.message ?? "Extract error" } : it));
      toast.error(`Extract failed for ${item.name}: ${e?.message ?? e}`);
    }
  }, [items, columnsHint]);

  const runBatchExtract = useCallback(async () => {
    const pending = items.filter((it) => it.extractState === "idle" || it.extractState === "error");
    if (!pending.length) { toast.info("All images already extracted."); return; }
    for (const item of pending) await runExtract(item.id);
  }, [items, runExtract]);

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
        <span>Drop a ZIP archive of images here, or click to browse</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadArchive(f); }}
        />
      </div>

      {/* Shared columns hint */}
      {items.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Shared columns hint (optional)</Label>
          <Textarea
            placeholder="e.g. Date, Description, Amount, VAT"
            value={columnsHint}
            onChange={(e) => setColumnsHint(e.target.value)}
            className="h-20 text-sm"
          />
          <p className="text-xs text-muted-foreground">Passed to every extraction prompt as column guidance.</p>
        </div>
      )}

      {/* Image list */}
      {items.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{items.length} image{items.length !== 1 ? "s" : ""}</span>
            <Button size="sm" variant="outline" onClick={runBatchAI}>
              <Sparkles className="mr-1 h-3.5 w-3.5" />Analyse all (AI date)
            </Button>
            <Button size="sm" variant="outline" onClick={runBatchExtract}>
              <TableProperties className="mr-1 h-3.5 w-3.5" />Extract all tables
            </Button>
          </div>

          <div className="space-y-4">
            {items.map((item) => {
              const displayRows = item.editedRows ?? item.extraction?.rows ?? [];
              const columns = item.extraction?.columns ?? [];
              return (
                <div key={item.id} className="rounded-lg border border-border p-3 space-y-3">
                  <div className="flex gap-3">
                    {/* Thumbnail */}
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="h-24 w-20 flex-shrink-0 rounded object-cover"
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
                        {/* AI date */}
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
                        {/* Extract table */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => runExtract(item.id)}
                          disabled={item.extractState === "loading"}
                        >
                          {item.extractState === "loading"
                            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            : <TableProperties className="mr-1 h-3 w-3" />}
                          Extract table
                        </Button>
                        {(item.aiState === "error" || item.extractState === "error") && (
                          <span className="text-xs text-destructive">⚠ error</span>
                        )}
                        {/* Remove */}
                        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => removeItem(item.id)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Editable table */}
                  {columns.length > 0 && (
                    <CsvTable
                      filename={item.name}
                      columns={columns}
                      rows={displayRows}
                      onRowsChange={(rows) => setEditedRows(item.id, rows)}
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

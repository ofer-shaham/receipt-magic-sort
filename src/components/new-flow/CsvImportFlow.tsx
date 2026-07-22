/**
 * CsvImportFlow — "CSV Import/Export" tab at /new/csv-export.
 *
 * • Drop .csv / .zip — parsed in-browser, no upload.
 * • Multi-keyword filter (OR union) with per-keyword colour highlighting.
 * • Expose X/Y context rows around matches — global + per-table override.
 * • Column-schema validation banner.
 * • "Generate report" → stores merged table in AppStore → navigates to /new/report.
 * • Per-file and bulk null-row stripping; bulk ZIP export.
 */
import { useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  FileSpreadsheet, FileArchive,
  ArrowUp, ArrowDown,
  Download, Trash2, X, Loader2, Filter, Eraser,
  AlertTriangle, TableProperties, SlidersHorizontal, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import {
  useAppStore, type StoreImportedCsv, type StoreReportRow,
} from "@/contexts/AppStore";

// ── Keyword chip colours ──────────────────────────────────────────────────────

const KW_COLORS = [
  { bg: "bg-yellow-100 dark:bg-yellow-800/60", text: "text-yellow-800 dark:text-yellow-200", mark: "bg-yellow-200 text-yellow-900 dark:bg-yellow-700 dark:text-yellow-100" },
  { bg: "bg-blue-100 dark:bg-blue-800/60",    text: "text-blue-800 dark:text-blue-200",    mark: "bg-blue-200 text-blue-900 dark:bg-blue-700 dark:text-blue-100" },
  { bg: "bg-green-100 dark:bg-green-800/60",  text: "text-green-800 dark:text-green-200",  mark: "bg-green-200 text-green-900 dark:bg-green-700 dark:text-green-100" },
  { bg: "bg-rose-100 dark:bg-rose-800/60",    text: "text-rose-800 dark:text-rose-200",    mark: "bg-rose-200 text-rose-900 dark:bg-rose-700 dark:text-rose-100" },
  { bg: "bg-purple-100 dark:bg-purple-800/60",text: "text-purple-800 dark:text-purple-200",mark: "bg-purple-200 text-purple-900 dark:bg-purple-700 dark:text-purple-100" },
  { bg: "bg-orange-100 dark:bg-orange-800/60",text: "text-orange-800 dark:text-orange-200",mark: "bg-orange-200 text-orange-900 dark:bg-orange-700 dark:text-orange-100" },
];
const kwColor = (i: number) => KW_COLORS[i % KW_COLORS.length];

// ── Types ─────────────────────────────────────────────────────────────────────

type ExposeOverride = { before: number; after: number };

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCsvText(raw: string): { columns: string[]; rows: string[][] } {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let i = 0, n = text.length;
  while (i < n) {
    const record: string[] = [];
    while (i < n && text[i] !== "\n") {
      if (text[i] === '"') {
        let f = ""; i++;
        while (i < n) {
          if (text[i] === '"') { if (text[i+1] === '"') { f += '"'; i += 2; } else { i++; break; } }
          else f += text[i++];
        }
        record.push(f);
        if (i < n && text[i] === ",") i++;
      } else {
        let f = "";
        while (i < n && text[i] !== "," && text[i] !== "\n") f += text[i++];
        record.push(f);
        if (i < n && text[i] === ",") i++;
      }
    }
    if (i < n && text[i] === "\n") i++;
    if (record.length === 1 && record[0] === "") continue;
    if (record.length > 0) records.push(record);
  }
  if (!records.length) return { columns: [], rows: [] };
  return { columns: records[0], rows: records.slice(1) };
}

// ── Tag parser ────────────────────────────────────────────────────────────────

const CURR_YEAR = String(new Date().getFullYear());
function parseTagFromFilename(name: string) {
  const m1 = name.match(/y(\d{4})_m(\d{2})__p(\d+)/i);
  if (m1) return { year: m1[1], month: m1[2], part: m1[3] };
  const m2 = name.match(/y(\d{4})_m(\d{2})/i);
  if (m2) return { year: m2[1], month: m2[2], part: "1" };
  const m3 = name.match(/(\d{4})[-_](\d{2})/);
  if (m3) return { year: m3[1], month: m3[2].padStart(2, "0"), part: "1" };
  const m4 = name.match(/(\d{2})[-_](\d{4})/);
  if (m4) return { year: m4[2], month: m4[1].padStart(2, "0"), part: "1" };
  return { year: CURR_YEAR, month: "01", part: "1" };
}

function tagKey(tag: StoreImportedCsv["tag"]) {
  return parseInt(tag.year,10)*10000 + parseInt(tag.month,10)*100 + parseInt(tag.part,10);
}

// ── CSV serialiser ────────────────────────────────────────────────────────────

function isNullCell(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" || t === "null" || t === "n/a" || t === "undefined" || t === "-";
}

function stripNullRows(rows: string[][]): string[][] {
  return rows.filter((row) => !row.every((v) => isNullCell(v)));
}

/**
 * Serialise to CSV. cleanNullCells=true (default) replaces null-like cells with "".
 */
function serializeCsv(columns: string[], rows: string[][], cleanNullCells = true): string {
  const esc = (v: string | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (cleanNullCells && isNullCell(s)) s = "";
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

// ── Filter + expose helpers ───────────────────────────────────────────────────

/**
 * Returns the indices of rows in `item` whose value in `col` matches ANY of
 * the keywords (case-insensitive substring, OR union).
 * If col or keywords are empty, returns all indices.
 */
function getMatchingIndices(
  item: StoreImportedCsv,
  col: string,
  keywords: string[],
): number[] {
  const colTrim = col.trim();
  const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!colTrim || !kws.length) return item.rows.map((_, i) => i);
  const colIdx = item.columns.findIndex((c) => c.toLowerCase() === colTrim.toLowerCase());
  if (colIdx === -1) return [];
  const result = new Set<number>();
  item.rows.forEach((row, i) => {
    const cell = (row[colIdx] ?? "").toLowerCase();
    if (kws.some((kw) => cell.includes(kw))) result.add(i);
  });
  return [...result].sort((a, b) => a - b);
}

/** Returns which keyword (index) matches this cell value, or -1. */
function matchingKeywordIndex(val: string, keywords: string[]): number {
  const lower = val.toLowerCase();
  for (let i = 0; i < keywords.length; i++) {
    if (keywords[i].trim() && lower.includes(keywords[i].trim().toLowerCase())) return i;
  }
  return -1;
}

function expandWithContext(
  matchIndices: number[], totalRows: number, before: number, after: number,
): { index: number; isMatch: boolean }[] {
  if (!matchIndices.length) return [];
  const matchSet = new Set(matchIndices);
  const included = new Set<number>();
  for (const idx of matchIndices) {
    for (let j = Math.max(0, idx-before); j <= Math.min(totalRows-1, idx+after); j++) included.add(j);
  }
  return [...included].sort((a,b)=>a-b).map((index) => ({ index, isMatch: matchSet.has(index) }));
}

function getDisplayRows(
  item: StoreImportedCsv, col: string, keywords: string[],
  before: number, after: number, filterActive: boolean,
): { row: string[]; isMatch: boolean }[] {
  if (!filterActive) return item.rows.map((row) => ({ row, isMatch: false }));
  const matchIdx = getMatchingIndices(item, col, keywords);
  const expanded = expandWithContext(matchIdx, item.rows.length, before, after);
  return expanded.map(({ index, isMatch }) => ({ row: item.rows[index], isMatch }));
}

// ── Schema validation ─────────────────────────────────────────────────────────

type SchemaMismatch = { name: string; columns: string[] };
function validateSchemas(files: StoreImportedCsv[]): SchemaMismatch[] {
  if (files.length < 2) return [];
  const ref = files[0].columns.join("\0");
  return files.filter((f) => f.columns.join("\0") !== ref).map((f) => ({ name: f.name, columns: f.columns }));
}

// ── Misc ──────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);

// ── Expose control ────────────────────────────────────────────────────────────

function ExposeControl({ before, after, onBefore, onAfter, compact = false }: {
  before: number; after: number;
  onBefore: (v: number) => void; onAfter: (v: number) => void;
  compact?: boolean;
}) {
  const cls = compact
    ? "h-6 w-14 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
    : "h-7 w-16 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <SlidersHorizontal className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      <span>Expose</span>
      <input type="number" min={0} max={50} value={before} className={cls} title="Rows before each match"
        onChange={(e) => onBefore(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />
      <span>before</span>
      <input type="number" min={0} max={50} value={after} className={cls} title="Rows after each match"
        onChange={(e) => onAfter(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />
      <span>after</span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CsvImportFlow() {
  const {
    importedCsvFiles, setImportedCsvFiles,
    setReportRows, setReportColumns,
  } = useAppStore();

  const navigate = useNavigate();

  const [sortDir,      setSortDir]      = useState<"asc"|"desc">("asc");
  const [loading,      setLoading]      = useState(false);
  const [zipExporting, setZipExporting] = useState(false);
  const [openItems,    setOpenItems]    = useState<string[]>([]);

  // ── multi-keyword filter ───────────────────────────────────────────────────
  const [filterColumn,   setFilterColumn]   = useState("");
  const [filterKeywords, setFilterKeywords] = useState<string[]>([]);   // committed chips
  const [keywordInput,   setKeywordInput]   = useState("");             // input in progress

  // ── expose ────────────────────────────────────────────────────────────────
  const [globalBefore,    setGlobalBefore]    = useState(0);
  const [globalAfter,     setGlobalAfter]     = useState(0);
  const [exposeOverrides, setExposeOverrides] = useState<Record<string, ExposeOverride>>({});

  const inputRef = useRef<HTMLInputElement>(null);

  // ── derived ───────────────────────────────────────────────────────────────

  const sorted = [...importedCsvFiles].sort((a, b) => {
    const d = tagKey(a.tag) - tagKey(b.tag);
    return sortDir === "asc" ? d : -d;
  });

  const isFilterActive = filterColumn.trim() !== "" && filterKeywords.length > 0;

  const schemaMismatches = useMemo(() => validateSchemas(importedCsvFiles), [importedCsvFiles]);

  // ── expose helpers ────────────────────────────────────────────────────────

  const getItemExpose = (id: string) =>
    exposeOverrides[id] ?? { before: globalBefore, after: globalAfter };

  const setItemExpose = (id: string, val: Partial<ExposeOverride>) =>
    setExposeOverrides((prev) => ({ ...prev, [id]: { ...getItemExpose(id), ...val } }));

  const clearItemExposeOverride = (id: string) =>
    setExposeOverrides((prev) => { const n = { ...prev }; delete n[id]; return n; });

  // ── keyword helpers ───────────────────────────────────────────────────────

  const autoExpandMatches = useCallback(
    (col: string, kws: string[], items: StoreImportedCsv[]) => {
      if (!col.trim() || !kws.length) return;
      const ids = items.filter((it) => getMatchingIndices(it, col, kws).length > 0).map((it) => it.id);
      if (ids.length) setOpenItems((prev) => [...new Set([...prev, ...ids])]);
    },
    [],
  );

  const commitKeyword = useCallback((raw: string) => {
    const kw = raw.trim();
    if (!kw || filterKeywords.includes(kw)) { setKeywordInput(""); return; }
    const next = [...filterKeywords, kw];
    setFilterKeywords(next);
    setKeywordInput("");
    autoExpandMatches(filterColumn, next, sorted);
  }, [filterKeywords, filterColumn, sorted, autoExpandMatches]);

  const removeKeyword = (kw: string) => {
    const next = filterKeywords.filter((k) => k !== kw);
    setFilterKeywords(next);
  };

  const onKeywordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitKeyword(keywordInput); }
    if (e.key === "Backspace" && !keywordInput && filterKeywords.length) {
      removeKeyword(filterKeywords[filterKeywords.length - 1]);
    }
  };

  const onFilterColumnChange = (val: string) => {
    setFilterColumn(val);
    autoExpandMatches(val, filterKeywords, sorted);
  };

  const clearFilter = () => { setFilterColumn(""); setFilterKeywords([]); setKeywordInput(""); };

  // ── filter summary ────────────────────────────────────────────────────────

  const filterStats = isFilterActive
    ? sorted.reduce((acc, item) => {
        const { before, after } = getItemExpose(item.id);
        const disp = getDisplayRows(item, filterColumn, filterKeywords, before, after, true);
        const m = disp.filter((r) => r.isMatch).length;
        return { total: acc.total + m, exposed: acc.exposed + disp.filter((r) => !r.isMatch).length, files: acc.files + (m>0?1:0) };
      }, { total: 0, exposed: 0, files: 0 })
    : null;

  // ── file ingestion ────────────────────────────────────────────────────────

  const addFiles = useCallback(async (rawFiles: File[]) => {
    setLoading(true);
    const newItems: StoreImportedCsv[] = [];
    for (const file of rawFiles) {
      const lname = file.name.toLowerCase();
      if (lname.endsWith(".csv")) {
        try {
          const { columns, rows } = parseCsvText(await file.text());
          newItems.push({ id: uid(), name: file.name, tag: parseTagFromFilename(file.name), columns, rows });
        } catch (e: any) { toast.error(`Could not parse ${file.name}: ${e?.message ?? e}`); }
      } else if (lname.endsWith(".zip") || file.type.includes("zip")) {
        try {
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(file);
          const entries = Object.entries(zip.files).filter(([n, e]) => !e.dir && n.toLowerCase().endsWith(".csv"));
          for (const [entryName, entry] of entries) {
            try {
              const { columns, rows } = parseCsvText(await entry.async("text"));
              const baseName = entryName.split("/").pop() ?? entryName;
              newItems.push({ id: uid(), name: baseName, tag: parseTagFromFilename(baseName), columns, rows });
            } catch (e: any) { toast.error(`Could not parse ${entryName}: ${e?.message ?? e}`); }
          }
        } catch (e: any) { toast.error(`Could not read ${file.name}: ${e?.message ?? e}`); }
      }
    }
    if (newItems.length) {
      setImportedCsvFiles((prev) => [...prev, ...newItems]);
      toast.success(`Loaded ${newItems.length} CSV file${newItems.length !== 1 ? "s" : ""}.`);
      if (filterColumn.trim() && filterKeywords.length) autoExpandMatches(filterColumn, filterKeywords, newItems);
    } else if (rawFiles.length > 0) {
      toast.warning("No CSV files found in the dropped files.");
    }
    setLoading(false);
  }, [setImportedCsvFiles, filterColumn, filterKeywords, autoExpandMatches]);

  const onDrop = useCallback(
    (e: React.DragEvent) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); },
    [addFiles],
  );

  // ── per-item download ─────────────────────────────────────────────────────

  const downloadItem = (item: StoreImportedCsv) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([serializeCsv(item.columns, item.rows)], { type: "text/csv" }));
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
  };

  // ── export all ZIP ────────────────────────────────────────────────────────

  const exportAllZip = useCallback(async () => {
    if (!importedCsvFiles.length) return;
    setZipExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let stripped = 0;
      for (const item of importedCsvFiles) {
        const clean = stripNullRows(item.rows);
        stripped += item.rows.length - clean.length;
        zip.file(item.name, serializeCsv(item.columns, clean));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `csv-import-${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
      toast.success(`Exported ${importedCsvFiles.length} file${importedCsvFiles.length !== 1 ? "s" : ""}` +
        (stripped > 0 ? ` · ${stripped} null row${stripped !== 1 ? "s" : ""} removed` : ""));
    } catch (e: any) { toast.error(`Export failed: ${e?.message ?? e}`); }
    setZipExporting(false);
  }, [importedCsvFiles]);

  // ── strip null rows ───────────────────────────────────────────────────────

  const stripNullRowsForItem = (id: string) => {
    setImportedCsvFiles((prev) => prev.map((it) => {
      if (it.id !== id) return it;
      const clean = stripNullRows(it.rows);
      const removed = it.rows.length - clean.length;
      toast.success(removed > 0 ? `Stripped ${removed} null row${removed !== 1 ? "s" : ""} from ${it.name}` : `No null rows in ${it.name}`);
      return { ...it, rows: clean };
    }));
  };

  const stripAllNullRows = () => {
    let total = 0;
    setImportedCsvFiles((prev) => prev.map((it) => {
      const clean = stripNullRows(it.rows);
      total += it.rows.length - clean.length;
      return { ...it, rows: clean };
    }));
    setTimeout(() => toast.success(total > 0 ? `Stripped ${total} null row${total !== 1 ? "s" : ""} across all files` : "No null rows found"), 0);
  };

  // ── remove item ───────────────────────────────────────────────────────────

  const removeItem = (id: string) => {
    setImportedCsvFiles((prev) => prev.filter((it) => it.id !== id));
    setOpenItems((prev) => prev.filter((x) => x !== id));
    clearItemExposeOverride(id);
  };

  // ── generate report → /new/report ─────────────────────────────────────────

  const generateReport = useCallback(() => {
    // Build column list: reference file order + any extras
    const refCols = importedCsvFiles[0]?.columns ?? [];
    const extra = [...new Set(importedCsvFiles.flatMap((f) => f.columns))].filter((c) => !refCols.includes(c));
    const dataCols = [...refCols, ...extra];

    const rows: StoreReportRow[] = [];
    for (const item of sorted) {
      const { before, after } = getItemExpose(item.id);
      const displayed = getDisplayRows(item, filterColumn, filterKeywords, before, after, isFilterActive);
      for (const { row, isMatch } of displayed) {
        const cells = dataCols.map((col) => {
          const ci = item.columns.indexOf(col);
          return ci >= 0 ? (row[ci] ?? "") : "";
        });
        rows.push({ id: uid(), filename: item.name, cells, isContext: !isMatch, notes: "" });
      }
    }

    setReportColumns(dataCols);
    setReportRows(rows);

    const matchCount = rows.filter((r) => !r.isContext).length;
    const ctxCount   = rows.filter((r) => r.isContext).length;
    toast.success(
      `Report: ${matchCount} match${matchCount !== 1 ? "es" : ""}` +
      (ctxCount > 0 ? ` + ${ctxCount} context` : "") +
      ` from ${importedCsvFiles.length} file${importedCsvFiles.length !== 1 ? "s" : ""}`,
    );
    navigate({ to: "/new/report" });
  }, [sorted, filterColumn, filterKeywords, isFilterActive, importedCsvFiles,
      exposeOverrides, globalBefore, globalAfter, setReportColumns, setReportRows, navigate]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 p-4">

      {/* Drop zone */}
      <div
        onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-8 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        <div className="flex items-center gap-3 opacity-60">
          <FileSpreadsheet className="h-6 w-6" />
          <FileArchive className="h-6 w-6" />
        </div>
        <p className="text-center text-xs">
          Drop <strong>.csv</strong> files or <strong>.zip</strong> archives — or click to browse
        </p>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        <input ref={inputRef} type="file" multiple className="hidden"
          accept=".csv,.zip,application/zip,application/x-zip-compressed"
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))} />
      </div>

      {importedCsvFiles.length > 0 && (
        <>
          {/* Schema mismatch warning */}
          {schemaMismatches.length > 0 && (
            <div className="rounded-lg border border-yellow-400/60 bg-yellow-50/60 px-3 py-2.5 dark:border-yellow-600/40 dark:bg-yellow-900/20">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-yellow-800 dark:text-yellow-300">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                Column schema mismatch — {schemaMismatches.length} file{schemaMismatches.length !== 1 ? "s" : ""} differ from the first file
              </div>
              <ul className="space-y-0.5 pl-5">
                {schemaMismatches.map((m) => (
                  <li key={m.name} className="text-xs text-yellow-700 dark:text-yellow-400">
                    <span className="font-medium">{m.name}</span>{" — "}
                    <span className="font-mono">[{m.columns.join(", ")}]</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-yellow-600 dark:text-yellow-500">
                Expected: <span className="font-mono">[{importedCsvFiles[0].columns.join(", ")}]</span>
              </p>
            </div>
          )}

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {importedCsvFiles.length} file{importedCsvFiles.length !== 1 ? "s" : ""}
            </span>
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"
              onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}>
              {sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {sortDir === "asc" ? "Oldest first" : "Newest first"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={stripAllNullRows}>
              <Eraser className="mr-1 h-3.5 w-3.5" />Strip null rows
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={exportAllZip} disabled={zipExporting}>
              {zipExporting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
              Export all ZIP
            </Button>
            <div className="ml-auto flex items-center">
              <ExposeControl before={globalBefore} after={globalAfter} onBefore={setGlobalBefore} onAfter={setGlobalAfter} />
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive"
              onClick={() => { setImportedCsvFiles([]); setOpenItems([]); clearFilter(); }}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />Clear all
            </Button>
          </div>

          {/* Filter bar */}
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />

              {/* Column input */}
              <input
                placeholder="Column name"
                value={filterColumn}
                onChange={(e) => onFilterColumnChange(e.target.value)}
                className="h-7 w-36 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />

              {/* Keyword chips + input */}
              <div className="flex flex-1 flex-wrap items-center gap-1 rounded border border-input bg-background px-2 py-0.5 min-w-48">
                {filterKeywords.map((kw, i) => {
                  const c = kwColor(i);
                  return (
                    <span key={kw} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
                      {kw}
                      <button onClick={() => removeKeyword(kw)} className="opacity-60 hover:opacity-100">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  );
                })}
                <input
                  placeholder={filterKeywords.length ? "Add keyword…" : "Keyword (Enter to add)"}
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={onKeywordKeyDown}
                  onBlur={() => { if (keywordInput.trim()) commitKeyword(keywordInput); }}
                  className="h-6 flex-1 min-w-24 bg-transparent text-xs focus:outline-none"
                />
                {keywordInput.trim() && (
                  <button onClick={() => commitKeyword(keywordInput)}
                    className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary hover:bg-primary/20">
                    <Plus className="h-3 w-3" />
                  </button>
                )}
              </div>

              {isFilterActive && (
                <>
                  <span className="text-xs text-muted-foreground">
                    {filterStats!.total} match{filterStats!.total !== 1 ? "es" : ""}
                    {filterStats!.exposed > 0 && ` + ${filterStats!.exposed} ctx`}
                    {" · "}{filterStats!.files} file{filterStats!.files !== 1 ? "s" : ""}
                  </span>
                  <button onClick={clearFilter}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />Clear
                  </button>
                </>
              )}

              {/* Generate report — always visible when files are loaded */}
              <Button size="sm" variant={isFilterActive ? "secondary" : "outline"} className="h-7 gap-1 text-xs"
                onClick={generateReport}>
                <TableProperties className="h-3.5 w-3.5" />Generate report
              </Button>
            </div>
          </div>

          {/* Accordion list */}
          <Accordion type="multiple" value={openItems} onValueChange={setOpenItems} className="space-y-2">
            {sorted.map((item) => {
              const { before, after } = getItemExpose(item.id);
              const hasOverride = !!exposeOverrides[item.id];
              const displayed   = getDisplayRows(item, filterColumn, filterKeywords, before, after, isFilterActive);
              const matchCount  = displayed.filter((r) => r.isMatch).length;
              const hasMatches  = !isFilterActive || matchCount > 0;
              const colIdx      = item.columns.findIndex((c) => c.toLowerCase() === filterColumn.trim().toLowerCase());

              return (
                <AccordionItem key={item.id} value={item.id}
                  className={`overflow-hidden rounded-lg border px-3 transition-opacity ${isFilterActive && !hasMatches ? "border-border opacity-40" : "border-border"}`}>
                  <AccordionTrigger className="py-2.5 hover:no-underline [&>svg]:flex-shrink-0">
                    <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                      <FileSpreadsheet className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium" title={item.name}>{item.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 font-mono text-[11px] tracking-tight">
                        {item.tag.year}:{item.tag.month}:p{item.tag.part}
                      </Badge>
                      <span className={`flex-shrink-0 text-xs ${isFilterActive ? (hasMatches ? "font-semibold text-primary" : "text-muted-foreground") : "text-muted-foreground"}`}>
                        {isFilterActive
                          ? `${matchCount} match${matchCount !== 1 ? "es" : ""}` + (displayed.length > matchCount ? ` + ${displayed.length - matchCount} ctx` : "")
                          : `${item.rows.length} row${item.rows.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="pb-3">
                    {/* Per-item actions */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => downloadItem(item)}>
                        <Download className="mr-1 h-3 w-3" />Download
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => stripNullRowsForItem(item.id)}>
                        <Eraser className="mr-1 h-3 w-3" />Strip null rows
                      </Button>
                      <div className="flex items-center gap-1">
                        <ExposeControl before={before} after={after} compact
                          onBefore={(v) => setItemExpose(item.id, { before: v })}
                          onAfter={(v) => setItemExpose(item.id, { after: v })} />
                        {hasOverride && (
                          <button onClick={() => clearItemExposeOverride(item.id)}
                            className="ml-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                            reset
                          </button>
                        )}
                      </div>
                      <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 text-muted-foreground"
                        title="Remove" onClick={() => removeItem(item.id)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {/* Table */}
                    {item.columns.length > 0 ? (
                      displayed.length > 0 ? (
                        <div className="overflow-x-auto rounded border border-border">
                          <table className="min-w-full text-xs">
                            <thead className="bg-muted">
                              <tr>
                                {item.columns.map((col, ci) => (
                                  <th key={ci}
                                    className={`whitespace-nowrap px-2 py-1.5 text-left font-semibold ${isFilterActive && ci === colIdx ? "bg-primary/10 text-primary" : ""}`}>
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {displayed.map(({ row, isMatch }, ri) => (
                                <tr key={ri}
                                  className={`border-t border-border ${isFilterActive && !isMatch ? "opacity-50" : ri % 2 === 1 ? "bg-muted/30" : ""}`}>
                                  {item.columns.map((col, ci) => {
                                    const val = row[ci] ?? "";
                                    const kwIdx = isMatch && isFilterActive && ci === colIdx
                                      ? matchingKeywordIndex(val, filterKeywords) : -1;
                                    return (
                                      <td key={ci} className={`whitespace-nowrap px-2 py-1 ${kwIdx >= 0 ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                                        {kwIdx >= 0 ? <MultiHighlight text={val} keywords={filterKeywords} /> : val}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No rows match this filter.</p>
                      )
                    ) : (
                      <p className="text-xs text-muted-foreground">Empty or unreadable CSV.</p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </>
      )}
    </div>
  );
}

// ── Multi-keyword highlight ───────────────────────────────────────────────────

function MultiHighlight({ text, keywords }: { text: string; keywords: string[] }) {
  if (!keywords.length) return <>{text}</>;

  // Build a list of [start, end, kwIndex] spans
  const spans: { start: number; end: number; kwIdx: number }[] = [];
  keywords.forEach((kw, kwIdx) => {
    if (!kw.trim()) return;
    const lower = text.toLowerCase();
    const needle = kw.trim().toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = lower.indexOf(needle, pos);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + needle.length, kwIdx });
      pos = idx + needle.length;
    }
  });

  if (!spans.length) return <>{text}</>;

  // Sort and merge overlapping spans (first keyword wins)
  spans.sort((a, b) => a.start - b.start || a.kwIdx - b.kwIdx);
  const merged: { start: number; end: number; kwIdx: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; }
    else merged.push({ ...s });
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, kwIdx } of merged) {
    if (cursor < start) parts.push(text.slice(cursor, start));
    const c = kwColor(kwIdx);
    parts.push(
      <mark key={start} className={`rounded px-0.5 ${c.mark}`}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

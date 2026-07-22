/**
 * CsvImportFlow — "CSV Import/Export" tab at /new/csv-export.
 *
 * Features:
 * • Drop .csv / .zip archives; parse in-browser (no upload).
 * • Infers year:month:part tag from filename.
 * • Accordion list sorted by tag; auto-expands matches.
 * • Filter by column + keyword with matched-row highlighting.
 * • Expose X rows before / Y rows after each match (global + per-table override).
 * • Column-schema validation across files (shows warning when schemas differ).
 * • Generate report: merged table (filename | ...cols | notes) from all
 *   filtered+exposed rows; notes column is editable; export as CSV.
 * • Per-file and bulk null-row stripping; bulk ZIP export.
 */
import { useState, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import {
  FileSpreadsheet, FileArchive,
  ArrowUp, ArrowDown,
  Download, Trash2, X, Loader2, Filter, Eraser,
  AlertTriangle, ChevronDown, ChevronUp, TableProperties,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAppStore, type StoreImportedCsv } from "@/contexts/AppStore";
import { toCsv } from "@/lib/new-flow/csv-extract";
import { timestamp } from "@/lib/receipt-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type ReportRow = {
  id: string;
  filename: string;
  cells: string[];
  isContext: boolean; // true = context/expose row, false = direct match
  notes: string;
};

type ExposeOverride = { before: number; after: number };

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCsvText(raw: string): { columns: string[]; rows: string[][] } {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const record: string[] = [];
    while (i < n && text[i] !== "\n") {
      if (text[i] === '"') {
        let field = "";
        i++;
        while (i < n) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i++]; }
        }
        record.push(field);
        if (i < n && text[i] === ",") i++;
      } else {
        let field = "";
        while (i < n && text[i] !== "," && text[i] !== "\n") field += text[i++];
        record.push(field);
        if (i < n && text[i] === ",") i++;
      }
    }
    if (i < n && text[i] === "\n") i++;
    if (record.length === 1 && record[0] === "") continue;
    if (record.length > 0) records.push(record);
  }

  if (records.length === 0) return { columns: [], rows: [] };
  return { columns: records[0], rows: records.slice(1) };
}

// ── Tag parser ────────────────────────────────────────────────────────────────

const CURR_YEAR = String(new Date().getFullYear());

function parseTagFromFilename(name: string): { year: string; month: string; part: string } {
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

// ── Sort key ──────────────────────────────────────────────────────────────────

function tagKey(tag: StoreImportedCsv["tag"]): number {
  return parseInt(tag.year, 10) * 10000
       + parseInt(tag.month, 10) * 100
       + parseInt(tag.part,  10);
}

// ── CSV serialiser ────────────────────────────────────────────────────────────

/**
 * Serialise columns + rows to a CSV string.
 * When cleanNullCells is true (default), any cell that is blank, "null",
 * "undefined", "N/A", or "-" is written as an empty field instead.
 */
function serializeCsv(
  columns: string[],
  rows: string[][],
  cleanNullCells = true,
): string {
  const esc = (v: string | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (cleanNullCells && isNullCell(s)) s = "";
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => esc(c)).join(","),
    ...rows.map((r) => r.map(esc).join(",")),
  ].join("\n");
}

// ── Null-value helpers ────────────────────────────────────────────────────────

function isNullCell(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" || t === "null" || t === "n/a" || t === "undefined" || t === "-";
}

function stripNullRows(rows: string[][]): string[][] {
  return rows.filter((row) => !row.every((v) => isNullCell(v)));
}

// ── Filter + expose helpers ───────────────────────────────────────────────────

/** Returns indices of rows that match the filter. */
function getMatchingIndices(item: StoreImportedCsv, col: string, kw: string): number[] {
  const colTrim = col.trim();
  const kwTrim  = kw.trim();
  if (!colTrim || !kwTrim) return item.rows.map((_, i) => i);
  const colIdx = item.columns.findIndex(
    (c) => c.toLowerCase() === colTrim.toLowerCase(),
  );
  if (colIdx === -1) return [];
  const kwLower = kwTrim.toLowerCase();
  return item.rows.reduce<number[]>((acc, row, i) => {
    if ((row[colIdx] ?? "").toLowerCase().includes(kwLower)) acc.push(i);
    return acc;
  }, []);
}

/** Expands matched indices by exposeBefore / exposeAfter, returning sorted unique indices. */
function expandWithContext(
  matchIndices: number[],
  totalRows: number,
  before: number,
  after: number,
): { index: number; isMatch: boolean }[] {
  if (matchIndices.length === 0) return [];
  const matchSet = new Set(matchIndices);
  const included = new Set<number>();
  for (const idx of matchIndices) {
    for (let j = Math.max(0, idx - before); j <= Math.min(totalRows - 1, idx + after); j++) {
      included.add(j);
    }
  }
  return Array.from(included)
    .sort((a, b) => a - b)
    .map((index) => ({ index, isMatch: matchSet.has(index) }));
}

/** Returns rows + isMatch flag for a given item + filter + expose settings. */
function getDisplayRows(
  item: StoreImportedCsv,
  col: string,
  kw: string,
  before: number,
  after: number,
  filterActive: boolean,
): { row: string[]; isMatch: boolean }[] {
  if (!filterActive) return item.rows.map((row) => ({ row, isMatch: false }));
  const matchIdx = getMatchingIndices(item, col, kw);
  const expanded  = expandWithContext(matchIdx, item.rows.length, before, after);
  return expanded.map(({ index, isMatch }) => ({ row: item.rows[index], isMatch }));
}

// ── Column-schema validation ──────────────────────────────────────────────────

type SchemaMismatch = { name: string; columns: string[] };

function validateSchemas(files: StoreImportedCsv[]): SchemaMismatch[] {
  if (files.length < 2) return [];
  const ref = files[0].columns.join("\0");
  return files
    .filter((f) => f.columns.join("\0") !== ref)
    .map((f) => ({ name: f.name, columns: f.columns }));
}

// ── uid ───────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);

// ── Expose control ────────────────────────────────────────────────────────────

function ExposeControl({
  before, after, onBefore, onAfter, compact = false,
}: {
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
      <input
        type="number" min={0} max={50} value={before}
        onChange={(e) => onBefore(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
        className={cls} title="Rows before each match"
      />
      <span>before</span>
      <input
        type="number" min={0} max={50} value={after}
        onChange={(e) => onAfter(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
        className={cls} title="Rows after each match"
      />
      <span>after</span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CsvImportFlow() {
  const { importedCsvFiles, setImportedCsvFiles } = useAppStore();

  const [sortDir,      setSortDir]      = useState<"asc" | "desc">("asc");
  const [loading,      setLoading]      = useState(false);
  const [zipExporting, setZipExporting] = useState(false);

  // ── accordion ─────────────────────────────────────────────────────────────
  const [openItems, setOpenItems] = useState<string[]>([]);

  // ── filter ────────────────────────────────────────────────────────────────
  const [filterColumn,  setFilterColumn]  = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");

  // ── expose (global) ───────────────────────────────────────────────────────
  const [globalBefore, setGlobalBefore] = useState(0);
  const [globalAfter,  setGlobalAfter]  = useState(0);

  // ── expose (per-item override) ────────────────────────────────────────────
  const [exposeOverrides, setExposeOverrides] = useState<Record<string, ExposeOverride>>({});

  // ── report ────────────────────────────────────────────────────────────────
  const [reportRows,    setReportRows]    = useState<ReportRow[]>([]);
  const [reportColumns, setReportColumns] = useState<string[]>([]);
  const [showReport,    setShowReport]    = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // ── derived ───────────────────────────────────────────────────────────────

  const sorted = [...importedCsvFiles].sort((a, b) => {
    const diff = tagKey(a.tag) - tagKey(b.tag);
    return sortDir === "asc" ? diff : -diff;
  });

  const isFilterActive = filterColumn.trim() !== "" && filterKeyword.trim() !== "";

  const schemaMismatches = useMemo(
    () => validateSchemas(importedCsvFiles),
    [importedCsvFiles],
  );

  // ── filter/expose helpers ─────────────────────────────────────────────────

  const getItemExpose = (id: string) =>
    exposeOverrides[id] ?? { before: globalBefore, after: globalAfter };

  const setItemExpose = (id: string, val: Partial<ExposeOverride>) =>
    setExposeOverrides((prev) => ({
      ...prev,
      [id]: { ...getItemExpose(id), ...val },
    }));

  const clearItemExposeOverride = (id: string) =>
    setExposeOverrides((prev) => { const n = { ...prev }; delete n[id]; return n; });

  const autoExpandMatches = useCallback(
    (col: string, kw: string, items: StoreImportedCsv[]) => {
      if (!col.trim() || !kw.trim()) return;
      const matchedIds = items
        .filter((it) => getMatchingIndices(it, col, kw).length > 0)
        .map((it) => it.id);
      if (matchedIds.length) {
        setOpenItems((prev) => [...new Set([...prev, ...matchedIds])]);
      }
    },
    [],
  );

  const onFilterColumnChange = (val: string) => {
    setFilterColumn(val);
    autoExpandMatches(val, filterKeyword, sorted);
  };

  const onFilterKeywordChange = (val: string) => {
    setFilterKeyword(val);
    autoExpandMatches(filterColumn, val, sorted);
  };

  const clearFilter = () => {
    setFilterColumn("");
    setFilterKeyword("");
  };

  // ── filter summary ────────────────────────────────────────────────────────

  const filterStats = isFilterActive
    ? sorted.reduce(
        (acc, item) => {
          const { before, after } = getItemExpose(item.id);
          const displayed = getDisplayRows(item, filterColumn, filterKeyword, before, after, true);
          const matches = displayed.filter((r) => r.isMatch).length;
          return {
            total: acc.total + matches,
            exposed: acc.exposed + displayed.filter((r) => !r.isMatch).length,
            files: acc.files + (matches > 0 ? 1 : 0),
          };
        },
        { total: 0, exposed: 0, files: 0 },
      )
    : null;

  // ── file ingestion ────────────────────────────────────────────────────────

  const addFiles = useCallback(
    async (rawFiles: File[]) => {
      setLoading(true);
      const newItems: StoreImportedCsv[] = [];

      for (const file of rawFiles) {
        const lname = file.name.toLowerCase();

        if (lname.endsWith(".csv")) {
          try {
            const text = await file.text();
            const { columns, rows } = parseCsvText(text);
            newItems.push({ id: uid(), name: file.name, tag: parseTagFromFilename(file.name), columns, rows });
          } catch (e: any) {
            toast.error(`Could not parse ${file.name}: ${e?.message ?? e}`);
          }
        } else if (
          lname.endsWith(".zip") ||
          file.type === "application/zip" ||
          file.type === "application/x-zip-compressed"
        ) {
          try {
            const JSZip = (await import("jszip")).default;
            const zip   = await JSZip.loadAsync(file);
            const entries = Object.entries(zip.files).filter(
              ([n, e]) => !e.dir && n.toLowerCase().endsWith(".csv"),
            );
            for (const [entryName, entry] of entries) {
              try {
                const text     = await entry.async("text");
                const { columns, rows } = parseCsvText(text);
                const baseName = entryName.split("/").pop() ?? entryName;
                newItems.push({ id: uid(), name: baseName, tag: parseTagFromFilename(baseName), columns, rows });
              } catch (e: any) {
                toast.error(`Could not parse ${entryName}: ${e?.message ?? e}`);
              }
            }
          } catch (e: any) {
            toast.error(`Could not read ${file.name}: ${e?.message ?? e}`);
          }
        }
      }

      if (newItems.length) {
        setImportedCsvFiles((prev) => [...prev, ...newItems]);
        toast.success(`Loaded ${newItems.length} CSV file${newItems.length !== 1 ? "s" : ""}.`);
        if (filterColumn.trim() && filterKeyword.trim()) {
          autoExpandMatches(filterColumn, filterKeyword, newItems);
        }
      } else if (rawFiles.length > 0) {
        toast.warning("No CSV files found in the dropped files.");
      }
      setLoading(false);
    },
    [setImportedCsvFiles, filterColumn, filterKeyword, autoExpandMatches],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); },
    [addFiles],
  );

  // ── per-item download ─────────────────────────────────────────────────────

  const downloadItem = (item: StoreImportedCsv) => {
    const csv = serializeCsv(item.columns, item.rows);
    const a   = document.createElement("a");
    a.href    = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
  };

  // ── export all as ZIP ─────────────────────────────────────────────────────

  const exportAllZip = useCallback(async () => {
    if (!importedCsvFiles.length) return;
    setZipExporting(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip   = new JSZip();
      let totalStripped = 0;
      for (const item of importedCsvFiles) {
        const cleanRows = stripNullRows(item.rows);
        totalStripped  += item.rows.length - cleanRows.length;
        zip.file(item.name, serializeCsv(item.columns, cleanRows));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = `csv-import-${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
      toast.success(
        `Exported ${importedCsvFiles.length} file${importedCsvFiles.length !== 1 ? "s" : ""}` +
        (totalStripped > 0 ? ` · ${totalStripped} null row${totalStripped !== 1 ? "s" : ""} removed` : ""),
      );
    } catch (e: any) {
      toast.error(`Export failed: ${e?.message ?? e}`);
    }
    setZipExporting(false);
  }, [importedCsvFiles]);

  // ── strip null rows ───────────────────────────────────────────────────────

  const stripNullRowsForItem = (id: string) => {
    setImportedCsvFiles((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const before = it.rows.length;
        const cleaned = stripNullRows(it.rows);
        const removed = before - cleaned.length;
        toast.success(
          removed > 0
            ? `Stripped ${removed} null row${removed !== 1 ? "s" : ""} from ${it.name}`
            : `No null rows found in ${it.name}`,
        );
        return { ...it, rows: cleaned };
      }),
    );
  };

  const stripAllNullRows = () => {
    let totalRemoved = 0;
    setImportedCsvFiles((prev) =>
      prev.map((it) => {
        const cleaned = stripNullRows(it.rows);
        totalRemoved += it.rows.length - cleaned.length;
        return { ...it, rows: cleaned };
      }),
    );
    setTimeout(() => {
      toast.success(
        totalRemoved > 0
          ? `Stripped ${totalRemoved} null row${totalRemoved !== 1 ? "s" : ""} across all files`
          : "No null rows found in any file",
      );
    }, 0);
  };

  // ── remove item ───────────────────────────────────────────────────────────

  const removeItem = (id: string) => {
    setImportedCsvFiles((prev) => prev.filter((it) => it.id !== id));
    setOpenItems((prev) => prev.filter((x) => x !== id));
    clearItemExposeOverride(id);
  };

  // ── generate report ───────────────────────────────────────────────────────

  const generateReport = useCallback(() => {
    // Determine report columns: use the reference file's columns (first loaded).
    // If schemas differ, use the union so nothing is lost.
    const allCols = importedCsvFiles.flatMap((f) => f.columns);
    const uniqueCols = [...new Set(allCols)];
    // Prefer the order of the first file.
    const refCols = importedCsvFiles[0]?.columns ?? [];
    const extraCols = uniqueCols.filter((c) => !refCols.includes(c));
    const dataCols = [...refCols, ...extraCols];

    const rows: ReportRow[] = [];

    for (const item of sorted) {
      const { before, after } = getItemExpose(item.id);
      const displayed = getDisplayRows(item, filterColumn, filterKeyword, before, after, isFilterActive);

      for (const { row, isMatch } of displayed) {
        // Map row cells to dataCols order
        const cells = dataCols.map((col) => {
          const ci = item.columns.indexOf(col);
          return ci >= 0 ? (row[ci] ?? "") : "";
        });
        rows.push({
          id: uid(),
          filename: item.name,
          cells,
          isContext: !isMatch,
          notes: "",
        });
      }
    }

    setReportColumns(dataCols);
    setReportRows(rows);
    setShowReport(true);

    const matchCount = rows.filter((r) => !r.isContext).length;
    const contextCount = rows.filter((r) => r.isContext).length;
    toast.success(
      `Report generated: ${matchCount} match${matchCount !== 1 ? "es" : ""}` +
      (contextCount > 0 ? ` + ${contextCount} context row${contextCount !== 1 ? "s" : ""}` : "") +
      ` from ${importedCsvFiles.length} file${importedCsvFiles.length !== 1 ? "s" : ""}`,
    );
  }, [sorted, filterColumn, filterKeyword, isFilterActive, importedCsvFiles, exposeOverrides, globalBefore, globalAfter]);

  const updateReportNote = (id: string, notes: string) =>
    setReportRows((prev) => prev.map((r) => r.id === id ? { ...r, notes } : r));

  const downloadReport = useCallback(() => {
    if (!reportRows.length) return;
    const columns = ["filename", ...reportColumns, "notes"];
    const rows = reportRows.map((r) => [r.filename, ...r.cells, r.notes]);
    const csv = toCsv(columns, rows);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `report.${timestamp()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
  }, [reportRows, reportColumns]);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 p-4">

      {/* ── Drop zone ── */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-8 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        <div className="flex items-center gap-3 opacity-60">
          <FileSpreadsheet className="h-6 w-6" />
          <FileArchive className="h-6 w-6" />
        </div>
        <p className="text-center text-xs">
          Drop <strong>.csv</strong> files or <strong>.zip</strong> archives of CSVs — or click to browse
        </p>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.zip,application/zip,application/x-zip-compressed"
          className="hidden"
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
        />
      </div>

      {importedCsvFiles.length > 0 && (
        <>
          {/* ── Schema mismatch warning ── */}
          {schemaMismatches.length > 0 && (
            <div className="rounded-lg border border-yellow-400/60 bg-yellow-50/60 px-3 py-2.5 dark:border-yellow-600/40 dark:bg-yellow-900/20">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-yellow-800 dark:text-yellow-300">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                Column schema mismatch — {schemaMismatches.length} file{schemaMismatches.length !== 1 ? "s" : ""} differ from the first file
              </div>
              <ul className="space-y-0.5 pl-5">
                {schemaMismatches.map((m) => (
                  <li key={m.name} className="text-xs text-yellow-700 dark:text-yellow-400">
                    <span className="font-medium">{m.name}</span>
                    {" — "}
                    <span className="font-mono">[{m.columns.join(", ")}]</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-yellow-600 dark:text-yellow-500">
                Expected: <span className="font-mono">[{importedCsvFiles[0].columns.join(", ")}]</span>
              </p>
            </div>
          )}

          {/* ── Toolbar ── */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {importedCsvFiles.length} file{importedCsvFiles.length !== 1 ? "s" : ""}
            </span>

            <Button
              size="sm" variant="outline" className="h-7 gap-1 text-xs"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {sortDir === "asc" ? "Oldest first" : "Newest first"}
            </Button>

            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              onClick={stripAllNullRows}
            >
              <Eraser className="mr-1 h-3.5 w-3.5" />
              Strip null rows
            </Button>

            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              onClick={exportAllZip} disabled={zipExporting}
            >
              {zipExporting
                ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                : <Download className="mr-1 h-3.5 w-3.5" />}
              Export all ZIP
            </Button>

            {/* ── Global expose control ── */}
            <div className="ml-auto flex items-center">
              <ExposeControl
                before={globalBefore} after={globalAfter}
                onBefore={setGlobalBefore} onAfter={setGlobalAfter}
              />
            </div>

            <Button
              size="sm" variant="ghost" className="h-7 text-xs text-destructive"
              onClick={() => { setImportedCsvFiles([]); setOpenItems([]); clearFilter(); setReportRows([]); setShowReport(false); }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />Clear all
            </Button>
          </div>

          {/* ── Filter bar ── */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <Filter className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />

            <input
              placeholder="Column name"
              value={filterColumn}
              onChange={(e) => onFilterColumnChange(e.target.value)}
              className="h-7 w-36 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />

            <input
              placeholder="Keyword"
              value={filterKeyword}
              onChange={(e) => onFilterKeywordChange(e.target.value)}
              className="h-7 min-w-32 flex-1 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />

            {isFilterActive && (
              <>
                <span className="text-xs text-muted-foreground">
                  {filterStats!.total} match{filterStats!.total !== 1 ? "es" : ""}
                  {filterStats!.exposed > 0 && ` + ${filterStats!.exposed} context`}
                  {" across "}
                  {filterStats!.files} file{filterStats!.files !== 1 ? "s" : ""}
                </span>

                {/* Generate report */}
                <Button
                  size="sm" variant="secondary" className="h-7 gap-1 text-xs"
                  onClick={generateReport}
                >
                  <TableProperties className="h-3.5 w-3.5" />
                  Generate report
                </Button>

                <button
                  onClick={clearFilter}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  title="Clear filter"
                >
                  <X className="h-3 w-3" />Clear
                </button>
              </>
            )}

            {/* Generate report even without filter */}
            {!isFilterActive && importedCsvFiles.length > 0 && (
              <Button
                size="sm" variant="outline" className="ml-auto h-7 gap-1 text-xs"
                onClick={generateReport}
              >
                <TableProperties className="h-3.5 w-3.5" />
                Generate report
              </Button>
            )}
          </div>

          {/* ── Accordion list ── */}
          <Accordion
            type="multiple"
            value={openItems}
            onValueChange={setOpenItems}
            className="space-y-2"
          >
            {sorted.map((item) => {
              const { before, after } = getItemExpose(item.id);
              const hasOverride = !!exposeOverrides[item.id];
              const displayed  = getDisplayRows(item, filterColumn, filterKeyword, before, after, isFilterActive);
              const matchCount = displayed.filter((r) => r.isMatch).length;
              const hasMatches = !isFilterActive || matchCount > 0;

              return (
                <AccordionItem
                  key={item.id}
                  value={item.id}
                  className={`overflow-hidden rounded-lg border px-3 transition-opacity ${
                    isFilterActive && !hasMatches ? "border-border opacity-40" : "border-border"
                  }`}
                >
                  <AccordionTrigger className="py-2.5 hover:no-underline [&>svg]:flex-shrink-0">
                    <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                      <FileSpreadsheet className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

                      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium" title={item.name}>
                        {item.name}
                      </span>

                      <Badge variant="secondary" className="flex-shrink-0 font-mono text-[11px] tracking-tight">
                        {item.tag.year}:{item.tag.month}:p{item.tag.part}
                      </Badge>

                      <span className={`flex-shrink-0 text-xs ${
                        isFilterActive
                          ? hasMatches ? "font-semibold text-primary" : "text-muted-foreground"
                          : "text-muted-foreground"
                      }`}>
                        {isFilterActive
                          ? `${matchCount} match${matchCount !== 1 ? "es" : ""}` +
                            (displayed.length > matchCount ? ` + ${displayed.length - matchCount} ctx` : "")
                          : `${item.rows.length} row${item.rows.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="pb-3">
                    {/* Actions row */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => downloadItem(item)}>
                        <Download className="mr-1 h-3 w-3" />Download
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => stripNullRowsForItem(item.id)}>
                        <Eraser className="mr-1 h-3 w-3" />Strip null rows
                      </Button>

                      {/* Per-item expose override */}
                      <div className="flex items-center gap-1">
                        <ExposeControl
                          before={before} after={after} compact
                          onBefore={(v) => setItemExpose(item.id, { before: v })}
                          onAfter={(v) => setItemExpose(item.id, { after: v })}
                        />
                        {hasOverride && (
                          <button
                            onClick={() => clearItemExposeOverride(item.id)}
                            className="ml-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                            title="Reset to global"
                          >
                            reset
                          </button>
                        )}
                      </div>

                      <Button
                        size="icon" variant="ghost"
                        className="ml-auto h-7 w-7 text-muted-foreground"
                        title="Remove"
                        onClick={() => removeItem(item.id)}
                      >
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
                                  <th
                                    key={ci}
                                    className={`whitespace-nowrap px-2 py-1.5 text-left font-semibold ${
                                      isFilterActive && col.toLowerCase() === filterColumn.trim().toLowerCase()
                                        ? "bg-primary/10 text-primary" : ""
                                    }`}
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {displayed.map(({ row, isMatch }, ri) => (
                                <tr
                                  key={ri}
                                  className={`border-t border-border ${
                                    isFilterActive && !isMatch
                                      ? "opacity-50"
                                      : ri % 2 === 1 ? "bg-muted/30" : ""
                                  }`}
                                >
                                  {item.columns.map((col, ci) => {
                                    const val = row[ci] ?? "";
                                    const isMatchCell =
                                      isMatch &&
                                      isFilterActive &&
                                      col.toLowerCase() === filterColumn.trim().toLowerCase() &&
                                      filterKeyword.trim() !== "" &&
                                      val.toLowerCase().includes(filterKeyword.trim().toLowerCase());
                                    return (
                                      <td
                                        key={ci}
                                        className={`whitespace-nowrap px-2 py-1 ${
                                          isMatchCell ? "font-medium text-foreground" : "text-muted-foreground"
                                        }`}
                                      >
                                        {isMatchCell ? (
                                          <Highlight text={val} keyword={filterKeyword.trim()} />
                                        ) : val}
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

          {/* ── Report panel ── */}
          {showReport && reportRows.length > 0 && (
            <div className="rounded-lg border border-border">
              {/* Report header */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <TableProperties className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-sm font-semibold">
                  Report
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {reportRows.filter((r) => !r.isContext).length} match{reportRows.filter((r) => !r.isContext).length !== 1 ? "es" : ""}
                    {reportRows.some((r) => r.isContext) && ` + ${reportRows.filter((r) => r.isContext).length} context`}
                    {" · "}{[...new Set(reportRows.map((r) => r.filename))].length} file{[...new Set(reportRows.map((r) => r.filename))].length !== 1 ? "s" : ""}
                  </span>
                </span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={downloadReport}>
                  <Download className="mr-1 h-3.5 w-3.5" />Export CSV
                </Button>
                <button
                  onClick={() => setShowReport(false)}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                  title="Close report"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Report table */}
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-muted">
                    <tr>
                      <th className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-muted-foreground">
                        filename
                      </th>
                      {reportColumns.map((col, ci) => (
                        <th key={ci} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">
                          {col}
                        </th>
                      ))}
                      <th className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-primary">
                        notes
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.map((rr, ri) => (
                      <tr
                        key={rr.id}
                        className={`border-t border-border ${
                          rr.isContext
                            ? "opacity-50"
                            : ri % 2 === 1 ? "bg-muted/30" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                          {rr.filename}
                        </td>
                        {rr.cells.map((cell, ci) => (
                          <td key={ci} className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                            {cell}
                          </td>
                        ))}
                        <td className="px-1 py-0.5">
                          <input
                            className="w-full min-w-24 rounded bg-transparent px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                            value={rr.notes}
                            placeholder="Add note…"
                            onChange={(e) => updateReportNote(rr.id, e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Highlight matched substring ───────────────────────────────────────────────

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-yellow-200 px-0.5 text-yellow-900 dark:bg-yellow-700 dark:text-yellow-100">
        {text.slice(idx, idx + keyword.length)}
      </mark>
      {text.slice(idx + keyword.length)}
    </>
  );
}

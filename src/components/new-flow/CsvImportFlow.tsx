/**
 * CsvImportFlow — "CSV Import" tab in /new.
 *
 * • Accepts individual .csv files or .zip archives containing .csv files.
 * • Parses each CSV in-browser (no upload).
 * • Infers a year:month:part tag from the filename.
 * • Displays each file in a collapsed Accordion, sorted by tag (asc / desc).
 * • Filter by column + keyword — auto-expands matching accordions.
 * • Export all as ZIP with null rows stripped.
 */
import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  FileSpreadsheet, FileArchive,
  ArrowUp, ArrowDown,
  Download, Trash2, X, Loader2, Filter, Eraser,
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

function serializeCsv(columns: string[], rows: string[][]): string {
  const esc = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    columns.map(esc).join(","),
    ...rows.map((r) => r.map(esc).join(",")),
  ].join("\n");
}

// ── Null-value helpers ────────────────────────────────────────────────────────
// A cell is "null" when it is blank, literally "null", "N/A", "undefined", or "-".
// A row is null when every one of its cells is null.

function isNullCell(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" || t === "null" || t === "n/a" || t === "undefined" || t === "-";
}

function stripNullRows(rows: string[][]): string[][] {
  return rows.filter((row) => !row.every((v) => isNullCell(v)));
}

// ── Filter helper ─────────────────────────────────────────────────────────────

function getMatchingRows(
  item: StoreImportedCsv,
  col: string,
  kw: string,
): string[][] {
  const colTrim = col.trim();
  const kwTrim  = kw.trim();
  if (!colTrim || !kwTrim) return item.rows;
  const colIdx = item.columns.findIndex(
    (c) => c.toLowerCase() === colTrim.toLowerCase(),
  );
  if (colIdx === -1) return [];
  const kwLower = kwTrim.toLowerCase();
  return item.rows.filter((row) =>
    (row[colIdx] ?? "").toLowerCase().includes(kwLower),
  );
}

// ── uid ───────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);

// ── Component ─────────────────────────────────────────────────────────────────

export function CsvImportFlow() {
  const { importedCsvFiles, setImportedCsvFiles } = useAppStore();

  const [sortDir,      setSortDir]      = useState<"asc" | "desc">("asc");
  const [loading,      setLoading]      = useState(false);
  const [zipExporting, setZipExporting] = useState(false);

  // ── accordion controlled open state ─────────────────────────────────────────
  // Tracks which item IDs are open. Auto-expanded by the filter.
  const [openItems, setOpenItems] = useState<string[]>([]);

  // ── filter state ─────────────────────────────────────────────────────────────
  const [filterColumn,  setFilterColumn]  = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);

  // ── sorted items ─────────────────────────────────────────────────────────────

  const sorted = [...importedCsvFiles].sort((a, b) => {
    const diff = tagKey(a.tag) - tagKey(b.tag);
    return sortDir === "asc" ? diff : -diff;
  });

  // ── filter helpers ────────────────────────────────────────────────────────────

  const isFilterActive = filterColumn.trim() !== "" && filterKeyword.trim() !== "";

  /** Auto-expand items that have matches for a given col+kw pair. */
  const autoExpandMatches = useCallback(
    (col: string, kw: string, items: StoreImportedCsv[]) => {
      if (!col.trim() || !kw.trim()) return;
      const matchedIds = items
        .filter((it) => getMatchingRows(it, col, kw).length > 0)
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

  // ── filter summary ────────────────────────────────────────────────────────────

  const filterStats = isFilterActive
    ? sorted.reduce(
        (acc, item) => {
          const matches = getMatchingRows(item, filterColumn, filterKeyword).length;
          return { total: acc.total + matches, files: acc.files + (matches > 0 ? 1 : 0) };
        },
        { total: 0, files: 0 },
      )
    : null;

  // ── file ingestion ────────────────────────────────────────────────────────────

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
        // Auto-expand matches if filter is already active
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

  // ── per-item download ─────────────────────────────────────────────────────────

  const downloadItem = (item: StoreImportedCsv) => {
    const csv = serializeCsv(item.columns, item.rows);
    const a   = document.createElement("a");
    a.href    = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
  };

  // ── export all as ZIP (null rows stripped) ────────────────────────────────────

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

  // ── strip null rows (per-item) ────────────────────────────────────────────────

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

  // ── strip null rows (all files) ───────────────────────────────────────────────

  const stripAllNullRows = () => {
    let totalRemoved = 0;
    setImportedCsvFiles((prev) =>
      prev.map((it) => {
        const cleaned = stripNullRows(it.rows);
        totalRemoved += it.rows.length - cleaned.length;
        return { ...it, rows: cleaned };
      }),
    );
    // Use setTimeout so the state update completes before reading totalRemoved
    setTimeout(() => {
      toast.success(
        totalRemoved > 0
          ? `Stripped ${totalRemoved} null row${totalRemoved !== 1 ? "s" : ""} across all files`
          : "No null rows found in any file",
      );
    }, 0);
  };

  // ── remove item ───────────────────────────────────────────────────────────────

  const removeItem = (id: string) => {
    setImportedCsvFiles((prev) => prev.filter((it) => it.id !== id));
    setOpenItems((prev) => prev.filter((x) => x !== id));
  };

  // ── render ────────────────────────────────────────────────────────────────────

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

            <Button
              size="sm" variant="ghost" className="ml-auto h-7 text-xs text-destructive"
              onClick={() => { setImportedCsvFiles([]); setOpenItems([]); clearFilter(); }}
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
                  {" "}across{" "}
                  {filterStats!.files} file{filterStats!.files !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={clearFilter}
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  title="Clear filter"
                >
                  <X className="h-3 w-3" />Clear
                </button>
              </>
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
              const matchingRows = getMatchingRows(item, filterColumn, filterKeyword);
              const matchCount   = isFilterActive ? matchingRows.length : item.rows.length;
              const hasMatches   = !isFilterActive || matchingRows.length > 0;
              const displayRows  = isFilterActive ? matchingRows : item.rows;

              return (
                <AccordionItem
                  key={item.id}
                  value={item.id}
                  className={`overflow-hidden rounded-lg border px-3 transition-opacity ${
                    isFilterActive && !hasMatches
                      ? "border-border opacity-40"
                      : "border-border"
                  }`}
                >
                  <AccordionTrigger className="py-2.5 hover:no-underline [&>svg]:flex-shrink-0">
                    <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                      <FileSpreadsheet className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

                      <span
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                        title={item.name}
                      >
                        {item.name}
                      </span>

                      {/* Tag */}
                      <Badge
                        variant="secondary"
                        className="flex-shrink-0 font-mono text-[11px] tracking-tight"
                      >
                        {item.tag.year}:{item.tag.month}:p{item.tag.part}
                      </Badge>

                      {/* Row / match count */}
                      <span
                        className={`flex-shrink-0 text-xs ${
                          isFilterActive
                            ? hasMatches ? "font-semibold text-primary" : "text-muted-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {isFilterActive
                          ? `${matchCount} match${matchCount !== 1 ? "es" : ""}`
                          : `${item.rows.length} row${item.rows.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="pb-3">
                    {/* Actions */}
                    <div className="mb-2 flex items-center gap-2">
                      <Button
                        size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => downloadItem(item)}
                      >
                        <Download className="mr-1 h-3 w-3" />Download
                      </Button>
                      <Button
                        size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => stripNullRowsForItem(item.id)}
                      >
                        <Eraser className="mr-1 h-3 w-3" />Strip null rows
                      </Button>
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
                      displayRows.length > 0 ? (
                        <div className="overflow-x-auto rounded border border-border">
                          <table className="min-w-full text-xs">
                            <thead className="bg-muted">
                              <tr>
                                {item.columns.map((col, ci) => (
                                  <th
                                    key={ci}
                                    className={`whitespace-nowrap px-2 py-1.5 text-left font-semibold ${
                                      isFilterActive &&
                                      col.toLowerCase() === filterColumn.trim().toLowerCase()
                                        ? "bg-primary/10 text-primary"
                                        : ""
                                    }`}
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {displayRows.map((row, ri) => (
                                <tr
                                  key={ri}
                                  className={`border-t border-border ${ri % 2 === 1 ? "bg-muted/30" : ""}`}
                                >
                                  {item.columns.map((col, ci) => {
                                    const val     = row[ci] ?? "";
                                    const isMatch =
                                      isFilterActive &&
                                      col.toLowerCase() === filterColumn.trim().toLowerCase() &&
                                      filterKeyword.trim() !== "" &&
                                      val.toLowerCase().includes(filterKeyword.trim().toLowerCase());
                                    return (
                                      <td
                                        key={ci}
                                        className={`whitespace-nowrap px-2 py-1 ${
                                          isMatch
                                            ? "font-medium text-foreground"
                                            : "text-muted-foreground"
                                        }`}
                                      >
                                        {isMatch ? (
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
                        <p className="text-xs text-muted-foreground">
                          No rows match this filter.
                        </p>
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

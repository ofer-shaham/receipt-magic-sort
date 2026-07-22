/**
 * CsvImportFlow — "CSV Import" tab in /new.
 *
 * • Accepts individual .csv files or .zip archives containing .csv files.
 * • Parses each CSV in-browser (no upload).
 * • Infers a year:month:part tag from the filename.
 * • Displays each file in a collapsed Accordion, sorted by tag (asc / desc toggle).
 */
import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  FileSpreadsheet, FileArchive,
  ArrowUp, ArrowDown,
  Download, Trash2, X, Loader2,
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
// Handles double-quoted fields (including embedded commas and newlines) and
// optional \r\n line endings.

function parseCsvText(raw: string): { columns: string[]; rows: string[][] } {
  // Normalise line endings so we only deal with \n
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const record: string[] = [];

    while (i < n && text[i] !== "\n") {
      if (text[i] === '"') {
        // Quoted field
        let field = "";
        i++; // skip opening quote
        while (i < n) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i++];
          }
        }
        record.push(field);
        // skip comma separator
        if (i < n && text[i] === ",") i++;
      } else {
        let field = "";
        while (i < n && text[i] !== "," && text[i] !== "\n") {
          field += text[i++];
        }
        record.push(field);
        if (i < n && text[i] === ",") i++;
      }
    }

    // skip the newline
    if (i < n && text[i] === "\n") i++;

    // Skip blank lines (single empty field)
    if (record.length === 1 && record[0] === "") continue;
    if (record.length > 0) records.push(record);
  }

  if (records.length === 0) return { columns: [], rows: [] };
  return { columns: records[0], rows: records.slice(1) };
}

// ── Tag parser ────────────────────────────────────────────────────────────────
// Tries several filename patterns in order of specificity.

const CURR_YEAR = String(new Date().getFullYear());

function parseTagFromFilename(name: string): { year: string; month: string; part: string } {
  // y2024_m01__p3  (canonical app export format)
  const m1 = name.match(/y(\d{4})_m(\d{2})__p(\d+)/i);
  if (m1) return { year: m1[1], month: m1[2], part: m1[3] };

  // y2024_m01  (no part)
  const m2 = name.match(/y(\d{4})_m(\d{2})/i);
  if (m2) return { year: m2[1], month: m2[2], part: "1" };

  // YYYY-MM or YYYY_MM
  const m3 = name.match(/(\d{4})[-_](\d{2})/);
  if (m3) return { year: m3[1], month: m3[2].padStart(2, "0"), part: "1" };

  // MM-YYYY or MM_YYYY
  const m4 = name.match(/(\d{2})[-_](\d{4})/);
  if (m4) return { year: m4[2], month: m4[1].padStart(2, "0"), part: "1" };

  return { year: CURR_YEAR, month: "01", part: "1" };
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function tagKey(tag: StoreImportedCsv["tag"]): number {
  // Numeric key: YYYYMMPP  (e.g. 2024_01_01 → 20240101)
  return parseInt(tag.year, 10) * 10000
       + parseInt(tag.month, 10) * 100
       + parseInt(tag.part,  10);
}

// ── CSV re-serialiser for download ────────────────────────────────────────────

function serializeCsv(columns: string[], rows: string[][]): string {
  const esc = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  return [
    columns.map(esc).join(","),
    ...rows.map((r) => r.map(esc).join(",")),
  ].join("\n");
}

// ── uid ───────────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);

// ── Component ─────────────────────────────────────────────────────────────────

export function CsvImportFlow() {
  const { importedCsvFiles, setImportedCsvFiles } = useAppStore();
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── file processing ─────────────────────────────────────────────────────────

  const parseCsvFile = useCallback(
    async (file: File, nameOverride?: string): Promise<StoreImportedCsv | null> => {
      try {
        const text = await file.text();
        const { columns, rows } = parseCsvText(text);
        const name = nameOverride ?? file.name;
        return { id: uid(), name, tag: parseTagFromFilename(name), columns, rows };
      } catch (e: any) {
        toast.error(`Could not parse ${file.name}: ${e?.message ?? e}`);
        return null;
      }
    },
    [],
  );

  const addFiles = useCallback(
    async (rawFiles: File[]) => {
      setLoading(true);
      const newItems: StoreImportedCsv[] = [];

      for (const file of rawFiles) {
        const lname = file.name.toLowerCase();

        if (lname.endsWith(".csv")) {
          const item = await parseCsvFile(file);
          if (item) newItems.push(item);

        } else if (
          lname.endsWith(".zip") ||
          file.type === "application/zip" ||
          file.type === "application/x-zip-compressed"
        ) {
          try {
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(file);
            const entries = Object.entries(zip.files).filter(
              ([n, e]) => !e.dir && n.toLowerCase().endsWith(".csv"),
            );
            for (const [entryName, entry] of entries) {
              try {
                const text = await entry.async("text");
                const { columns, rows } = parseCsvText(text);
                const baseName = entryName.split("/").pop() ?? entryName;
                newItems.push({
                  id: uid(),
                  name: baseName,
                  tag: parseTagFromFilename(baseName),
                  columns,
                  rows,
                });
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
        toast.success(
          `Loaded ${newItems.length} CSV file${newItems.length !== 1 ? "s" : ""}.`,
        );
      } else if (rawFiles.length > 0) {
        toast.warning("No CSV files found in the dropped files.");
      }

      setLoading(false);
    },
    [parseCsvFile, setImportedCsvFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  // ── actions ─────────────────────────────────────────────────────────────────

  const removeItem = (id: string) =>
    setImportedCsvFiles((prev) => prev.filter((it) => it.id !== id));

  const downloadItem = (item: StoreImportedCsv) => {
    const csv = serializeCsv(item.columns, item.rows);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
  };

  // ── sorted view ─────────────────────────────────────────────────────────────

  const sorted = [...importedCsvFiles].sort((a, b) => {
    const diff = tagKey(a.tag) - tagKey(b.tag);
    return sortDir === "asc" ? diff : -diff;
  });

  // ── render ──────────────────────────────────────────────────────────────────

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

      {/* ── Toolbar ── */}
      {importedCsvFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {importedCsvFiles.length} file{importedCsvFiles.length !== 1 ? "s" : ""}
          </span>

          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          >
            {sortDir === "asc"
              ? <ArrowUp className="h-3 w-3" />
              : <ArrowDown className="h-3 w-3" />}
            {sortDir === "asc" ? "Oldest first" : "Newest first"}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs text-destructive"
            onClick={() => setImportedCsvFiles([])}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear all
          </Button>
        </div>
      )}

      {/* ── Accordion list ── */}
      {sorted.length > 0 && (
        <Accordion type="multiple" className="space-y-2">
          {sorted.map((item) => (
            <AccordionItem
              key={item.id}
              value={item.id}
              className="overflow-hidden rounded-lg border border-border px-3"
            >
              <AccordionTrigger className="py-2.5 hover:no-underline [&>svg]:flex-shrink-0">
                {/* Left side: icon + filename */}
                <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                  <FileSpreadsheet className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                    title={item.name}
                  >
                    {item.name}
                  </span>

                  {/* Tag badge: year:month:pN */}
                  <Badge
                    variant="secondary"
                    className="flex-shrink-0 font-mono text-[11px] tracking-tight"
                  >
                    {item.tag.year}:{item.tag.month}:p{item.tag.part}
                  </Badge>

                  {/* Row count */}
                  <span className="flex-shrink-0 text-xs text-muted-foreground">
                    {item.rows.length} row{item.rows.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </AccordionTrigger>

              <AccordionContent className="pb-3">
                {/* Actions row */}
                <div className="mb-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => downloadItem(item)}
                  >
                    <Download className="mr-1 h-3 w-3" />
                    Download
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-7 w-7 text-muted-foreground"
                    title="Remove"
                    onClick={() => removeItem(item.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Table */}
                {item.columns.length > 0 ? (
                  <div className="overflow-x-auto rounded border border-border">
                    <table className="min-w-full text-xs">
                      <thead className="bg-muted">
                        <tr>
                          {item.columns.map((col, ci) => (
                            <th
                              key={ci}
                              className="whitespace-nowrap px-2 py-1.5 text-left font-semibold"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {item.rows.map((row, ri) => (
                          <tr
                            key={ri}
                            className={`border-t border-border ${ri % 2 === 1 ? "bg-muted/30" : ""}`}
                          >
                            {item.columns.map((_, ci) => (
                              <td
                                key={ci}
                                className="whitespace-nowrap px-2 py-1 text-muted-foreground"
                              >
                                {row[ci] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Empty or unreadable CSV.
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}

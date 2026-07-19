import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { toCsv } from "@/lib/new-flow/csv-extract";
import { timestamp } from "@/lib/receipt-utils";

export type CsvTableProps = {
  filename: string;
  columns: string[];
  rows: string[][];
  onRowsChange: (rows: string[][]) => void;
};

export function CsvTable({ filename, columns, rows, onRowsChange }: CsvTableProps) {
  const setCell = useCallback(
    (ri: number, ci: number, val: string) => {
      const next = rows.map((r) => [...r]);
      while (next[ri].length <= ci) next[ri].push("");
      next[ri][ci] = val;
      onRowsChange(next);
    },
    [rows, onRowsChange],
  );

  const download = useCallback(() => {
    const csv = toCsv(columns, rows);
    const base = filename.replace(/\.[^.]+$/, "");
    const name = `${base}.${timestamp()}.csv`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, [columns, rows, filename]);

  if (!columns.length) return null;

  return (
    <div className="mt-2 space-y-2">
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-muted">
            <tr>
              {columns.map((c, i) => (
                <th key={i} className="px-2 py-1 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-t border-border">
                {columns.map((_, ci) => (
                  <td key={ci} className="px-1 py-0.5">
                    <input
                      className="w-full rounded bg-transparent px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
                      value={row[ci] ?? ""}
                      onChange={(e) => setCell(ri, ci, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" variant="outline" onClick={download}>
        <Download className="mr-1 h-3.5 w-3.5" />
        Download CSV
      </Button>
    </div>
  );
}

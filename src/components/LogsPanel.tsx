/**
 * LogsPanel — shared sheet showing AI request logs written to localStorage
 * by both the /new crop flow and the /new CSV flow.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import { Clock, Trash2 } from "lucide-react";
import { readAILogs, type AIRequestLog } from "@/lib/new-flow/logging";

const LOG_KEY = "receiptforge-new-ai-logs-v1";

function clearLogs() {
  try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
}

function fmtTs(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

export function LogsPanel() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<AIRequestLog[]>([]);

  const handleOpen = (v: boolean) => {
    if (v) setLogs(readAILogs());
    setOpen(v);
  };

  const handleClear = () => {
    clearLogs();
    setLogs([]);
  };

  const sorted = [...logs].reverse().slice(0, 200);

  return (
    <Sheet open={open} onOpenChange={handleOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="AI Request Logs">
          <Clock className="h-4 w-4" />
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="flex w-80 flex-col gap-0 p-0">
        <SheetHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <SheetTitle className="text-sm font-semibold">AI Request Logs</SheetTitle>
          {logs.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-destructive"
              onClick={handleClear}>
              <Trash2 className="h-3 w-3" />Clear
            </Button>
          )}
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {sorted.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No AI requests logged yet. Run an extraction to see logs here.
            </p>
          )}

          {sorted.map((log, i) => (
            <div key={i}
              className="rounded-md border border-border bg-muted/20 p-2.5 text-xs space-y-0.5">
              <p className="font-medium truncate" title={log.filename}>{log.filename}</p>
              <p className="font-mono text-[11px] text-muted-foreground truncate">{log.model}</p>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{log.origin}</span>
                <span>{fmtBytes(log.byteSize)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">{fmtTs(log.ts)}</p>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPdfsWithLimit,
  compressImage,
  extractDateWithAI,
  extractImagesFromArchive,
  fetchOpenRouterCredits,
  formatBytes,
  FREE_VISION_MODELS,
  sha256,
  type OpenRouterCredits,
} from "@/lib/receipt-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Upload,
  Download,
  Sparkles,
  ArrowUpDown,
  X,
  GripVertical,
  Loader2,
  FileText,
  KeyRound,
  AlertTriangle,
  ExternalLink,
  Trash2,
  RefreshCw,
  Tag,
  Archive,
} from "lucide-react";

type DateSource = "ai" | "manual";

type Receipt = {
  id: string;
  hash: string;
  name: string;
  originalSize: number;
  file: File;
  qualityOverride: number | null;
  compressed?: {
    quality: number;
    blob: Blob;
    dataUrl: string;
    width: number;
    height: number;
  };
  date?: string | null;
  dateSource?: DateSource;
  aiState: "idle" | "loading" | "done" | "error";
};


type LogEntry = {
  id: string;
  ts: number;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  stack?: string;
};

const DATE_CACHE_KEY = "receipt-date-cache-v2";
const API_KEY_STORAGE = "openrouter-api-key";
const MODEL_STORAGE = "openrouter-model";

type CachedDate = { date: string | null; source?: DateSource };

function loadDateCache(): Record<string, CachedDate> {
  try {
    const raw = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}");
    // migrate v1 (plain string|null) if present
    if (raw && typeof raw === "object") {
      const out: Record<string, CachedDate> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === "object" && "date" in v) out[k] = v as CachedDate;
        else out[k] = { date: v as string | null, source: "ai" };
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}
function saveDateCache(c: Record<string, CachedDate>) {
  localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(c));
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const YEAR_RANGE = 5;

export function ReceiptApp() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [globalQuality, setGlobalQuality] = useState(70);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string>(FREE_VISION_MODELS[0]);
  const [pdfs, setPdfs] = useState<{ url: string; size: number; pageCount: number }[]>([]);
  const [pdfSizeLimitMB, setPdfSizeLimitMB] = useState(10);
  const [building, setBuilding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [credits, setCredits] = useState<OpenRouterCredits | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const dragId = useRef<string | null>(null);
  const dateCache = useRef<Record<string, CachedDate>>(loadDateCache());


  const pushLog = useCallback(
    (entry: Omit<LogEntry, "id" | "ts">) => {
      setLogs((prev) =>
        [
          {
            ...entry,
            id: crypto.randomUUID(),
            ts: Date.now(),
          },
          ...prev,
        ].slice(0, 50),
      );
    },
    [],
  );

  useEffect(() => {
    const k = localStorage.getItem(API_KEY_STORAGE);
    if (k) setApiKey(k);
    const m = localStorage.getItem(MODEL_STORAGE);
    if (m) setModel(m);
  }, []);

  // Capture global errors
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      pushLog({
        level: "error",
        source: `${e.filename || "window"}:${e.lineno || 0}`,
        message: e.message || String(e.error),
        stack: e.error?.stack,
      });
    };
    const onRej = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      pushLog({
        level: "error",
        source: "unhandledrejection",
        message: r?.message || String(r),
        stack: r?.stack,
      });
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);

    // Patch console.error / console.warn
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => {
      pushLog({
        level: "error",
        source: "console",
        message: args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "),
        stack: args.find((a) => a instanceof Error) instanceof Error ? (args.find((a) => a instanceof Error) as Error).stack : undefined,
      });
      origErr(...args);
    };
    console.warn = (...args: unknown[]) => {
      pushLog({
        level: "warn",
        source: "console",
        message: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      });
      origWarn(...args);
    };
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      console.error = origErr;
      console.warn = origWarn;
    };
  }, [pushLog]);

  // Recompress when needed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updates: Receipt[] = [];
      let changed = false;
      for (const r of receipts) {
        const targetQ = r.qualityOverride ?? globalQuality;
        if (!r.compressed || r.compressed.quality !== targetQ) {
          try {
            const c = await compressImage(r.file, targetQ);
            if (cancelled) return;
            updates.push({ ...r, compressed: { quality: targetQ, ...c } });
            changed = true;
          } catch (e) {
            pushLog({
              level: "error",
              source: "compressImage",
              message: `${r.name}: ${(e as Error).message}`,
              stack: (e as Error).stack,
            });
            updates.push(r);
          }
        } else {
          updates.push(r);
        }
      }
      if (changed && !cancelled) setReceipts(updates);
    })();
    return () => {
      cancelled = true;
    };
  }, [receipts, globalQuality, pushLog]);

  // Rebuild PDF when compressed data ready
  useEffect(() => {
    let cancelled = false;
    const ready = receipts.every((r) => r.compressed);
    if (!ready || receipts.length === 0) {
      if (receipts.length === 0) {
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setPdfSize(0);
      }
      return;
    }
    setBuilding(true);
    (async () => {
      try {
        const bytes = await buildPdf(receipts.map((r) => r.compressed!));
        if (cancelled) return;
        const ab = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const blob = new Blob([ab], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setPdfSize(blob.size);
      } catch (e) {
        pushLog({
          level: "error",
          source: "buildPdf",
          message: (e as Error).message,
          stack: (e as Error).stack,
        });
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipts, pushLog]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      const newOnes: Receipt[] = [];
      for (const file of arr) {
        try {
          const hash = await sha256(file);
          const cachedDate = dateCache.current[hash];
          newOnes.push({
            id: crypto.randomUUID(),
            hash,
            name: file.name,
            originalSize: file.size,
            file,
            qualityOverride: null,
            date: cachedDate ?? undefined,
            aiState: "idle",
          });
        } catch (e) {
          pushLog({
            level: "error",
            source: "handleFiles",
            message: `${file.name}: ${(e as Error).message}`,
          });
        }
      }
      setReceipts((prev) => [...prev, ...newOnes]);
    },
    [pushLog],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  const removeReceipt = (id: string) => {
    setReceipts((prev) => prev.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const reorderByDate = () => {
    setReceipts((prev) => {
      const withDates = prev.filter((r) => r.date);
      const without = prev.filter((r) => !r.date);
      withDates.sort((a, b) => (a.date! < b.date! ? -1 : 1));
      return [...withDates, ...without];
    });
    toast.success("Sorted by date");
  };

  const refreshCredits = useCallback(
    async (silent = false) => {
      if (!apiKey) return;
      setCreditsLoading(true);
      try {
        const c = await fetchOpenRouterCredits(apiKey);
        setCredits(c);
      } catch (e) {
        pushLog({
          level: "error",
          source: "openrouter/credits",
          message: (e as Error).message,
        });
        if (!silent) toast.error(`Credits: ${(e as Error).message}`);
      } finally {
        setCreditsLoading(false);
      }
    },
    [apiKey, pushLog],
  );

  // Auto-load credits on key change
  useEffect(() => {
    if (apiKey) refreshCredits(true);
  }, [apiKey, refreshCredits]);

  const runAI = async () => {
    if (!apiKey) {
      toast.error("Add your OpenRouter API key first");
      return;
    }
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    localStorage.setItem(MODEL_STORAGE, model);
    let processed = 0;
    let fromCache = 0;
    for (const r of receipts) {
      if (r.date) continue;
      if (dateCache.current[r.hash] !== undefined) {
        const d = dateCache.current[r.hash];
        setReceipts((prev) =>
          prev.map((x) => (x.id === r.id ? { ...x, date: d, aiState: "done" } : x)),
        );
        fromCache++;
        continue;
      }
      if (!r.compressed) continue;
      setReceipts((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, aiState: "loading" } : x)),
      );
      try {
        const d = await extractDateWithAI(apiKey, r.compressed.dataUrl, model);
        dateCache.current[r.hash] = d;
        saveDateCache(dateCache.current);
        setReceipts((prev) =>
          prev.map((x) =>
            x.id === r.id ? { ...x, date: d, aiState: "done" } : x,
          ),
        );
        processed++;
      } catch (e) {
        const msg = (e as Error).message;
        pushLog({
          level: "error",
          source: `openrouter/${model}`,
          message: `${r.name}: ${msg}`,
          stack: (e as Error).stack,
        });
        setReceipts((prev) =>
          prev.map((x) => (x.id === r.id ? { ...x, aiState: "error" } : x)),
        );
        toast.error(`AI failed: ${msg}`);
      }
    }
    toast.success(`Extracted ${processed} dates (${fromCache} from cache)`);
    refreshCredits(true);
  };

  const setItemQuality = (id: string, q: number | null) => {
    setReceipts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, qualityOverride: q } : r)),
    );
  };

  const handleDragStart = (id: string) => (dragId.current = id);
  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (!dragId.current || dragId.current === id) return;
    setReceipts((prev) => {
      const from = prev.findIndex((r) => r.id === dragId.current);
      const to = prev.findIndex((r) => r.id === id);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const selected = useMemo(
    () => receipts.find((r) => r.id === selectedId),
    [receipts, selectedId],
  );

  const downloadPdf = () => {
    if (!pdfUrl) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = `receipts-${Date.now()}.pdf`;
    a.click();
  };

  const openPdfInNewTab = () => {
    if (pdfUrl) window.open(pdfUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <header className="mx-auto mb-6 flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Receipt<span className="text-primary">Forge</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Compress, sort, and export receipts to a single PDF.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <Input
              type="password"
              placeholder="OpenRouter API key"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                localStorage.setItem(API_KEY_STORAGE, e.target.value);
              }}
              className="h-8 w-56 border-0 bg-transparent p-0 focus-visible:ring-0"
            />
          </div>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              localStorage.setItem(MODEL_STORAGE, e.target.value);
            }}
            className="h-10 rounded-lg border bg-card px-2 text-xs shadow-sm"
            title="Free vision model"
          >
            {FREE_VISION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m.replace(":free", "")}
              </option>
            ))}
          </select>
          <div
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs shadow-sm"
            title="OpenRouter credits (total / used / remaining)"
          >
            <span className="text-muted-foreground">Credits:</span>
            {credits ? (
              <span className="font-mono">
                <span className="font-semibold text-primary">
                  ${credits.remaining.toFixed(4)}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  / ${credits.totalCredits.toFixed(2)} (used $
                  {credits.totalUsage.toFixed(4)})
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {apiKey ? "—" : "add key"}
              </span>
            )}
            <button
              onClick={() => refreshCredits()}
              disabled={!apiKey || creditsLoading}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw
                className={`h-3 w-3 ${creditsLoading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* LEFT */}
        <div className="space-y-4">
          <Card
            className="border-dashed bg-card/50 p-6"
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <label className="flex cursor-pointer flex-col items-center gap-3 text-center">
              <div className="rounded-full bg-primary/10 p-4">
                <Upload className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="font-medium">Drop receipts or click to upload</p>
                <p className="text-xs text-muted-foreground">
                  JPG, PNG, WebP — multiple files supported
                </p>
              </div>
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
              />
            </label>
          </Card>

          <Card className="space-y-4 p-5">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-sm">Global quality</Label>
                <span className="font-mono text-sm font-semibold text-primary">
                  {globalQuality}%
                </span>
              </div>
              <Slider
                value={[globalQuality]}
                onValueChange={(v) => setGlobalQuality(v[0])}
                min={5}
                max={100}
                step={5}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={runAI} variant="secondary" size="sm" disabled={!receipts.length}>
                <Sparkles className="mr-1.5 h-4 w-4" /> Extract dates (AI)
              </Button>
              <Button onClick={reorderByDate} variant="secondary" size="sm" disabled={!receipts.length}>
                <ArrowUpDown className="mr-1.5 h-4 w-4" /> Sort by date
              </Button>
              <Button onClick={downloadPdf} disabled={!pdfUrl} size="sm" className="ml-auto">
                <Download className="mr-1.5 h-4 w-4" /> Download PDF
              </Button>
            </div>
          </Card>

          {selected && (
            <Card className="space-y-3 p-5">
              <div className="flex items-center justify-between">
                <Label className="text-sm">
                  Selected: <span className="font-mono text-xs">{selected.name}</span>
                </Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setItemQuality(selected.id, null)}
                  disabled={selected.qualityOverride === null}
                >
                  Reset
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Override quality</Label>
                <span className="font-mono text-sm font-semibold text-primary">
                  {selected.qualityOverride ?? globalQuality}%
                  {selected.qualityOverride === null && (
                    <span className="ml-1 text-xs text-muted-foreground">(global)</span>
                  )}
                </span>
              </div>
              <Slider
                value={[selected.qualityOverride ?? globalQuality]}
                onValueChange={(v) => setItemQuality(selected.id, v[0])}
                min={5}
                max={100}
                step={5}
              />
            </Card>
          )}

          <div className="space-y-2">
            {receipts.map((r, i) => (
              <Card
                key={r.id}
                draggable
                onDragStart={() => handleDragStart(r.id)}
                onDragOver={(e) => handleDragOver(e, r.id)}
                onClick={() => setSelectedId(r.id)}
                className={`flex cursor-pointer items-center gap-3 p-2 transition ${
                  selectedId === r.id
                    ? "ring-2 ring-primary"
                    : "hover:bg-accent/30"
                }`}
              >
                <GripVertical className="h-4 w-4 text-muted-foreground" />
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold">
                  {i + 1}
                </div>
                {r.compressed && (
                  <img
                    src={r.compressed.dataUrl}
                    alt={r.name}
                    className="h-12 w-12 rounded-md object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.compressed
                      ? `${formatBytes(r.compressed.blob.size)} · ${r.compressed.quality}%`
                      : "Compressing…"}
                    {r.date && (
                      <span className="ml-2 rounded bg-success/15 px-1.5 py-0.5 font-mono text-[10px] text-success">
                        {r.date}
                      </span>
                    )}
                    {r.aiState === "loading" && (
                      <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />
                    )}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeReceipt(r.id);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </Card>
            ))}
            {!receipts.length && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No receipts yet.
              </p>
            )}
          </div>

          {/* Error / Log panel */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
              <div className="flex items-center gap-2">
                <AlertTriangle
                  className={`h-4 w-4 ${
                    logs.some((l) => l.level === "error")
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="text-sm font-semibold">
                  Errors & logs ({logs.length})
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLogs([])}
                disabled={!logs.length}
              >
                <Trash2 className="mr-1 h-3 w-3" /> Clear
              </Button>
            </div>
            <div className="max-h-60 overflow-auto">
              {logs.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  No errors. Client and server errors will appear here.
                </p>
              ) : (
                <ul className="divide-y">
                  {logs.map((l) => (
                    <li key={l.id} className="px-4 py-2 text-xs">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                            l.level === "error"
                              ? "bg-destructive/15 text-destructive"
                              : l.level === "warn"
                                ? "bg-yellow-500/15 text-yellow-600"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {l.level}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {new Date(l.ts).toLocaleTimeString()}
                        </span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {l.source}
                        </span>
                      </div>
                      <p className="mt-1 break-words font-mono text-[11px]">
                        {l.message}
                      </p>
                      {l.stack && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-muted-foreground">
                            stack
                          </summary>
                          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                            {l.stack}
                          </pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        {/* RIGHT: live preview (image-stack, Brave-safe) */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Live PDF preview</span>
                {building && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-md bg-card px-2 py-1 font-mono">
                  {receipts.length} {receipts.length === 1 ? "page" : "pages"}
                </span>
                <span className="rounded-md bg-primary/10 px-2 py-1 font-mono font-semibold text-primary">
                  {formatBytes(pdfSize)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={openPdfInNewTab}
                  disabled={!pdfUrl}
                  title="Open generated PDF in a new tab"
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="max-h-[80vh] space-y-4 overflow-auto bg-muted/40 p-4">
              {receipts.length === 0 ? (
                <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">
                  Upload receipts to see preview
                </div>
              ) : (
                receipts.map((r, i) => (
                  <div
                    key={r.id}
                    className="relative overflow-hidden rounded-md border bg-white shadow-sm"
                  >
                    <div className="absolute left-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
                      Page {i + 1} / {receipts.length}
                    </div>
                    {r.compressed ? (
                      <img
                        src={r.compressed.dataUrl}
                        alt={`Page ${i + 1}`}
                        className="block w-full"
                      />
                    ) : (
                      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Compressing…
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
              Note: Preview shows page images. Some browsers (e.g. Brave) block
              embedded PDF viewers — use{" "}
              <button
                onClick={openPdfInNewTab}
                disabled={!pdfUrl}
                className="underline disabled:opacity-50"
              >
                Open PDF
              </button>{" "}
              or{" "}
              <button
                onClick={downloadPdf}
                disabled={!pdfUrl}
                className="underline disabled:opacity-50"
              >
                Download
              </button>
              .
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

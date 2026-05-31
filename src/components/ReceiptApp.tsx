import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPdf,
  compressImage,
  extractDateWithAI,
  formatBytes,
  sha256,
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
} from "lucide-react";

type Receipt = {
  id: string;
  hash: string;
  name: string;
  originalSize: number;
  file: File;
  // per-item override of global quality (or null = use global)
  qualityOverride: number | null;
  // compressed cache
  compressed?: {
    quality: number;
    blob: Blob;
    dataUrl: string;
    width: number;
    height: number;
  };
  date?: string | null;
  aiState: "idle" | "loading" | "done" | "error";
};

const DATE_CACHE_KEY = "receipt-date-cache-v1";
const API_KEY_STORAGE = "openrouter-api-key";

function loadDateCache(): Record<string, string | null> {
  try {
    return JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveDateCache(c: Record<string, string | null>) {
  localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(c));
}

export function ReceiptApp() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [globalQuality, setGlobalQuality] = useState(70);
  const [apiKey, setApiKey] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfSize, setPdfSize] = useState(0);
  const [building, setBuilding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const dateCache = useRef<Record<string, string | null>>(loadDateCache());

  useEffect(() => {
    const k = localStorage.getItem(API_KEY_STORAGE);
    if (k) setApiKey(k);
  }, []);

  // Recompress when needed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updates: Receipt[] = [];
      let changed = false;
      for (const r of receipts) {
        const targetQ = r.qualityOverride ?? globalQuality;
        if (!r.compressed || r.compressed.quality !== targetQ) {
          const c = await compressImage(r.file, targetQ);
          if (cancelled) return;
          updates.push({ ...r, compressed: { quality: targetQ, ...c } });
          changed = true;
        } else {
          updates.push(r);
        }
      }
      if (changed && !cancelled) setReceipts(updates);
    })();
    return () => {
      cancelled = true;
    };
  }, [receipts, globalQuality]);

  // Rebuild PDF when compressed data ready
  useEffect(() => {
    let cancelled = false;
    const ready = receipts.every((r) => r.compressed);
    if (!ready || receipts.length === 0) {
      if (receipts.length === 0) {
        setPdfUrl(null);
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
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipts]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const newOnes: Receipt[] = [];
    for (const file of arr) {
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
    }
    setReceipts((prev) => [...prev, ...newOnes]);
  }, []);

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

  const runAI = async () => {
    if (!apiKey) {
      toast.error("Add your OpenRouter API key first");
      return;
    }
    localStorage.setItem(API_KEY_STORAGE, apiKey);
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
        const d = await extractDateWithAI(apiKey, r.compressed.dataUrl);
        dateCache.current[r.hash] = d;
        saveDateCache(dateCache.current);
        setReceipts((prev) =>
          prev.map((x) =>
            x.id === r.id ? { ...x, date: d, aiState: "done" } : x,
          ),
        );
        processed++;
      } catch (e) {
        setReceipts((prev) =>
          prev.map((x) => (x.id === r.id ? { ...x, aiState: "error" } : x)),
        );
        toast.error(`AI failed: ${(e as Error).message}`);
      }
    }
    toast.success(`Extracted ${processed} dates (${fromCache} from cache)`);
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

  return (
    <div className="min-h-screen p-4 md:p-8">
      <header className="mx-auto mb-6 flex max-w-[1600px] items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Receipt<span className="text-primary">Forge</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Compress, sort, and export receipts to a single PDF.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <Input
            type="password"
            placeholder="OpenRouter API key (optional)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-8 w-64 border-0 bg-transparent p-0 focus-visible:ring-0"
          />
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* LEFT: controls + list */}
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
        </div>

        {/* RIGHT: live preview */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Live PDF preview</span>
                {building && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="rounded-md bg-card px-2 py-1 font-mono">
                  {receipts.length} {receipts.length === 1 ? "page" : "pages"}
                </span>
                <span className="rounded-md bg-primary/10 px-2 py-1 font-mono font-semibold text-primary">
                  {formatBytes(pdfSize)}
                </span>
              </div>
            </div>
            <div className="aspect-[3/4] bg-muted">
              {pdfUrl ? (
                <iframe
                  src={pdfUrl}
                  className="h-full w-full"
                  title="PDF preview"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Upload receipts to see preview
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPdfsWithLimit,
  buildRenamedArchive,
  compressImage,
  extractDateRoundRobin,
  extractImagesFromArchive,
  fetchFreeVisionModelsList,
  fetchOpenRouterCredits,
  formatBytes,
  FREE_VISION_MODELS,
  safeSlug,
  splitImageVertically,
  timestamp,
  type AIDateEntry,
  type KeyStatus,
  type OpenRouterCredits,
  type PdfItem,
} from "@/lib/receipt-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Upload,
  Download,
  Sparkles,
  ArrowUpDown,
  X,
  Loader2,
  FileText,
  KeyRound,
  AlertTriangle,
  ExternalLink,
  Trash2,
  RefreshCw,
  Tag,
  Archive,
  Wand2,
  ChevronLeft,
  ChevronRight,
  Plus,
  Sun,
  Moon,
  Droplet,
  FileDown,
  Upload as UploadIcon,
  TableIcon,
  Maximize2,
  Check,
  Settings as SettingsIcon,
  EyeOff,
  Copy,
} from "lucide-react";

type DateSource = "ai" | "manual";
type Theme = "light" | "dark" | "blue";

type Receipt = {
  id: string;
  name: string;
  cacheKey: string;
  originalSize: number;
  file: File;
  qualityOverride: number | null;
  excluded?: boolean;
  compressed?: {
    quality: number;
    blob: Blob;
    dataUrl: string;
    width: number;
    height: number;
  };
  date?: string | null;
  dateRaw?: string | null;
  dateSource?: DateSource;
  // All dates the AI detected on this image (>=1). Used for multi-receipt review.
  aiDates?: AIDateEntry[];
  // User has confirmed the displayed date is correct.
  approved?: boolean;
  aiState: "idle" | "queued" | "loading" | "done" | "error";
};

type LogEntry = {
  id: string;
  ts: number;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  stack?: string;
};

const DATE_CACHE_KEY = "receipt-date-cache-v3";
const API_KEYS_STORAGE_V2 = "openrouter-api-keys-v2";
const MODEL_STORAGE = "openrouter-model";
const MODELS_LIST_STORAGE = "openrouter-models-list";
const THEME_STORAGE = "receipt-theme";
const SETTINGS_STORAGE = "receipt-settings-v1";
const YEAR_START_STORAGE = "receipt-year-start";
const YEAR_END_STORAGE = "receipt-year-end";

type CachedDate = {
  iso: string | null;
  raw: string | null;
  source?: DateSource;
  aiDates?: AIDateEntry[];
  approved?: boolean;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function makeCacheKey(file: { name: string; size: number }) {
  return `${file.name}::${file.size}`;
}

function loadDateCache(): Record<string, CachedDate> {
  try {
    const raw = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}");
    if (raw && typeof raw === "object") return raw as Record<string, CachedDate>;
  } catch {}
  return {};
}
function saveDateCache(c: Record<string, CachedDate>) {
  localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(c));
}

type SectionKey =
  | "actions"
  | "quality"
  | "keys"
  | "models"
  | "years"
  | "report-opts";

type Settings = {
  minKeyIntervalSec: number;
  maxPdfSizeMB: number;
  maxPdfSizeRangeMB: number;
  showDateLabel: boolean;
  gridPdf: boolean;
  gridCols: number;
  reportIncludeFilenames: boolean;
  cooldownAfterFailures: number;
  cooldownSec: number;
  autoSaveEnabled: boolean;
  autoSaveIntervalSec: number;
  // When AI detects multiple receipt dates on a single image, auto-split the
  // image into N horizontal slices and treat each slice as its own receipt.
  splitMultiReceipt: boolean;
  visibleSections: Record<SectionKey, boolean>;
};
const DEFAULT_SETTINGS: Settings = {
  minKeyIntervalSec: 0,
  maxPdfSizeMB: 10,
  maxPdfSizeRangeMB: 10,
  showDateLabel: false,
  gridPdf: false,
  gridCols: 3,
  reportIncludeFilenames: true,
  cooldownAfterFailures: 3,
  cooldownSec: 65,
  autoSaveEnabled: false,
  autoSaveIntervalSec: 60,
  splitMultiReceipt: false,
  visibleSections: {
    actions: true,
    quality: true,
    keys: true,
    models: true,
    years: true,
    "report-opts": true,
  },
};

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || "{}");
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      visibleSections: { ...DEFAULT_SETTINGS.visibleSections, ...(raw?.visibleSections ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function triggerDownload(blobOrUrl: Blob | string, filename: string) {
  const url =
    typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== "string") setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ReceiptApp() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [globalQuality, setGlobalQuality] = useState(70);
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [models, setModels] = useState<string[]>([...FREE_VISION_MODELS]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<string>(FREE_VISION_MODELS[0]);
  const [pdfs, setPdfs] = useState<
    { url: string; size: number; pageCount: number }[]
  >([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [building, setBuilding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [credits, setCredits] = useState<OpenRouterCredits | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [previewScale, setPreviewScale] = useState(220);
  const [imagePreviewId, setImagePreviewId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardQueue, setWizardQueue] = useState<string[]>([]);
  const [wizardPos, setWizardPos] = useState(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState({ done: 0, total: 0 });
  const [theme, setTheme] = useState<Theme>("light");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [reportOpen, setReportOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [yearStart, setYearStart] = useState(new Date().getFullYear() - 4);
  const [yearEnd, setYearEnd] = useState(new Date().getFullYear());

  const dateCache = useRef<Record<string, CachedDate>>(loadDateCache());
  const keyIndexRef = useRef(0);
  const keyStateRef = useRef<Record<string, KeyStatus>>({});
  const cancelAIRef = useRef(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const pushLog = useCallback((entry: Omit<LogEntry, "id" | "ts">) => {
    setLogs((prev) =>
      [{ ...entry, id: crypto.randomUUID(), ts: Date.now() }, ...prev].slice(0, 80),
    );
  }, []);

  // Initial load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(API_KEYS_STORAGE_V2);
      if (raw) setApiKeys(JSON.parse(raw));
      else {
        // migrate old format
        const old =
          localStorage.getItem("openrouter-api-keys") ||
          localStorage.getItem("openrouter-api-key") ||
          "";
        if (old) {
          const parsed = old.split(/[\s,;\n]+/).map((s) => s.trim()).filter(Boolean);
          setApiKeys(parsed);
        }
      }
    } catch {}
    const m = localStorage.getItem(MODEL_STORAGE);
    if (m) setModel(m);
    try {
      const list = JSON.parse(localStorage.getItem(MODELS_LIST_STORAGE) || "null");
      if (Array.isArray(list) && list.length) setModels(list);
    } catch {}
    setSettings(loadSettings());
    const t = (localStorage.getItem(THEME_STORAGE) as Theme) || "light";
    setTheme(t);
    const ys = Number(localStorage.getItem(YEAR_START_STORAGE));
    const ye = Number(localStorage.getItem(YEAR_END_STORAGE));
    if (ys) setYearStart(ys);
    if (ye) setYearEnd(ye);
  }, []);

  const hydratedRef = useRef(false);
  useEffect(() => {
    // mark hydrated after the initial-load effect above has run
    hydratedRef.current = true;
  }, []);
  useEffect(() => {
    if (!hydratedRef.current) return;
    localStorage.setItem(API_KEYS_STORAGE_V2, JSON.stringify(apiKeys));
  }, [apiKeys]);
  useEffect(() => {
    if (!hydratedRef.current) return;
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (!hydratedRef.current) return;
    localStorage.setItem(YEAR_START_STORAGE, String(yearStart));
    localStorage.setItem(YEAR_END_STORAGE, String(yearEnd));
  }, [yearStart, yearEnd]);

  // Theme application
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "theme-blue");
    if (theme === "dark") root.classList.add("dark");
    if (theme === "blue") root.classList.add("theme-blue");
    localStorage.setItem(THEME_STORAGE, theme);
  }, [theme]);

  // Auto-save exported data timer
  useEffect(() => {
    if (!settings.autoSaveEnabled || settings.autoSaveIntervalSec <= 0) return;
    const intervalMs = settings.autoSaveIntervalSec * 1000;
    const id = setInterval(() => {
      exportStorage();
    }, intervalMs);
    return () => clearInterval(id);
  }, [settings.autoSaveEnabled, settings.autoSaveIntervalSec]);

  // Capture errors
  useEffect(() => {
    const onErr = (e: ErrorEvent) =>
      pushLog({
        level: "error",
        source: `${e.filename || "window"}:${e.lineno || 0}`,
        message: e.message || String(e.error),
        stack: e.error?.stack,
      });
    const onRej = (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      pushLog({
        level: "error",
        source: "unhandledrejection",
        message: r?.message || String(r),
        stack: r?.stack,
      });
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, [pushLog]);

  // Compress
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
            });
            updates.push(r);
          }
        } else updates.push(r);
      }
      if (changed && !cancelled) setReceipts(updates);
    })();
    return () => {
      cancelled = true;
    };
  }, [receipts, globalQuality, pushLog]);

  // Auto-sorted receipts (display & PDF order)
  const sortedReceipts = useMemo(() => {
    const withD = receipts.filter((r) => r.date);
    const without = receipts.filter((r) => !r.date);
    withD.sort((a, b) =>
      sortDir === "asc"
        ? (a.date! < b.date! ? -1 : 1)
        : (a.date! > b.date! ? -1 : 1),
    );
    return [...withD, ...without];
  }, [receipts, sortDir]);

  // Rebuild PDFs whenever sorted order, quality, or pdf options change
  useEffect(() => {
    let cancelled = false;
    const ready = sortedReceipts.length > 0 && sortedReceipts.every((r) => r.compressed);
    if (!ready) {
      if (sortedReceipts.length === 0) {
        setPdfs((prev) => {
          prev.forEach((p) => URL.revokeObjectURL(p.url));
          return [];
        });
      }
      return;
    }
    setBuilding(true);
    (async () => {
      try {
        const limit = Math.max(1, settings.maxPdfSizeMB) * 1024 * 1024;
        const items: PdfItem[] = sortedReceipts
          .filter((r) => !r.excluded)
          .map((r) => ({
            ...r.compressed!,
            label: r.dateRaw || r.date || "",
          }));
        const out = await buildPdfsWithLimit(items, limit, {
          showLabel: settings.showDateLabel,
          grid: settings.gridPdf,
          gridCols: settings.gridCols,
        });
        if (cancelled) return;
        const next = out.map((p) => {
          const ab = p.bytes.buffer.slice(
            p.bytes.byteOffset,
            p.bytes.byteOffset + p.bytes.byteLength,
          ) as ArrayBuffer;
          const blob = new Blob([ab], { type: "application/pdf" });
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            pageCount: p.pageCount,
          };
        });
        setPdfs((prev) => {
          prev.forEach((p) => URL.revokeObjectURL(p.url));
          return next;
        });
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
  }, [
    sortedReceipts,
    settings.maxPdfSizeMB,
    settings.showDateLabel,
    settings.gridPdf,
    settings.gridCols,
    pushLog,
  ]);

  const ingestImageFiles = useCallback(async (arr: File[]) => {
    const newOnes: Receipt[] = arr.map((file) => {
      const cacheKey = makeCacheKey(file);
      const cached = dateCache.current[cacheKey];
      return {
        id: crypto.randomUUID(),
        name: file.name,
        cacheKey,
        originalSize: file.size,
        file,
        qualityOverride: null,
        date: cached?.iso ?? undefined,
        dateRaw: cached?.raw ?? undefined,
        dateSource: cached?.source,
        aiDates: cached?.aiDates,
        approved: cached?.approved,
        aiState: "idle",
      };
    });
    setReceipts((prev) => [...prev, ...newOnes]);
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const all = Array.from(files);
      const images = all.filter((f) => f.type.startsWith("image/"));
      const archives = all.filter(
        (f) =>
          /\.zip$/i.test(f.name) ||
          f.type === "application/zip" ||
          f.type === "application/x-zip-compressed",
      );
      if (images.length) await ingestImageFiles(images);
      for (const zipFile of archives) {
        try {
          const extracted = await extractImagesFromArchive(zipFile);
          if (!extracted.length) {
            toast.warning(`${zipFile.name}: no images found`);
            continue;
          }
          await ingestImageFiles(extracted);
          toast.success(`${zipFile.name}: imported ${extracted.length} image(s)`);
        } catch (e) {
          pushLog({
            level: "error",
            source: "archive",
            message: `${zipFile.name}: ${(e as Error).message}`,
          });
          toast.error(`Archive failed: ${(e as Error).message}`);
        }
      }
    },
    [ingestImageFiles, pushLog],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  const removeReceipt = (id: string) => {
    setReceipts((prev) => prev.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const toggleExclude = (id: string) => {
    setReceipts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, excluded: !r.excluded } : r)),
    );
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  const setReceiptDate = useCallback(
    (
      id: string,
      iso: string | null,
      raw: string | null,
      source: DateSource,
      opts: { approved?: boolean } = {},
    ) => {
      const approved = opts.approved ?? (source === "manual");
      let updated: Receipt | undefined;
      setReceipts((prev) =>
        prev.map((x) => {
          if (x.id !== id) return x;
          updated = {
            ...x,
            date: iso ?? undefined,
            dateRaw: raw ?? undefined,
            dateSource: source,
            approved,
            aiState: "done",
          };
          return updated;
        }),
      );
      const r = receipts.find((x) => x.id === id);
      if (r) {
        dateCache.current[r.cacheKey] = {
          iso,
          raw,
          source,
          aiDates: updated?.aiDates,
          approved,
        };
        saveDateCache(dateCache.current);
      }
    },
    [receipts],
  );

  const approveReceipt = useCallback((id: string) => {
    setReceipts((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, approved: true };
        dateCache.current[x.cacheKey] = {
          iso: x.date ?? null,
          raw: x.dateRaw ?? null,
          source: x.dateSource,
          aiDates: x.aiDates,
          approved: true,
        };
        saveDateCache(dateCache.current);
        return next;
      }),
    );
  }, []);

  const refreshCredits = useCallback(
    async (silent = false) => {
      const key = apiKeys[0];
      if (!key) return;
      setCreditsLoading(true);
      try {
        setCredits(await fetchOpenRouterCredits(key));
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
    [apiKeys, pushLog],
  );

  useEffect(() => {
    if (apiKeys.length) refreshCredits(true);
  }, [apiKeys, refreshCredits]);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const list = await fetchFreeVisionModelsList();
      if (list.length) {
        setModels(list);
        localStorage.setItem(MODELS_LIST_STORAGE, JSON.stringify(list));
        toast.success(`Loaded ${list.length} free vision models`);
      } else toast.warning("No models returned");
    } catch (e) {
      toast.error((e as Error).message);
      pushLog({ level: "error", source: "openrouter/models", message: (e as Error).message });
    } finally {
      setModelsLoading(false);
    }
  }, [pushLog]);

  const runAI = async () => {
    if (!apiKeys.length) {
      toast.error("Add at least one OpenRouter API key");
      return;
    }
    localStorage.setItem(MODEL_STORAGE, model);

    const queue = receipts.filter((r) => !r.date && r.compressed);
    if (!queue.length) {
      toast.info("Nothing to extract — all receipts already dated");
      return;
    }

    setReceipts((prev) =>
      prev.map((x) =>
        queue.some((q) => q.id === x.id) ? { ...x, aiState: "queued" } : x,
      ),
    );

    cancelAIRef.current = false;
    setAiRunning(true);
    setAiProgress({ done: 0, total: queue.length });
    let processed = 0;
    let fromCache = 0;

    for (const r of queue) {
      if (cancelAIRef.current) break;
      const cached = dateCache.current[r.cacheKey];
      if (cached !== undefined) {
        setReceipts((prev) =>
          prev.map((x) =>
            x.id === r.id
              ? {
                  ...x,
                  date: cached.iso ?? undefined,
                  dateRaw: cached.raw ?? undefined,
                  dateSource: cached.source,
                  aiDates: cached.aiDates,
                  approved: cached.approved,
                  aiState: "done",
                }
              : x,
          ),
        );
        fromCache++;
        setAiProgress((p) => ({ ...p, done: p.done + 1 }));
        continue;
      }
      setReceipts((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, aiState: "loading" } : x)),
      );
      try {
        const { result, nextIndex, usedKeyIndex } = await extractDateRoundRobin(
          apiKeys,
          keyStateRef.current,
          keyIndexRef.current,
          r.compressed!.dataUrl,
          model,
          {
            minIntervalMs: settings.minKeyIntervalSec * 1000,
            cooldownAfterFailures: settings.cooldownAfterFailures,
            cooldownMs: settings.cooldownSec * 1000,
          },
        );
        keyIndexRef.current = nextIndex;
        const dates = result.dates ?? [];

        // Multi-receipt image + split mode → replace this receipt with N slices,
        // each pre-tagged with the corresponding detected date (unapproved).
        if (dates.length > 1 && settings.splitMultiReceipt) {
          try {
            const parts = await splitImageVertically(r.file, dates.length);
            const newReceipts: Receipt[] = [];
            for (let i = 0; i < parts.length; i++) {
              const f = parts[i];
              const d = dates[i] ?? { iso: null, raw: null };
              const ck = makeCacheKey(f);
              newReceipts.push({
                id: crypto.randomUUID(),
                name: f.name,
                cacheKey: ck,
                originalSize: f.size,
                file: f,
                qualityOverride: null,
                date: d.iso ?? undefined,
                dateRaw: d.raw ?? undefined,
                dateSource: "ai",
                approved: false,
                aiDates: [d],
                aiState: "done",
              });
              dateCache.current[ck] = {
                iso: d.iso,
                raw: d.raw,
                source: "ai",
                aiDates: [d],
                approved: false,
              };
            }
            saveDateCache(dateCache.current);
            setReceipts((prev) => {
              const idx = prev.findIndex((x) => x.id === r.id);
              if (idx < 0) return prev;
              const next = [...prev];
              next.splice(idx, 1, ...newReceipts);
              return next;
            });
            pushLog({
              level: "info",
              source: `openrouter/key#${usedKeyIndex + 1}`,
              message: `${r.name} → split into ${parts.length} (${dates.map((d) => d.raw ?? d.iso ?? "?").join(", ")})`,
            });
            toast.success(`${r.name}: split into ${parts.length} receipts`);
            processed++;
            setAiProgress((p) => ({ ...p, done: p.done + 1 }));
            continue;
          } catch (splitErr) {
            pushLog({
              level: "error",
              source: "splitImage",
              message: `${r.name}: ${(splitErr as Error).message}`,
            });
            // fall through to single-receipt handling below
          }
        }

        dateCache.current[r.cacheKey] = {
          iso: result.iso,
          raw: result.raw,
          source: "ai",
          aiDates: dates,
          approved: false,
        };
        saveDateCache(dateCache.current);
        setReceipts((prev) =>
          prev.map((x) =>
            x.id === r.id
              ? {
                  ...x,
                  date: result.iso ?? undefined,
                  dateRaw: result.raw ?? undefined,
                  dateSource: "ai",
                  aiDates: dates,
                  approved: false,
                  aiState: "done",
                }
              : x,
          ),
        );
        processed++;
        pushLog({
          level: "info",
          source: `openrouter/key#${usedKeyIndex + 1}`,
          message: `${r.name} → ${result.raw ?? "NONE"} (${result.iso ?? "—"})${dates.length > 1 ? ` [+${dates.length - 1} more]` : ""}`,
        });
        if (dates.length > 1) {
          toast.warning(
            `${r.name}: detected ${dates.length} receipts — review in wizard`,
          );
        }
      } catch (e) {
        const msg = (e as Error).message;
        pushLog({
          level: "error",
          source: `openrouter/${model}`,
          message: `${r.name}: ${msg}`,
        });
        setReceipts((prev) =>
          prev.map((x) => (x.id === r.id ? { ...x, aiState: "error" } : x)),
        );
        toast.error(`AI failed: ${msg}`);
      }
      setAiProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    setAiRunning(false);
    toast.success(`Extracted ${processed} dates (${fromCache} from cache)`);
    refreshCredits(true);
  };

  const setItemQuality = (id: string, q: number | null) =>
    setReceipts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, qualityOverride: q } : r)),
    );

  const selected = useMemo(
    () => receipts.find((r) => r.id === selectedId),
    [receipts, selectedId],
  );

  const totalPdfSize = useMemo(() => pdfs.reduce((s, p) => s + p.size, 0), [pdfs]);

  const stamp = () => timestamp();

  const downloadAllPdfs = () => {
    const t = stamp();
    pdfs.forEach((p, i) =>
      triggerDownload(
        p.url,
        pdfs.length === 1
          ? `receipts-${t}.pdf`
          : `receipts-${t}-part${i + 1}.pdf`,
      ),
    );
  };

  const openPdfInNewTab = (url: string) =>
    window.open(url, "_blank", "noopener,noreferrer");

  const years = useMemo(() => {
    const a = Math.min(yearStart, yearEnd);
    const b = Math.max(yearStart, yearEnd);
    return Array.from({ length: b - a + 1 }, (_, i) => b - i);
  }, [yearStart, yearEnd]);

  const previewImage = receipts.find((r) => r.id === imagePreviewId);

  const buildWizardQueue = () => {
    // Priority: untagged → AI-tagged-but-unapproved → approved/manual
    const untagged = receipts.filter((r) => !r.date).map((r) => r.id);
    const needsReview = sortedReceipts
      .filter((r) => r.date && r.dateSource === "ai" && !r.approved)
      .map((r) => r.id);
    const rest = sortedReceipts
      .filter((r) => r.date && !(r.dateSource === "ai" && !r.approved))
      .map((r) => r.id);
    return [...untagged, ...needsReview, ...rest];
  };
  const startWizard = (focusId?: string) => {
    const q = buildWizardQueue();
    if (!q.length) return;
    setWizardQueue(q);
    setWizardPos(focusId ? Math.max(0, q.indexOf(focusId)) : 0);
    setWizardOpen(true);
  };
  const wizardReceipt = receipts.find((r) => r.id === wizardQueue[wizardPos]);

  // Split a receipt into N slices (user-driven from the wizard).
  const splitReceiptIntoParts = async (id: string, dates: AIDateEntry[]) => {
    const r = receipts.find((x) => x.id === id);
    if (!r || dates.length < 2) return;
    try {
      const parts = await splitImageVertically(r.file, dates.length);
      const newReceipts: Receipt[] = parts.map((f, i) => {
        const d = dates[i] ?? { iso: null, raw: null };
        const ck = makeCacheKey(f);
        dateCache.current[ck] = {
          iso: d.iso,
          raw: d.raw,
          source: "ai",
          aiDates: [d],
          approved: false,
        };
        return {
          id: crypto.randomUUID(),
          name: f.name,
          cacheKey: ck,
          originalSize: f.size,
          file: f,
          qualityOverride: null,
          date: d.iso ?? undefined,
          dateRaw: d.raw ?? undefined,
          dateSource: "ai",
          approved: false,
          aiDates: [d],
          aiState: "done",
        };
      });
      saveDateCache(dateCache.current);
      setReceipts((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        if (idx < 0) return prev;
        const next = [...prev];
        next.splice(idx, 1, ...newReceipts);
        return next;
      });
      // Rebuild wizard queue and jump to first new slice
      const newIds = newReceipts.map((nr) => nr.id);
      setWizardQueue((q) => {
        const pos = q.indexOf(id);
        if (pos < 0) return [...q, ...newIds];
        const next = [...q];
        next.splice(pos, 1, ...newIds);
        return next;
      });
      toast.success(`Split into ${parts.length} receipts`);
    } catch (e) {
      toast.error(`Split failed: ${(e as Error).message}`);
      pushLog({
        level: "error",
        source: "splitImage",
        message: (e as Error).message,
      });
    }
  };

  // Key management
  const addKey = () => {
    const k = newKey.trim();
    if (!k) return;
    if (apiKeys.includes(k)) {
      toast.warning("Key already added");
      return;
    }
    setApiKeys((p) => [...p, k]);
    setNewKey("");
  };
  const removeKey = (i: number) =>
    setApiKeys((p) => p.filter((_, idx) => idx !== i));

  // Export / import localStorage
  const exportStorage = () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      data[k] = localStorage.getItem(k) ?? "";
    }
    triggerDownload(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `receiptforge-storage-${stamp()}.json`,
    );
  };
  const importStorage = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error("Invalid file");
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") localStorage.setItem(k, v);
      }
      toast.success("Storage imported — reloading");
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    }
  };

  // Date report
  const downloadDateReport = () => {
    const lines = ["date_iso\tdate_raw" + (settings.reportIncludeFilenames ? "\tfilename" : "")];
    for (const r of sortedReceipts) {
      const row = [
        r.date ?? "",
        (r.dateRaw ?? "").replace(/\t/g, " "),
        settings.reportIncludeFilenames ? r.name : "",
      ].filter((_, i) => i < 2 || settings.reportIncludeFilenames);
      lines.push(row.join("\t"));
    }
    triggerDownload(
      new Blob([lines.join("\n")], { type: "text/tab-separated-values" }),
      `receipt-dates-${stamp()}.tsv`,
    );
  };

  // Renamed-archive export
  const downloadRenamedArchive = async () => {
    if (!sortedReceipts.length) return;
    const items: { blob: Blob; name: string }[] = [];
    for (const r of sortedReceipts) {
      const blob: Blob = r.compressed?.blob ?? r.file;
      const ext = (r.name.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
      const base = r.date
        ? `${r.date}_${safeSlug(r.name.replace(/\.[^.]+$/, ""))}`
        : `undated_${safeSlug(r.name.replace(/\.[^.]+$/, ""))}`;
      items.push({ blob, name: `${base}.${ext}` });
    }
    toast.info("Building archive…");
    const zip = await buildRenamedArchive(items);
    triggerDownload(zip, `receipts-renamed-${stamp()}.zip`);
  };

  // Year×Month matrix data
  const matrix = useMemo(() => {
    const out: Record<number, boolean[]> = {};
    for (const r of receipts) {
      if (!r.date) continue;
      const y = Number(r.date.slice(0, 4));
      const m = Number(r.date.slice(5, 7));
      if (!out[y]) out[y] = Array(12).fill(false);
      out[y][m - 1] = true;
    }
    return out;
  }, [receipts]);

  return (
    <div className="min-h-screen p-4 md:p-8">
      <header className="mx-auto mb-4 flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Receipt<span className="text-primary">Forge</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Compress, sort, and export receipts to PDF.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs shadow-sm"
            title="OpenRouter credits (first key)"
          >
            <span className="text-muted-foreground">Credits:</span>
            {credits ? (
              <span className="font-mono">
                <span className="font-semibold text-primary">
                  ${credits.remaining.toFixed(4)}
                </span>
                <span className="text-muted-foreground">
                  {" "}/ ${credits.totalCredits.toFixed(2)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {apiKeys.length ? "—" : "add key"}
              </span>
            )}
            <button
              onClick={() => refreshCredits()}
              disabled={!apiKeys.length || creditsLoading}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${creditsLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="flex items-center rounded-lg border bg-card p-1 shadow-sm">
            <button
              onClick={() => setTheme("light")}
              className={`rounded px-2 py-1 ${theme === "light" ? "bg-accent" : ""}`}
              title="Light"
            >
              <Sun className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`rounded px-2 py-1 ${theme === "dark" ? "bg-accent" : ""}`}
              title="Dark"
            >
              <Moon className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setTheme("blue")}
              className={`rounded px-2 py-1 ${theme === "blue" ? "bg-accent" : ""}`}
              title="Blue"
            >
              <Droplet className="h-3.5 w-3.5" />
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
                <p className="font-medium">Drop receipts, ZIP archives, or click to upload</p>
                <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                  JPG, PNG, WebP · <Archive className="h-3 w-3" /> ZIP (in-memory)
                </p>
              </div>
              <input
                type="file"
                accept="image/*,.zip,application/zip"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </Card>

          <Card className="p-3">
            <div className="flex justify-end pb-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSettingsDialogOpen(true)}
                title="Show/hide controls"
              >
                <SettingsIcon className="mr-1 h-3.5 w-3.5" /> Controls
              </Button>
            </div>
            <Accordion type="multiple" defaultValue={["actions"]}>
              {settings.visibleSections.actions && (
              <AccordionItem value="actions">
                <AccordionTrigger className="py-2">Actions</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={runAI} variant="secondary" size="sm" disabled={!receipts.length || aiRunning}>
                      {aiRunning ? (
                        <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{aiProgress.done}/{aiProgress.total}</>
                      ) : (
                        <><Sparkles className="mr-1.5 h-4 w-4" /> Extract dates (AI)</>
                      )}
                    </Button>
                    {aiRunning && (
                      <Button size="sm" variant="ghost" onClick={() => (cancelAIRef.current = true)}>Stop</Button>
                    )}
                    <Button onClick={() => startWizard()} variant="secondary" size="sm" disabled={!receipts.length}>
                      <Wand2 className="mr-1.5 h-4 w-4" /> Review wizard
                    </Button>
                    <Button
                      onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                      variant="secondary"
                      size="sm"
                      disabled={!receipts.length}
                      title="Flip sort direction (auto-sorted by date)"
                    >
                      <ArrowUpDown className="mr-1.5 h-4 w-4" /> {sortDir === "asc" ? "Asc" : "Desc"}
                    </Button>
                    <Button onClick={downloadAllPdfs} disabled={!pdfs.length} size="sm" className="ml-auto">
                      <Download className="mr-1.5 h-4 w-4" />
                      {pdfs.length > 1 ? `Download ${pdfs.length} PDFs` : "Download PDF"}
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                    <Button size="sm" variant="outline" onClick={() => setReportOpen(true)} disabled={!receipts.length}>
                      <FileDown className="mr-1 h-3 w-3" /> Date report
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setMatrixOpen(true)} disabled={!receipts.length}>
                      <TableIcon className="mr-1 h-3 w-3" /> Year/Month matrix
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadRenamedArchive} disabled={!receipts.length}>
                      <Archive className="mr-1 h-3 w-3" /> Renamed ZIP
                    </Button>
                    <Button size="sm" variant="outline" onClick={exportStorage}>
                      <FileDown className="mr-1 h-3 w-3" /> Export data
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => importFileRef.current?.click()}>
                      <UploadIcon className="mr-1 h-3 w-3" /> Import data
                    </Button>
                    <input
                      ref={importFileRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) importStorage(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="autosave"
                        checked={settings.autoSaveEnabled}
                        onCheckedChange={(c) =>
                          setSettings((s) => ({ ...s, autoSaveEnabled: c === true }))
                        }
                      />
                      <Label htmlFor="autosave" className="text-sm">
                        Auto-save exported data
                      </Label>
                    </div>
                    {settings.autoSaveEnabled && (
                      <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground">Every</Label>
                        <Input
                          type="number"
                          min={5}
                          max={3600}
                          value={settings.autoSaveIntervalSec}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              autoSaveIntervalSec: Math.max(5, Number(e.target.value) || 60),
                            }))
                          }
                          className="h-7 w-20 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">seconds</span>
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
              )}

              {settings.visibleSections.quality && (
              <AccordionItem value="quality">
                <AccordionTrigger className="py-2">
                  Quality & PDF size
                </AccordionTrigger>
                <AccordionContent className="space-y-4">
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <Label className="text-sm">Global quality</Label>
                      <span className="font-mono text-sm font-semibold text-primary">{globalQuality}%</span>
                    </div>
                    <Slider value={[globalQuality]} onValueChange={(v) => setGlobalQuality(v[0])} min={5} max={100} step={5} />
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <Label className="text-sm">Max PDF size</Label>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-primary">
                          {settings.maxPdfSizeMB} MB
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={500}
                          value={settings.maxPdfSizeRangeMB}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              maxPdfSizeRangeMB: Math.max(1, Number(e.target.value) || 1),
                            }))
                          }
                          className="h-7 w-20 text-xs"
                          title="Slider max range (MB)"
                        />
                      </div>
                    </div>
                    <Slider
                      value={[Math.min(settings.maxPdfSizeMB, settings.maxPdfSizeRangeMB)]}
                      onValueChange={(v) => setSettings((s) => ({ ...s, maxPdfSizeMB: v[0] }))}
                      min={1}
                      max={settings.maxPdfSizeRangeMB}
                      step={1}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="datelbl"
                      checked={settings.showDateLabel}
                      onCheckedChange={(c) =>
                        setSettings((s) => ({ ...s, showDateLabel: c === true }))
                      }
                    />
                    <Label htmlFor="datelbl" className="text-sm">
                      Add date tag below each image in PDF
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="gridpdf"
                      checked={settings.gridPdf}
                      onCheckedChange={(c) =>
                        setSettings((s) => ({ ...s, gridPdf: c === true }))
                      }
                    />
                    <Label htmlFor="gridpdf" className="text-sm">
                      Grid PDF (images per page like preview)
                    </Label>
                    {settings.gridPdf && (
                      <Input
                        type="number"
                        min={1}
                        max={6}
                        value={settings.gridCols}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, gridCols: Math.max(1, Math.min(6, Number(e.target.value) || 3)) }))
                        }
                        className="h-7 w-16 text-xs"
                        title="Columns"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2 border-t pt-2">
                    <Checkbox
                      id="splitmulti"
                      checked={settings.splitMultiReceipt}
                      onCheckedChange={(c) =>
                        setSettings((s) => ({ ...s, splitMultiReceipt: c === true }))
                      }
                    />
                    <Label htmlFor="splitmulti" className="text-sm">
                      When AI detects multiple receipts on one image, auto-split into separate images
                    </Label>
                  </div>
                </AccordionContent>
              </AccordionItem>
              )}

              {settings.visibleSections.keys && (
              <AccordionItem value="keys">
                <AccordionTrigger className="py-2">
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" /> OpenRouter API keys ({apiKeys.length})
                  </span>
                </AccordionTrigger>
                <AccordionContent className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="sk-or-…"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addKey()}
                      className="text-xs font-mono"
                    />
                    <Button size="sm" onClick={addKey}>
                      <Plus className="mr-1 h-3 w-3" /> Add
                    </Button>
                  </div>
                  {apiKeys.length > 0 && (
                    <ul className="space-y-1">
                      {apiKeys.map((k, i) => {
                        const st = keyStateRef.current[k];
                        const cooling =
                          st && st.cooldownUntil > Date.now()
                            ? Math.ceil((st.cooldownUntil - Date.now()) / 1000)
                            : 0;
                        return (
                          <li
                            key={i}
                            className="flex items-center justify-between gap-2 rounded border bg-muted/30 px-2 py-1"
                          >
                            <span className="truncate font-mono text-[11px]">
                              #{i + 1} · {k.slice(0, 10)}…{k.slice(-4)}
                            </span>
                            {cooling > 0 && (
                              <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                                cooldown {cooling}s
                              </span>
                            )}
                            <Button size="icon" variant="ghost" onClick={() => removeKey(i)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="flex items-center justify-between gap-2 pt-2">
                    <Label className="text-xs">Min delay between key uses</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={120}
                        value={settings.minKeyIntervalSec}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            minKeyIntervalSec: Math.max(0, Number(e.target.value) || 0),
                          }))
                        }
                        className="h-7 w-20 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">sec</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Cooldown after N failures</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        value={settings.cooldownAfterFailures}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cooldownAfterFailures: Math.max(1, Number(e.target.value) || 3),
                          }))
                        }
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">→</span>
                      <Input
                        type="number"
                        min={5}
                        value={settings.cooldownSec}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cooldownSec: Math.max(5, Number(e.target.value) || 65),
                          }))
                        }
                        className="h-7 w-20 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">sec</span>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              )}

              {settings.visibleSections.models && (
              <AccordionItem value="models">
                <AccordionTrigger className="py-2">
                  Model ({models.length} free)
                </AccordionTrigger>
                <AccordionContent className="space-y-2">
                  <div className="flex gap-2">
                    <select
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        localStorage.setItem(MODEL_STORAGE, e.target.value);
                      }}
                      className="h-9 flex-1 rounded-md border bg-card px-2 text-xs"
                    >
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="outline" onClick={refreshModels} disabled={modelsLoading}>
                      {modelsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      <span className="ml-1">Fetch free</span>
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Lists active vision-capable models with max_price=0.
                  </p>
                </AccordionContent>
              </AccordionItem>
              )}

              {settings.visibleSections.years && (
              <AccordionItem value="years">
                <AccordionTrigger className="py-2">Manual tag year range</AccordionTrigger>
                <AccordionContent>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">From</Label>
                    <Input
                      type="number"
                      value={yearStart}
                      onChange={(e) => setYearStart(Number(e.target.value) || yearStart)}
                      className="h-7 w-24 text-xs"
                    />
                    <Label className="text-xs">To</Label>
                    <Input
                      type="number"
                      value={yearEnd}
                      onChange={(e) => setYearEnd(Number(e.target.value) || yearEnd)}
                      className="h-7 w-24 text-xs"
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
              )}

              {settings.visibleSections["report-opts"] && (
              <AccordionItem value="report-opts">
                <AccordionTrigger className="py-2">Report options</AccordionTrigger>
                <AccordionContent>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="rincl"
                      checked={settings.reportIncludeFilenames}
                      onCheckedChange={(c) =>
                        setSettings((s) => ({ ...s, reportIncludeFilenames: c === true }))
                      }
                    />
                    <Label htmlFor="rincl" className="text-sm">
                      Include filenames in date report
                    </Label>
                  </div>
                </AccordionContent>
              </AccordionItem>
              )}
            </Accordion>
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
                </span>
              </div>
              <Slider
                value={[selected.qualityOverride ?? globalQuality]}
                onValueChange={(v) => setItemQuality(selected.id, v[0])}
                min={5}
                max={100}
                step={5}
              />
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button size="sm" variant="secondary" onClick={() => startWizard(selected.id)}>
                  <Wand2 className="mr-1 h-3 w-3" /> Open in wizard to tag/edit date
                </Button>
              </div>
            </Card>
          )}

          <Accordion type="single" collapsible defaultValue="list">
            <AccordionItem value="list">
              <AccordionTrigger className="py-2">
                Receipts ({receipts.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2">
                  {sortedReceipts.map((r, i) => (
                    <Card
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      onDoubleClick={() => setImagePreviewId(r.id)}
                      title="Double-click to view large"
                      className={`flex cursor-pointer items-center gap-3 p-2 transition ${
                        selectedId === r.id ? "ring-2 ring-primary" : "hover:bg-accent/30"
                      }`}
                    >
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold">
                        {i + 1}
                      </div>
                      {r.compressed && (
                        <img src={r.compressed.dataUrl} alt={r.name} className="h-12 w-12 rounded-md object-cover" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.compressed
                            ? `${formatBytes(r.compressed.blob.size)} · ${r.compressed.quality}%`
                            : "Compressing…"}
                          {r.date && (
                            <span
                              className={`ml-2 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                r.dateSource === "ai"
                                  ? "bg-primary/15 text-primary"
                                  : "bg-emerald-500/15 text-emerald-600"
                              }`}
                              title={r.dateSource === "ai" ? "AI extracted" : "Manually tagged"}
                            >
                              {r.dateSource === "ai" ? (
                                <Sparkles className="h-2.5 w-2.5" />
                              ) : (
                                <Tag className="h-2.5 w-2.5" />
                              )}
                              {r.dateRaw || r.date}
                            </span>
                          )}
                          {r.date && r.dateSource === "ai" && !r.approved && (
                            <span
                              className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-600"
                              title="AI detection — open wizard to review/approve"
                            >
                              {r.aiDates && r.aiDates.length > 1 ? `?×${r.aiDates.length}` : "?"}
                            </span>
                          )}
                          {r.aiState === "queued" && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">queued</span>
                          )}
                          {r.aiState === "loading" && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
                          {r.aiState === "error" && (
                            <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                              AI error
                            </span>
                          )}
                        </p>
                      </div>
                      <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); setImagePreviewId(r.id); }} title="Preview">
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); removeReceipt(r.id); }}>
                        <X className="h-4 w-4" />
                      </Button>
                    </Card>
                  ))}
                  {!receipts.length && (
                    <p className="py-6 text-center text-sm text-muted-foreground">No receipts yet.</p>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="logs">
              <AccordionTrigger className="py-2">
                <span className="flex items-center gap-2">
                  <AlertTriangle
                    className={`h-4 w-4 ${logs.some((l) => l.level === "error") ? "text-destructive" : "text-muted-foreground"}`}
                  />
                  Errors & logs ({logs.length})
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const text = logs
                        .map(
                          (l) =>
                            `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.source}\n${l.message}${l.stack ? "\n" + l.stack : ""}`,
                        )
                        .join("\n\n");
                      copyToClipboard(text);
                    }}
                    disabled={!logs.length}
                  >
                    <Copy className="mr-1 h-3 w-3" /> Copy all
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setLogs([])} disabled={!logs.length}>
                    <Trash2 className="mr-1 h-3 w-3" /> Clear
                  </Button>
                </div>
                <div className="max-h-96 overflow-auto">
                  {logs.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">No errors.</p>
                  ) : (
                    <ul className="divide-y">
                      {logs.map((l) => {
                        const expanded = expandedLogId === l.id;
                        const fullText = `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.source}\n${l.message}${l.stack ? "\n" + l.stack : ""}`;
                        return (
                          <li key={l.id} className="px-1 py-2 text-xs">
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
                              <span className="truncate font-mono text-[10px] text-muted-foreground">{l.source}</span>
                              <button
                                onClick={() => copyToClipboard(fullText)}
                                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                title="Copy"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                              {l.stack && (
                                <button
                                  onClick={() => setExpandedLogId(expanded ? null : l.id)}
                                  className="rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                  {expanded ? "hide" : "stack"}
                                </button>
                              )}
                            </div>
                            <p className="mt-1 break-words font-mono text-[11px] whitespace-pre-wrap">{l.message}</p>
                            {expanded && l.stack && (
                              <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] whitespace-pre-wrap break-all">
                                {l.stack}
                              </pre>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* RIGHT */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Live PDF preview</span>
                {building && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md bg-card px-2 py-1 font-mono">
                  {receipts.length} {receipts.length === 1 ? "image" : "images"}
                </span>
                <span className="rounded-md bg-card px-2 py-1 font-mono">
                  {pdfs.reduce((s, p) => s + p.pageCount, 0)} pages
                </span>
                <span className="rounded-md bg-card px-2 py-1 font-mono">
                  {pdfs.length} {pdfs.length === 1 ? "PDF" : "PDFs"}
                </span>
                <span className="rounded-md bg-primary/10 px-2 py-1 font-mono font-semibold text-primary">
                  {formatBytes(totalPdfSize)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-2">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">Grid scale</Label>
              <Slider value={[previewScale]} onValueChange={(v) => setPreviewScale(v[0])} min={120} max={500} step={10} className="flex-1" />
              <span className="w-12 text-right font-mono text-xs text-muted-foreground">{previewScale}px</span>
            </div>

            {pdfs.length > 0 && (
              <div className="space-y-1 border-b bg-muted/20 px-4 py-2">
                {pdfs.map((p, i) => (
                  <div key={p.url} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono">
                      {pdfs.length > 1 ? `Part ${i + 1}` : "PDF"} · {p.pageCount} {p.pageCount === 1 ? "page" : "pages"} ·{" "}
                      <span className="font-semibold text-primary">{formatBytes(p.size)}</span>
                    </span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openPdfInNewTab(p.url)} title="Open">
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const t = stamp();
                          triggerDownload(
                            p.url,
                            pdfs.length === 1 ? `receipts-${t}.pdf` : `receipts-${t}-part${i + 1}.pdf`,
                          );
                        }}
                      >
                        <Download className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="max-h-[80vh] overflow-auto bg-muted/40 p-4">
              {sortedReceipts.length === 0 ? (
                <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">
                  Upload receipts to see preview
                </div>
              ) : (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${previewScale}px, 1fr))` }}>
                  {sortedReceipts.map((r, i) => (
                    <div
                      key={r.id}
                      className={`group relative cursor-pointer overflow-hidden rounded-md border bg-white shadow-sm ${r.excluded ? "opacity-40 ring-2 ring-destructive/50" : ""}`}
                      onClick={() => setSelectedId(r.id)}
                      onDoubleClick={() => setImagePreviewId(r.id)}
                    >
                      <div className="absolute left-1 top-1 z-10 flex flex-wrap gap-1">
                        <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">{i + 1}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startWizard(r.id);
                          }}
                          className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] transition hover:ring-2 hover:ring-white ${
                            !r.date
                              ? "bg-muted-foreground/70 text-white"
                              : r.dateSource === "ai"
                                ? "bg-primary/80 text-primary-foreground"
                                : "bg-emerald-600/80 text-white"
                          }`}
                        >
                          {r.dateSource === "ai" ? (
                            <Sparkles className="h-2.5 w-2.5" />
                          ) : (
                            <Tag className="h-2.5 w-2.5" />
                          )}
                          {r.dateRaw || r.date || "tag…"}
                        </button>
                        {r.excluded && (
                          <span className="rounded bg-destructive/80 px-1.5 py-0.5 font-mono text-[10px] text-white">
                            excluded
                          </span>
                        )}
                      </div>
                      <div className="absolute right-1 top-1 z-10 flex gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          className="rounded bg-black/50 p-1 text-white hover:bg-black/70"
                          onClick={(e) => {
                            e.stopPropagation();
                            setImagePreviewId(r.id);
                          }}
                          title="Preview large"
                        >
                          <Maximize2 className="h-3 w-3" />
                        </button>
                        <button
                          className={`rounded p-1 text-white ${r.excluded ? "bg-emerald-600/80 hover:bg-emerald-600" : "bg-yellow-600/70 hover:bg-yellow-600"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExclude(r.id);
                          }}
                          title={r.excluded ? "Include in PDF" : "Exclude from PDF"}
                        >
                          <EyeOff className="h-3 w-3" />
                        </button>
                        <button
                          className="rounded bg-destructive/80 p-1 text-white hover:bg-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeReceipt(r.id);
                          }}
                          title="Remove image"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      {r.compressed ? (
                        <img src={r.compressed.dataUrl} alt={`Page ${i + 1}`} className="block w-full" />
                      ) : (
                        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Compressing…
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
              Auto-sorted by date {sortDir === "asc" ? "↑" : "↓"}. Double-click for large preview. Click date chip to edit in wizard.
            </div>
          </Card>
        </div>
      </div>

      {/* Large image preview */}
      <Dialog open={!!previewImage} onOpenChange={(o) => !o && setImagePreviewId(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{previewImage?.name}</DialogTitle>
          </DialogHeader>
          {previewImage?.compressed && (
            <div className="max-h-[80vh] overflow-auto">
              <img src={previewImage.compressed.dataUrl} alt={previewImage.name} className="mx-auto block" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Wizard */}
      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" />
              Review dates ({wizardPos + 1} / {wizardQueue.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">untagged first</span>
            </DialogTitle>
          </DialogHeader>
          {wizardReceipt && (
            <WizardStep
              key={wizardReceipt.id}
              receipt={wizardReceipt}
              years={years}
              onChange={(iso, raw) => {
                setReceiptDate(wizardReceipt.id, iso, raw, "manual", { approved: true });
                toast.success(iso ? `Saved date: ${raw || iso}` : "Date cleared");
              }}
              onApprove={() => {
                approveReceipt(wizardReceipt.id);
                toast.success("Approved");
                if (wizardPos < wizardQueue.length - 1) setWizardPos((i) => i + 1);
              }}
              onPickDetected={(d) => {
                setReceiptDate(wizardReceipt.id, d.iso, d.raw, "ai", { approved: true });
                toast.success(`Picked: ${d.raw || d.iso || "?"}`);
              }}
              onSplit={() => {
                if (wizardReceipt.aiDates && wizardReceipt.aiDates.length > 1) {
                  splitReceiptIntoParts(wizardReceipt.id, wizardReceipt.aiDates);
                }
              }}
              onClear={() => {
                setReceipts((prev) =>
                  prev.map((x) =>
                    x.id === wizardReceipt.id
                      ? { ...x, date: undefined, dateRaw: undefined, dateSource: undefined, approved: false, aiState: "idle" }
                      : x,
                  ),
                );
                delete dateCache.current[wizardReceipt.cacheKey];
                saveDateCache(dateCache.current);
              }}
            />
          )}
          <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
            <Button variant="outline" size="sm" disabled={wizardPos === 0} onClick={() => setWizardPos((i) => Math.max(0, i - 1))}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground">Changes auto-save</span>
            <Button
              size="sm"
              onClick={() => {
                if (wizardPos >= wizardQueue.length - 1) setWizardOpen(false);
                else setWizardPos((i) => i + 1);
              }}
            >
              {wizardPos >= wizardQueue.length - 1 ? "Done" : (<>Next <ChevronRight className="ml-1 h-4 w-4" /></>)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Date report */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Date report</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-2 py-1 text-left">ISO</th>
                  <th className="px-2 py-1 text-left">Raw</th>
                  {settings.reportIncludeFilenames && <th className="px-2 py-1 text-left">Filename</th>}
                </tr>
              </thead>
              <tbody>
                {sortedReceipts.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-2 py-1 font-mono">{r.date ?? "—"}</td>
                    <td className="px-2 py-1">{r.dateRaw ?? "—"}</td>
                    {settings.reportIncludeFilenames && <td className="px-2 py-1 font-mono">{r.name}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button size="sm" onClick={downloadDateReport}>
            <Download className="mr-1 h-3 w-3" /> Download TSV
          </Button>
        </DialogContent>
      </Dialog>

      {/* Matrix */}
      <Dialog open={matrixOpen} onOpenChange={setMatrixOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Year × Month coverage</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-2 py-1 text-left">Year</th>
                  {MONTHS.map((m) => <th key={m} className="px-2 py-1">{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.keys(matrix).map(Number).sort((a, b) => b - a).map((y) => (
                  <tr key={y} className="border-t">
                    <td className="px-2 py-1 font-mono font-semibold">{y}</td>
                    {matrix[y].map((on, i) => (
                      <td key={i} className="px-2 py-1 text-center">
                        {on ? <Check className="mx-auto h-3 w-3 text-emerald-600" /> : ""}
                      </td>
                    ))}
                  </tr>
                ))}
                {Object.keys(matrix).length === 0 && (
                  <tr><td colSpan={13} className="px-2 py-4 text-center text-muted-foreground">No dated receipts yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Controls visibility settings */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4" /> Show / hide controls
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Toggle the side-panel sections. Upload, image list and logs are always visible.
          </p>
          <div className="space-y-2">
            {(
              [
                ["actions", "Actions (AI, sort, download, export)"],
                ["quality", "Quality & PDF size"],
                ["keys", "OpenRouter API keys"],
                ["models", "Model selector"],
                ["years", "Manual tag year range"],
                ["report-opts", "Report options"],
              ] as [SectionKey, string][]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 rounded border bg-muted/20 px-3 py-2 text-sm">
                <Checkbox
                  checked={settings.visibleSections[k]}
                  onCheckedChange={(c) =>
                    setSettings((s) => ({
                      ...s,
                      visibleSections: { ...s.visibleSections, [k]: c === true },
                    }))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WizardStep({
  receipt,
  years,
  onChange,
  onClear,
  onApprove,
  onPickDetected,
  onSplit,
}: {
  receipt: Receipt;
  years: number[];
  onChange: (iso: string | null, raw: string | null) => void;
  onClear: () => void;
  onApprove: () => void;
  onPickDetected: (d: AIDateEntry) => void;
  onSplit: () => void;
}) {
  const [iso, setIso] = useState<string>(receipt.date ?? "");
  const [raw, setRaw] = useState<string>(receipt.dateRaw ?? "");

  useEffect(() => {
    setIso(receipt.date ?? "");
    setRaw(receipt.dateRaw ?? "");
  }, [receipt.id, receipt.date, receipt.dateRaw]);

  const year = iso ? Number(iso.slice(0, 4)) : "";
  const month = iso ? Number(iso.slice(5, 7)) : "";
  const day = iso ? Number(iso.slice(8, 10)) : "";

  // Auto-save on every change.
  const commit = (newIso: string, newRaw: string) => {
    setIso(newIso);
    setRaw(newRaw);
    onChange(newIso || null, newRaw || newIso || null);
  };

  const setPart = (y: number | "", m: number | "", d: number | "") => {
    const yy = String(y || years[0] || new Date().getFullYear()).padStart(4, "0");
    const mm = String(m || 1).padStart(2, "0");
    const dd = String(d || 1).padStart(2, "0");
    const next = `${yy}-${mm}-${dd}`;
    // Default printed format: DD/MM/YY (matches receipt format)
    const formattedRaw = `${dd}/${mm}/${yy.slice(2)}`;
    commit(next, raw || formattedRaw);
  };

  return (
    <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
      <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/20">
        {receipt.compressed ? (
          <img src={receipt.compressed.dataUrl} alt={receipt.name} className="block w-full" />
        ) : (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">Compressing…</div>
        )}
      </div>
      <div className="space-y-3">
        <p className="truncate font-mono text-xs text-muted-foreground">{receipt.name}</p>
        {receipt.dateSource && (
          <p className="text-xs">
            Source:{" "}
            <span className={receipt.dateSource === "ai" ? "text-primary" : "text-emerald-600"}>
              {receipt.dateSource === "ai" ? "AI extracted" : "Manual"}
            </span>
            {receipt.dateSource === "ai" && (
              receipt.approved ? (
                <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600">approved</span>
              ) : (
                <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-600">needs approval</span>
              )
            )}
          </p>
        )}
        {receipt.aiDates && receipt.aiDates.length > 1 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
            <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
              ⚠ AI detected {receipt.aiDates.length} receipts on this image
            </p>
            <div className="mb-2 flex flex-wrap gap-1">
              {receipt.aiDates.map((d, i) => {
                const active = (d.iso && d.iso === receipt.date) || (!d.iso && d.raw === receipt.dateRaw);
                return (
                  <button
                    key={i}
                    onClick={() => onPickDetected(d)}
                    className={`rounded px-2 py-1 font-mono text-[11px] ${active ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent border"}`}
                    title="Use this date"
                  >
                    {d.raw || d.iso || "?"}
                  </button>
                );
              })}
            </div>
            <Button size="sm" variant="outline" onClick={onSplit}>
              Split image into {receipt.aiDates.length} receipts
            </Button>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Date as printed on receipt</Label>
          <Input
            value={raw}
            onChange={(e) => commit(iso, e.target.value)}
            placeholder="e.g. 03/11/2024 or Nov 3 2024"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date for sorting (ISO)</Label>
          <div className="grid grid-cols-3 gap-2">
            <select
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={year}
              onChange={(e) => setPart(Number(e.target.value), month || 1, day || 1)}
            >
              <option value="">Year</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={month}
              onChange={(e) => setPart(year || years[0], Number(e.target.value), day || 1)}
            >
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={day}
              onChange={(e) => setPart(year || years[0], month || 1, Number(e.target.value))}
            >
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">{iso || "—"}</p>
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-2">
          {receipt.date && !receipt.approved && (
            <Button size="sm" onClick={onApprove}>
              <Check className="mr-1 h-3 w-3" /> Approve
            </Button>
          )}
          {receipt.date && (
            <Button size="sm" variant="ghost" onClick={onClear}>Clear date</Button>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPdfsWithLimit,
  buildRenamedArchive,
  compressImage,
  cropImageRegion,
  estimateCertainty,
  extractDateRoundRobin,
  extractDateWithAI,
  extractImagesFromArchive,
  fetchFreeVisionModelsList,
  fetchOpenRouterCredits,
  formatBytes,
  FREE_VISION_MODELS,
  RECEIPT_PROMPT,
  rotateImageBlob,
  safeSlug,
  timestamp,
  extractDateWithGemini,
  InsufficientCreditsError,
  type AICallMeta,
  type AIDateEntry,
  type AIDateResultWithMeta,
  type BBox,
  type KeyStatus,
  type OpenRouterCredits,
  type PdfItem,
} from "@/lib/receipt-utils";
import { CropWizard } from "@/components/CropWizard";
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Upload, Download, Sparkles, ArrowUpDown, X, Loader as Loader2, FileText, KeyRound, TriangleAlert as AlertTriangle, ExternalLink, Trash2, RefreshCw, Tag, Archive, Wand as Wand2, ChevronLeft, ChevronRight, Plus, Sun, Moon, Droplet, FileDown, Upload as UploadIcon, Table as TableIcon, Maximize2, Check, Settings as SettingsIcon, EyeOff, Copy, Clock, Lightbulb, ClipboardList, RotateCw, Scissors, Eye } from "lucide-react";


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
  approved?: boolean;
  aiState: "idle" | "queued" | "loading" | "done" | "error";
  lastModified?: number;
  // Raw AI detections (may include multiple receipts per image).
  aiDates?: AIDateEntry[];
  // User-set rotation in degrees (0/90/180/270). Persisted per cacheKey and
  // applied to previews AND baked into exported pixels.
  rotation?: number;
};


type LogCategory = "user" | "token" | "client" | "server" | "third-party";

type LogEntry = {
  id: string;
  ts: number;
  level: "error" | "warn" | "info";
  category: LogCategory;
  source: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
};

type UserActionLog = {
  id: string;
  ts: number;
  action: string;
  imageId: string;
  imageName: string;
  details?: string;
};

const DATE_CACHE_KEY = "receipt-date-cache-v3";
const API_KEYS_STORAGE_V2 = "openrouter-api-keys-v2";
const PROMPT_STORAGE = "receipt-prompt-v1";
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
  approved?: boolean;
  rotation?: number;
};

// Session-only record of every AI extraction call.
export type AnalysisEntry = {
  id: string;
  ts: number;
  imageId: string;
  imageName: string;
  provider: "openrouter" | "gemini";
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs: number;
  certainty: number;
  iso: string | null;
  raw: string | null;
  datesCount: number;
  error?: string;
  promptText?: string;
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

type SortMode = "date" | "modified";

type AIProvider = "openrouter" | "gemini" | "auto";

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
  splitMultiReceipt: boolean;
  visibleSections: Record<SectionKey, boolean>;
  aiProvider: AIProvider;
  geminiApiKey: string;
  geminiModel: string;
  concurrency: number;
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
  aiProvider: "auto",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  concurrency: 3,
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
  const [queryAllModels, setQueryAllModels] = useState<boolean>(false);
  const [pdfs, setPdfs] = useState<
    { url: string; size: number; pageCount: number }[]
  >([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [building, setBuilding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [userActionLogs, setUserActionLogs] = useState<UserActionLog[]>([]);
  const [credits, setCredits] = useState<OpenRouterCredits | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [previewScale, setPreviewScale] = useState(220);
  const [imagePreviewId, setImagePreviewId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardQueue, setWizardQueue] = useState<string[]>([]);
  const [wizardPos, setWizardPos] = useState(0);
  const [wizardPendingDate, setWizardPendingDate] = useState<{ iso: string | null; raw: string | null } | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState({ done: 0, total: 0 });
  const [theme, setTheme] = useState<Theme>("light");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [sortMode, setSortMode] = useState<SortMode>("date");
  const [reportOpen, setReportOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [yearStart, setYearStart] = useState(new Date().getFullYear() - 4);
  const [yearEnd, setYearEnd] = useState(new Date().getFullYear());
  const [cropWizardOpen, setCropWizardOpen] = useState(false);
  const [cropWizardId, setCropWizardId] = useState<string | null>(null);
  const [pdfsStale, setPdfsStale] = useState(false);

  // Session-only analysis report (never persisted).
  const [analysisEntries, setAnalysisEntries] = useState<AnalysisEntry[]>([]);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  // Recommendation dialog state
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [recommendation, setRecommendation] = useState<null | {
    openrouter: { model: string; note: string } | null;
    gemini: { model: string; note: string };
    compare: string;
    loading: boolean;
  }>(null);

  // Multi-receipt handling queue (images whose AI returned 2+ dates).
  const [multiQueueOpen, setMultiQueueOpen] = useState(false);

  const [customPrompt, setCustomPrompt] = useState<string>(
    () => localStorage.getItem(PROMPT_STORAGE) ?? "",
  );

  const dateCache = useRef<Record<string, CachedDate>>(loadDateCache());
  const keyIndexRef = useRef(0);
  const keyStateRef = useRef<Record<string, KeyStatus>>({});
  const cancelAIRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const pushLog = useCallback((entry: Omit<LogEntry, "id" | "ts" | "category"> & { category?: LogCategory }) => {
    const category = entry.category ?? "client";
    setLogs((prev) =>
      [{ ...entry, id: crypto.randomUUID(), ts: Date.now(), category }, ...prev].slice(0, 200),
    );
  }, []);

  const pushUserAction = useCallback((action: string, imageId: string, imageName: string, details?: string) => {
    const entry: UserActionLog = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      action,
      imageId,
      imageName,
      details,
    };
    setUserActionLogs((prev) => [entry, ...prev].slice(0, 200));
    pushLog({
      category: "user",
      level: "info",
      source: "user-action",
      message: `${action}: ${imageName}${details ? ` (${details})` : ""}`,
    });
  }, [pushLog]);

  const recordAnalysis = useCallback(
    (
      imageId: string,
      imageName: string,
      meta: AICallMeta,
      result: { iso: string | null; raw: string | null; dates: AIDateEntry[] } | null,
      error?: string,
      promptText?: string,
    ) => {
      const certainty = result ? estimateCertainty(result) : 0;
      setAnalysisEntries((prev) =>
        [
          {
            id: crypto.randomUUID(),
            ts: Date.now(),
            imageId,
            imageName,
            provider: meta.provider,
            model: meta.model,
            promptTokens: meta.promptTokens,
            completionTokens: meta.completionTokens,
            totalTokens: meta.totalTokens,
            costUsd: meta.costUsd,
            latencyMs: meta.latencyMs,
            certainty,
            iso: result?.iso ?? null,
            raw: result?.raw ?? null,
            datesCount: result?.dates?.length ?? 0,
            error,
            promptText: promptText ?? meta.promptText,
          },
          ...prev,
        ].slice(0, 500),
      );
    },
    [],
  );

  const setReceiptRotation = useCallback((id: string, deg: number) => {
    const norm = ((deg % 360) + 360) % 360;
    setReceipts((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        dateCache.current[x.cacheKey] = {
          ...(dateCache.current[x.cacheKey] ?? { iso: null, raw: null }),
          rotation: norm,
        };
        saveDateCache(dateCache.current);
        return { ...x, rotation: norm, lastModified: Date.now() };
      }),
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

  // Deduplicated & auto-sorted receipts (display & PDF order)
  const sortedReceipts = useMemo(() => {
    // Deduplicate: keep most recent modification per cacheKey
    const byCacheKey = new Map<string, Receipt>();
    for (const r of receipts) {
      const existing = byCacheKey.get(r.cacheKey);
      if (!existing || (r.lastModified ?? 0) > (existing.lastModified ?? 0)) {
        byCacheKey.set(r.cacheKey, r);
      }
    }
    const deduped = Array.from(byCacheKey.values());

    // Sort based on mode
    const withDate = deduped.filter((r) => r.date);
    const withoutDate = deduped.filter((r) => !r.date);

    if (sortMode === "date") {
      withDate.sort((a, b) =>
        sortDir === "asc"
          ? (a.date! < b.date! ? -1 : 1)
          : (a.date! > b.date! ? -1 : 1),
      );
    } else {
      // Sort by lastModified timestamp
      const all = [...withDate, ...withoutDate];
      all.sort((a, b) => {
        const aMod = a.lastModified ?? 0;
        const bMod = b.lastModified ?? 0;
        return sortDir === "asc" ? aMod - bMod : bMod - aMod;
      });
      return all;
    }
    return [...withDate, ...withoutDate];
  }, [receipts, sortDir, sortMode]);

  // Manual PDF build — user-triggered. Auto-clear PDFs when no receipts.
  useEffect(() => {
    if (sortedReceipts.length === 0) {
      setPdfs((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.url));
        return [];
      });
      setPdfsStale(false);
    }
  }, [sortedReceipts.length]);

  // Mark PDFs stale whenever anything that would affect output changes.
  useEffect(() => {
    if (sortedReceipts.length > 0) setPdfsStale(true);
  }, [
    sortedReceipts,
    settings.maxPdfSizeMB,
    settings.showDateLabel,
    settings.gridPdf,
    settings.gridCols,
  ]);

  const buildAllPdfs = useCallback(async () => {
    const ready =
      sortedReceipts.length > 0 && sortedReceipts.every((r) => r.compressed);
    if (!ready) {
      toast.error("Receipts still compressing — try again in a moment.");
      return;
    }
    setBuilding(true);
    try {
      const limit = Math.max(1, settings.maxPdfSizeMB) * 1024 * 1024;
      const included = sortedReceipts.filter((r) => !r.excluded);
      const items: PdfItem[] = [];
      for (const r of included) {
        const rot = ((r.rotation ?? 0) % 360 + 360) % 360;
        if (rot === 0) {
          items.push({ ...r.compressed!, label: r.dateRaw || r.date || "" });
        } else {
          const rotated = await rotateImageBlob(r.compressed!.blob, rot);
          items.push({
            blob: rotated.blob,
            width: rotated.width,
            height: rotated.height,
            label: r.dateRaw || r.date || "",
          });
        }
      }
      if (!items.length) {
        toast.error("Nothing to include — every image is excluded.");
        return;
      }
      const out = await buildPdfsWithLimit(items, limit, {
        showLabel: settings.showDateLabel,
        grid: settings.gridPdf,
        gridCols: settings.gridCols,
      });
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
      setPdfsStale(false);
      toast.success(
        `Built ${next.length} PDF${next.length === 1 ? "" : "s"} (${formatBytes(
          next.reduce((s, p) => s + p.size, 0),
        )})`,
      );
    } catch (e) {
      pushLog({
        level: "error",
        source: "buildPdf",
        message: (e as Error).message,
        stack: (e as Error).stack,
      });
      toast.error(`Build failed: ${(e as Error).message}`);
    } finally {
      setBuilding(false);
    }
  }, [
    sortedReceipts,
    settings.maxPdfSizeMB,
    settings.showDateLabel,
    settings.gridPdf,
    settings.gridCols,
    pushLog,
  ]);

  const ingestImageFiles = useCallback(async (arr: File[]) => {
    const now = Date.now();
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
        approved: cached?.approved,
        rotation: cached?.rotation ?? 0,
        aiState: "idle",
        lastModified: now,
      };
    });
    setReceipts((prev) => [...prev, ...newOnes]);
    pushLog({
      category: "client",
      level: "info",
      source: "ingest",
      message: `Ingested ${newOnes.length} image(s)`,
    });
  }, [pushLog]);

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

  const removeReceipt = useCallback((id: string) => {
    const r = receipts.find((x) => x.id === id);
    setReceipts((prev) => prev.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (r) {
      pushUserAction("removed", id, r.name);
    }
  }, [receipts, selectedId, pushUserAction]);

  const toggleExclude = useCallback((id: string) => {
    const r = receipts.find((x) => x.id === id);
    setReceipts((prev) =>
      prev.map((x) => (x.id === id ? { ...x, excluded: !x.excluded, lastModified: Date.now() } : x)),
    );
    if (r) {
      pushUserAction("toggle-exclude", id, r.name, r.excluded ? "include" : "exclude");
    }
  }, [receipts, pushUserAction]);

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
      const now = Date.now();
      setReceipts((prev) =>
        prev.map((x) => {
          if (x.id !== id) return x;
          const updated: Receipt = {
            ...x,
            date: iso ?? undefined,
            dateRaw: raw ?? undefined,
            dateSource: source,
            approved,
            aiState: "done",
            lastModified: now,
          };
          dateCache.current[x.cacheKey] = {
            iso,
            raw,
            source,
            approved,
          };
          saveDateCache(dateCache.current);
          pushUserAction("set-date", id, x.name, `${source}: ${raw || iso || "cleared"}`);
          return updated;
        }),
      );
    },
    [pushUserAction],
  );

  const approveReceipt = useCallback((id: string) => {
    const r = receipts.find((x) => x.id === id);
    setReceipts((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, approved: true, lastModified: Date.now() };
        dateCache.current[x.cacheKey] = {
          iso: x.date ?? null,
          raw: x.dateRaw ?? null,
          source: x.dateSource,
          approved: true,
        };
        saveDateCache(dateCache.current);
        return next;
      }),
    );
    if (r) {
      pushUserAction("approved", id, r.name);
    }
  }, [receipts, pushUserAction]);

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

  const runAI = async (trialMode = false) => {
    const hasOR = apiKeys.length > 0;
    const hasGemini = !!settings.geminiApiKey.trim();
    const provider = settings.aiProvider;
    const useGemini =
      provider === "gemini" || (provider === "auto" && !hasOR && hasGemini);

    if (!hasOR && !hasGemini) {
      toast.error("Add at least one API key (OpenRouter or Gemini)");
      return;
    }
    localStorage.setItem(MODEL_STORAGE, model);

    let queue = receipts.filter((r) => !r.date && r.compressed);
    if (trialMode) queue = queue.slice(0, 1);
    if (!queue.length) {
      toast.info("Nothing to extract — all receipts already dated");
      return;
    }

    setReceipts((prev) =>
      prev.map((x) =>
        queue.some((q) => q.id === x.id) ? { ...x, aiState: "queued" } : x,
      ),
    );

    const abort = new AbortController();
    abortControllerRef.current = abort;
    cancelAIRef.current = false;
    setAiRunning(true);
    setAiProgress({ done: 0, total: queue.length });
    let processed = 0;
    let fromCache = 0;
    const activePrompt = customPrompt.trim() || RECEIPT_PROMPT;
    let queueIdx = 0;

    const processOne = async () => {
      while (true) {
        if (abort.signal.aborted) break;
        const myIdx = queueIdx++;
        if (myIdx >= queue.length) break;
        const r = queue[myIdx];

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
                    approved: cached.approved,
                    aiState: "done",
                    lastModified: Date.now(),
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
          let result: AIDateResultWithMeta;
          let sourceLabel = "gemini";
          if (useGemini) {
            if (!hasGemini) throw new Error("Gemini API key is not set");
            result = await extractDateWithGemini(
              settings.geminiApiKey.trim(),
              r.compressed!.dataUrl,
              settings.geminiModel || "gemini-2.0-flash",
              { prompt: activePrompt, signal: abort.signal },
            );
          } else if (queryAllModels && models.length > 1) {
            const modelList = models.slice();
            const outcomes = await Promise.all(
              modelList.map(async (m, i) => {
                const key = apiKeys[i % apiKeys.length];
                try {
                  const res = await extractDateWithAI(key, r.compressed!.dataUrl, m, {
                    prompt: activePrompt,
                    signal: abort.signal,
                  });
                  recordAnalysis(r.id, r.name, res.meta, res, undefined, activePrompt);
                  return { ok: true as const, model: m, res };
                } catch (err) {
                  const msg = (err as Error).message;
                  recordAnalysis(
                    r.id,
                    r.name,
                    { provider: "openrouter", model: m, latencyMs: 0, rawText: "" },
                    null,
                    msg,
                    activePrompt,
                  );
                  pushLog({
                    category: "third-party",
                    level: "warn",
                    source: `openrouter/${m}`,
                    message: `${r.name}: ${msg}`,
                  });
                  return { ok: false as const, model: m, err: msg };
                }
              }),
            );
            const successes = outcomes.filter((o) => o.ok) as Array<
              Extract<(typeof outcomes)[number], { ok: true }>
            >;
            const best =
              successes.find((s) => s.res.iso) ??
              successes.find((s) => s.res.raw) ??
              successes[0];
            if (!best) throw new Error(`All ${modelList.length} models failed`);
            result = best.res;
            sourceLabel = `openrouter/all(${successes.length}/${modelList.length}) → ${best.model}`;
          } else {
            try {
              const rr = await extractDateRoundRobin(
                apiKeys,
                keyStateRef.current,
                keyIndexRef.current,
                r.compressed!.dataUrl,
                model,
                {
                  minIntervalMs: settings.minKeyIntervalSec * 1000,
                  cooldownAfterFailures: settings.cooldownAfterFailures,
                  cooldownMs: settings.cooldownSec * 1000,
                  prompt: activePrompt,
                  signal: abort.signal,
                },
              );
              keyIndexRef.current = rr.nextIndex;
              result = rr.result;
              sourceLabel = `openrouter/key#${rr.usedKeyIndex + 1}`;
            } catch (err) {
              if (
                err instanceof InsufficientCreditsError &&
                provider === "auto" &&
                hasGemini
              ) {
                pushLog({
                  category: "third-party",
                  level: "warn",
                  source: "openrouter",
                  message: `Falling back to Gemini: ${(err as Error).message}`,
                });
                result = await extractDateWithGemini(
                  settings.geminiApiKey.trim(),
                  r.compressed!.dataUrl,
                  settings.geminiModel || "gemini-2.0-flash",
                  { prompt: activePrompt, signal: abort.signal },
                );
              } else {
                throw err;
              }
            }
          }

          if (abort.signal.aborted) break;

          dateCache.current[r.cacheKey] = {
            iso: result.iso,
            raw: result.raw,
            source: "ai",
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
                    approved: false,
                    aiState: "done",
                    aiDates: result.dates,
                    lastModified: Date.now(),
                  }
                : x,
            ),
          );
          processed++;
          if (!sourceLabel.startsWith("openrouter/all")) {
            recordAnalysis(r.id, r.name, result.meta, result, undefined, activePrompt);
          }
          pushLog({
            category: "third-party",
            level: "info",
            source: sourceLabel,
            message: `${r.name} → ${result.raw ?? "NONE"} (${result.iso ?? "—"})`,
          });
          pushUserAction("ai-extract", r.id, r.name, result.raw || result.iso || "no date");
        } catch (e) {
          if ((e as Error).name === "AbortError") break;
          const msg = (e as Error).message;
          recordAnalysis(
            r.id,
            r.name,
            { provider: "openrouter", model, latencyMs: 0, rawText: "" },
            null,
            msg,
            activePrompt,
          );
          pushLog({
            category: "third-party",
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
    };

    const concurrency = Math.max(1, Math.min(10, settings.concurrency ?? 3));
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, processOne),
    );

    setAiRunning(false);
    abortControllerRef.current = null;
    if (abort.signal.aborted) {
      toast.info(`Stopped after ${processed} extracted.`);
    } else {
      toast.success(`Extracted ${processed} dates (${fromCache} from cache)`);
    }
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

  // Images whose AI detection returned multiple receipts.
  const multiReceiptImages = useMemo(
    () => sortedReceipts.filter((r) => (r.aiDates?.length ?? 0) > 1),
    [sortedReceipts],
  );
  const unapprovedAI = useMemo(
    () =>
      sortedReceipts.filter(
        (r) => r.date && r.dateSource === "ai" && !r.approved,
      ),
    [sortedReceipts],
  );

  // Start the wizard filtered to unapproved AI detections only.
  const startApprovalWizard = () => {
    const q = unapprovedAI.map((r) => r.id);
    if (!q.length) {
      toast.info("Nothing to approve — all AI dates already approved");
      return;
    }
    setWizardQueue(q);
    setWizardPos(0);
    setWizardPendingDate(null);
    setWizardOpen(true);
  };

  // Multi-receipt queue: opens the crop wizard on the first multi-receipt
  // image, then advances via the wizard's dialog onOpenChange handler below.
  const startMultiReceiptQueue = () => {
    if (!multiReceiptImages.length) return;
    setMultiQueueOpen(true);
    setCropWizardId(multiReceiptImages[0].id);
    setCropWizardOpen(true);
  };

  const buildRecommendation = async () => {
    setRecommendOpen(true);
    setRecommendation({
      openrouter: null,
      gemini: { model: "gemini-2.5-flash-lite", note: "" },
      compare: "",
      loading: true,
    });
    try {
      const [freeList, cr] = await Promise.all([
        fetchFreeVisionModelsList().catch(() => [] as string[]),
        apiKeys[0]
          ? fetchOpenRouterCredits(apiKeys[0]).catch(() => null)
          : Promise.resolve(null),
      ]);
      // Prefer Gemini vision on free tier when available.
      const preferOrder = [
        "google/gemini-2.0-flash-exp:free",
        "google/gemini-2.5-flash-image:free",
        "qwen/qwen2.5-vl-72b-instruct:free",
        "meta-llama/llama-3.2-11b-vision-instruct:free",
      ];
      const orModel =
        preferOrder.find((m) => freeList.includes(m)) ??
        freeList[0] ??
        FREE_VISION_MODELS[0];
      const orNote = freeList.length
        ? `Picked from ${freeList.length} vision-capable free models. Rate-limited by OpenRouter (~10/min per key, ~200/day).`
        : "Free model list unavailable — using built-in fallback.";
      const remaining = cr?.remaining ?? 0;
      // Direct Gemini choice.
      const geminiModel =
        remaining < 0.01 && !settings.geminiApiKey.trim()
          ? "gemini-2.5-flash-lite"
          : "gemini-2.5-flash-lite";
      const geminiNote =
        "Cheapest Gemini vision model (~$0.10/1M in, $0.40/1M out). ~1.4K in + 80 out per receipt = ~$0.00018/req → ~5,500 req/$1. Bypasses OpenRouter rate limits.";
      let compare = "";
      if (
        orModel.startsWith("google/gemini") &&
        geminiModel.startsWith("gemini")
      ) {
        compare =
          "Same underlying family (Google Gemini vision). The free OpenRouter route is $0 but rate-limited; the direct Gemini API costs ~$0.0002/receipt with no free-tier daily cap and higher throughput.";
      } else {
        compare =
          "Different providers. OpenRouter free route saves money but rate-limits daily; Gemini direct is paid but faster and unlimited.";
      }
      setRecommendation({
        openrouter: { model: orModel, note: orNote },
        gemini: { model: geminiModel, note: geminiNote },
        compare,
        loading: false,
      });
    } catch (e) {
      toast.error(`Recommendation failed: ${(e as Error).message}`);
      setRecommendation((r) => (r ? { ...r, loading: false } : r));
    }
  };



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
    setWizardPendingDate(null);
    setWizardOpen(true);
  };
  const wizardReceipt = receipts.find((r) => r.id === wizardQueue[wizardPos]);

  // Extract N cropped parts from an image using arbitrary user-drawn bboxes.
  const extractCroppedParts = async (
    id: string,
    boxes: BBox[],
    removeOriginal: boolean,
  ) => {
    const r = receipts.find((x) => x.id === id);
    if (!r || !boxes.length) return;
    try {
      const now = Date.now();
      const files: File[] = [];
      for (let i = 0; i < boxes.length; i++) {
        files.push(await cropImageRegion(r.file, boxes[i], i + 1));
      }
      const newReceipts: Receipt[] = files.map((f) => {
        const ck = makeCacheKey(f);
        return {
          id: crypto.randomUUID(),
          name: f.name,
          cacheKey: ck,
          originalSize: f.size,
          file: f,
          qualityOverride: null,
          aiState: "idle",
          lastModified: now,
        };
      });
      setReceipts((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        if (idx < 0) return [...prev, ...newReceipts];
        const next = [...prev];
        if (removeOriginal) next.splice(idx, 1, ...newReceipts);
        else next.splice(idx + 1, 0, ...newReceipts);
        return next;
      });
      toast.success(
        `Extracted ${files.length} part${files.length === 1 ? "" : "s"}${
          removeOriginal ? " (original removed)" : ""
        }`,
      );
      setCropWizardOpen(false);
      pushUserAction("crop-extract", id, r.name, `${boxes.length} parts`);
    } catch (e) {
      toast.error(`Crop failed: ${(e as Error).message}`);
      pushLog({
        category: "client",
        level: "error",
        source: "cropImage",
        message: (e as Error).message,
      });
    }
  };
  const cropTarget = receipts.find((r) => r.id === cropWizardId);

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
      const rot = ((r.rotation ?? 0) % 360 + 360) % 360;
      const srcBlob: Blob = r.compressed?.blob ?? r.file;
      let outBlob: Blob = srcBlob;
      let ext = (r.name.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
      if (rot !== 0) {
        const rotated = await rotateImageBlob(srcBlob, rot);
        outBlob = rotated.blob;
        ext = "jpg";
      }
      const rawBase = safeSlug(r.name.replace(/\.[^.]+$/, ""));
      const rotSuffix = rot !== 0 ? "_rotated" : "";
      const base = r.date
        ? `${r.date}_${rawBase}${rotSuffix}`
        : `undated_${rawBase}${rotSuffix}`;
      items.push({ blob: outBlob, name: `${base}.${ext}` });
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
                    <Button onClick={() => runAI(false)} variant="secondary" size="sm" disabled={!receipts.length || aiRunning}>
                      {aiRunning ? (
                        <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{aiProgress.done}/{aiProgress.total}</>
                      ) : (
                        <><Sparkles className="mr-1.5 h-4 w-4" /> Extract dates (AI)</>
                      )}
                    </Button>
                    <Button
                      onClick={() => runAI(true)}
                      variant="outline"
                      size="sm"
                      disabled={!receipts.length || aiRunning}
                      title="Send only 1 un-dated image — useful for testing prompt/model"
                    >
                      Trial (1)
                    </Button>
                    {aiRunning && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => abortControllerRef.current?.abort()}
                      >
                        Stop
                      </Button>
                    )}
                    <div className="flex items-center gap-1" title="Concurrent AI requests">
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={settings.concurrency}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            concurrency: Math.max(1, Math.min(10, Number(e.target.value) || 3)),
                          }))
                        }
                        className="h-7 w-12 text-xs text-center"
                      />
                      <span className="text-[10px] text-muted-foreground">parallel</span>
                    </div>
                    <Button onClick={() => startWizard()} variant="secondary" size="sm" disabled={!receipts.length}>
                      <Wand2 className="mr-1.5 h-4 w-4" /> Review wizard
                    </Button>
                    <Button
                      onClick={buildRecommendation}
                      variant="outline"
                      size="sm"
                      title="Recommend best OpenRouter-free & Gemini vision models"
                    >
                      <Lightbulb className="mr-1.5 h-4 w-4" /> Recommend model
                    </Button>
                    <Button
                      onClick={() => setAnalysisOpen(true)}
                      variant="outline"
                      size="sm"
                      disabled={!analysisEntries.length}
                      title="View AI-analysis history (session)"
                    >
                      <ClipboardList className="mr-1.5 h-4 w-4" />
                      Analyses ({analysisEntries.length})
                    </Button>
                    {multiReceiptImages.length > 0 && (
                      <Button
                        onClick={startMultiReceiptQueue}
                        size="sm"
                        variant="secondary"
                        className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
                        title="Images with multiple receipts detected — click to crop them one by one"
                      >
                        <Scissors className="mr-1.5 h-4 w-4" />
                        Multi-receipt ({multiReceiptImages.length})
                      </Button>
                    )}
                    {unapprovedAI.length > 0 && (
                      <Button
                        onClick={startApprovalWizard}
                        size="sm"
                        variant="secondary"
                        className="bg-primary/15 text-primary hover:bg-primary/25"
                        title="AI dates awaiting your approval"
                      >
                        <Check className="mr-1.5 h-4 w-4" />
                        Approve ({unapprovedAI.length})
                      </Button>
                    )}
                    <select
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as SortMode)}
                      className="h-8 rounded-md border bg-card px-2 text-xs"
                      disabled={!receipts.length}
                    >
                      <option value="date">By Date</option>
                      <option value="modified">By Modified</option>
                    </select>
                    <Button
                      onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                      variant="secondary"
                      size="sm"
                      disabled={!receipts.length}
                      title="Flip sort direction"
                    >
                      <ArrowUpDown className="mr-1.5 h-4 w-4" /> {sortDir === "asc" ? "Asc" : "Desc"}
                    </Button>
                    <Button
                      onClick={buildAllPdfs}
                      size="sm"
                      variant={pdfsStale ? "default" : "outline"}
                      disabled={!receipts.length || building}
                      className="ml-auto"
                      title="Generate PDF(s) with current settings"
                    >
                      {building ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <FileText className="mr-1.5 h-4 w-4" />
                      )}
                      Build PDF{pdfsStale && pdfs.length ? " (stale)" : ""}
                    </Button>
                    <Button onClick={downloadAllPdfs} disabled={!pdfs.length} size="sm">
                      <Download className="mr-1.5 h-4 w-4" />
                      {pdfs.length > 1 ? `Download ${pdfs.length} PDFs` : "Download PDF"}
                    </Button>
                  </div>
                  {pdfsStale && pdfs.length > 0 && (
                    <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                      Settings changed — rebuild to refresh PDF output.
                    </p>
                  )}
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
                <AccordionContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">AI provider</Label>
                    <div className="flex gap-2">
                      {(["auto", "openrouter", "gemini"] as AIProvider[]).map((p) => (
                        <Button
                          key={p}
                          size="sm"
                          variant={settings.aiProvider === p ? "default" : "outline"}
                          onClick={() => setSettings((s) => ({ ...s, aiProvider: p }))}
                          className="text-xs capitalize"
                        >
                          {p}
                        </Button>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Auto uses OpenRouter first and falls back to Gemini on insufficient credits.
                    </p>
                  </div>
                  <div className="space-y-1.5 border-t pt-2">
                    <Label className="text-xs">Google Gemini API key (direct)</Label>
                    <Input
                      type="password"
                      placeholder="AIza…"
                      value={settings.geminiApiKey}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, geminiApiKey: e.target.value }))
                      }
                      className="text-xs font-mono"
                    />
                    <Input
                      placeholder="gemini-2.0-flash"
                      value={settings.geminiModel}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, geminiModel: e.target.value }))
                      }
                      className="text-xs font-mono"
                    />
                  </div>
                  <div className="border-t pt-2 space-y-2">
                    <Label className="text-xs">OpenRouter keys</Label>
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
                      value={models.includes(model) ? model : "__custom__"}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") return;
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
                      {!models.includes(model) && (
                        <option value="__custom__">{model} (custom)</option>
                      )}
                    </select>
                    <Button size="sm" variant="outline" onClick={refreshModels} disabled={modelsLoading}>
                      {modelsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      <span className="ml-1">Fetch free</span>
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs whitespace-nowrap">Model slug</Label>
                    <Input
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        localStorage.setItem(MODEL_STORAGE, e.target.value);
                      }}
                      placeholder="vendor/model[:free]"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Pick from the list or type any OpenRouter model slug (e.g. append <code>:free</code>).
                  </p>
                  <label className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={queryAllModels}
                      onChange={(e) => setQueryAllModels(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Query ALL {models.length} listed models in parallel</span>
                      <span className="block text-[10px] text-muted-foreground mt-0.5">
                        For each image, fire one request per listed model concurrently (spreads across your OpenRouter keys). Best ISO-dated response wins; every attempt is logged in the Analysis report. Use to survive flaky/failing free models.
                      </span>
                    </span>
                  </label>

                  <div className="space-y-1 border-t pt-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">AI prompt</Label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          setCustomPrompt("");
                          localStorage.removeItem(PROMPT_STORAGE);
                        }}
                        disabled={!customPrompt}
                      >
                        Reset to default
                      </Button>
                    </div>
                    <textarea
                      value={customPrompt || RECEIPT_PROMPT}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomPrompt(val === RECEIPT_PROMPT ? "" : val);
                        localStorage.setItem(PROMPT_STORAGE, val === RECEIPT_PROMPT ? "" : val);
                      }}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-xs font-mono resize-y leading-relaxed"
                      rows={3}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      {(customPrompt || RECEIPT_PROMPT).length} chars
                      {customPrompt ? " · custom" : " · default"}
                    </p>
                  </div>
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
                        <img src={r.compressed.dataUrl} alt={r.name} className="h-12 w-12 rounded-md object-cover" style={{ transform: r.rotation ? `rotate(${r.rotation}deg)` : undefined }} />
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
                              ?
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
                  Logs ({logs.length + userActionLogs.length})
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <Tabs defaultValue="all" className="w-full">
                  <TabsList className="mb-2 h-8">
                    <TabsTrigger value="all" className="text-[11px]">All ({logs.length})</TabsTrigger>
                    <TabsTrigger value="user" className="text-[11px]">User ({userActionLogs.length})</TabsTrigger>
                    <TabsTrigger value="token" className="text-[11px]">Token</TabsTrigger>
                    <TabsTrigger value="client" className="text-[11px]">Client</TabsTrigger>
                    <TabsTrigger value="third-party" className="text-[11px]">3rd Party</TabsTrigger>
                  </TabsList>

                  <TabsContent value="all" className="mt-0">
                    <LogListView
                      logs={logs}
                      expandedLogId={expandedLogId}
                      setExpandedLogId={setExpandedLogId}
                      copyToClipboard={copyToClipboard}
                      setLogs={setLogs}
                    />
                  </TabsContent>

                  <TabsContent value="user" className="mt-0">
                    <div className="flex justify-end gap-2 mb-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const text = userActionLogs
                            .map((l) => `[${new Date(l.ts).toISOString()}] ${l.action}: ${l.imageName}${l.details ? ` (${l.details})` : ""}`)
                            .join("\n");
                          copyToClipboard(text);
                        }}
                        disabled={!userActionLogs.length}
                      >
                        <Copy className="mr-1 h-3 w-3" /> Copy
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setUserActionLogs([])} disabled={!userActionLogs.length}>
                        <Trash2 className="mr-1 h-3 w-3" /> Clear
                      </Button>
                    </div>
                    <div className="max-h-80 overflow-auto">
                      {userActionLogs.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground">No user actions yet.</p>
                      ) : (
                        <ul className="divide-y">
                          {userActionLogs.map((l) => (
                            <li key={l.id} className="px-1 py-2 text-xs">
                              <div className="flex items-baseline gap-2">
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600">
                                  {l.action}
                                </span>
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {new Date(l.ts).toLocaleString()}
                                </span>
                              </div>
                              <p className="mt-1 truncate font-mono text-[11px]">{l.imageName}</p>
                              {l.details && (
                                <p className="text-[10px] text-muted-foreground">{l.details}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="token" className="mt-0">
                    <div className="p-4 text-xs space-y-2">
                      <p className="text-muted-foreground">OpenRouter Credits:</p>
                      {credits ? (
                        <div className="rounded border bg-muted/30 p-3 space-y-1">
                          <p>Remaining: <span className="font-mono font-semibold text-primary">${credits.remaining.toFixed(4)}</span></p>
                          <p>Total: <span className="font-mono">${credits.totalCredits.toFixed(2)}</span></p>
                          <p>Used: <span className="font-mono">${credits.totalUsage.toFixed(4)}</span></p>
                        </div>
                      ) : (
                        <p className="text-muted-foreground">Add an API key to see credits.</p>
                      )}
                      <Button size="sm" variant="outline" onClick={() => refreshCredits()} disabled={creditsLoading || !apiKeys.length}>
                        {creditsLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                        Refresh
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="client" className="mt-0">
                    <LogListView
                      logs={logs.filter((l) => l.category === "client")}
                      expandedLogId={expandedLogId}
                      setExpandedLogId={setExpandedLogId}
                      copyToClipboard={copyToClipboard}
                      setLogs={setLogs}
                    />
                  </TabsContent>

                  <TabsContent value="third-party" className="mt-0">
                    <LogListView
                      logs={logs.filter((l) => l.category === "third-party")}
                      expandedLogId={expandedLogId}
                      setExpandedLogId={setExpandedLogId}
                      copyToClipboard={copyToClipboard}
                      setLogs={setLogs}
                    />
                  </TabsContent>
                </Tabs>
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
                          className="rounded bg-primary/80 p-1 text-primary-foreground hover:bg-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCropWizardId(r.id);
                            setCropWizardOpen(true);
                          }}
                          title="Crop multiple receipts out of this image"
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></svg>
                        </button>
                        <button
                          className="rounded bg-black/60 p-1 text-white hover:bg-black/80"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReceiptRotation(r.id, (r.rotation ?? 0) + 90);
                          }}
                          title="Rotate 90° (persists in previews & baked into export)"
                        >
                          <RotateCw className="h-3 w-3" />
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
                        <img src={r.compressed.dataUrl} alt={`Page ${i + 1}`} className="block w-full" style={{ transform: r.rotation ? `rotate(${r.rotation}deg)` : undefined }} />
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

      {/* Large image preview (rotate + zoom loupe + open crop wizard) */}
      <ImagePreviewDialog
        open={!!previewImage}
        onOpenChange={(o) => !o && setImagePreviewId(null)}
        src={previewImage?.compressed?.dataUrl ?? null}
        name={previewImage?.name ?? ""}
        rotation={previewImage?.rotation ?? 0}
        onRotationChange={(deg) => {
          if (previewImage) setReceiptRotation(previewImage.id, deg);
        }}
        onOpenCropWizard={
          previewImage
            ? () => {
                setCropWizardId(previewImage.id);
                setCropWizardOpen(true);
                setImagePreviewId(null);
              }
            : undefined
        }
      />

      {/* Crop wizard — extract multiple receipts out of one image */}
      <CropWizard
        open={cropWizardOpen}
        onOpenChange={(o) => {
          setCropWizardOpen(o);
          if (!o) {
            const closedId = cropWizardId;
            setCropWizardId(null);
            // Multi-receipt queue: advance to next remaining multi-receipt image.
            if (multiQueueOpen) {
              const remaining = multiReceiptImages.filter(
                (r) => r.id !== closedId,
              );
              if (remaining.length) {
                setTimeout(() => {
                  setCropWizardId(remaining[0].id);
                  setCropWizardOpen(true);
                }, 100);
              } else {
                setMultiQueueOpen(false);
                toast.success(
                  "Multi-receipt queue complete — you can now export a fresh archive.",
                  {
                    action: {
                      label: "Export ZIP",
                      onClick: () => downloadRenamedArchive(),
                    },
                  },
                );
              }
            }
          }
        }}
        imageSrc={cropTarget?.compressed?.dataUrl ?? null}
        imageName={cropTarget?.name ?? ""}
        aiBoxes={
          cropTarget?.aiDates
            ?.map((d) => d.bbox)
            .filter((b): b is BBox => !!b) ?? []
        }
        onExtract={(boxes, removeOriginal) => {
          if (cropWizardId) extractCroppedParts(cropWizardId, boxes, removeOriginal);
        }}
      />


      {/* Wizard */}
      <Dialog open={wizardOpen} onOpenChange={(open) => {
        setWizardOpen(open);
        if (!open) setWizardPendingDate(null);
      }}>
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
              pendingDate={wizardPendingDate}
              onPendingChange={(iso, raw) => setWizardPendingDate({ iso, raw })}
              onCommit={(iso, raw, source) => {
                setReceiptDate(wizardReceipt.id, iso, raw, source, { approved: true });
                setWizardPendingDate(null);
                toast.success(iso ? `Saved date: ${raw || iso}` : "Date cleared");
              }}
              onCancelPending={() => setWizardPendingDate(null)}
              onApprove={() => {
                approveReceipt(wizardReceipt.id);
                toast.success("Approved");
                if (wizardPos < wizardQueue.length - 1) setWizardPos((i) => i + 1);
              }}
              onRunAI={async () => {
                const provider = settings.aiProvider;
                const hasOR = apiKeys.length > 0;
                const hasGemini = !!settings.geminiApiKey.trim();
                const useGemini =
                  provider === "gemini" ||
                  (provider === "auto" && !hasOR && hasGemini);
                if (!useGemini && !hasOR) {
                  toast.error("Add an OpenRouter or Gemini API key");
                  return;
                }
                if (!wizardReceipt.compressed) {
                  toast.error("Image still compressing");
                  return;
                }
                setReceipts((prev) =>
                  prev.map((x) => (x.id === wizardReceipt.id ? { ...x, aiState: "loading" } : x)),
                );
                try {
                  let result: AIDateResultWithMeta;
                  let sourceLabel = "gemini";
                  if (useGemini) {
                    result = await extractDateWithGemini(
                      settings.geminiApiKey.trim(),
                      wizardReceipt.compressed!.dataUrl,
                      settings.geminiModel || "gemini-2.0-flash",
                    );
                  } else {
                    try {
                      const rr = await extractDateRoundRobin(
                        apiKeys,
                        keyStateRef.current,
                        keyIndexRef.current,
                        wizardReceipt.compressed!.dataUrl,
                        model,
                        {
                          minIntervalMs: settings.minKeyIntervalSec * 1000,
                          cooldownAfterFailures: settings.cooldownAfterFailures,
                          cooldownMs: settings.cooldownSec * 1000,
                        },
                      );
                      keyIndexRef.current = rr.nextIndex;
                      result = rr.result;
                      sourceLabel = `openrouter/key#${rr.usedKeyIndex + 1}`;
                    } catch (err) {
                      if (
                        err instanceof InsufficientCreditsError &&
                        provider === "auto" &&
                        hasGemini
                      ) {
                        result = await extractDateWithGemini(
                          settings.geminiApiKey.trim(),
                          wizardReceipt.compressed!.dataUrl,
                          settings.geminiModel || "gemini-2.0-flash",
                        );
                        sourceLabel = "gemini (fallback)";
                      } else {
                        throw err;
                      }
                    }
                  }
                  setReceipts((prev) =>
                    prev.map((x) =>
                      x.id === wizardReceipt.id
                        ? { ...x, aiState: "done", aiDates: result.dates }
                        : x,
                    ),
                  );
                  recordAnalysis(wizardReceipt.id, wizardReceipt.name, result.meta, result);
                  if (result.iso || result.raw) {
                    setWizardPendingDate({ iso: result.iso, raw: result.raw });
                    pushLog({
                      category: "third-party",
                      level: "info",
                      source: sourceLabel,
                      message: `${wizardReceipt.name} → ${result.raw ?? result.iso}`,
                    });
                    pushUserAction("ai-extract", wizardReceipt.id, wizardReceipt.name, result.raw || result.iso || "no date");
                  } else {
                    toast.info("No date detected");
                  }
                } catch (e) {
                  const msg = (e as Error).message;
                  recordAnalysis(
                    wizardReceipt.id,
                    wizardReceipt.name,
                    { provider: useGemini ? "gemini" : "openrouter", model: useGemini ? (settings.geminiModel || "gemini-2.0-flash") : model, latencyMs: 0, rawText: "" },
                    null,
                    msg,
                  );
                  setReceipts((prev) =>
                    prev.map((x) => (x.id === wizardReceipt.id ? { ...x, aiState: "error" } : x)),
                  );
                  toast.error(`AI failed: ${msg}`);
                  pushLog({
                    category: "third-party",
                    level: "error",
                    source: "openrouter",
                    message: `${wizardReceipt.name}: ${msg}`,
                  });
                }
              }}
              onClear={() => {
                setReceipts((prev) =>
                  prev.map((x) =>
                    x.id === wizardReceipt.id
                      ? { ...x, date: undefined, dateRaw: undefined, dateSource: undefined, approved: false, aiState: "idle", lastModified: Date.now() }
                      : x,
                  ),
                );
                delete dateCache.current[wizardReceipt.cacheKey];
                saveDateCache(dateCache.current);
                pushUserAction("clear-date", wizardReceipt.id, wizardReceipt.name);
                setWizardPendingDate(null);
              }}
            />
          )}
          <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
            <Button variant="outline" size="sm" disabled={wizardPos === 0} onClick={() => {
              setWizardPendingDate(null);
              setWizardPos((i) => Math.max(0, i - 1));
            }}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              {wizardPendingDate ? "Review change before proceeding" : "Changes auto-save"}
            </span>
            {wizardPendingDate ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWizardPendingDate(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!wizardReceipt) return;
                    const src = wizardReceipt.dateSource === "ai" ? "ai" : "manual";
                    setReceiptDate(wizardReceipt.id, wizardPendingDate.iso, wizardPendingDate.raw, src, { approved: true });
                    setWizardPendingDate(null);
                    toast.success("Date saved");
                    if (wizardPos >= wizardQueue.length - 1) setWizardOpen(false);
                    else setWizardPos((i) => i + 1);
                  }}
                >
                  <Check className="mr-1 h-3 w-3" /> Approve
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  if (wizardPos >= wizardQueue.length - 1) setWizardOpen(false);
                  else setWizardPos((i) => i + 1);
                }}
              >
                {wizardPos >= wizardQueue.length - 1 ? "Done" : (<>Next <ChevronRight className="ml-1 h-4 w-4" /></>)}
              </Button>
            )}
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

      {/* Recommendation dialog */}
      <Dialog open={recommendOpen} onOpenChange={setRecommendOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-primary" /> Model recommendation
            </DialogTitle>
          </DialogHeader>
          {!recommendation || recommendation.loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Querying OpenRouter…
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Best OpenRouter free model
                  </span>
                  {recommendation.openrouter && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setModel(recommendation.openrouter!.model);
                        localStorage.setItem(MODEL_STORAGE, recommendation.openrouter!.model);
                        setSettings((s) => ({ ...s, aiProvider: "openrouter" }));
                        toast.success("Applied OpenRouter model");
                      }}
                    >
                      Apply
                    </Button>
                  )}
                </div>
                <p className="font-mono text-xs">
                  {recommendation.openrouter?.model ?? "—"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {recommendation.openrouter?.note ?? "No free models available."}
                </p>
              </div>

              <div className="rounded-md border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Best Gemini direct model
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSettings((s) => ({
                        ...s,
                        aiProvider: "gemini",
                        geminiModel: recommendation.gemini.model,
                      }));
                      toast.success("Applied Gemini model");
                    }}
                  >
                    Apply
                  </Button>
                </div>
                <p className="font-mono text-xs">{recommendation.gemini.model}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {recommendation.gemini.note}
                </p>
              </div>

              <div className="rounded-md bg-muted/40 p-3 text-xs">
                <p className="font-semibold">Comparison</p>
                <p className="mt-1 text-muted-foreground">{recommendation.compare}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Analysis report dialog */}
      <Dialog open={analysisOpen} onOpenChange={setAnalysisOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              AI analysis report ({analysisEntries.length} calls this session)
            </DialogTitle>
          </DialogHeader>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span>
                Cost:{" "}
                <span className="font-mono font-semibold text-primary">
                  ${analysisEntries.reduce((s, a) => s + (a.costUsd ?? 0), 0).toFixed(6)}
                </span>
              </span>
              <span>
                Tokens:{" "}
                <span className="font-mono">
                  {analysisEntries.reduce((s, a) => s + (a.totalTokens ?? 0), 0).toLocaleString()}
                </span>
              </span>
              {credits != null && (
                <span>
                  Credits left:{" "}
                  <span className="font-mono font-semibold text-emerald-600">
                    ${credits.remaining.toFixed(4)}
                  </span>
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAnalysisEntries([])}
              disabled={!analysisEntries.length}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Clear
            </Button>
          </div>
          <div className="max-h-[65vh] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                <tr>
                  <th className="px-2 py-1 text-left">When</th>
                  <th className="px-2 py-1 text-left">Image</th>
                  <th className="px-2 py-1 text-left">Provider · Model</th>
                  <th className="px-2 py-1 text-left">Prompt</th>
                  <th className="px-2 py-1 text-right">Tokens</th>
                  <th className="px-2 py-1 text-right">Cost</th>
                  <th className="px-2 py-1 text-right">Certainty</th>
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {analysisEntries.map((a) => {
                  const stillExists = receipts.some((r) => r.id === a.imageId);
                  return (
                    <tr key={a.id} className="border-t">
                      <td className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                        {new Date(a.ts).toLocaleTimeString()}
                      </td>
                      <td className="px-2 py-1 max-w-[220px] truncate font-mono" title={a.imageName}>
                        {a.imageName}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px]">
                        <span className="rounded bg-primary/10 px-1 py-0.5 text-primary">
                          {a.provider}
                        </span>{" "}
                        {a.model}
                      </td>
                      <td
                        className="px-2 py-1 max-w-[200px] truncate font-mono text-[10px] text-muted-foreground"
                        title={a.promptText ?? ""}
                      >
                        {a.promptText ? a.promptText.slice(0, 60) + (a.promptText.length > 60 ? "…" : "") : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {a.totalTokens ?? "—"}
                        {a.promptTokens != null && a.completionTokens != null && (
                          <span className="ml-1 text-muted-foreground">
                            ({a.promptTokens}/{a.completionTokens})
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {a.costUsd != null ? `$${a.costUsd.toFixed(6)}` : "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                            a.certainty >= 0.7
                              ? "bg-emerald-500/15 text-emerald-600"
                              : a.certainty >= 0.4
                                ? "bg-amber-500/15 text-amber-600"
                                : "bg-destructive/15 text-destructive"
                          }`}
                        >
                          {Math.round(a.certainty * 100)}%
                        </span>
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {a.error ? (
                          <span className="text-destructive">err: {a.error.slice(0, 40)}</span>
                        ) : (
                          a.raw || a.iso || "—"
                        )}
                        {a.datesCount > 1 && (
                          <span className="ml-1 text-amber-600">×{a.datesCount}</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!stillExists}
                          title={stillExists ? "Open image preview" : "Image no longer in session"}
                          onClick={() => {
                            setImagePreviewId(a.imageId);
                            setAnalysisOpen(false);
                          }}
                        >
                          <Eye className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {analysisEntries.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">
                      No AI calls yet this session.
                    </td>
                  </tr>
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
  pendingDate,
  onPendingChange,
  onCommit,
  onCancelPending,
  onApprove,
  onRunAI,
  onClear,
}: {
  receipt: Receipt;
  years: number[];
  pendingDate: { iso: string | null; raw: string | null } | null;
  onPendingChange: (iso: string | null, raw: string | null) => void;
  onCommit: (iso: string | null, raw: string | null, source: DateSource) => void;
  onCancelPending: () => void;
  onApprove: () => void;
  onRunAI: () => void;
  onClear: () => void;
}) {
  const currentIso = pendingDate?.iso ?? receipt.date ?? "";
  const currentRaw = pendingDate?.raw ?? receipt.dateRaw ?? "";

  const year = currentIso ? Number(currentIso.slice(0, 4)) : "";
  const month = currentIso ? Number(currentIso.slice(5, 7)) : "";
  const day = currentIso ? Number(currentIso.slice(8, 10)) : "";

  const setPart = (y: number | "", m: number | "", d: number | "") => {
    const yy = String(y || years[0] || new Date().getFullYear()).padStart(4, "0");
    const mm = String(m || 1).padStart(2, "0");
    const dd = String(d || 1).padStart(2, "0");
    const newIso = `${yy}-${mm}-${dd}`;
    const newRaw = `${dd}/${mm}/${yy.slice(2)}`;
    onPendingChange(newIso || null, currentRaw || newRaw);
  };

  return (
    <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
      <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/20">
        {receipt.compressed ? (
          <img src={receipt.compressed.dataUrl} alt={receipt.name} className="block w-full" style={{ transform: receipt.rotation ? `rotate(${receipt.rotation}deg)` : undefined }} />
        ) : (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">Compressing…</div>
        )}
      </div>
      <div className="space-y-4">
        <p className="truncate font-mono text-xs text-muted-foreground">{receipt.name}</p>

        {/* Final Date Section */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <Label className="text-xs font-semibold">Final Date</Label>

          {/* Date Source Badge */}
          {receipt.dateSource && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Source:</span>
              <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                receipt.dateSource === "ai"
                  ? "bg-primary/15 text-primary"
                  : "bg-emerald-500/15 text-emerald-600"
              }`}>
                {receipt.dateSource === "ai" ? (
                  <><Sparkles className="h-3 w-3" /> AI</>
                ) : (
                  <><Tag className="h-3 w-3" /> Manual</>
                )}
              </span>
              {receipt.dateSource === "ai" && !receipt.approved && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-600">
                  needs approval
                </span>
              )}
            </div>
          )}

          {/* AI Run Button */}
          <Button
            size="sm"
            variant="outline"
            onClick={onRunAI}
            disabled={receipt.aiState === "loading"}
            className="w-full"
          >
            {receipt.aiState === "loading" ? (
              <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Extracting…</>
            ) : (
              <><Sparkles className="mr-1.5 h-3 w-3" /> Run AI Date Detection</>
            )}
          </Button>

          {/* Date Dropdowns - Day, Month, Year order */}
          <div className="space-y-1">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[10px] text-muted-foreground">Day</Label>
                <select
                  className="h-9 w-full rounded-md border bg-card px-2 text-sm"
                  value={day}
                  onChange={(e) => setPart(year || years[0], month || 1, Number(e.target.value))}
                >
                  <option value="">Day</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Month</Label>
                <select
                  className="h-9 w-full rounded-md border bg-card px-2 text-sm"
                  value={month}
                  onChange={(e) => setPart(year || years[0], Number(e.target.value), day || 1)}
                >
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Year</Label>
                <select
                  className="h-9 w-full rounded-md border bg-card px-2 text-sm"
                  value={year}
                  onChange={(e) => setPart(Number(e.target.value), month || 1, day || 1)}
                >
                  <option value="">Year</option>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">ISO: {currentIso || "—"}</p>
          </div>

          {/* Pending change indicator */}
          {pendingDate && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              <p className="font-medium text-amber-700 dark:text-amber-400">Pending change: {pendingDate.raw || pendingDate.iso || "no date"}</p>
              <p className="text-muted-foreground mt-1">Approve or cancel before navigating</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {receipt.date && !receipt.approved && !pendingDate && (
              <Button size="sm" onClick={onApprove}>
                <Check className="mr-1 h-3 w-3" /> Approve
              </Button>
            )}
            {receipt.date && !pendingDate && (
              <Button size="sm" variant="ghost" onClick={onClear}>Clear date</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LogListView({
  logs,
  expandedLogId,
  setExpandedLogId,
  copyToClipboard,
  setLogs,
}: {
  logs: LogEntry[];
  expandedLogId: string | null;
  setExpandedLogId: (id: string | null) => void;
  copyToClipboard: (text: string) => void;
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
}) {
  return (
    <>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const text = logs
              .map(
                (l) =>
                  `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} [${l.category}] ${l.source}\n${l.message}${l.stack ? "\n" + l.stack : ""}`,
              )
              .join("\n\n");
            copyToClipboard(text);
          }}
          disabled={!logs.length}
        >
          <Copy className="mr-1 h-3 w-3" /> Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLogs([])} disabled={!logs.length}>
          <Trash2 className="mr-1 h-3 w-3" /> Clear
        </Button>
      </div>
      <div className="max-h-80 overflow-auto">
        {logs.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">No logs.</p>
        ) : (
          <ul className="divide-y">
            {logs.map((l) => {
              const expanded = expandedLogId === l.id;
              const fullText = `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} [${l.category}] ${l.source}\n${l.message}${l.stack ? "\n" + l.stack : ""}`;
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
                    <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {l.category}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {new Date(l.ts).toLocaleString()}
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
    </>
  );
}

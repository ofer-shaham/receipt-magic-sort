/**
 * GlobalAISettingsDialog — full AI settings dialog opened from the footer.
 *
 * Reads/writes the same localStorage keys used by both /old (ReceiptApp) and /new flows.
 * Dispatches a custom "ai-settings-changed" window event so any mounted flow can
 * react without a page reload.
 */
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Settings, Eye, EyeOff, X, Plus, ExternalLink, RefreshCw, Loader2,
} from "lucide-react";
import {
  fetchFreeVisionModelsList,
  fetchOpenRouterCredits,
  FREE_VISION_MODELS,
  RECEIPT_PROMPT,
  type OpenRouterCredits,
} from "@/lib/receipt-utils";

// ── localStorage keys (must match ReceiptApp.tsx) ─────────────────────────────
const KEYS_K        = "openrouter-api-keys-v2";
const MODEL_K       = "openrouter-model";
const MODELS_LIST_K = "openrouter-models-list";
const SETTINGS_K    = "receipt-settings-v1";
const PROMPT_K      = "receipt-prompt-v1";
const QUERY_ALL_K   = "receipt-query-all-models";

type AIProvider = "openrouter" | "gemini" | "auto";

type PersistedAISettings = {
  aiProvider: AIProvider;
  geminiApiKey: string;
  geminiModel: string;
  minKeyIntervalSec: number;
  cooldownAfterFailures: number;
  cooldownSec: number;
};

const DEFAULT_AI: PersistedAISettings = {
  aiProvider: "auto",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  minKeyIntervalSec: 0,
  cooldownAfterFailures: 3,
  cooldownSec: 65,
};

// ── localStorage helpers ──────────────────────────────────────────────────────

function readKeys(): string[] {
  try {
    const v2 = localStorage.getItem(KEYS_K);
    if (v2) { const p = JSON.parse(v2); if (Array.isArray(p)) return p.filter(Boolean); }
    const v1 = localStorage.getItem("openrouter-api-keys");
    if (v1) { const p = JSON.parse(v1); if (Array.isArray(p)) return p.filter(Boolean); }
    const s = localStorage.getItem("openrouter-api-key");
    if (s) return [s];
  } catch { /* ignore */ }
  return [];
}

function readAISettings(): PersistedAISettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_K) || "{}");
    return { ...DEFAULT_AI, ...raw };
  } catch { return { ...DEFAULT_AI }; }
}

function readModels(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(MODELS_LIST_K) || "null");
    if (Array.isArray(list) && list.length) return list;
  } catch { /* ignore */ }
  return [...FREE_VISION_MODELS];
}

function writeAISettings(patch: Partial<PersistedAISettings>) {
  const current = readAISettings();
  const next = { ...current, ...patch };
  localStorage.setItem(SETTINGS_K, JSON.stringify(next));
  notify();
}

function notify() {
  window.dispatchEvent(new Event("ai-settings-changed"));
}

// ── main component ────────────────────────────────────────────────────────────

type Props = { open: boolean; onOpenChange: (v: boolean) => void };

export function GlobalAISettingsDialog({ open, onOpenChange }: Props) {
  // ── state ──
  const [keys,          setKeys]          = useState<string[]>([]);
  const [newKey,        setNewKey]        = useState("");
  const [showKey,       setShowKey]       = useState(false);
  const [ai,            setAi]            = useState<PersistedAISettings>(DEFAULT_AI);
  const [model,         setModel]         = useState<string>(FREE_VISION_MODELS[0]);
  const [models,        setModels]        = useState<string[]>([...FREE_VISION_MODELS]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [queryAll,      setQueryAll]      = useState(false);
  const [customPrompt,  setCustomPrompt]  = useState("");
  const [credits,       setCredits]       = useState<OpenRouterCredits | null>(null);
  const [creditsLoading,setCreditsLoading]= useState(false);

  // Load from localStorage whenever dialog opens
  useEffect(() => {
    if (!open) return;
    setKeys(readKeys());
    setAi(readAISettings());
    setModel(localStorage.getItem(MODEL_K) || FREE_VISION_MODELS[0]);
    setModels(readModels());
    setQueryAll(localStorage.getItem(QUERY_ALL_K) === "true");
    setCustomPrompt(localStorage.getItem(PROMPT_K) ?? "");
    setCredits(null);
  }, [open]);

  // Auto-fetch credits when dialog opens and there's a key
  useEffect(() => {
    if (!open || !keys.length) return;
    setCreditsLoading(true);
    fetchOpenRouterCredits(keys[0])
      .then(setCredits)
      .catch(() => {})
      .finally(() => setCreditsLoading(false));
  }, [open, keys]);

  // ── key management ──
  const persistKeys = useCallback((k: string[]) => {
    const clean = k.filter(Boolean);
    setKeys(clean);
    localStorage.setItem(KEYS_K, JSON.stringify(clean));
    notify();
  }, []);

  const addKey = () => {
    const k = newKey.trim();
    if (!k) return;
    if (keys.includes(k)) { toast.warning("Key already added"); return; }
    persistKeys([...keys, k]);
    setNewKey("");
  };

  // ── AI settings ──
  const patchAi = (patch: Partial<PersistedAISettings>) => {
    const next = { ...ai, ...patch };
    setAi(next);
    writeAISettings(patch);
  };

  // ── model ──
  const saveModel = (m: string) => {
    setModel(m);
    localStorage.setItem(MODEL_K, m);
    notify();
  };

  // ── fetch free models ──
  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const list = await fetchFreeVisionModelsList();
      if (list.length) {
        setModels(list);
        localStorage.setItem(MODELS_LIST_K, JSON.stringify(list));
        notify();
        toast.success(`Loaded ${list.length} free vision models`);
      } else {
        toast.warning("No models returned");
      }
    } catch (e: any) {
      toast.error(`Failed to fetch models: ${e?.message ?? e}`);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  // ── query-all ──
  const saveQueryAll = (v: boolean) => {
    setQueryAll(v);
    localStorage.setItem(QUERY_ALL_K, String(v));
    notify();
  };

  // ── prompt ──
  const savePrompt = (val: string) => {
    setCustomPrompt(val === RECEIPT_PROMPT ? "" : val);
    if (val === RECEIPT_PROMPT) {
      localStorage.removeItem(PROMPT_K);
    } else {
      localStorage.setItem(PROMPT_K, val);
    }
    notify();
  };

  const effectivePrompt = customPrompt || RECEIPT_PROMPT;
  const isCustomPrompt  = !!customPrompt && customPrompt !== RECEIPT_PROMPT;

  // ── credits refresh ──
  const refreshCredits = () => {
    if (!keys.length) return;
    setCreditsLoading(true);
    fetchOpenRouterCredits(keys[0])
      .then(setCredits)
      .catch(() => toast.error("Failed to fetch credits"))
      .finally(() => setCreditsLoading(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-4 w-4" /> AI Settings
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-1">

          {/* ── Provider ── */}
          <section className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              AI Provider
            </Label>
            <div className="flex gap-2">
              {(["auto", "openrouter", "gemini"] as AIProvider[]).map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={ai.aiProvider === p ? "default" : "outline"}
                  onClick={() => patchAi({ aiProvider: p })}
                  className="capitalize"
                >
                  {p}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Auto uses OpenRouter first and falls back to Gemini on insufficient credits.
            </p>
          </section>

          {/* ── OpenRouter Keys ── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                OpenRouter Keys ({keys.length})
              </Label>
              {/* Credits */}
              <div className="flex items-center gap-1.5 text-xs">
                {creditsLoading
                  ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  : credits
                    ? <span><span className="font-semibold text-primary">${credits.remaining.toFixed(4)}</span><span className="text-muted-foreground"> / ${credits.totalCredits.toFixed(2)}</span></span>
                    : keys.length ? <span className="text-muted-foreground">—</span> : null
                }
                {keys.length > 0 && (
                  <button onClick={refreshCredits} disabled={creditsLoading}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40">
                    <RefreshCw className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Existing keys */}
            {keys.length === 0 && (
              <p className="text-xs text-muted-foreground">No keys added yet.</p>
            )}
            {keys.map((k, i) => (
              <div key={i}
                className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
                <span className="flex-1 truncate font-mono">#{i + 1} · {k.slice(0, 10)}…{k.slice(-4)}</span>
                <Button size="icon" variant="ghost" className="h-5 w-5 text-muted-foreground hover:text-destructive"
                  onClick={() => persistKeys(keys.filter((_, j) => j !== i))}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}

            {/* Add key */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder="sk-or-…"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addKey()}
                  className="h-8 pr-8 font-mono text-xs"
                />
                <button type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              </div>
              <Button size="sm" className="h-8 px-3" onClick={addKey}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>

            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
              Get a free key at openrouter.ai <ExternalLink className="h-2.5 w-2.5" />
            </a>

            {/* Cooldown settings */}
            <div className="space-y-2 border-t pt-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Min delay between key uses</Label>
                <div className="flex items-center gap-1.5">
                  <Input type="number" min={0} max={120}
                    value={ai.minKeyIntervalSec}
                    onChange={(e) => patchAi({ minKeyIntervalSec: Math.max(0, Number(e.target.value) || 0) })}
                    className="h-7 w-20 text-xs" />
                  <span className="text-xs text-muted-foreground">sec</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Cooldown after N failures</Label>
                <div className="flex items-center gap-1.5">
                  <Input type="number" min={1}
                    value={ai.cooldownAfterFailures}
                    onChange={(e) => patchAi({ cooldownAfterFailures: Math.max(1, Number(e.target.value) || 3) })}
                    className="h-7 w-16 text-xs" />
                  <span className="text-xs text-muted-foreground">→</span>
                  <Input type="number" min={5}
                    value={ai.cooldownSec}
                    onChange={(e) => patchAi({ cooldownSec: Math.max(5, Number(e.target.value) || 65) })}
                    className="h-7 w-20 text-xs" />
                  <span className="text-xs text-muted-foreground">sec</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── Gemini ── */}
          <section className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Google Gemini (direct)
            </Label>
            <Input
              type="password"
              placeholder="AIza…"
              value={ai.geminiApiKey}
              onChange={(e) => patchAi({ geminiApiKey: e.target.value })}
              className="h-8 font-mono text-xs"
            />
            <Input
              placeholder="gemini-2.0-flash"
              value={ai.geminiModel}
              onChange={(e) => patchAi({ geminiModel: e.target.value })}
              className="h-8 font-mono text-xs"
            />
          </section>

          {/* ── OpenRouter Model ── */}
          <section className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              OpenRouter Model ({models.length} free)
            </Label>
            <div className="flex gap-2">
              <select
                value={models.includes(model) ? model : "__custom__"}
                onChange={(e) => { if (e.target.value !== "__custom__") saveModel(e.target.value); }}
                className="h-9 flex-1 rounded-md border bg-card px-2 text-xs"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                {!models.includes(model) && (
                  <option value="__custom__">{model} (custom)</option>
                )}
              </select>
              <Button size="sm" variant="outline" onClick={fetchModels} disabled={modelsLoading} className="h-9">
                {modelsLoading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
                <span className="ml-1">Fetch free</span>
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap">Custom slug</Label>
              <Input
                value={model}
                onChange={(e) => saveModel(e.target.value)}
                placeholder="vendor/model[:free]"
                className="h-8 text-xs font-mono"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Pick from the list or type any OpenRouter model slug (e.g. append <code>:free</code>).
            </p>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={queryAll}
                onChange={(e) => saveQueryAll(e.target.checked)}
              />
              <span>
                <span className="font-medium">Query ALL {models.length} listed models in parallel</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  For each image, fire one request per listed model concurrently (spreads across your OpenRouter keys).
                  Best ISO-dated response wins; every attempt is logged. Use to survive flaky/failing free models.
                </span>
              </span>
            </label>
          </section>

          {/* ── AI Prompt ── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                AI Prompt
              </Label>
              <Button
                size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
                onClick={() => savePrompt(RECEIPT_PROMPT)}
                disabled={!isCustomPrompt}
              >
                Reset to default
              </Button>
            </div>
            <textarea
              value={effectivePrompt}
              onChange={(e) => savePrompt(e.target.value)}
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed"
              rows={4}
            />
            <p className="text-[10px] text-muted-foreground">
              {effectivePrompt.length} chars{isCustomPrompt ? " · custom" : " · default"}
            </p>
          </section>

        </div>
      </DialogContent>
    </Dialog>
  );
}

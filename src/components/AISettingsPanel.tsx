/**
 * AISettingsPanel — shared popover for managing OpenRouter API keys and model.
 * Reads/writes the same localStorage keys used by both /old and /new flows.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Settings, Eye, EyeOff, X, Plus, ExternalLink } from "lucide-react";

const KEYS_K  = "openrouter-api-keys-v2";
const MODEL_K = "openrouter-model";
const DEFAULT_MODEL = "google/gemini-2.0-flash-lite-001";

const QUICK_MODELS = [
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.0-flash-exp:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
];

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

export function AISettingsPanel() {
  const [keys,    setKeys]    = useState<string[]>([]);
  const [model,   setModel]   = useState(DEFAULT_MODEL);
  const [newKey,  setNewKey]  = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setKeys(readKeys());
    setModel(localStorage.getItem(MODEL_K) || DEFAULT_MODEL);
  }, []);

  const persist = (k: string[]) => {
    const clean = k.filter(Boolean);
    setKeys(clean);
    localStorage.setItem(KEYS_K, JSON.stringify(clean));
  };

  const addKey = () => {
    if (!newKey.trim()) return;
    persist([...keys, newKey.trim()]);
    setNewKey("");
  };

  const saveModel = (m: string) => {
    setModel(m);
    localStorage.setItem(MODEL_K, m);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="AI Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 space-y-4 p-4">
        <p className="text-sm font-semibold">AI Settings</p>

        {/* ── API Keys ── */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">OpenRouter API Keys</Label>

          {keys.length === 0 && (
            <p className="text-xs text-muted-foreground">No keys added yet.</p>
          )}

          {keys.map((k, i) => (
            <div key={i}
              className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
              <span className="flex-1 truncate font-mono">{k.slice(0, 10)}···</span>
              <Button size="icon" variant="ghost" className="h-5 w-5 text-muted-foreground hover:text-destructive"
                onClick={() => persist(keys.filter((_, j) => j !== i))}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}

          {/* Add key row */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                placeholder="sk-or-..."
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addKey()}
                className="h-7 pr-8 font-mono text-xs"
              />
              <button type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
            <Button size="sm" className="h-7 px-2" onClick={addKey} title="Add key">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
            Get a free key at openrouter.ai <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>

        {/* ── Model ── */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">Model</Label>
          <Input
            value={model}
            onChange={(e) => saveModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
            className="h-7 font-mono text-xs"
          />
          <div className="flex flex-wrap gap-1">
            {QUICK_MODELS.map((m) => (
              <button key={m}
                onClick={() => saveModel(m)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                  model === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}>
                {m.split("/")[1]}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

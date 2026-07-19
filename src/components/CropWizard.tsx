import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trash2, Scissors, Sparkles, SquareDashed } from "lucide-react";
import type { BBox } from "@/lib/receipt-utils";

// ── Public types ──────────────────────────────────────────────────────────────

export type TaggedCrop = BBox & { year: string; month: string; part: string };

export type CropWizardProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string | null;
  imageName: string;
  aiBoxes?: BBox[];
  onExtract: (boxes: BBox[], removeOriginal: boolean) => void;
};

export type CropWizardPanelProps = {
  imageSrc: string | null;
  imageName: string;
  aiBoxes?: BBox[];
  /** When true, show year/month/part inputs per rectangle */
  showTagInputs?: boolean;
  defaultYear?: string;
  defaultMonth?: string;
  onExtract?: (boxes: BBox[], removeOriginal: boolean) => void;
  onTaggedExtract?: (crops: TaggedCrop[], removeOriginal: boolean) => void;
  onCancel?: () => void;
  showRemoveOriginal?: boolean;
};

// ── Internal types ────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => String(CURRENT_YEAR - i));
const MONTHS = ["01","02","03","04","05","06","07","08","09","10","11","12"];

/** Six distinct colours for crop rectangles — cycled by index */
const RECT_COLORS = [
  { border: "rgba(16,185,129,1)",  bg: "rgba(16,185,129,0.15)"  }, // emerald
  { border: "rgba(59,130,246,1)",  bg: "rgba(59,130,246,0.15)"  }, // blue
  { border: "rgba(245,158,11,1)",  bg: "rgba(245,158,11,0.15)"  }, // amber
  { border: "rgba(244,63,94,1)",   bg: "rgba(244,63,94,0.15)"   }, // rose
  { border: "rgba(139,92,246,1)",  bg: "rgba(139,92,246,0.15)"  }, // violet
  { border: "rgba(6,182,212,1)",   bg: "rgba(6,182,212,0.15)"   }, // cyan
] as const;

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Rect = BBox & {
  id: string;
  source: "ai" | "user";
  year: string;
  month: string;
  part: string;
};

type DragMode =
  | { mode: "idle" }
  | { mode: "drawing"; rect: Rect }
  | { mode: "adjusting"; rectId: string; handle: HandleId | "body"; startMouse: { x: number; y: number }; startRect: Rect };

const uid = () => Math.random().toString(36).slice(2, 9);

// 8 resize handles: position + cursor
const HANDLES: { id: HandleId; style: React.CSSProperties; cursor: string }[] = [
  { id: "nw", style: { top: -4, left:  -4 },                         cursor: "nw-resize" },
  { id: "n",  style: { top: -4, left:  "calc(50% - 4px)" },          cursor: "n-resize"  },
  { id: "ne", style: { top: -4, right: -4 },                         cursor: "ne-resize" },
  { id: "e",  style: { top:  "calc(50% - 4px)", right: -4 },         cursor: "e-resize"  },
  { id: "se", style: { bottom: -4, right: -4 },                      cursor: "se-resize" },
  { id: "s",  style: { bottom: -4, left:  "calc(50% - 4px)" },       cursor: "s-resize"  },
  { id: "sw", style: { bottom: -4, left:  -4 },                      cursor: "sw-resize" },
  { id: "w",  style: { top:  "calc(50% - 4px)", left: -4 },          cursor: "w-resize"  },
];

function applyDrag(
  startRect: Rect,
  handle: HandleId | "body",
  delta: { dx: number; dy: number },
): Rect {
  const MIN = 0.02;
  let { x, y, w, h } = startRect;
  const { dx, dy } = delta;

  switch (handle) {
    case "body": x += dx; y += dy; break;
    case "nw":   x += dx; y += dy; w -= dx; h -= dy; break;
    case "n":             y += dy;           h -= dy; break;
    case "ne":            y += dy; w += dx;  h -= dy; break;
    case "e":                      w += dx;           break;
    case "se":                     w += dx;  h += dy; break;
    case "s":                                h += dy;  break;
    case "sw":   x += dx;          w -= dx;  h += dy; break;
    case "w":    x += dx;          w -= dx;           break;
  }

  w = Math.max(MIN, w);
  h = Math.max(MIN, h);
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));

  return { ...startRect, x, y, w, h };
}

// ── CropWizardPanel (headless, no Dialog) ─────────────────────────────────────

export function CropWizardPanel({
  imageSrc,
  imageName,
  aiBoxes,
  showTagInputs = false,
  defaultYear,
  defaultMonth,
  onExtract,
  onTaggedExtract,
  onCancel,
  showRemoveOriginal = true,
}: CropWizardPanelProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [drag, setDrag] = useState<DragMode>({ mode: "idle" });
  const [removeOriginal, setRemoveOriginal] = useState(true);
  const [useAISuggestions, setUseAISuggestions] = useState(true);

  const fallbackYear  = defaultYear  ?? String(CURRENT_YEAR);
  const fallbackMonth = defaultMonth ?? "01";

  // Seed AI boxes whenever they or toggle change
  useEffect(() => {
    if (useAISuggestions && aiBoxes && aiBoxes.length) {
      setRects(
        aiBoxes.map((b, i) => ({
          ...b, id: uid(), source: "ai" as const,
          year: fallbackYear, month: fallbackMonth, part: String(i + 1),
        })),
      );
    } else if (!useAISuggestions) {
      setRects([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiBoxes, useAISuggestions]);

  // Update tag defaults on source items when defaultYear/defaultMonth change
  useEffect(() => {
    setRects((prev) =>
      prev.map((r) => ({
        ...r,
        year:  r.year  === String(CURRENT_YEAR) || r.year  === "" ? fallbackYear  : r.year,
        month: r.month === "01"                  || r.month === "" ? fallbackMonth : r.month,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultYear, defaultMonth]);

  // ── coordinate helpers ──────────────────────────────────────────────────────

  const toNorm = (e: React.MouseEvent): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
    };
  };

  // ── container events ────────────────────────────────────────────────────────

  const onContainerDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset?.role === "rect-handle") return;
    if ((e.target as HTMLElement).dataset?.role === "rect-body") return;
    const p = toNorm(e);
    if (!p) return;
    setDrag({
      mode: "drawing",
      rect: { id: uid(), source: "user", x: p.x, y: p.y, w: 0, h: 0,
              year: fallbackYear, month: fallbackMonth, part: "1" },
    });
  };

  const onContainerMove = (e: React.MouseEvent) => {
    const p = toNorm(e);
    if (!p) return;

    if (drag.mode === "drawing") {
      const s = { x: drag.rect.x, y: drag.rect.y };
      setDrag((d) =>
        d.mode !== "drawing" ? d : {
          ...d,
          rect: {
            ...d.rect,
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            w: Math.abs(p.x - s.x),
            h: Math.abs(p.y - s.y),
          },
        },
      );
    } else if (drag.mode === "adjusting") {
      const dx = p.x - drag.startMouse.x;
      const dy = p.y - drag.startMouse.y;
      const updated = applyDrag(drag.startRect, drag.handle, { dx, dy });
      setRects((prev) => prev.map((r) => (r.id === drag.rectId ? updated : r)));
    }
  };

  const onContainerUp = () => {
    if (drag.mode === "drawing") {
      if (drag.rect.w > 0.02 && drag.rect.h > 0.02) {
        setRects((prev) => [...prev, drag.rect]);
      }
    }
    setDrag({ mode: "idle" });
  };

  // ── rect-level events ───────────────────────────────────────────────────────

  const onBodyDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const p = toNorm(e);
    if (!p) return;
    const rect = rects.find((r) => r.id === id);
    if (!rect) return;
    setDrag({ mode: "adjusting", rectId: id, handle: "body", startMouse: p, startRect: rect });
  };

  const onHandleDown = (e: React.MouseEvent, id: string, handle: HandleId) => {
    e.stopPropagation();
    const p = toNorm(e);
    if (!p) return;
    const rect = rects.find((r) => r.id === id);
    if (!rect) return;
    setDrag({ mode: "adjusting", rectId: id, handle, startMouse: p, startRect: rect });
  };

  // ── tag updates ─────────────────────────────────────────────────────────────

  const updateRectTag = (id: string, field: "year" | "month" | "part", val: string) =>
    setRects((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)));

  const removeRect = (id: string) =>
    setRects((prev) => prev.filter((r) => r.id !== id));

  const addFullImage = () => {
    setRects((prev) => [
      ...prev,
      { id: uid(), source: "user" as const, x: 0, y: 0, w: 1, h: 1,
        year: fallbackYear, month: fallbackMonth, part: "1" },
    ]);
  };

  // ── extract ─────────────────────────────────────────────────────────────────

  const handleExtract = () => {
    if (onTaggedExtract) {
      onTaggedExtract(
        rects.map(({ x, y, w, h, year, month, part }) => ({ x, y, w, h, year, month, part })),
        removeOriginal,
      );
    } else if (onExtract) {
      onExtract(rects.map(({ x, y, w, h }) => ({ x, y, w, h })), removeOriginal);
    }
  };

  // ── visible rects (committed + in-progress draw) ─────────────────────────────

  const allRects = [...rects, ...(drag.mode === "drawing" ? [drag.rect] : [])];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Draw rectangles over each receipt. Drag corners or edges to adjust.
        {aiBoxes && aiBoxes.length > 0 && (
          <> Boxes with <Sparkles className="inline h-3 w-3 text-primary" /> came from the AI.</>
        )}
      </p>

      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        {/* Canvas */}
        <div className="relative select-none overflow-auto rounded-md border bg-muted/20">
          {imageSrc && (
            <div
              className="relative inline-block w-full"
              style={{ cursor: drag.mode === "adjusting" && drag.handle === "body" ? "grabbing" : "crosshair" }}
              onMouseDown={onContainerDown}
              onMouseMove={onContainerMove}
              onMouseUp={onContainerUp}
              onMouseLeave={onContainerUp}
            >
              <img
                ref={imgRef}
                src={imageSrc}
                alt={imageName}
                draggable={false}
                className="block w-full"
              />

              {allRects.map((r, idx) => {
                const isDrawing = drag.mode === "drawing" && r.id === drag.rect.id;
                const col = RECT_COLORS[idx % RECT_COLORS.length];

                return (
                  <div
                    key={r.id}
                    className="absolute"
                    style={{
                      left:        `${r.x * 100}%`,
                      top:         `${r.y * 100}%`,
                      width:       `${r.w * 100}%`,
                      height:      `${r.h * 100}%`,
                      border:      `2px solid ${col.border}`,
                      background:  col.bg,
                      cursor:      isDrawing ? "crosshair" : "move",
                      zIndex:      10,
                    }}
                    data-role="rect-body"
                    onMouseDown={(e) => !isDrawing && onBodyDown(e, r.id)}
                  >
                    {/* Index label – larger for readability */}
                    <span
                      className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-sm font-bold leading-none shadow"
                      style={{ background: col.border, color: "#fff" }}
                    >
                      {idx + 1}
                    </span>

                    {/* Resize handles (not shown on in-progress draw) */}
                    {!isDrawing && HANDLES.map((h) => (
                      <div
                        key={h.id}
                        data-role="rect-handle"
                        style={{ ...h.style, cursor: h.cursor, position: "absolute", width: 8, height: 8 }}
                        className="rounded-sm border border-gray-600 bg-white shadow"
                        onMouseDown={(e) => onHandleDown(e, r.id, h.id)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Controls + preview list */}
        <div className="flex flex-col gap-3">
          {aiBoxes && aiBoxes.length > 0 && (
            <div className="flex items-center gap-2 rounded border bg-muted/20 p-2">
              <Checkbox
                id="ai-sug-panel"
                checked={useAISuggestions}
                onCheckedChange={(c) => setUseAISuggestions(c === true)}
              />
              <Label htmlFor="ai-sug-panel" className="text-xs">
                Use AI suggestions ({aiBoxes.length})
              </Label>
            </div>
          )}
          {showRemoveOriginal && (
            <div className="flex items-center gap-2 rounded border bg-muted/20 p-2">
              <Checkbox
                id="rm-orig-panel"
                checked={removeOriginal}
                onCheckedChange={(c) => setRemoveOriginal(c === true)}
              />
              <Label htmlFor="rm-orig-panel" className="text-xs">
                Remove original after extract
              </Label>
            </div>
          )}

          {/* Rect list */}
          <div className="flex-1 overflow-auto rounded-md border">
            {rects.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">
                Draw a rectangle over each receipt to add it here.
              </p>
            ) : (
              <div className="divide-y">
                {rects.map((r, i) => (
                  <div key={r.id} className="space-y-1 px-2 py-2 text-xs">
                    <div className="flex items-center justify-between gap-1">
                      <span className="flex items-center gap-1 font-medium">
                        {r.source === "ai" && <Sparkles className="h-3 w-3 text-primary" />}
                        Part {i + 1}
                      </span>
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeRect(r.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    {showTagInputs && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Select value={r.year} onValueChange={(v) => updateRectTag(r.id, "year", v)}>
                          <SelectTrigger className="h-6 w-[4.5rem] text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{YEARS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select value={r.month} onValueChange={(v) => updateRectTag(r.id, "month", v)}>
                          <SelectTrigger className="h-6 w-14 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{MONTHS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                        </Select>
                        <div className="flex items-center gap-0.5">
                          <span className="text-muted-foreground">p.</span>
                          <input
                            type="number" min={1} max={99}
                            value={r.part}
                            onChange={(e) => updateRectTag(r.id, "part", String(Math.max(1, Math.min(99, Number(e.target.value) || 1))))}
                            className="h-6 w-10 rounded border border-input bg-background px-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" className="h-7 text-xs"
                      onClick={addFullImage}>
                <SquareDashed className="mr-1 h-3 w-3" />
                Full image
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs"
                      onClick={() => setRects([])} disabled={!rects.length}>
                Clear
              </Button>
            </div>
            <div className="flex gap-1">
              {onCancel && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
                  Cancel
                </Button>
              )}
              <Button size="sm" className="h-7 text-xs"
                      onClick={handleExtract} disabled={!rects.length}>
                <Scissors className="mr-1 h-3 w-3" />
                Extract {rects.length} {rects.length === 1 ? "part" : "parts"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CropWizard – Dialog wrapper (used by old flow, signature unchanged) ───────

export function CropWizard({
  open,
  onOpenChange,
  imageSrc,
  imageName,
  aiBoxes,
  onExtract,
}: CropWizardProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-primary" /> Crop receipts from image
          </DialogTitle>
        </DialogHeader>
        <CropWizardPanel
          imageSrc={imageSrc}
          imageName={imageName}
          aiBoxes={aiBoxes}
          onExtract={(boxes, removeOriginal) => {
            onExtract(boxes, removeOriginal);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

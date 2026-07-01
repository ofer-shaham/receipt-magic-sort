import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Trash2, Scissors, Sparkles } from "lucide-react";
import type { BBox } from "@/lib/receipt-utils";

export type CropWizardProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string | null;
  imageName: string;
  aiBoxes?: BBox[]; // suggested by AI
  onExtract: (boxes: BBox[], removeOriginal: boolean) => void;
};

type Rect = BBox & { id: string; source: "ai" | "user" };

const uid = () => Math.random().toString(36).slice(2, 9);

export function CropWizard({
  open,
  onOpenChange,
  imageSrc,
  imageName,
  aiBoxes,
  onExtract,
}: CropWizardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [removeOriginal, setRemoveOriginal] = useState(true);
  const [useAISuggestions, setUseAISuggestions] = useState(true);

  // Seed with AI boxes when dialog opens or AI boxes change
  useEffect(() => {
    if (!open) return;
    if (useAISuggestions && aiBoxes && aiBoxes.length) {
      setRects(
        aiBoxes.map((b) => ({
          ...b,
          id: uid(),
          source: "ai" as const,
        })),
      );
    } else {
      setRects([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, aiBoxes, useAISuggestions]);

  const toNorm = (e: React.MouseEvent) => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const onDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset?.role === "rect") return;
    const p = toNorm(e);
    if (!p) return;
    startRef.current = p;
    setDrawing({ id: uid(), source: "user", x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!startRef.current || !drawing) return;
    const p = toNorm(e);
    if (!p) return;
    const s = startRef.current;
    setDrawing({
      ...drawing,
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };
  const onUp = () => {
    if (drawing && drawing.w > 0.02 && drawing.h > 0.02) {
      setRects((prev) => [...prev, drawing]);
    }
    setDrawing(null);
    startRef.current = null;
  };

  const remove = (id: string) =>
    setRects((prev) => prev.filter((r) => r.id !== id));

  const previews = useMemo(
    () =>
      rects.map((r, i) => ({
        id: r.id,
        idx: i + 1,
        name: `${imageName.replace(/\.[^.]+$/, "")}.part.${i + 1}.jpg`,
        source: r.source,
      })),
    [rects, imageName],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-primary" /> Crop receipts from image
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Drag rectangles around each receipt. Boxes with{" "}
          <Sparkles className="inline h-3 w-3 text-primary" /> came from the AI.
        </p>

        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
          <div
            ref={containerRef}
            className="relative max-h-[70vh] select-none overflow-auto rounded-md border bg-muted/20"
          >
            {imageSrc && (
              <div
                className="relative inline-block cursor-crosshair"
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
              >
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt={imageName}
                  draggable={false}
                  className="block max-w-full"
                />
                {[...rects, ...(drawing ? [drawing] : [])].map((r) => (
                  <div
                    key={r.id}
                    data-role="rect"
                    className={`absolute border-2 ${
                      r.source === "ai"
                        ? "border-primary bg-primary/10"
                        : "border-emerald-500 bg-emerald-500/10"
                    }`}
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.w * 100}%`,
                      height: `${r.h * 100}%`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded border bg-muted/20 p-2">
              <Checkbox
                id="ai-sug"
                checked={useAISuggestions}
                onCheckedChange={(c) => setUseAISuggestions(c === true)}
              />
              <Label htmlFor="ai-sug" className="text-xs">
                Use AI suggestions ({aiBoxes?.length ?? 0})
              </Label>
            </div>
            <div className="flex items-center gap-2 rounded border bg-muted/20 p-2">
              <Checkbox
                id="rm-orig"
                checked={removeOriginal}
                onCheckedChange={(c) => setRemoveOriginal(c === true)}
              />
              <Label htmlFor="rm-orig" className="text-xs">
                Remove original after extract
              </Label>
            </div>
            <div className="max-h-[50vh] space-y-1 overflow-auto rounded-md border">
              {previews.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  Draw a rectangle over each receipt to add it here.
                </p>
              ) : (
                previews.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 border-b px-2 py-1 text-xs last:border-b-0"
                  >
                    <span className="flex items-center gap-1">
                      {p.source === "ai" && (
                        <Sparkles className="h-3 w-3 text-primary" />
                      )}
                      <span className="font-mono">{p.name}</span>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => remove(p.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 border-t pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRects([])}
                disabled={!rects.length}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => onExtract(rects, removeOriginal)}
                disabled={!rects.length}
              >
                <Scissors className="mr-1 h-3 w-3" />
                Extract {rects.length} {rects.length === 1 ? "part" : "parts"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

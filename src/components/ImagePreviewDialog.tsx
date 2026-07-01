import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RotateCw, RotateCcw, ZoomIn, Scissors } from "lucide-react";

export type ImagePreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string | null;
  name: string;
  onOpenCropWizard?: () => void;
};

export function ImagePreviewDialog({
  open,
  onOpenChange,
  src,
  name,
  onOpenCropWizard,
}: ImagePreviewDialogProps) {
  const [rotation, setRotation] = useState(0);
  const [zoomEnabled, setZoomEnabled] = useState(true);
  const [zoom, setZoom] = useState({ visible: false, x: 0, y: 0, bgX: 0, bgY: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const LOUPE = 200; // px
  const MAG = 3;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!zoomEnabled) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Position loupe so it doesn't cover cursor; keep inside container
    const lx = Math.min(Math.max(0, x - LOUPE / 2), r.width - LOUPE);
    const ly = Math.min(Math.max(0, y - LOUPE / 2), r.height - LOUPE);
    // Background-position for magnified image
    const bgX = -(x * MAG - LOUPE / 2);
    const bgY = -(y * MAG - LOUPE / 2);
    setZoom({ visible: true, x: lx, y: ly, bgX, bgY });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setRotation(0);
          setZoom((z) => ({ ...z, visible: false }));
        }
      }}
    >
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-sm">{name}</span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
                title="Rotate left"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                title="Rotate right"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant={zoomEnabled ? "default" : "outline"}
                onClick={() => setZoomEnabled((z) => !z)}
                title="Toggle zoom loupe"
              >
                <ZoomIn className="mr-1 h-3.5 w-3.5" /> Loupe {zoomEnabled ? "on" : "off"}
              </Button>
              {onOpenCropWizard && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onOpenCropWizard}
                  title="Extract multiple receipts by cropping"
                >
                  <Scissors className="mr-1 h-3.5 w-3.5" /> Crop parts
                </Button>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>
        {src && (
          <div
            ref={wrapRef}
            className="relative max-h-[80vh] overflow-auto rounded-md border bg-muted/20"
            onMouseMove={onMove}
            onMouseLeave={() => setZoom((z) => ({ ...z, visible: false }))}
          >
            <img
              src={src}
              alt={name}
              draggable={false}
              className="mx-auto block max-w-full select-none transition-transform"
              style={{ transform: `rotate(${rotation}deg)` }}
            />
            {zoomEnabled && zoom.visible && (
              <div
                className="pointer-events-none absolute rounded-md border-2 border-primary shadow-lg"
                style={{
                  left: zoom.x,
                  top: zoom.y,
                  width: LOUPE,
                  height: LOUPE,
                  backgroundImage: `url(${src})`,
                  backgroundRepeat: "no-repeat",
                  backgroundSize: `${(wrapRef.current?.clientWidth ?? 0) * MAG}px auto`,
                  backgroundPosition: `${zoom.bgX}px ${zoom.bgY}px`,
                }}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

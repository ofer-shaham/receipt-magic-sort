/**
 * CropModal — full-page overlay that hosts CropWizardPanel.
 * The panel fills the entire viewport so the canvas is as large as possible.
 */
import { useState } from "react";
import { CropWizardPanel, type TaggedCrop } from "@/components/CropWizard";
import { Button } from "@/components/ui/button";
import { Scissors, X } from "lucide-react";

export type CropModalProps = {
  imageSrc:      string;
  imageName:     string;
  defaultYear?:  string;
  defaultMonth?: string;
  /** Number of PDF pages (undefined for images) */
  pageCount?:    number;
  onExtract:     (crops: TaggedCrop[], removeOriginal: boolean) => void;
  onClose:       () => void;
};

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

export function CropModal({
  imageSrc, imageName, defaultYear, defaultMonth, pageCount, onExtract, onClose,
}: CropModalProps) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // Estimate JPEG size from base64 dataUrl length
  const approxBytes = imageSrc.startsWith("data:")
    ? Math.round((imageSrc.length * 3) / 4)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ── Header bar ── */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Scissors className="h-4 w-4 flex-shrink-0 text-primary" />
        <div className="flex flex-1 flex-col min-w-0">
          <span className="truncate text-sm font-semibold leading-tight">{imageName}</span>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground leading-tight">
            {pageCount != null && pageCount > 1 && (
              <span>{pageCount} pages stitched</span>
            )}
            {dims && (
              <span>{dims.w} × {dims.h} px</span>
            )}
            {approxBytes != null && (
              <span>≈ {fmtBytes(approxBytes)}</span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-auto p-4">
        <CropWizardPanel
          imageSrc={imageSrc}
          imageName={imageName}
          defaultYear={defaultYear}
          defaultMonth={defaultMonth}
          showTagInputs
          onTaggedExtract={onExtract}
          onCancel={onClose}
          onImageLoad={(w, h) => setDims({ w, h })}
        />
      </div>
    </div>
  );
}

/**
 * CropModal — full-page overlay that hosts CropWizardPanel.
 * The panel fills the entire viewport so the canvas is as large as possible.
 */
import { CropWizardPanel, type TaggedCrop } from "@/components/CropWizard";
import { Button } from "@/components/ui/button";
import { Scissors, X } from "lucide-react";

export type CropModalProps = {
  imageSrc:     string;
  imageName:    string;
  defaultYear?: string;
  defaultMonth?: string;
  onExtract:    (crops: TaggedCrop[], removeOriginal: boolean) => void;
  onClose:      () => void;
};

export function CropModal({
  imageSrc, imageName, defaultYear, defaultMonth, onExtract, onClose,
}: CropModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ── Header bar ── */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Scissors className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="flex-1 truncate text-sm font-semibold">{imageName}</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
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
        />
      </div>
    </div>
  );
}

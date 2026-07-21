/**
 * AISettingsPanel — footer trigger button that opens the GlobalAISettingsDialog.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { GlobalAISettingsDialog } from "@/components/GlobalAISettingsDialog";

export function AISettingsPanel() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title="AI Settings"
        onClick={() => setOpen(true)}
      >
        <Settings className="h-4 w-4" />
      </Button>

      <GlobalAISettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

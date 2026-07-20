/**
 * AppFooter — shared bottom bar that appears on every route.
 * Contains: AI settings | Logs
 */
import { AISettingsPanel } from "@/components/AISettingsPanel";
import { LogsPanel } from "@/components/LogsPanel";

export function AppFooter() {
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex h-10 items-center gap-1 border-t border-border bg-background/95 px-3 backdrop-blur-sm">
      <span className="text-[11px] font-medium text-muted-foreground select-none mr-1">
        AI
      </span>
      <AISettingsPanel />
      <LogsPanel />
    </footer>
  );
}

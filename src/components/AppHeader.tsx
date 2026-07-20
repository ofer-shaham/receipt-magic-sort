/**
 * AppHeader — shared top navigation that appears on every route.
 * Contains: app title | theme selector | AI settings | logs | route tabs (Old / New)
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Sun, Moon, Droplet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AISettingsPanel } from "@/components/AISettingsPanel";
import { LogsPanel } from "@/components/LogsPanel";

type Theme = "light" | "dark" | "blue";
const THEME_KEY = "receipt-theme";

function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "theme-blue");
  if (t === "dark")  root.classList.add("dark");
  if (t === "blue")  root.classList.add("theme-blue");
  localStorage.setItem(THEME_KEY, t);
}

export function AppHeader() {
  const [theme, setTheme] = useState<Theme>("light");

  // Read stored theme on mount and apply immediately
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_KEY) as Theme) || "light";
    setTheme(stored);
    applyTheme(stored);
  }, []);

  const changeTheme = (t: Theme) => { setTheme(t); applyTheme(t); };

  return (
    <header className="border-b border-border bg-background">
      {/* ── Top bar: title | theme | AI | Logs ── */}
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="text-sm font-bold tracking-tight text-foreground select-none">
          ReceiptForge
        </span>

        <div className="flex-1" />

        {/* Theme toggle group */}
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <ThemeBtn current={theme} value="light" title="Light"  onClick={changeTheme}>
            <Sun  className="h-3.5 w-3.5" />
          </ThemeBtn>
          <ThemeBtn current={theme} value="dark"  title="Dark"   onClick={changeTheme}>
            <Moon className="h-3.5 w-3.5" />
          </ThemeBtn>
          <ThemeBtn current={theme} value="blue"  title="Blue"   onClick={changeTheme}>
            <Droplet className="h-3.5 w-3.5" />
          </ThemeBtn>
        </div>

        <AISettingsPanel />
        <LogsPanel />
      </div>

      {/* ── Route tabs: Old | New ── */}
      <div className="flex px-4">
        <RouteTab to="/old" label="Old" exact />
        <RouteTab to="/new" label="New" />
      </div>
    </header>
  );
}

// ── Private helpers ─────────────────────────────────────────────────────────

function ThemeBtn({
  current, value, title, onClick, children,
}: {
  current: Theme; value: Theme; title: string;
  onClick: (t: Theme) => void; children: React.ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant={current === value ? "secondary" : "ghost"}
      className="h-6 w-6"
      title={title}
      onClick={() => onClick(value)}
    >
      {children}
    </Button>
  );
}

function RouteTab({ to, label, exact }: { to: string; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact, includeSearch: false }}
      className="relative px-4 py-2 text-sm font-medium text-muted-foreground transition-colors
        hover:text-foreground
        data-[status=active]:text-foreground
        data-[status=active]:after:absolute data-[status=active]:after:bottom-0
        data-[status=active]:after:left-0   data-[status=active]:after:right-0
        data-[status=active]:after:h-0.5    data-[status=active]:after:rounded-t
        data-[status=active]:after:bg-primary"
    >
      {label}
    </Link>
  );
}

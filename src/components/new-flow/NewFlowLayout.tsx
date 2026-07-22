/**
 * NewFlowLayout — layout shell for /new/* routes.
 * Renders the tab bar (router-linked) and an <Outlet /> for the active tab.
 */
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";

function InlineTab({ to, children }: { to: string; children: React.ReactNode }) {
  const matchRoute = useMatchRoute();
  const isActive = !!matchRoute({ to });
  return (
    <Link
      to={to}
      className={`relative px-4 py-2 text-sm font-medium transition-colors ${
        isActive
          ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:rounded-t after:bg-primary"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

export function NewFlowLayout() {
  return (
    <div className="flex min-h-[calc(100vh-6.5rem)] flex-col">
      <div className="flex border-b border-border px-4">
        <InlineTab to="/new/crop-tag">Crop &amp; Tag</InlineTab>
        <InlineTab to="/new/image-csv">Image → CSV</InlineTab>
        <InlineTab to="/new/csv-export">CSV Import/Export</InlineTab>
      </div>
      <Outlet />
    </div>
  );
}

import { createFileRoute, Outlet, Link, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/new")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/new" || location.pathname === "/new/") {
      throw redirect({ to: "/new/pdf-to-images" });
    }
  },
  component: NewLayout,
});

function NewLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Sub-tab bar */}
      <div className="flex border-b border-border bg-muted/40 px-4">
        <SubTab to="/new/pdf-to-images" label="PDF → Images" />
        <SubTab to="/new/images-to-csv" label="Images → CSV" />
      </div>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function SubTab({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true, includeSearch: false }}
      className="relative px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground
        data-[status=active]:text-foreground data-[status=active]:after:absolute
        data-[status=active]:after:bottom-0 data-[status=active]:after:left-0
        data-[status=active]:after:right-0 data-[status=active]:after:h-0.5
        data-[status=active]:after:bg-primary"
    >
      {label}
    </Link>
  );
}

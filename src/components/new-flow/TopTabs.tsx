import { Link } from "@tanstack/react-router";

export function TopTabs() {
  return (
    <div className="flex border-b border-border bg-background px-4">
      <TopTab to="/old" label="Old" exact />
      <TopTab to="/new" label="New" />
    </div>
  );
}

function TopTab({
  to,
  label,
  exact,
}: {
  to: string;
  label: string;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact, includeSearch: false }}
      className="relative px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground
        data-[status=active]:text-foreground data-[status=active]:after:absolute
        data-[status=active]:after:bottom-0 data-[status=active]:after:left-0
        data-[status=active]:after:right-0 data-[status=active]:after:h-0.5
        data-[status=active]:after:bg-primary data-[status=active]:after:rounded-t"
    >
      {label}
    </Link>
  );
}

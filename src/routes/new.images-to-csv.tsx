import { createFileRoute, redirect } from "@tanstack/react-router";

// Sub-route preserved for backward compat; redirects to the unified /new flow.
export const Route = createFileRoute("/new/images-to-csv")({
  beforeLoad: () => { throw redirect({ to: "/new" }); },
  component: () => null,
});

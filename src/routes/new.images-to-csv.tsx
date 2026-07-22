import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy URL — redirect to the new per-route path.
export const Route = createFileRoute("/new/images-to-csv")({
  beforeLoad: () => { throw redirect({ to: "/new/image-csv" }); },
  component: () => null,
});

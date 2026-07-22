import { createFileRoute } from "@tanstack/react-router";
import { ReportFlow } from "@/components/new-flow/ReportFlow";

export const Route = createFileRoute("/new/report")({
  component: ReportFlow,
});

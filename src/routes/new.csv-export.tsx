import { createFileRoute } from "@tanstack/react-router";
import { CsvImportFlow } from "@/components/new-flow/CsvImportFlow";

export const Route = createFileRoute("/new/csv-export")({
  component: CsvImportFlow,
});

import { createFileRoute } from "@tanstack/react-router";
import { ImageCsvFlow } from "@/components/new-flow/ImageCsvFlow";

export const Route = createFileRoute("/new/image-csv")({
  component: ImageCsvFlow,
});

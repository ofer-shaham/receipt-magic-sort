import { createFileRoute } from "@tanstack/react-router";
import { CropTagFlow } from "@/components/new-flow/CropTagFlow";

export const Route = createFileRoute("/new/crop-tag")({
  component: CropTagFlow,
});

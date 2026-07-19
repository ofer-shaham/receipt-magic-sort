import { createFileRoute } from "@tanstack/react-router";
import { ImagesToCsvFlow } from "@/components/new-flow/ImagesToCsvFlow";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/new/images-to-csv")({
  head: () => ({
    meta: [{ title: "ReceiptForge — Images → CSV" }],
  }),
  component: ImagesToCsvPage,
});

function ImagesToCsvPage() {
  return (
    <>
      <ImagesToCsvFlow />
      <Toaster />
    </>
  );
}

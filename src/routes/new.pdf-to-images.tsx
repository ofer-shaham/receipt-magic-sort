import { createFileRoute } from "@tanstack/react-router";
import { PdfToImagesFlow } from "@/components/new-flow/PdfToImagesFlow";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/new/pdf-to-images")({
  head: () => ({
    meta: [{ title: "ReceiptForge — PDF → Images" }],
  }),
  component: PdfToImagesPage,
});

function PdfToImagesPage() {
  return (
    <>
      <PdfToImagesFlow />
      <Toaster />
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { ReceiptApp } from "@/components/ReceiptApp";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/old")({
  head: () => ({
    meta: [
      { title: "ReceiptForge — Compress, sort & export receipts to PDF" },
      { name: "description", content: "Upload receipts, control compression, auto-extract dates with AI, and export a single optimised PDF." },
    ],
  }),
  component: OldPage,
});

function OldPage() {
  return (
    <>
      <ReceiptApp />
      <Toaster />
    </>
  );
}

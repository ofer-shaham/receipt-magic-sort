import { createFileRoute } from "@tanstack/react-router";
import { NewReceiptFlow } from "@/components/new-flow/NewReceiptFlow";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/new")({
  component: NewPage,
});

function NewPage() {
  return (
    <>
      <NewReceiptFlow />
      <Toaster />
    </>
  );
}

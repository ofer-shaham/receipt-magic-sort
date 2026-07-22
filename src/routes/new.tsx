import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { NewFlowLayout } from "@/components/new-flow/NewFlowLayout";

export const Route = createFileRoute("/new")({
  component: NewPage,
});

function NewPage() {
  return (
    <>
      <NewFlowLayout />
      <Toaster />
    </>
  );
}

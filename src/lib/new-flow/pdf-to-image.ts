/**
 * Render every page of a PDF file into a single vertically-stitched JPEG.
 * pdfjs-dist is imported lazily so the module can be evaluated in SSR
 * (which lacks DOMMatrix / canvas) without throwing.
 */
export async function pdfToStitchedJpeg(
  file: File,
  dpi = 150,
  onProgress?: (current: number, total: number) => void,
): Promise<{ file: File; pageCount: number }> {
  const pdfjsLib = await import("pdfjs-dist");

  // Point the worker at the bundled copy so Vite can resolve it at build time.
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const scale = dpi / 72; // PDF points are 72 dpi

  const canvases: HTMLCanvasElement[] = [];
  let totalHeight = 0;
  let maxWidth = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    canvases.push(canvas);
    totalHeight += canvas.height;
    maxWidth = Math.max(maxWidth, canvas.width);
  }

  const stitched = document.createElement("canvas");
  stitched.width = maxWidth;
  stitched.height = totalHeight;
  const sctx = stitched.getContext("2d")!;
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, maxWidth, totalHeight);
  let y = 0;
  for (const c of canvases) {
    sctx.drawImage(c, 0, y);
    y += c.height;
  }

  const blob: Blob = await new Promise((res) =>
    stitched.toBlob((b) => res(b!), "image/jpeg", 0.85),
  );
  const base = file.name.replace(/\.pdf$/i, "");
  return {
    file: new File([blob], `${base}.jpg`, { type: "image/jpeg" }),
    pageCount: pdf.numPages,
  };
}

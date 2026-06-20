# ReceiptForge

A client-side web app that compresses, sorts, dates and exports receipt photos to one or more PDFs — entirely in your browser. No server, no upload of your data.

## Features

### Ingest
- Drag-and-drop or pick multiple images (JPG, PNG, WebP).
- Drop ZIP archives — images are extracted in-memory and the archive itself is discarded (no storage).
- Per-image quality override + global JPEG quality slider.

### AI date extraction (OpenRouter)
- Free vision models with built-in fallback list plus on-demand "Fetch free" lookup of every active vision model priced at $0.
- Round-robin across multiple OpenRouter API keys, with **per-key cooldowns** (keyed by the key string, not the index).
- Configurable: minimum delay between key uses, failures-before-cooldown, cooldown duration.
- LocalStorage cache of AI date results, keyed by `filename::size`, survives reloads.
- Each receipt is tagged with its source (AI ✨ vs Manual 🏷) and model name.
- Receipts use **DD/MM/YY** as the canonical printed format (the AI is instructed accordingly to avoid day/month flips).

### Review wizard
- Step through every image, see large preview, set/clear date.
- Auto-saves on every change with a toast confirmation.
- Year/Month/Day pickers; configurable year range (default = last 5 years).

### Grid preview & PDF export
- Live grid preview with adjustable scale, sort direction (asc/desc by date).
- Per-image controls in preview: **preview large**, **exclude from PDF**, **remove**.
- Export options:
  - One-image-per-page PDF with optional printed date label.
  - Grid PDF (multiple images per page), configurable columns.
  - **Auto-split** into multiple PDFs to respect a configurable max-size (default 10 MB).
- Live PDF size + page count display, with open/download per part.

### Reports & exports
- Date report (TSV download + in-app table), optionally including filenames.
- Year × Month coverage matrix (✓ per month that has at least one receipt).
- Renamed-archive ZIP export: every image renamed `YYYY-MM-DD_<slug>.<ext>`.
- LocalStorage **export / import** (JSON) with optional **auto-save every N seconds**.

### UX
- Light / Dark / Blue themes.
- Configurable visibility of side-panel control sections (settings dialog).
- Full error log with stack traces, per-entry and "copy all" clipboard buttons.

---

## Possible future ideas

- OCR full-receipt text extraction (vendor, total, tax) and structured CSV report.
- Currency / total parsing → monthly spend chart and per-vendor breakdown.
- Tagging by category (food, travel, fuel…) with bulk edit.
- Cloud sync of cache & settings (opt-in, end-to-end encrypted).
- Multi-page receipt detection (stitch consecutive images of the same long receipt).
- Bulk wizard: assign the same month/year to a range of selected receipts.
- Duplicate detection by perceptual hash.
- Direct upload to Google Drive / Dropbox once the PDF is built.
- Custom PDF layouts: cover page, table of contents, per-month section breaks.
- Mobile capture mode (camera-first UI, deskew + edge-crop).
- IndexedDB caching of compressed blobs for faster reopen of large batches.
- * i18n: localized month names, RTL layout, Hebrew/Arabic date parsing.
- * Configurable date-format preference (DD/MM/YY, MM/DD/YY, YYYY-MM-DD) feeding the AI prompt.
- * Self-hosted OCR fallback (Tesseract.js WASM) for offline operation.
- Keyboard shortcuts for the wizard (←/→ navigate, ⌫ clear, ↵ next).

---

## Next TODOs
1. add a tab which expose full logs (server, client, 3rd parties (i.e: AI))
2. add tab which monitor AI work and token balance
3. add a flow named "cropping" which allows the user extract image from another. and keep recording of the new images which created by cropping and allow to export the new images to files based on the original filename and also add a suffix:  .child.[index]
4. add an alternative flow for the cropping  which automaticly extract image to its receipts if there are more then 1 in a single picture (AI can return the coordinates for cropping and then the cropping will be done automaticly based on that info).
5. update the README and explain how the app work: which operation the AI is doing and which one the image library.






---

## Tech

- React 19 + TanStack Start (Vite 7)
- Tailwind v4 + shadcn/ui
- `pdf-lib` for PDF generation, `jszip` for ZIP read/write
- 100% client-side — your receipts never leave the browser.

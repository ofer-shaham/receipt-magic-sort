# ReceiptForge

A 100% client-side web app that compresses, sorts, dates, and exports receipt photos to PDF — receipts never leave the browser.

## Stack

- React 19 + TanStack Start (Vite 7)
- Tailwind v4 + shadcn/ui
- `pdf-lib` for PDF generation, `jszip` for ZIP read/write
- No backend — all processing happens in the browser

## Running the app

```bash
npm install
npm run dev
```

The dev server starts on port 8080. The workflow "Start application" runs `npm run dev` automatically.

## Key features

- Drag-and-drop or ZIP upload of JPG/PNG/WebP receipts
- AI date extraction via OpenRouter (users supply their own API keys through the app UI — no secrets needed to run the app)
- Review wizard to manually set/correct dates
- Grid preview + PDF export (one-per-page or grid layout, auto-split by size)
- Date report, Year×Month matrix, renamed-archive ZIP export
- LocalStorage persistence for AI results and settings
- Light / Dark / Blue themes

## Project structure

- `src/routes/` — TanStack Router page routes
- `src/components/` — React components
- `src/hooks/` — custom hooks
- `src/contexts/` — React context providers
- `src/lib/` — utilities

## User preferences

_None recorded yet._

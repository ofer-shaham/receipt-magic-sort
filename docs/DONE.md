# Done — Change log

A running log of major features that have shipped in ReceiptForge. Newest first.

## Multi-receipt-per-image + approval flow

### 1. AI returns an array of dates per image
- `extractDateWithAI` now asks the model to return `{"dates":[{raw, iso}, …]}` —
  one entry per distinct receipt visible in the image.
- The result type `AIDateResult` exposes `dates: AIDateEntry[]` alongside the
  primary `iso`/`raw` (first detected date). Backward-compatible: single-date
  responses still parse correctly.
- Detection prompt re-asserts the strict DD/MM/YY format (day-first, never
  swapped with month) — applies to single and multi-receipt images alike.

### 2. User approval flow (Wizard)
- Each `Receipt` now carries an `approved: boolean`. AI extractions land as
  `approved=false`; manual edits and explicit wizard approvals set it to
  `true`.
- Wizard queue order prioritises **untagged → AI-unapproved → approved/manual**
  so the user reviews uncertain detections first.
- New **Approve** button confirms the displayed date is correct and advances
  to the next item. Editing the date through the printed-text field or the
  Year/Month/Day selectors also counts as approval.
- A `needs approval` / `approved` badge appears in the wizard header, and a
  small amber `?` (or `?×N` for multi-detection images) appears beside the
  date chip in the receipts list.
- Multi-detection images render an amber **"AI detected N receipts"** panel
  with one chip per detected date — click a chip to pick that date as the
  primary one for this image.

### 3. Alternative: split a multi-receipt image into separate images
- New setting **"When AI detects multiple receipts on one image, auto-split
  into separate images"** under the *Quality & PDF size* section.
  - When enabled: the AI call that returns N dates triggers a horizontal
    image split into N equal slices. Each slice becomes its own receipt,
    pre-tagged with the corresponding detected date, marked unapproved so
    the user can still verify.
- On-demand split: even with the setting off, the wizard shows a
  **"Split image into N receipts"** button on any multi-detection image.
  The split is done client-side via canvas; the new slices reuse the
  original filename with `_part1`, `_part2`, … suffixes.
- Cache (`receipt-date-cache-v3`) now stores `aiDates` and `approved` so the
  multi-detection state and approvals persist across reloads and exports.

## Previously shipped (highlights)

- Per-image localStorage cache keyed by `name::size`.
- Round-robin across multiple OpenRouter API keys, per-key cooldown after
  rate-limit or N consecutive failures, configurable min interval between
  uses of the same key.
- AI job queue with progress, cancel, and tag chip showing which key/model
  produced the result.
- Wizard with image preview, free-text printed-date field, and separate
  Year / Month / Day selectors that prevent day/month flipping. Output
  defaults to DD/MM/YY.
- Date chip styling distinguishes AI vs manual sources.
- Double-click an image (list or grid) for a large preview dialog.
- Exclude / include images in the PDF; remove an image entirely from the
  collection.
- Grid PDF mode with adjustable column count; per-image quality override;
  per-PDF max size (default 10 MB, range editable).
- Date report (TSV) and Year × Month coverage matrix.
- Renamed-archive export (`<date>_<filename>.jpg` ZIP).
- Export / import the full localStorage as JSON; optional auto-save every
  N seconds.
- Themes: light / dark / blue.
- Configurable show/hide for every side-panel section.
- Error log panel with expandable stack traces and copy-to-clipboard for
  individual entries or the whole log.
- Fetch the live free-vision OpenRouter model list and pick one per run.

## Ideas for the future

- Confidence score per AI detection (model-reported when available).
- Smart split: detect receipt boundaries via white-gap analysis instead of
  always slicing into equal parts.
- Cross-check the AI date against EXIF capture time when present.
- Bulk approve / bulk re-extract from the list view.
- Per-key quota tracking from OpenRouter credits API.

/**
 * AppStore — lives in the root component so state survives /old ↔ /new navigation.
 * File objects are in-memory only (cannot be serialised). Tag metadata is separately
 * persisted to localStorage by the individual flows.
 */
import React, { createContext, useContext, useState } from "react";

// ── Item types ────────────────────────────────────────────────────────────────

export type StorePdfItem = {
  kind:  "pdf";
  id:    string;
  file:  File;
  name:  string;
};

export type StoreSourceItem = {
  kind:    "source";
  id:      string;
  file:    File;
  dataUrl: string;
  name:    string;
};

export type StoreTaggedItem = {
  kind:    "tagged";
  id:      string;
  file:    File;
  dataUrl: string;
  name:    string;
  year:    string;
  month:   string;
  part:    string;
  ck:      string;   // `name::size` — localStorage tag-cache key
};

export type StoreCsvItem = {
  id:           string;
  file:         File;
  dataUrl:      string;
  name:         string;
  year:         string;
  month:        string;
  part:         string;
  ck:           string;
  extraction:   { columns: string[]; rows: string[][] } | null;
  editedRows:   string[][] | null;
  extractState: "idle" | "loading" | "done" | "error";
  extractError?: string;
};

// ── Default global columns hint ───────────────────────────────────────────────
export const DEFAULT_COLUMNS_HINT = "יום,ערך,תיאור פעולה,אסמכתא,זכות,חובה,יתרה";

// ── Imported CSV file (CSV Import/Export tab) ─────────────────────────────────

export type StoreImportedCsv = {
  id:      string;
  name:    string;   // original filename
  tag:     { year: string; month: string; part: string };
  columns: string[];
  rows:    string[][];
};

// ── Report (generated from CSV Import/Export) ─────────────────────────────────

export type StoreReportRow = {
  id:        string;
  filename:  string;
  cells:     string[];
  isContext: boolean; // true = exposed context row, false = direct keyword match
  notes:     string;
};

// ── CSV Import/Export UI state ────────────────────────────────────────────────
// Kept in the store so the tab survives navigation away and back.

export type CsvImportUiState = {
  sortDir:        "asc" | "desc";
  filterColumn:   string;
  filterKeywords: string[];
  globalBefore:   number;
  globalAfter:    number;
  openItems:      string[];
  exposeOverrides: Record<string, { before: number; after: number }>;
};

export const DEFAULT_CSV_IMPORT_UI: CsvImportUiState = {
  sortDir:         "asc",
  filterColumn:    "",
  filterKeywords:  [],
  globalBefore:    0,
  globalAfter:     0,
  openItems:       [],
  exposeOverrides: {},
};

// ── Context ───────────────────────────────────────────────────────────────────

type AppStoreCtx = {
  // /new — crop & tag
  pdfs:       StorePdfItem[];
  setPdfs:    React.Dispatch<React.SetStateAction<StorePdfItem[]>>;
  sources:    StoreSourceItem[];
  setSources: React.Dispatch<React.SetStateAction<StoreSourceItem[]>>;
  tagged:     StoreTaggedItem[];
  setTagged:  React.Dispatch<React.SetStateAction<StoreTaggedItem[]>>;
  // /new — image → csv
  csvItems:    StoreCsvItem[];
  setCsvItems: React.Dispatch<React.SetStateAction<StoreCsvItem[]>>;
  // global CSV columns hint (shared across all extractions)
  csvColumnsHint:    string;
  setCsvColumnsHint: React.Dispatch<React.SetStateAction<string>>;
  // /new — csv import/export (files + ui state)
  importedCsvFiles:    StoreImportedCsv[];
  setImportedCsvFiles: React.Dispatch<React.SetStateAction<StoreImportedCsv[]>>;
  csvImportUi:    CsvImportUiState;
  setCsvImportUi: React.Dispatch<React.SetStateAction<CsvImportUiState>>;
  // /new — report (generated from csv import/export, shown in /new/report)
  reportRows:       StoreReportRow[];
  setReportRows:    React.Dispatch<React.SetStateAction<StoreReportRow[]>>;
  reportColumns:    string[];
  setReportColumns: React.Dispatch<React.SetStateAction<string[]>>;
};

const AppStore = createContext<AppStoreCtx | null>(null);

export function AppStoreProvider({ children }: { children: React.ReactNode }) {
  const [pdfs,             setPdfs]             = useState<StorePdfItem[]>([]);
  const [sources,          setSources]          = useState<StoreSourceItem[]>([]);
  const [tagged,           setTagged]           = useState<StoreTaggedItem[]>([]);
  const [csvItems,         setCsvItems]         = useState<StoreCsvItem[]>([]);
  const [csvColumnsHint,   setCsvColumnsHint]   = useState<string>(DEFAULT_COLUMNS_HINT);
  const [importedCsvFiles, setImportedCsvFiles] = useState<StoreImportedCsv[]>([]);
  const [csvImportUi,      setCsvImportUi]      = useState<CsvImportUiState>(DEFAULT_CSV_IMPORT_UI);
  const [reportRows,       setReportRows]       = useState<StoreReportRow[]>([]);
  const [reportColumns,    setReportColumns]    = useState<string[]>([]);

  return (
    <AppStore.Provider value={{
      pdfs, setPdfs,
      sources, setSources,
      tagged, setTagged,
      csvItems, setCsvItems,
      csvColumnsHint, setCsvColumnsHint,
      importedCsvFiles, setImportedCsvFiles,
      csvImportUi, setCsvImportUi,
      reportRows, setReportRows,
      reportColumns, setReportColumns,
    }}>
      {children}
    </AppStore.Provider>
  );
}

export function useAppStore() {
  const ctx = useContext(AppStore);
  if (!ctx) throw new Error("useAppStore must be used inside AppStoreProvider");
  return ctx;
}

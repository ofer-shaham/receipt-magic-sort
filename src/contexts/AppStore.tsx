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
  // active internal tab in /new
  newTab:    "crop" | "csv";
  setNewTab: React.Dispatch<React.SetStateAction<"crop" | "csv">>;
};

const AppStore = createContext<AppStoreCtx | null>(null);

export function AppStoreProvider({ children }: { children: React.ReactNode }) {
  const [pdfs,     setPdfs]     = useState<StorePdfItem[]>([]);
  const [sources,  setSources]  = useState<StoreSourceItem[]>([]);
  const [tagged,   setTagged]   = useState<StoreTaggedItem[]>([]);
  const [csvItems, setCsvItems] = useState<StoreCsvItem[]>([]);
  const [newTab,   setNewTab]   = useState<"crop" | "csv">("crop");

  return (
    <AppStore.Provider value={{
      pdfs, setPdfs,
      sources, setSources,
      tagged, setTagged,
      csvItems, setCsvItems,
      newTab, setNewTab,
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

const LOG_KEY = "receiptforge-new-ai-logs-v1";

export type AIRequestLog = {
  ts: number;
  filename: string;
  model: string;
  provider: string;
  byteSize: number;
  origin: "pdf-to-images" | "images-to-csv";
};

export function appendAILog(entry: AIRequestLog): void {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const logs: AIRequestLog[] = raw ? JSON.parse(raw) : [];
    logs.push(entry);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  } catch {
    /* ignore storage errors */
  }
}

export function readAILogs(): AIRequestLog[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

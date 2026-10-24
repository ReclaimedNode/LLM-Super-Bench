/**
 * `bun run probe http://host:8000` -- asks a machine every status address this tool knows
 * about and prints what came back, then what it made of it. For when a machine's details
 * say "not reported": paste the output into an issue and the reading can be fixed.
 *
 * The output is made safe to paste: addresses and home folders are masked unless --raw.
 * Read-only: it only ever sends GET requests.
 */

import { probeDetails } from "./details.ts";
import type { Fetcher } from "./lane.ts";

/** Every address the engine readers look at, in one list. */
export const PROBE_PATHS = [
  "/v1/models",
  "/props",
  "/slots",
  "/version",
  "/health",
  "/info",
  "/get_server_info",
  "/api/version",
  "/api/tags",
  "/api/ps",
  "/api/v0/models",
  "/api/extra/version",
  "/metrics",
] as const;

const SNIPPET = 600;

/** Masks IPv4 addresses, host names with a port, and user folders, so a paste does not give away a network. */
export function redact(text: string): string {
  return text
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "x.x.x.x")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|home|internal)\b/gi, "host.local")
    .replace(/\/(Users|home)\/[^/\s"']+/g, "/$1/<user>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "C:\\Users\\<user>");
}

export interface ProbeAnswer {
  path: string;
  status: number | null;
  type: string | null;
  snippet: string | null;
  error: string | null;
}

export async function askAll(baseUrl: string, opts: { apiKey?: string; fetchImpl?: Fetcher; timeoutMs?: number } = {}): Promise<ProbeAnswer[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return Promise.all(
    PROBE_PATHS.map(async (path): Promise<ProbeAnswer> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
      try {
        const headers: Record<string, string> = {};
        if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
        const r = await fetchImpl(`${baseUrl}${path}`, { headers, signal: controller.signal });
        const body = (await r.text()).slice(0, 200_000);
        // /metrics is long; show only the lines that name the engine or its limits.
        const shown = path === "/metrics"
          ? body.split("\n").filter((l) => /max_num_seqs|^# HELP (vllm|sglang|tgi|llamacpp)/i.test(l)).slice(0, 6).join("\n")
          : body;
        return { path, status: r.status, type: r.headers.get("content-type"), snippet: shown.slice(0, SNIPPET), error: null };
      } catch (err) {
        return { path, status: null, type: null, snippet: null, error: err instanceof Error && err.name === "AbortError" ? "no answer in time" : "could not connect" };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

export async function probeReport(baseUrl: string, opts: { apiKey?: string; fetchImpl?: Fetcher; raw?: boolean } = {}): Promise<string> {
  const answers = await askAll(baseUrl, opts);
  const details = await probeDetails({ label: "probe", baseUrl, model: "", ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) } as never, "probe", { fetchImpl: opts.fetchImpl });
  const lines: string[] = ["LLM-Super-Bench probe", ""];
  lines.push("What this tool made of it:");
  lines.push(`  engine:            ${details.engine ?? "not recognised"}`);
  lines.push(`  model file:        ${details.modelFile ?? "not reported"}`);
  lines.push(`  quant:             ${details.quant ?? "not reported"}`);
  lines.push(`  build / version:   ${details.build ?? "not reported"}`);
  lines.push(`  slots:             ${details.slots ?? "not reported"}`);
  lines.push(`  context per slot:  ${details.contextPerSlot ?? "not reported"}`);
  lines.push(`  images:            ${details.vision ?? "not reported"}`);
  lines.push("", "What each address answered:");
  for (const a of answers) {
    if (a.error) {
      lines.push(`  GET ${a.path}  ->  ${a.error}`);
      continue;
    }
    lines.push(`  GET ${a.path}  ->  HTTP ${a.status}${a.type ? `  (${a.type.split(";")[0]})` : ""}`);
    if (a.status !== null && a.status >= 200 && a.status < 300 && a.snippet) {
      for (const l of a.snippet.split("\n").slice(0, 12)) lines.push(`      ${l.slice(0, 200)}`);
    }
  }
  const text = lines.join("\n") + "\n";
  return opts.raw ? text : redact(text);
}

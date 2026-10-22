/**
 * Preflight, run once per lane before a race.
 *
 * Two checks:
 *  1. The configured model id must appear in GET {base}/v1/models. mlx_lm.server
 *     treats an unknown `model` as a model to DOWNLOAD -- it calls out to
 *     huggingface.co and 404s. A lane that would do that is refused, loudly,
 *     instead of racing.
 *  2. A one-token streaming probe asking for `stream_options.include_usage`,
 *     which answers "does this endpoint report token counts?" before the race
 *     rather than after it. The probe also warms the model on every lane
 *     equally, which is the fair way to start.
 */

import type { Fetcher } from "./lane.ts";
import { readUsageTokens } from "./lane.ts";
import type { LaneConfig } from "./types.ts";

export interface PreflightResult {
  ok: boolean;
  message: string;
  /** null when the probe could not answer (timed out, or the lane is already refused). */
  usageSupported: boolean | null;
  /** Model ids the endpoint listed, for the refusal message. */
  availableModels: string[];
}

function authHeaders(lane: LaneConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (lane.apiKey) h.Authorization = `Bearer ${lane.apiKey}`;
  return h;
}

export function extractModelIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** Does this endpoint return a usage block when asked? One cheap streaming call. */
async function probeUsage(
  lane: LaneConfig,
  fetchImpl: Fetcher,
  timeoutMs: number,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${lane.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(lane),
      signal: controller.signal,
      body: JSON.stringify({
        model: lane.model,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 1,
        temperature: 0,
      }),
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawUsage = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try {
          if (readUsageTokens(JSON.parse(payload)) !== null) sawUsage = true;
        } catch {
          /* ignore a malformed probe frame */
        }
      }
    }
    return sawUsage;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightLane(opts: {
  lane: LaneConfig;
  timeoutMs: number;
  fetchImpl?: Fetcher;
  /** Skip the usage/warmup probe. Tests use this; races do not. */
  skipUsageProbe?: boolean;
}): Promise<PreflightResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { lane } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let ids: string[];
  try {
    const res = await fetchImpl(`${lane.baseUrl}/v1/models`, {
      headers: authHeaders(lane),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        message: `Cannot reach ${lane.label}: GET /v1/models returned HTTP ${res.status}`,
        usageSupported: null,
        availableModels: [],
      };
    }
    ids = extractModelIds(await res.json());
  } catch (err) {
    const reason = err instanceof DOMException && err.name === "AbortError"
      ? `no answer in ${Math.round(opts.timeoutMs / 1000)}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      message: `Cannot reach ${lane.label}: ${reason}`,
      usageSupported: null,
      availableModels: [],
    };
  } finally {
    clearTimeout(timer);
  }

  if (!ids.includes(lane.model)) {
    const shown = ids.slice(0, 4).join(", ") || "none";
    return {
      ok: false,
      message:
        `${lane.label} will not start: this endpoint does not have the configured model. ` +
        `It lists: ${shown}${ids.length > 4 ? ` (+${ids.length - 4} more)` : ""}.`,
      usageSupported: null,
      availableModels: ids,
    };
  }

  const usageSupported = opts.skipUsageProbe ? null : await probeUsage(lane, fetchImpl, opts.timeoutMs);
  const usageWord = usageSupported === true ? "reports token usage" : usageSupported === false ? "does not report token usage, so speed is counted in chunks" : "usage support unknown";
  return {
    ok: true,
    message: `${lane.label} ready - ${usageWord}.`,
    usageSupported,
    availableModels: ids,
  };
}

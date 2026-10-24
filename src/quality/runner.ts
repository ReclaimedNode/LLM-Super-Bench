/**
 * Asks every machine the same questions and scores the answers.
 *
 * Unlike a race this does not time anything: it asks for the whole answer in one reply, the way a
 * person using the model would, and checks it. Every machine gets the same text, the same reply
 * length, temperature 0 and the same thinking switch as a race would send.
 */

import { scoreResults, byRule, APPROXIMATE_INSTRUCTIONS } from "./ifeval.ts";
import type { PromptResult, Score } from "./ifeval.ts";
import type { Question } from "./suite.ts";
import type { LaneConfig } from "../types.ts";

export interface Answer {
  text: string;
  /** The reply was only the model's thinking, so there was no answer to check. */
  thinkingOnly: boolean;
  /** The model hit the reply limit before it finished. */
  truncated: boolean;
  error: string | null;
}

export interface AskOptions {
  maxTokens: number;
  extraBody?: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function readReply(body: unknown): Answer {
  const choice = (body as { choices?: { message?: Record<string, unknown>; finish_reason?: unknown }[] })?.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const thinking = [message.reasoning_content, message.reasoning].find((t) => typeof t === "string" && t !== "") as string | undefined;
  return {
    text: content,
    thinkingOnly: content.trim() === "" && thinking !== undefined,
    truncated: choice?.finish_reason === "length",
    error: null,
  };
}

export async function ask(lane: LaneConfig, prompt: string, o: AskOptions): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (lane.apiKey) headers.Authorization = `Bearer ${lane.apiKey}`;
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  try {
    const response = await (o.fetchImpl ?? fetch)(`${lane.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: lane.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        max_tokens: o.maxTokens,
        temperature: 0,
        ...o.extraBody,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ").trim();
      return { text: "", thinkingOnly: false, truncated: false, error: `HTTP ${response.status}${detail ? ` - ${detail}` : ""}` };
    }
    return readReply(await response.json());
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    return { text: "", thinkingOnly: false, truncated: false, error: timedOut ? `Timed out after ${Math.round(o.timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err) };
  }
}

export interface QuestionOutcome extends PromptResult {
  truncated: boolean;
  thinkingOnly: boolean;
  error: string | null;
  /** The start of what the model wrote, so a failed answer can be looked at. */
  response: string;
}

export interface MachineQuality {
  laneId: string;
  asked: number;
  /** Answers that came back, errors excluded. */
  answered: number;
  errors: number;
  truncated: number;
  thinkingOnly: number;
  score: Score;
  /** Rules whose check rests on a rough language guess, counted so the page can say so. */
  approximateRules: number;
  byRule: Record<string, { total: number; strict: number }>;
  outcomes: QuestionOutcome[];
}

export interface RunQualityOptions {
  lanes: { laneId: string; lane: LaneConfig; extraBody?: Record<string, unknown> }[];
  questions: Question[];
  maxTokens: number;
  /** Questions in flight at once on each machine. */
  streams: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (laneId: string, done: number, total: number) => void;
}

const KEEP_CHARS = 3000;

export async function runQuality(o: RunQualityOptions): Promise<MachineQuality[]> {
  return Promise.all(
    o.lanes.map(async ({ laneId, lane, extraBody }) => {
      const outcomes: (QuestionOutcome | undefined)[] = new Array(o.questions.length);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < o.questions.length && !o.signal?.aborted) {
          const i = next++;
          const q = o.questions[i]!;
          const answer = await ask(lane, q.prompt, { maxTokens: o.maxTokens, extraBody, timeoutMs: o.timeoutMs, fetchImpl: o.fetchImpl, signal: o.signal });
          const checked = q.check(answer.text);
          outcomes[i] = {
            ...checked,
            truncated: answer.truncated,
            thinkingOnly: answer.thinkingOnly,
            error: answer.error,
            response: answer.text.slice(0, KEEP_CHARS),
          };
          o.onProgress?.(laneId, ++done, o.questions.length);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, o.streams) }, worker));
      const finished = outcomes.filter((x): x is QuestionOutcome => x !== undefined);
      return summarize(laneId, o.questions.length, finished);
    }),
  );
}

export function summarize(laneId: string, asked: number, outcomes: QuestionOutcome[]): MachineQuality {
  // A question that got no answer at all (error) counts as failed, never as skipped.
  return {
    laneId,
    asked,
    answered: outcomes.filter((x) => x.error === null).length,
    errors: outcomes.filter((x) => x.error !== null).length,
    truncated: outcomes.filter((x) => x.truncated).length,
    thinkingOnly: outcomes.filter((x) => x.thinkingOnly).length,
    score: scoreResults(outcomes),
    approximateRules: outcomes.flatMap((x) => x.rules).filter((r) => APPROXIMATE_INSTRUCTIONS.has(r.id)).length,
    byRule: byRule(outcomes),
    outcomes,
  };
}

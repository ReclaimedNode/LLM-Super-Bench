/**
 * Mock lane server: an OpenAI-compatible streaming endpoint with a dial for
 * first-word delay and streaming speed. The whole page can be built, tested and
 * demoed against these with no AI hardware in the room.
 *
 *   bun run mock
 *   bun run mock --ports 9001,9002 --first-word 200,900 --interval 15,55 --usage true,false
 */

import type { Server } from "bun";

export interface MockLaneOptions {
  port: number;
  /** Milliseconds before the first streamed text. */
  firstWordDelayMs: number;
  /** Milliseconds between streamed chunks. */
  chunkIntervalMs: number;
  /** How many text chunks to stream. */
  chunks: number;
  /** Whether to honour stream_options.include_usage. */
  includeUsage: boolean;
  /** Emit a few `delta.reasoning` chunks before the reply, like a thinking model. */
  reasoningChunks?: number;
  /** Send only the reasoning, as a thinking model does when its reply cap runs out before the answer. */
  thinkOnly?: boolean;
  /**
   * Emit this many text-free chunks immediately, before firstWordDelayMs starts.
   * Real servers commonly open with `{"role":"assistant","content":""}`. A tool
   * that calls that the first word reports a first-word time of nearly zero.
   */
  leadingEmptyChunks?: number;
  modelId?: string;
  /** Answer /v1/chat/completions with this HTTP status instead of streaming. */
  failWithStatus?: number;
  /**
   * Extra milliseconds of first-word delay per 1,000 characters of prompt.
   *
   * Real prefill is roughly linear in prompt size, and a mock with a flat delay
   * draws a flat line on the first-word-against-prompt-size chart, which is
   * exactly the shape the chart exists to disprove. Default 0 keeps the race
   * mocks behaving as they always did.
   */
  firstWordPerKCharMs?: number;
  /** Characters of prompt the mock pretends make one token. */
  charsPerToken?: number;
  /** Report this many prompt tokens as served from cache. */
  cachedTokens?: number;
  /** Stop after this many text chunks regardless of max_tokens, as an early EOS would. */
  stopAfterChunks?: number;
  /** Value for the system_fingerprint field on every frame. */
  fingerprint?: string;
  /**
   * Answer GET /props the way llama-server does, with this many slots. Absent
   * means the mock has no /props, like vLLM or mlx_lm.server.
   */
  slots?: number;
  /** The context /props reports for one request. */
  contextTokens?: number;
  /** model_path in /props, as a full path the way llama-server reports it. */
  modelPath?: string;
  /** build_info in /props. */
  build?: string;
  /** Answer like vLLM: no /props or /slots, /v1/models with root and max_model_len, and /version. */
  vllm?: { root: string; maxModelLen: number; version: string };
}

const WORDS = [
  "A", "graphics", "card", "is", "a", "small", "factory", "of", "identical", "workers.",
  "Each", "one", "is", "simple,", "but", "there", "are", "thousands", "of", "them,",
  "and", "they", "all", "do", "the", "same", "sum", "at", "the", "same", "moment.",
  "That", "is", "why", "it", "draws", "a", "game", "and", "runs", "a", "model", "well.",
];

function chunkFrame(model: string, delta: Record<string, string>, fingerprint: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: fingerprint,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startMockLane(options: MockLaneOptions): Server {
  const model = options.modelId ?? "mock-model";
  const reasoningChunks = options.reasoningChunks ?? 0;
  const leadingEmptyChunks = options.leadingEmptyChunks ?? 0;
  const perKChar = options.firstWordPerKCharMs ?? 0;
  const charsPerToken = options.charsPerToken ?? 4;
  const cachedTokens = options.cachedTokens ?? 0;
  const fingerprint = options.fingerprint ?? "mock-0.0.0-mock-0.0.0-mockOS-mockgpu";

  return Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (options.vllm && url.pathname === "/version") {
        return Response.json({ version: options.vllm.version });
      }

      if (url.pathname === "/v1/models") {
        if (options.vllm) {
          return Response.json({
            object: "list",
            data: [{ id: model, object: "model", created: 0, owned_by: "vllm", root: options.vllm.root, max_model_len: options.vllm.maxModelLen }],
          });
        }
        return Response.json({
          object: "list",
          data: [{ id: model, object: "model", created: 0, owned_by: "mock" }],
        });
      }

      if (url.pathname === "/props" && options.slots !== undefined) {
        return Response.json({
          total_slots: options.slots,
          default_generation_settings: { n_ctx: options.contextTokens ?? 32768 },
          model_path: options.modelPath ?? "/mock/models/Mock-27B-Q8_0.gguf",
          build_info: options.build ?? "b0000-mock",
          modalities: { vision: false, audio: false },
        });
      }

      if (url.pathname === "/slots" && options.slots !== undefined) {
        return Response.json(
          Array.from({ length: options.slots }, (_, id) => ({ id, n_ctx: options.contextTokens ?? 32768 })),
        );
      }

      if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      if (options.failWithStatus) {
        return new Response(JSON.stringify({ error: { message: "mock lane failure" } }), {
          status: options.failWithStatus,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = (await req.json().catch(() => ({}))) as {
        model?: string;
        max_tokens?: number;
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
        messages?: { role?: string; content?: string }[];
      };

      // A real endpoint 404s on an unknown model. The mock does too, so the
      // preflight path is exercisable without hardware.
      if (typeof body.model === "string" && body.model !== model) {
        return new Response(JSON.stringify({ error: { message: `model not found: ${body.model}` } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const wantsUsage = options.includeUsage && body.stream_options?.include_usage === true;
      const askedFor = body.max_tokens ?? options.chunks;
      const stopAfter = options.stopAfterChunks ?? Number.POSITIVE_INFINITY;
      const maxChunks = Math.max(1, Math.min(options.chunks, askedFor, stopAfter));

      // Prefill is roughly linear in prompt size on real hardware, so the mock
      // makes it linear too: a flat mock would draw a flat line on the chart
      // that exists to show the slope.
      const promptChars = (body.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0);
      const promptTokens = Math.max(1, Math.round(promptChars / charsPerToken));
      const firstWordDelayMs = options.firstWordDelayMs + (perKChar * promptChars) / 1000;

      // `stream: false` gets one JSON reply, like a real endpoint, so the quality test can run on the mock.
      if (body.stream === false) {
        await sleep(firstWordDelayMs);
        const text = options.thinkOnly ? "" : Array.from({ length: maxChunks }, (_, i) => WORDS[i % WORDS.length]!).join(" ");
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: maxChunks < options.chunks ? "length" : "stop" }],
        });
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (s: string) => controller.enqueue(encoder.encode(s));
          try {
            // Text-free opening chunks go out at once, before any delay.
            for (let i = 0; i < leadingEmptyChunks; i++) {
              send(chunkFrame(model, { role: "assistant", content: "" }, fingerprint));
            }

            await sleep(firstWordDelayMs);

            for (let i = 0; i < reasoningChunks; i++) {
              send(chunkFrame(model, { reasoning: i === 0 ? "Let me think." : " Still thinking." }, fingerprint));
              await sleep(options.chunkIntervalMs);
            }

            let sent = 0;
            while (!options.thinkOnly && sent < maxChunks) {
              const word = WORDS[sent % WORDS.length]!;
              send(chunkFrame(model, { content: sent === 0 ? word : ` ${word}` }, fingerprint));
              sent++;
              if (sent < maxChunks) await sleep(options.chunkIntervalMs);
            }

            if (wantsUsage) {
              // Deliberately not equal to the chunk count: a chunk is not a token.
              const completion = maxChunks + reasoningChunks + 3;
              send(
                `data: ${JSON.stringify({
                  id: "chatcmpl-mock",
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  system_fingerprint: fingerprint,
                  choices: [],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completion,
                    total_tokens: promptTokens + completion,
                    prompt_tokens_details: { cached_tokens: cachedTokens },
                  },
                })}\n\n`,
              );
            }

            send("data: [DONE]\n\n");
          } catch {
            /* client hung up */
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  });
}

// ---------------------------------------------------------------- CLI

function listArg(argv: string[], flag: string): string[] | null {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1]!.split(",").map((s) => s.trim());
}

function pick<T>(list: string[] | null, index: number, parse: (s: string) => T, fallback: T): T {
  if (!list || list.length === 0) return fallback;
  const raw = list[Math.min(index, list.length - 1)];
  return raw === undefined || raw === "" ? fallback : parse(raw);
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const ports = (listArg(argv, "--ports") ?? ["9001", "9002"]).map((p) => Number(p));
  const firstWord = listArg(argv, "--first-word");
  const interval = listArg(argv, "--interval");
  const chunks = listArg(argv, "--chunks");
  const usage = listArg(argv, "--usage");
  const reasoning = listArg(argv, "--reasoning");
  const thinkOnly = listArg(argv, "--think-only");
  const emptyLead = listArg(argv, "--empty-lead");
  const perKChar = listArg(argv, "--per-kchar");
  const cached = listArg(argv, "--cached");
  const stopAfter = listArg(argv, "--stop-after");
  // Lets a mock stand in for a real lane in a benchmark: the grid asks every
  // lane for the same model id, so the mock has to answer to it.
  const modelId = listArg(argv, "--model-id");
  // 0 or absent: no /props at all, the way a server that cannot say how many it runs looks.
  const slots = listArg(argv, "--slots");
  const modelPath = listArg(argv, "--model-path");
  const build = listArg(argv, "--build");
  // "--vllm root,maxModelLen,version" makes that mock answer the way vLLM does.
  const vllm = listArg(argv, "--vllm");

  // Defaults make lane 1 clearly slower than lane 0, so the scoreboard has
  // something to say the first time you press start.
  const defaultFirstWord = [250, 1100];
  const defaultInterval = [18, 55];

  const servers = ports.map((port, i) => {
    const opts: MockLaneOptions = {
      port,
      firstWordDelayMs: pick(firstWord, i, Number, defaultFirstWord[Math.min(i, 1)]!),
      chunkIntervalMs: pick(interval, i, Number, defaultInterval[Math.min(i, 1)]!),
      chunks: pick(chunks, i, Number, 90),
      includeUsage: pick(usage, i, (s) => s === "true", false),
      reasoningChunks: pick(reasoning, i, Number, 0),
      thinkOnly: pick(thinkOnly, i, (s) => s === "true", false),
      leadingEmptyChunks: pick(emptyLead, i, Number, 0),
      firstWordPerKCharMs: pick(perKChar, i, Number, 0),
      cachedTokens: pick(cached, i, Number, 0),
      stopAfterChunks: pick(stopAfter, i, Number, Number.POSITIVE_INFINITY),
      modelId: pick(modelId, i, (s) => s, "mock-model"),
      slots: pick(slots, i, (s) => (Number(s) > 0 ? Number(s) : undefined), undefined),
      modelPath: pick(modelPath, i, (s) => s, undefined),
      build: pick(build, i, (s) => s, undefined),
      vllm: pick(vllm, i, (s) => {
        const [root, len, version] = s.split("|");
        return { root: root ?? "", maxModelLen: Number(len) || 8192, version: version ?? "0.0.0" };
      }, undefined),
    };
    startMockLane(opts);
    return opts;
  });

  console.log("\n  Mock lanes up:\n");
  for (const s of servers) {
    console.log(
      `    http://localhost:${s.port}  model "${s.modelId ?? "mock-model"}"  first word ${s.firstWordDelayMs}ms  ` +
        `${s.chunkIntervalMs}ms/chunk  ${s.chunks} chunks  usage:${s.includeUsage}`,
    );
  }
  console.log("\n  Leave this running and start the race in another terminal: bun run race\n");
}

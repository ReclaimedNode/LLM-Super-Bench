/**
 * The progress page's server.
 *
 * A grid can run for two hours and this page may well be filmed while it does,
 * so it holds one job: say where the grid has got to, in numbers big enough to
 * read across a room. Every asset is local. Nothing here calls out.
 */

import { resolve } from "node:path";
import type { Server } from "bun";
import { PROJECT_ROOT } from "../config.ts";
import type { BenchEvent } from "./runner.ts";

const PUBLIC_DIR = resolve(PROJECT_ROOT, "public/bench");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "progress.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "progress.html", type: "text/html; charset=utf-8" },
  "/progress.js": { file: "progress.js", type: "text/javascript; charset=utf-8" },
  "/progress.css": { file: "progress.css", type: "text/css; charset=utf-8" },
  "/bench.css": { file: "bench.css", type: "text/css; charset=utf-8" },
};

export interface ProgressServer {
  server: Server;
  emit: (event: BenchEvent) => void;
  stop: () => void;
}

/**
 * Keeps every event so far, so a browser opened halfway through a two-hour
 * grid sees the whole state rather than whatever happens next. Run events are
 * capped: the page only draws the recent ones, and a 500-run grid should not
 * hand a late arrival half a megabyte of JSON.
 */
export function startProgressServer(port: number): ProgressServer {
  const clients = new Set<(chunk: string) => void>();
  const history: BenchEvent[] = [];
  const encoder = new TextEncoder();

  const remember = (event: BenchEvent): void => {
    if (event.type === "run" || event.type === "note") {
      history.push(event);
      // Keep the shape of the run: the opening event, the lane states, and a
      // tail of detail.
      const detail = history.filter((e) => e.type === "run" || e.type === "note");
      if (detail.length > 200) {
        const drop = detail.length - 200;
        let dropped = 0;
        for (let i = 0; i < history.length && dropped < drop; i++) {
          if (history[i]!.type === "run" || history[i]!.type === "note") {
            history.splice(i, 1);
            i--;
            dropped++;
          }
        }
      }
      return;
    }
    if (event.type === "lane") {
      // One line per lane: the latest state replaces the last.
      const at = history.findIndex((e) => e.type === "lane" && e.lane.laneLabel === event.lane.laneLabel);
      if (at >= 0) history[at] = event;
      else history.push(event);
      return;
    }
    history.push(event);
  };

  const emit = (event: BenchEvent): void => {
    remember(event);
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const send of clients) send(chunk);
  };

  const server = Bun.serve({
    port,
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);

      const stat = STATIC_FILES[url.pathname];
      if (stat && req.method === "GET") {
        return new Response(Bun.file(resolve(PUBLIC_DIR, stat.file)), {
          headers: { "Content-Type": stat.type, "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let open = true;
            const send = (chunk: string) => {
              if (!open) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                open = false;
                clients.delete(send);
              }
            };
            for (const event of history) send(`data: ${JSON.stringify(event)}\n\n`);
            clients.add(send);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, emit, stop: () => server.stop(true) };
}

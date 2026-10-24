/**
 * "Is there a newer version?" -- told, never done.
 *
 * Asks GitHub's public API how this checkout compares with the repository's main branch, and
 * the page shows a banner if main is ahead. It never pulls, installs or runs anything: a
 * newer version changes what the tool does, and that should be a choice made by a person.
 *
 * What it sends: one anonymous request to api.github.com naming this repository and the commit
 * you are on. Nothing about your machines. Set LLM_SUPER_BENCH_NO_UPDATE_CHECK=1 to turn it off.
 * It works only for a `git clone`; a zip download has no commit to compare, so it stays quiet.
 * Every failure (no internet, no git, rate limit) is silence, never an error on the page.
 */

import { PROJECT_ROOT } from "./config.ts";

export const REPO = "reclaimednode/LLM-Super-Bench";
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

export interface UpdateStatus {
  /** False when the check is switched off. */
  enabled: boolean;
  /** True only when the repository's main branch has changes this checkout does not. */
  available: boolean;
  /** How many changes it is behind. 0 when unknown or up to date. */
  behind: number;
  /** When it was last asked, or null if it has not been. */
  checkedAt: string | null;
}

export interface UpdateDeps {
  /** The commit this checkout is on, or null when it is not a git clone. */
  localCommit: () => Promise<string | null>;
  fetchImpl: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  now: () => number;
  env: Record<string, string | undefined>;
}

export async function gitCommit(cwd: string = PROJECT_ROOT): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Reads GitHub's compare answer. Only a plain "main is ahead of you" counts as an update. */
export function readCompare(body: unknown): { available: boolean; behind: number } {
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const ahead = typeof o.ahead_by === "number" && Number.isInteger(o.ahead_by) && o.ahead_by > 0 ? o.ahead_by : 0;
  // base=you, head=main: "ahead" means main has commits you lack. "diverged" means you also have your own,
  // which still means main has something new.
  const status = o.status;
  return { available: ahead > 0 && (status === "ahead" || status === "diverged"), behind: ahead };
}

export function makeUpdateChecker(deps: Partial<UpdateDeps> = {}) {
  const d: UpdateDeps = {
    localCommit: deps.localCommit ?? (() => gitCommit()),
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
  };
  let last: UpdateStatus | null = null;
  let lastAt = 0;
  let inFlight: Promise<UpdateStatus> | null = null;

  const off = () => (d.env.LLM_SUPER_BENCH_NO_UPDATE_CHECK ?? "").trim() !== "";

  async function ask(): Promise<UpdateStatus> {
    const checkedAt = new Date(d.now()).toISOString();
    const quiet = { enabled: true, available: false, behind: 0, checkedAt };
    const commit = await d.localCommit();
    if (commit === null) return quiet;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await d.fetchImpl(`https://api.github.com/repos/${REPO}/compare/${commit}...main`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "LLM-Super-Bench" },
        signal: controller.signal,
      });
      // 404 is a commit GitHub has never seen (yours, not pushed yet): nothing to say.
      if (!response.ok) return quiet;
      return { ...quiet, ...readCompare(await response.json()) };
    } catch {
      return quiet;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** The last answer, asking again only if it is over a day old. At most one request at a time. */
    async status(): Promise<UpdateStatus> {
      if (off()) return { enabled: false, available: false, behind: 0, checkedAt: null };
      if (last && d.now() - lastAt < DAY_MS) return last;
      inFlight ??= ask().finally(() => {
        inFlight = null;
      });
      last = await inFlight;
      lastAt = d.now();
      return last;
    },
  };
}

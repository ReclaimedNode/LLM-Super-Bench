/**
 * `bun run update` -- brings this copy up to date from GitHub, safely, and says in plain words what
 * happened. It is the same as `git pull`, except that it never leaves you at a prompt about
 * "divergent branches" and never merges, overwrites or discards anything unless you ask.
 *
 *   bun run update            fast-forward only: take what is new, change nothing else
 *   bun run update --merge    also join your own commits with GitHub's, undoing the join if it clashes
 *
 * It does not restart the server. Exit status: 0 when the copy is up to date or was updated, 1 when
 * it could not or would not, 2 for bad arguments.
 */

import { PROJECT_ROOT } from "./config.ts";

export interface GitResult {
  code: number;
  out: string;
  err: string;
}
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const runGit: GitRunner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: out.trim(), err: err.trim() };
  } catch (err) {
    return { code: 127, out: "", err: err instanceof Error ? err.message : String(err) };
  }
};

export type Relation = "up-to-date" | "behind" | "ahead" | "diverged";

/** `ahead` is commits only here, `behind` commits only on GitHub. */
export function relation(ahead: number, behind: number): Relation {
  if (ahead === 0 && behind === 0) return "up-to-date";
  if (ahead === 0) return "behind";
  if (behind === 0) return "ahead";
  return "diverged";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runUpdate(o: { cwd?: string; merge?: boolean; git?: GitRunner; log?: (line: string) => void }): Promise<number> {
  const cwd = o.cwd ?? PROJECT_ROOT;
  const git = o.git ?? runGit;
  const say = o.log ?? ((l: string) => console.log(l));

  if ((await git(["rev-parse", "--is-inside-work-tree"], cwd)).code !== 0) {
    say("This folder is not a git clone (it may be a zip download), so it cannot update itself.");
    say("Download the new version and copy your race.config.json into it.");
    return 1;
  }
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  if (upstream.code !== 0) {
    say("This copy is not linked to a branch on GitHub, so there is nothing to update from.");
    say("Fix: git branch --set-upstream-to=origin/main");
    return 1;
  }
  const fetched = await git(["fetch", "--quiet"], cwd);
  if (fetched.code !== 0) {
    say(`Could not reach GitHub, so nothing was changed. ${fetched.err.split("\n")[0] ?? ""}`.trim());
    return 1;
  }
  const counts = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd);
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  if (counts.code !== 0 || ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) {
    say(`Could not compare this copy with GitHub, so nothing was changed. ${counts.err}`.trim());
    return 1;
  }

  const state = relation(ahead, behind);
  if (state === "up-to-date") {
    say("Already up to date. Nothing to do.");
    return 0;
  }
  if (state === "ahead") {
    say(`Nothing new on GitHub. You have ${plural(ahead, "change")} of your own that GitHub does not (send them with: git push).`);
    return 0;
  }

  const news = await git(["log", "--oneline", "-n", "10", "HEAD..@{u}"], cwd);
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], cwd)).out;
  const describeNews = () => {
    say(`New on GitHub (${plural(behind, "change")}):`);
    for (const line of news.out.split("\n").filter((l) => l !== "")) say(`  ${line}`);
    if (behind > 10) say(`  ... and ${behind - 10} more`);
  };

  if (state === "diverged" && !o.merge) {
    say(`You and GitHub each have changes the other does not: ${plural(ahead, "of yours")}, ${plural(behind, "of theirs")}.`);
    say("That happens when you committed in this folder. Nothing was changed.");
    describeNews();
    say("To keep both, run:  bun run update --merge");
    say("(If the two clash it undoes itself and tells you which files, so nothing is lost.)");
    return 1;
  }

  describeNews();
  if (dirty !== "") say("Note: some files here are edited and not committed. If they clash with the update it will stop and change nothing.");

  const joined = state === "diverged" ? await git(["merge", "--no-edit", "@{u}"], cwd) : await git(["merge", "--ff-only", "@{u}"], cwd);
  if (joined.code !== 0) {
    let clashes = "";
    if (state === "diverged") {
      clashes = (await git(["diff", "--name-only", "--diff-filter=U"], cwd)).out;
      await git(["merge", "--abort"], cwd);
    }
    say("The update could not be applied, and nothing was changed.");
    if (clashes) say(`These files clash with your own changes:\n${clashes.split("\n").map((f) => `  ${f}`).join("\n")}`);
    else if (joined.err || joined.out) say((joined.err || joined.out).split("\n").slice(0, 6).join("\n"));
    say("Save your edits (git stash, or copy the files), run bun run update again, then put your edits back. Or paste this message into an issue.");
    return 1;
  }
  say(state === "diverged" ? "Updated, and joined with your own changes. To send yours to GitHub as well:  git push" : "Updated.");
  say("Restart the server so it runs the new version.");
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.find((a) => a !== "--merge");
  if (unknown) {
    console.error(`Unknown option ${unknown}. The only option is --merge.`);
    process.exit(2);
  }
  process.exit(await runUpdate({ merge: args.includes("--merge") }));
}

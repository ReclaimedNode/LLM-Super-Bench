import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relation, runGit, runUpdate } from "../src/updatecli.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** A GitHub stand-in and two clones of it: `me` (the machine being updated) and `other` (where changes are pushed from). */
async function world() {
  const root = await mkdtemp(join(tmpdir(), "update-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  await sh(root, "init", "--bare", "-b", "main", origin);
  const clone = async (name: string) => {
    const dir = join(root, name);
    await sh(root, "clone", "-q", origin, dir);
    await sh(dir, "config", "user.email", "t@example.com");
    await sh(dir, "config", "user.name", "T");
    await sh(dir, "checkout", "-q", "-B", "main");
    return dir;
  };
  const other = await clone("other");
  await writeFile(join(other, "a.txt"), "one\n");
  await sh(other, "add", "-A");
  await sh(other, "commit", "-qm", "first");
  await sh(other, "push", "-q", "-u", "origin", "main");
  const me = await clone("me");
  const push = async (file: string, text: string, msg: string) => {
    await writeFile(join(other, file), text);
    await sh(other, "add", "-A");
    await sh(other, "commit", "-qm", msg);
    await sh(other, "push", "-q");
  };
  const commit = async (file: string, text: string, msg: string) => {
    await writeFile(join(me, file), text);
    await sh(me, "add", "-A");
    await sh(me, "commit", "-qm", msg);
  };
  return { me, other, origin, push, commit };
}

async function update(cwd: string, merge = false) {
  const lines: string[] = [];
  const code = await runUpdate({ cwd, merge, log: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

describe("how this copy compares with GitHub", () => {
  test("four states", () => {
    expect(relation(0, 0)).toBe("up-to-date");
    expect(relation(0, 3)).toBe("behind");
    expect(relation(2, 0)).toBe("ahead");
    expect(relation(1, 1)).toBe("diverged");
  });
});

describe("bun run update", () => {
  test("up to date says so and changes nothing", async () => {
    const w = await world();
    const r = await update(w.me);
    expect(r.code).toBe(0);
    expect(r.text).toContain("Already up to date");
  });

  test("behind: takes the new work, lists it and reminds you to restart", async () => {
    const w = await world();
    await w.push("b.txt", "two\n", "Add b");
    const r = await update(w.me);
    expect(r.code).toBe(0);
    expect(r.text).toContain("Add b");
    expect(r.text).toContain("Updated.");
    expect(r.text).toContain("Restart the server");
    expect(await readFile(join(w.me, "b.txt"), "utf8")).toBe("two\n");
  });

  test("ahead: nothing to download, and says how to send your own work", async () => {
    const w = await world();
    await w.commit("mine.txt", "x\n", "mine");
    const r = await update(w.me);
    expect(r.code).toBe(0);
    expect(r.text).toContain("git push");
  });

  test("diverged without --merge explains, changes nothing, and names the fix", async () => {
    const w = await world();
    await w.commit("mine.txt", "x\n", "mine");
    await w.push("b.txt", "two\n", "Add b");
    const before = await sh(w.me, "rev-parse", "HEAD");
    const r = await update(w.me);
    expect(r.code).toBe(1);
    expect(r.text).toContain("bun run update --merge");
    expect(r.text).toContain("Nothing was changed");
    expect(await sh(w.me, "rev-parse", "HEAD")).toBe(before);
  });

  test("diverged with --merge keeps both sides", async () => {
    const w = await world();
    await w.commit("mine.txt", "x\n", "mine");
    await w.push("b.txt", "two\n", "Add b");
    const r = await update(w.me, true);
    expect(r.code).toBe(0);
    expect(r.text).toContain("joined with your own changes");
    expect(await readFile(join(w.me, "mine.txt"), "utf8")).toBe("x\n");
    expect(await readFile(join(w.me, "b.txt"), "utf8")).toBe("two\n");
  });

  test("a clash is undone, the files are named, and nothing is lost", async () => {
    const w = await world();
    await w.commit("a.txt", "mine\n", "my edit");
    await w.push("a.txt", "theirs\n", "their edit");
    const before = await sh(w.me, "rev-parse", "HEAD");
    const r = await update(w.me, true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("a.txt");
    expect(r.text).toContain("nothing was changed");
    expect(await sh(w.me, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(w.me, "a.txt"), "utf8")).toBe("mine\n");
    expect(await sh(w.me, "status", "--porcelain")).toBe("");
  });

  test("edited, uncommitted files that clash stop the update and are kept", async () => {
    const w = await world();
    await w.push("a.txt", "theirs\n", "their edit");
    await writeFile(join(w.me, "a.txt"), "my unsaved edit\n");
    const r = await update(w.me);
    expect(r.code).toBe(1);
    expect(r.text).toContain("not committed");
    expect(await readFile(join(w.me, "a.txt"), "utf8")).toBe("my unsaved edit\n");
  });

  test("a folder that is not a git clone, and a clone with no upstream, are explained", async () => {
    const plain = await mkdtemp(join(tmpdir(), "update-plain-"));
    roots.push(plain);
    const r = await update(plain);
    expect(r.code).toBe(1);
    expect(r.text).toContain("not a git clone");
    const w = await world();
    await sh(w.me, "checkout", "-q", "-b", "side");
    const s = await update(w.me);
    expect(s.code).toBe(1);
    expect(s.text).toContain("not linked");
  });

  test("no connection to GitHub changes nothing", async () => {
    const w = await world();
    await sh(w.me, "remote", "set-url", "origin", join(w.me, "does-not-exist.git"));
    const r = await update(w.me);
    expect(r.code).toBe(1);
    expect(r.text).toContain("Could not reach GitHub");
  });
});

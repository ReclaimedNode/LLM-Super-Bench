/**
 * The timing shim, actually executed.
 *
 * remote/mflux_bench.py is the highest-risk thing in this repo: it is the only
 * Python, it runs on a machine nobody is watching, and until this file existed
 * it had never been run at all. It cannot be fully proven without mflux and
 * twelve gigabytes of weights, but almost everything that could be wrong with
 * it is not about mflux -- it is about the shim's own control flow, and that
 * can be run here.
 *
 * So: a stand-in mflux under test/fixtures/fake-mflux, carrying the same module
 * paths, the same parser flags and the same per-model step defaults the real
 * one has, and the shim run against it for real. What this proves is the shim.
 * What it cannot prove is that mflux's real API has the shape the stand-in
 * copies -- that is what the first live cell is for, and it is the one thing
 * left unproven on this path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../../src/config.ts";
import { parseShimOutput } from "../../src/bench/image.ts";

const SHIM = resolve(PROJECT_ROOT, "remote/mflux_bench.py");
const FAKE_MFLUX = resolve(PROJECT_ROOT, "test/fixtures/fake-mflux");

const python = Bun.which("python3");
const describeIfPython = python ? describe : describe.skip;

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shim-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface RunResult {
  code: number | null;
  stdout: string;
  logged: { kind: string; event: string; [key: string]: unknown }[];
}

async function runShim(args: string[], outDir: string): Promise<RunResult> {
  const logPath = join(outDir, "stub.jsonl");
  const proc = Bun.spawn([python!, SHIM, ...args], {
    env: { ...process.env, PYTHONPATH: FAKE_MFLUX, MFLUX_STUB_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let logged: RunResult["logged"] = [];
  try {
    logged = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    logged = [];
  }
  return { code, stdout, logged };
}

function baseArgs(kind: string, outDir: string, extra: string[] = []): string[] {
  return [
    "--kind", kind,
    "--model", `${outDir}/weights`,
    "--prompt", "a cutaway of a workbench",
    "--seed", "42",
    "--count", "2",
    "--warmup", "1",
    "--output", `${outDir}/img_{i}.png`,
    ...extra,
  ];
}

describeIfPython("the shim, run for real against a stand-in mflux", () => {
  test("it loads once, times each image, and prints one JSON line per event", async () => {
    const dir = await scratch();
    const { code, stdout } = await runShim(baseArgs("z-image-turbo", dir), dir);
    expect(code).toBe(0);

    // Parsed by the SAME parser the runner uses, so this covers both halves.
    const parsed = parseShimOutput(stdout);
    expect(parsed.error).toBeNull();
    expect(parsed.loadSeconds).not.toBeNull();
    expect(parsed.images).toHaveLength(3); // 1 warm-up + 2 measured
    expect(parsed.images.filter((i) => i.warmup)).toHaveLength(1);
    expect(parsed.images.filter((i) => !i.warmup)).toHaveLength(2);
    expect(parsed.peakMemoryGb).not.toBeNull();
  });

  test("the model is loaded ONCE, however many images are asked for", async () => {
    const dir = await scratch();
    const { logged } = await runShim(baseArgs("z-image-turbo", dir, ["--count", "3"]), dir);
    expect(logged.filter((l) => l.event === "construct")).toHaveLength(1);
    expect(logged.filter((l) => l.event === "generate")).toHaveLength(4); // 1 warm-up + 3
  });

  test("the load time is the load, not a generation", async () => {
    // The stand-in sleeps longer to load than to generate, so if the shim were
    // folding one into the other this ordering would not hold.
    const dir = await scratch();
    const parsed = parseShimOutput((await runShim(baseArgs("z-image-turbo", dir), dir)).stdout);
    for (const image of parsed.images) {
      expect(image.seconds).toBeLessThan(parsed.loadSeconds!);
    }
  });

  test("it takes mflux's OWN per-model step default rather than passing nothing", async () => {
    // The whole reason the shim borrows mflux's parser. mflux's own tests pin
    // 9 for z-image-turbo and 4 for flux2-klein-4b.
    const z = await scratch();
    const zLog = (await runShim(baseArgs("z-image-turbo", z), z)).logged;
    expect(zLog.find((l) => l.event === "generate")!.num_inference_steps).toBe(9);

    const f = await scratch();
    const fLog = (await runShim(baseArgs("flux2-klein", f), f)).logged;
    expect(fLog.find((l) => l.event === "generate")!.num_inference_steps).toBe(4);
  });

  test("a step count given on the command line wins", async () => {
    const dir = await scratch();
    const { logged } = await runShim(baseArgs("z-image-turbo", dir, ["--steps", "3"]), dir);
    expect(logged.find((l) => l.event === "generate")!.num_inference_steps).toBe(3);
  });

  test("each model family is called the way its own CLI calls it", async () => {
    // flux2 has no negative branch and forces guidance to 1.0; z-image passes
    // a scheduler and a negative prompt. Getting these the wrong way round
    // would either error or silently change the picture.
    const f = await scratch();
    const flux = (await runShim(baseArgs("flux2-klein", f), f)).logged.find((l) => l.event === "generate")!;
    expect(flux.guidance).toBe(1);
    expect("negative_prompt" in flux).toBe(false);
    expect(flux.scheduler).toBe("flow_match_euler_discrete");

    const z = await scratch();
    const zimage = (await runShim(baseArgs("z-image-turbo", z), z)).logged.find((l) => l.event === "generate")!;
    expect("negative_prompt" in zimage).toBe(true);
    expect("scheduler" in zimage).toBe(true);
  });

  test("a local weights directory is passed as a model_path, which is the live path", async () => {
    const dir = await scratch();
    const { logged } = await runShim(baseArgs("z-image-turbo", dir), dir);
    const construct = logged.find((l) => l.event === "construct")!;
    expect(construct.model_path).toBe(`${dir}/weights`);
    expect(construct.model_name).toBe("z-image-turbo");
  });

  test("the size and seed asked for are the size and seed used", async () => {
    const dir = await scratch();
    const { logged } = await runShim(baseArgs("z-image-turbo", dir, ["--seed", "7", "--width", "512", "--height", "768"]), dir);
    const generate = logged.find((l) => l.event === "generate")!;
    expect(generate.seed).toBe(7);
    expect(generate.width).toBe(512);
    expect(generate.height).toBe(768);
  });

  test("one seed gives one picture: the checksums match", async () => {
    // This is what the board's side-by-side proof rests on.
    const dir = await scratch();
    const parsed = parseShimOutput((await runShim(baseArgs("z-image-turbo", dir), dir)).stdout);
    const sums = new Set(parsed.images.map((i) => i.sha256));
    expect(sums.size).toBe(1);
    expect([...sums][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a different seed gives a different picture, so the checksum means something", async () => {
    const a = await scratch();
    const b = await scratch();
    const first = parseShimOutput((await runShim(baseArgs("z-image-turbo", a, ["--seed", "1"]), a)).stdout);
    const second = parseShimOutput((await runShim(baseArgs("z-image-turbo", b, ["--seed", "2"]), b)).stdout);
    expect(first.images[0]!.sha256).not.toBe(second.images[0]!.sha256);
  });

  test("every image it reports is actually on disk", async () => {
    const dir = await scratch();
    const parsed = parseShimOutput((await runShim(baseArgs("z-image-turbo", dir), dir)).stdout);
    for (const image of parsed.images) {
      expect(await Bun.file(image.path).exists()).toBe(true);
    }
  });

  test("a failure is one JSON error line and a non-zero exit, not a traceback", async () => {
    const dir = await scratch();
    // No such kind of model: argparse rejects it before anything is loaded.
    const bad = await runShim(["--kind", "not-a-model", "--model", "x", "--prompt", "p", "--seed", "1", "--count", "1", "--output", `${dir}/o_{i}.png`], dir);
    expect(bad.code).not.toBe(0);

    // And a failure inside the run is reported in the shape the runner reads.
    const broken = await runShim(baseArgs("z-image-turbo", dir, ["--output", "/nope/cannot/write_{i}.png"]), dir);
    expect(broken.code).not.toBe(0);
    const parsed = parseShimOutput(broken.stdout);
    expect(parsed.error).not.toBeNull();
    expect(parsed.error).not.toContain("Traceback");
  });
});

/**
 * Preparing a machine to be a lane.
 *
 * A second Mac has to end up byte-for-byte comparable with the first, quickly,
 * and the numbers only mean anything if both run the SAME versions of the same
 * tools against the same weights at the same paths. So this does four things
 * over ssh and nothing else:
 *
 *   1. `uv`, installed for the user with its own installer if it is missing.
 *      Never sudo, never brew, never the system Python.
 *   2. An isolated environment per kind of model under ~/bench-envs, with
 *      PINNED versions. A pin is the whole point: "latest on both machines" is
 *      not a control, it is a coincidence.
 *   3. Every model at ~/bench-models/<dir>, the same path on every machine --
 *      symlinked when that machine already has a copy somewhere, downloaded
 *      when it does not.
 *   4. A verification pass that reports what is actually installed, rather
 *      than what these steps believe they did.
 *
 * Every step checks before it acts, so running it twice changes nothing.
 */

import { BENCH_ENVS_ROOT, BENCH_MODELS_ROOT, modelsForLane, uniformModelPath } from "./config.ts";
import { remoteArg, runRemote } from "./ssh.ts";
import { checkSleep, holdAwake } from "./awake.ts";
import { reachLane } from "./reach.ts";
import type { Pinger } from "./reach.ts";
import type { AwakeHold } from "./awake.ts";
import { PINS } from "./pins.ts";
import type { Pin } from "./pins.ts";
import type { RemoteRunner } from "./ssh.ts";
import type { BenchConfig, BenchLane, BenchModel, ModelKind, SshTarget } from "./types.ts";

// ------------------------------------------------------------------ pins

export type Environment = Pin & { kind: ModelKind };

/**
 * The environments, built from the pins.
 *
 * Every version lives in pins.ts. Nothing here decides what to install; this
 * file only knows how to put it on a machine.
 */
export const ENVIRONMENTS: Record<ModelKind, Environment> = {
  llm: { kind: "llm", ...PINS.llm },
  image: { kind: "image", ...PINS.image },
  video: { kind: "video", ...PINS.video },
};

export function envPath(kind: ModelKind): string {
  return `${BENCH_ENVS_ROOT}/${ENVIRONMENTS[kind].dir}`;
}

/** The bin directory a lane's `ssh.binDir` should point at for that kind. */
export function envBinDir(kind: ModelKind): string {
  return `${envPath(kind)}/bin`;
}

/** Free space to insist on beyond the model itself, so a disk never fills. */
export const DISK_HEADROOM_GB = 20;
/** What to demand when a model does not say how big it is. */
export const UNKNOWN_MODEL_GB = 50;

// ------------------------------------------------------------------ plan

export type ModelSource =
  | { kind: "symlink"; from: string }
  | { kind: "download"; repo: string }
  | { kind: "unavailable"; why: string };

export interface ModelStep {
  model: BenchModel;
  dir: string;
  target: string;
  source: ModelSource;
  /** What to check free disk against before downloading. */
  needGb: number;
}

export interface LaneSetupPlan {
  lane: BenchLane;
  target: SshTarget;
  environments: Environment[];
  models: ModelStep[];
}

export class SetupError extends Error {}

/**
 * What this lane needs, worked out before anything is touched.
 *
 * Pure: it reads the config and returns the intent. Nothing here reaches a
 * machine, which is what makes it testable and what makes `--plan` honest.
 */
export function planLaneSetup(config: BenchConfig, laneLabel: string): LaneSetupPlan {
  const lane = config.lanes.find((l) => l.label === laneLabel);
  if (!lane) {
    const known = config.lanes.map((l) => l.label).join(", ");
    throw new SetupError(`No lane called "${laneLabel}". The config has: ${known || "none"}.`);
  }
  if (!lane.ssh) {
    throw new SetupError(
      `Lane "${laneLabel}" has no ssh block, so it is a manual lane and there is nothing to set up on it. ` +
        `Add ssh { host, binDir, port } to have the runner manage it.`,
    );
  }

  const models = modelsForLane(config, lane);
  const steps: ModelStep[] = models.map((model) => {
    const dir = model.dir ?? null;
    if (dir === null) {
      return {
        model,
        dir: model.id,
        target: model.id,
        source: { kind: "unavailable", why: "this model has no `dir`, so setup has nowhere uniform to put it" },
        needGb: 0,
      };
    }

    const local = lane.localPaths?.[dir];
    const needGb = (model.approxGb ?? UNKNOWN_MODEL_GB) + DISK_HEADROOM_GB;

    if (local) return { model, dir, target: uniformModelPath(dir), source: { kind: "symlink", from: local }, needGb: 0 };
    if (model.hfRepo) {
      return { model, dir, target: uniformModelPath(dir), source: { kind: "download", repo: model.hfRepo }, needGb };
    }
    return {
      model,
      dir,
      target: uniformModelPath(dir),
      source: {
        kind: "unavailable",
        why: `no copy on this lane and no \`hfRepo\` to download it from`,
      },
      needGb: 0,
    };
  });

  // Only the environments this lane's models actually need.
  const kinds = [...new Set(models.map((m) => m.kind))];
  const environments = kinds.map((kind) => ENVIRONMENTS[kind]);

  return { lane, target: lane.ssh, environments, models: steps };
}

// ------------------------------------------------------------------ commands

/**
 * `uv` lives in the user's own bin. The login shell may not have it on PATH
 * yet on a machine where it was just installed, so every command that uses it
 * adds the two places its installer puts it.
 */
export const UV_PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH";';

export function uvVersionCommand(): string {
  return `${UV_PATH_PREFIX} command -v uv >/dev/null 2>&1 && uv --version || echo UV_MISSING`;
}

/**
 * The official installer, and nothing else: no sudo, no brew, no system
 * Python. This is the one command here that reaches the internet.
 */
export function installUvCommand(): string {
  return `curl -LsSf https://astral.sh/uv/install.sh | sh`;
}

export function envExistsCommand(kind: ModelKind): string {
  const python = remoteArg(`${envPath(kind)}/bin/python`, "environment python");
  return `test -x ${python} && echo ENV_PRESENT || echo ENV_MISSING`;
}

/**
 * Builds the environment. `fresh` clears an existing one first.
 *
 * A benchmark environment whose versions have drifted is rebuilt rather than
 * upgraded in place: the thing being measured should be an environment built
 * from the pins, not one that arrived at them by a series of upgrades.
 */
export function createEnvCommand(kind: ModelKind, fresh = false): string {
  const env = ENVIRONMENTS[kind];
  const path = remoteArg(envPath(kind), "environment path");
  return `${UV_PATH_PREFIX} uv venv ${path} --python '${env.python}'${fresh ? " --clear" : ""}`;
}

/** What is installed in an environment right now, one `name==version` per line. */
export function listPackagesCommand(kind: ModelKind): string {
  const python = remoteArg(`${envPath(kind)}/bin/python`, "environment python");
  return `${UV_PATH_PREFIX} uv pip list --python ${python} --format freeze 2>/dev/null || echo LIST_FAILED`;
}

export function installPackagesCommand(kind: ModelKind): string {
  const env = ENVIRONMENTS[kind];
  if (env.packages.length === 0) return "";
  const python = remoteArg(`${envPath(kind)}/bin/python`, "environment python");
  const pins = env.packages.map((p) => `'${p}'`).join(" ");
  return `${UV_PATH_PREFIX} uv pip install --python ${python} ${pins}`;
}

/** Is a package pinned in this environment already at the pinned version? */
export function packagesSatisfied(freezeOutput: string, packages: string[]): boolean {
  const have = new Map<string, string>();
  for (const line of freezeOutput.split("\n")) {
    const match = /^([A-Za-z0-9_.-]+)\s*==\s*([^\s]+)$/.exec(line.trim());
    if (match) have.set(match[1]!.toLowerCase().replace(/_/g, "-"), match[2]!);
  }
  return packages.every((pin) => {
    const [name, version] = pin.split("==");
    return have.get(name!.toLowerCase().replace(/_/g, "-")) === version;
  });
}

export function modelPresentCommand(target: string): string {
  const dir = remoteArg(target, "model directory");
  // -L so a symlink to a real copy counts as present.
  return (
    `if [ -L ${dir} ] || [ -d ${dir} ]; then ` +
    `n=$(find -L ${dir} -name '*.safetensors' 2>/dev/null | wc -l | tr -d ' '); ` +
    `echo "MODEL_PRESENT $n"; else echo MODEL_MISSING; fi`
  );
}

export function symlinkModelCommand(from: string, to: string): string {
  const source = remoteArg(from, "existing model path");
  const dest = remoteArg(to, "model directory");
  const root = remoteArg(BENCH_MODELS_ROOT, "models root");
  return (
    `mkdir -p ${root} && ` +
    `if [ ! -e ${source} ]; then echo SOURCE_MISSING; exit 3; fi && ` +
    // Replace only a link, never a real directory somebody may have filled.
    `if [ -L ${dest} ]; then rm ${dest}; fi && ` +
    `if [ -d ${dest} ]; then echo ALREADY_A_REAL_DIRECTORY; exit 4; fi && ` +
    `ln -s ${source} ${dest} && echo LINKED`
  );
}

/**
 * Downloads by repo id into the uniform path.
 *
 * `hf download` resumes: it is deliberately pointed at the same directory
 * rather than a fresh one, so a run that stopped halfway through twenty
 * gigabytes carries on from there instead of starting again.
 */
export function downloadModelCommand(repo: string, to: string): string {
  const repoArg = remoteArg(repo, "hugging face repo");
  const dest = remoteArg(to, "model directory");
  const root = remoteArg(BENCH_MODELS_ROOT, "models root");
  return (
    `${UV_PATH_PREFIX} mkdir -p ${root} && ` +
    `uv tool run --from huggingface_hub hf download ${repoArg} --local-dir ${dest}`
  );
}

/** Free space where the models go, in gigabytes. */
export function diskFreeCommand(): string {
  const root = remoteArg(BENCH_MODELS_ROOT, "models root");
  return `mkdir -p ${root} && df -k ${root} | awk 'NR==2 {print "FREE_KB " $4}'`;
}

export function parseFreeGb(stdout: string): number | null {
  const match = /FREE_KB\s+(\d+)/.exec(stdout);
  if (!match) return null;
  return Number(match[1]) / 1024 / 1024;
}

/**
 * The verification pass: what is ACTUALLY on the machine now.
 *
 * Deliberately not a summary of the steps above. A step that reported success
 * and a machine that is correctly set up are different claims, and only the
 * second one matters.
 */
export function verifyCommand(plan: LaneSetupPlan): string {
  const parts: string[] = [`${UV_PATH_PREFIX} echo "UV $(uv --version 2>/dev/null || echo none)"`];

  for (const env of plan.environments) {
    const python = remoteArg(`${envPath(env.kind)}/bin/python`, "environment python");
    parts.push(
      `if [ -x ${python} ]; then ` +
        `echo "PYTHON ${env.kind} $(${python} --version 2>&1)"; ` +
        `uv pip list --python ${python} --format freeze 2>/dev/null | sed 's/^/PKG ${env.kind} /'; ` +
        `else echo "PYTHON ${env.kind} missing"; fi`,
    );
  }

  for (const step of plan.models) {
    const dir = remoteArg(step.target, "model directory");
    parts.push(
      `if [ -e ${dir} ]; then ` +
        `echo "MODEL ${step.dir} $(find -L ${dir} -name '*.safetensors' 2>/dev/null | wc -l | tr -d ' ') ` +
        `$(du -skL ${dir} 2>/dev/null | cut -f1) $(if [ -L ${dir} ]; then echo link; else echo real; fi)"; ` +
        `else echo "MODEL ${step.dir} 0 0 missing"; fi`,
    );
  }

  parts.push(diskFreeCommand());
  return parts.join("; ");
}

export interface VerifiedModel {
  dir: string;
  safetensors: number;
  kilobytes: number;
  how: "link" | "real" | "missing";
}

export interface Verification {
  uv: string | null;
  pythons: Record<string, string>;
  packages: Record<string, string[]>;
  models: VerifiedModel[];
  freeGb: number | null;
}

export function parseVerification(stdout: string): Verification {
  const out: Verification = { uv: null, pythons: {}, packages: {}, models: [], freeGb: parseFreeGb(stdout) };

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("UV ")) {
      const value = line.slice(3).trim();
      out.uv = value === "none" ? null : value;
    } else if (line.startsWith("PYTHON ")) {
      const [, kind, ...rest] = line.split(/\s+/);
      if (kind) out.pythons[kind] = rest.join(" ");
    } else if (line.startsWith("PKG ")) {
      const [, kind, spec] = line.split(/\s+/);
      if (kind && spec) (out.packages[kind] ??= []).push(spec);
    } else if (line.startsWith("MODEL ")) {
      const [, dir, count, kb, how] = line.split(/\s+/);
      if (dir) {
        out.models.push({
          dir,
          safetensors: Number(count) || 0,
          kilobytes: Number(kb) || 0,
          how: how === "link" || how === "real" ? how : "missing",
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ run

export type StepStatus = "found" | "did" | "skipped" | "failed";

export interface SetupStep {
  what: string;
  status: StepStatus;
  detail: string;
}

export interface SetupReport {
  laneLabel: string;
  steps: SetupStep[];
  verification: Verification | null;
  ok: boolean;
}

export interface RunSetupOptions {
  plan: LaneSetupPlan;
  run?: RemoteRunner;
  /** Called as each step settles, so a long run says something while it works. */
  onStep?: (step: SetupStep) => void;
  /** Work out what is needed but change nothing. */
  dryRun?: boolean;
  downloadTimeoutMs?: number;
  /**
   * Called once the machine has answered and before any real work. This is
   * where the keep-awake hold starts: a lane that never answered should fail
   * saying so, not trail a caffeinate that could not have worked either.
   */
  onReachable?: () => Promise<void>;
  /** Test seams for the wake-it-up retry. */
  ping?: Pinger;
  sleep?: (ms: number) => Promise<void>;
}

const MINUTES = 60_000;

async function runLaneSetupInner(opts: RunSetupOptions): Promise<SetupReport> {
  const { plan } = opts;
  const run = opts.run ?? runRemote;
  const steps: SetupStep[] = [];

  const record = (what: string, status: StepStatus, detail: string): SetupStep => {
    const step = { what, status, detail };
    steps.push(step);
    opts.onStep?.(step);
    return step;
  };

  const report = (): SetupReport => ({
    laneLabel: plan.lane.label,
    steps,
    verification: null,
    ok: steps.every((s) => s.status !== "failed"),
  });

  // --- Reachable at all? Everything below is pointless otherwise, and the
  //     message for "the machine is not there" should say that, not fail on
  //     step four with a confusing shell error.
  const hello = await reachLane(plan.target, {
    run,
    ping: opts.ping,
    sleep: opts.sleep,
    log: (message) => record("reach the machine", "did", message),
  });
  if (!hello.ok) {
    record("reach the machine", "failed", hello.detail);
    return report();
  }
  record("reach the machine", "found", hello.wokeIt ? `ssh works, after waking the machine` : "ssh works");
  await opts.onReachable?.();

  // --- uv
  const uv = await run(plan.target, uvVersionCommand(), { timeoutMs: 60_000 });
  if (uv.stdout.includes("UV_MISSING")) {
    if (opts.dryRun) {
      record("uv", "skipped", "missing; would install it with the official installer");
    } else {
      const installed = await run(plan.target, installUvCommand(), { timeoutMs: 10 * MINUTES });
      const after = await run(plan.target, uvVersionCommand(), { timeoutMs: 60_000 });
      if (after.stdout.includes("UV_MISSING")) {
        record(
          "uv",
          "failed",
          `could not install uv: ${(installed.stderr || installed.stdout).trim().slice(0, 300) || "no output"}`,
        );
        return report();
      }
      record("uv", "did", `installed ${after.stdout.trim()}`);
    }
  } else {
    record("uv", "found", uv.stdout.trim());
  }

  // --- environments
  for (const env of plan.environments) {
    const label = `${env.kind} environment`;
    const exists = await run(plan.target, envExistsCommand(env.kind), { timeoutMs: 60_000 });
    const present = !exists.stdout.includes("ENV_MISSING");

    // What is installed decides what happens next, so it is read BEFORE the
    // environment is declared fine. An environment that exists but no longer
    // matches the pins is not "already there" -- it is the wrong environment.
    const listed = present && env.packages.length > 0
      ? await run(plan.target, listPackagesCommand(env.kind), { timeoutMs: 2 * MINUTES })
      : null;
    const matches = listed !== null && packagesSatisfied(listed.stdout, env.packages);
    const drifted = present && env.packages.length > 0 && !matches;

    if (present && !drifted) {
      record(label, "found", envPath(env.kind));
    } else if (opts.dryRun) {
      record(
        label,
        "skipped",
        drifted
          ? `would rebuild ${envPath(env.kind)}: it does not match ${env.packages.join(", ")}`
          : `would create ${envPath(env.kind)} on Python ${env.python}`,
      );
    } else {
      // Rebuilt from scratch rather than upgraded in place: what gets measured
      // should be an environment built from the pins, not one that arrived at
      // them through a series of upgrades.
      const made = await run(plan.target, createEnvCommand(env.kind, drifted), { timeoutMs: 15 * MINUTES });
      if (!made.ok) {
        record(label, "failed", `uv venv failed: ${(made.stderr || made.stdout).trim().slice(0, 300)}`);
        continue;
      }
      record(
        label,
        "did",
        drifted
          ? `rebuilt ${envPath(env.kind)} on Python ${env.python}, because its versions no longer matched the pins`
          : `created ${envPath(env.kind)} on Python ${env.python}`,
      );
    }

    if (env.packages.length === 0) {
      record(`${env.kind} packages`, "skipped", "nothing pinned for this kind yet");
      continue;
    }
    if (present && matches) {
      record(`${env.kind} packages`, "found", env.packages.join(", "));
      continue;
    }
    if (opts.dryRun) {
      record(`${env.kind} packages`, "skipped", `would install ${env.packages.join(", ")}`);
      continue;
    }

    const install = await run(plan.target, installPackagesCommand(env.kind), { timeoutMs: 30 * MINUTES });
    if (!install.ok) {
      record(
        `${env.kind} packages`,
        "failed",
        `installing ${env.packages.join(", ")} failed: ${(install.stderr || install.stdout).trim().slice(0, 300)}`,
      );
      continue;
    }
    record(`${env.kind} packages`, "did", `installed ${env.packages.join(", ")}`);
  }

  // --- models
  for (const step of plan.models) {
    const label = `model ${step.dir}`;

    if (step.source.kind === "unavailable") {
      record(label, "failed", step.source.why);
      continue;
    }

    const present = await run(plan.target, modelPresentCommand(step.target), { timeoutMs: 2 * MINUTES });
    const match = /MODEL_PRESENT\s+(\d+)/.exec(present.stdout);
    if (match && Number(match[1]) > 0) {
      record(label, "found", `already at ${step.target} with ${match[1]} safetensors files`);
      continue;
    }

    if (step.source.kind === "symlink") {
      if (opts.dryRun) {
        record(label, "skipped", `would link ${step.target} -> ${step.source.from}`);
        continue;
      }
      const linked = await run(plan.target, symlinkModelCommand(step.source.from, step.target), { timeoutMs: MINUTES });
      if (linked.stdout.includes("SOURCE_MISSING")) {
        record(label, "failed", `this lane's localPaths points at ${step.source.from}, which is not there`);
      } else if (linked.stdout.includes("ALREADY_A_REAL_DIRECTORY")) {
        record(label, "failed", `${step.target} is a real directory, not a link; setup will not delete it. Move it aside.`);
      } else if (!linked.ok) {
        record(label, "failed", `linking failed: ${(linked.stderr || linked.stdout).trim().slice(0, 200)}`);
      } else {
        record(label, "did", `linked ${step.target} -> ${step.source.from}`);
      }
      continue;
    }

    // --- download. Check the disk BEFORE starting: filling a machine's boot
    //     volume halfway through a download is a much worse afternoon than
    //     being told there is no room.
    const disk = await run(plan.target, diskFreeCommand(), { timeoutMs: MINUTES });
    const freeGb = parseFreeGb(disk.stdout);
    if (freeGb !== null && freeGb < step.needGb) {
      record(
        label,
        "failed",
        `needs about ${step.needGb.toFixed(0)} GB free (${(step.model.approxGb ?? UNKNOWN_MODEL_GB).toFixed(0)} GB ` +
          `for the model plus ${DISK_HEADROOM_GB} GB headroom) and this machine has ${freeGb.toFixed(1)} GB. Nothing downloaded.`,
      );
      continue;
    }

    if (opts.dryRun) {
      record(label, "skipped", `would download ${step.source.repo} into ${step.target}`);
      continue;
    }

    const pulled = await run(plan.target, downloadModelCommand(step.source.repo, step.target), {
      timeoutMs: opts.downloadTimeoutMs ?? 120 * MINUTES,
    });
    if (!pulled.ok) {
      record(
        label,
        "failed",
        `downloading ${step.source.repo} stopped: ${(pulled.stderr || pulled.stdout).trim().slice(0, 300)}. ` +
          `Run setup-lane again and it will carry on from where it stopped rather than start again.`,
      );
      continue;
    }
    record(label, "did", `downloaded ${step.source.repo} into ${step.target}`);
  }

  // --- verify what is really there
  const verified = await run(plan.target, verifyCommand(plan), { timeoutMs: 5 * MINUTES });
  const verification = verified.ok ? parseVerification(verified.stdout) : null;
  if (verification === null) {
    record("verify", "failed", `could not read the machine back: ${(verified.stderr || verified.stdout).trim().slice(0, 200)}`);
  }

  return {
    laneLabel: plan.lane.label,
    steps,
    verification,
    ok: steps.every((s) => s.status !== "failed"),
  };
}

/**
 * Setting a machine up outlasts a minute -- a download can take an hour -- so
 * the machine is held awake for the whole of it. A freshly set up Mac may be
 * set to sleep after one minute, and neither ssh nor a running download counts
 * as activity. The hold starts once the machine has answered and is let go on
 * the way out, whether that is a success, a failure or an interrupt.
 */
export async function runLaneSetup(opts: RunSetupOptions): Promise<SetupReport> {
  const run = opts.run ?? runRemote;
  const held: { hold: AwakeHold | null } = { hold: null };

  const release = () => {
    void held.hold?.release();
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);

  try {
    return await runLaneSetupInner({
      ...opts,
      onReachable: async () => {
        const { warning } = await checkSleep(opts.plan.target, run);
        if (warning) opts.onStep?.({ what: "system sleep", status: "found", detail: warning });
        const hold = await holdAwake({
          target: opts.plan.target,
          seconds: 3 * 60 * 60,
          run,
          dryRun: opts.dryRun,
        });
        held.hold = hold;
        if (hold.note) opts.onStep?.({ what: "keep awake", status: hold.pid ? "did" : "found", detail: hold.note });
      },
    });
  } finally {
    process.off("SIGINT", release);
    process.off("SIGTERM", release);
    await held.hold?.release();
  }
}

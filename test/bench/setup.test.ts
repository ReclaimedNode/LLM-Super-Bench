/**
 * Preparing a machine to be a lane.
 *
 * Every one of these runs against a FAKE ssh layer. Provisioning code is
 * exactly the kind that has to be proven before it is pointed at real
 * hardware, and exactly the kind that cannot be proven by pointing it at real
 * hardware: the interesting cases are a full disk, a half-finished download
 * and a second run that must change nothing, none of which you can conjure on
 * a borrowed Mac on the afternoon of a shoot.
 */

import { describe, expect, test } from "bun:test";
import { validateBenchConfig } from "../../src/bench/config.ts";
import {
  DISK_HEADROOM_GB,
  ENVIRONMENTS,
  createEnvCommand,
  diskFreeCommand,
  downloadModelCommand,
  envBinDir,
  envPath,
  installPackagesCommand,
  installUvCommand,
  packagesSatisfied,
  parseFreeGb,
  parseVerification,
  planLaneSetup,
  runLaneSetup,
  symlinkModelCommand,
  uvVersionCommand,
  verifyCommand,
} from "../../src/bench/setup.ts";
import { PINS } from "../../src/bench/pins.ts";
import type { LaneSetupPlan } from "../../src/bench/setup.ts";
import { renderPlan, renderReport, verificationMatchesPlan } from "../../src/bench/setupreport.ts";
import type { RemoteResult } from "../../src/bench/ssh.ts";

// ------------------------------------------------------------------ fixtures

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [
      { name: "Small", dir: "Small-4bit", hfRepo: "vendor/Small-4bit", approxGb: 8 },
      { name: "Big", dir: "Big-4bit", hfRepo: "vendor/Big-4bit", approxGb: 60 },
    ],
    lanes: [
      {
        label: "Studio",
        baseUrl: "http://box.local:8090",
        ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
    ...over,
  });
}

/**
 * A machine in a box.
 *
 * It answers the same shapes the real commands look for, and records every
 * command it was asked to run, so a test can assert both what happened and --
 * just as important for idempotence -- what did not.
 */
class FakeMachine {
  commands: string[] = [];
  uvInstalled = false;
  envs = new Set<string>();
  packages = new Map<string, string[]>();
  models = new Map<string, { safetensors: number; kb: number; how: "link" | "real" }>();
  existingPaths = new Set<string>();
  freeKb = 900 * 1024 * 1024; // 900 GB
  failDownload: string | null = null;
  unreachable = false;

  run = async (_target: unknown, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    const bad = (stderr: string, code = 1): RemoteResult => ({ ok: false, code, stdout: "", stderr });

    if (this.unreachable) return bad("ssh: connect to host port 22: Operation timed out", 255);
    if (command === "echo READY") return ok("READY\n");

    // The verification pass runs several of the same tools as the individual
    // steps, so it has to be recognised before any of them.
    if (command.includes('echo "UV ')) return ok(this.verification());

    if (command.includes("UV_MISSING")) return ok(this.uvInstalled ? "uv 0.9.9\n" : "UV_MISSING\n");
    if (command.includes("astral.sh/uv/install.sh")) {
      this.uvInstalled = true;
      return ok("installed\n");
    }

    if (command.includes("ENV_MISSING")) {
      const kind = this.kindFrom(command);
      return ok(this.envs.has(kind) ? "ENV_PRESENT\n" : "ENV_MISSING\n");
    }
    if (command.includes("uv venv")) {
      this.envs.add(this.kindFrom(command));
      return ok("created\n");
    }
    if (command.includes("uv pip list")) {
      return ok((this.packages.get(this.kindFrom(command)) ?? []).join("\n") + "\n");
    }
    if (command.includes("uv pip install")) {
      const kind = this.kindFrom(command);
      this.packages.set(kind, [...ENVIRONMENTS[kind as "llm"].packages]);
      return ok("installed\n");
    }

    if (command.includes("MODEL_MISSING")) {
      const dir = this.dirFrom(command);
      const model = this.models.get(dir);
      return ok(model ? `MODEL_PRESENT ${model.safetensors}\n` : "MODEL_MISSING\n");
    }
    if (command.includes("ln -s")) {
      const from = this.sourceFrom(command);
      const dir = this.dirFrom(command);
      if (!this.existingPaths.has(from)) return { ok: false, code: 3, stdout: "SOURCE_MISSING\n", stderr: "" };
      this.models.set(dir, { safetensors: 3, kb: 8 * 1024 * 1024, how: "link" });
      return ok("LINKED\n");
    }
    if (command.includes("hf download")) {
      if (this.failDownload) return bad(this.failDownload);
      const dir = this.dirFrom(command);
      this.models.set(dir, { safetensors: 5, kb: 12 * 1024 * 1024, how: "real" });
      return ok("downloaded\n");
    }
    if (command.includes("FREE_KB")) return ok(`FREE_KB ${this.freeKb}\n`);

    return ok("");
  };

  private kindFrom(command: string): string {
    return /bench-envs\/(\w+)/.exec(command)?.[1] ?? "llm";
  }
  private dirFrom(command: string): string {
    return /bench-models\/([A-Za-z0-9_.-]+)/.exec(command)?.[1] ?? "?";
  }
  private sourceFrom(command: string): string {
    return /ln -s (?:"\$HOME")?'([^']+)'/.exec(command)?.[1]?.replace(/^\//, "~/") ?? "?";
  }

  private verification(): string {
    const lines = [`UV ${this.uvInstalled ? "uv 0.9.9" : "none"}`];
    for (const kind of this.envs) {
      lines.push(`PYTHON ${kind} Python 3.12.7`);
      for (const spec of this.packages.get(kind) ?? []) lines.push(`PKG ${kind} ${spec}`);
    }
    for (const [dir, model] of this.models) {
      lines.push(`MODEL ${dir} ${model.safetensors} ${model.kb} ${model.how}`);
    }
    lines.push(`FREE_KB ${this.freeKb}`);
    return lines.join("\n") + "\n";
  }
}

function planFor(over: Record<string, unknown> = {}, lane = "Studio"): LaneSetupPlan {
  return planLaneSetup(config(over), lane);
}

// ------------------------------------------------------------------ planning

describe("planning what a lane needs", () => {
  test("links what the machine already has and downloads the rest", () => {
    const plan = planFor({
      lanes: [
        {
          label: "Studio",
          baseUrl: "http://box.local:8090",
          ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          localPaths: { "Big-4bit": "~/.other/models/vendor--Big-4bit" },
        },
      ],
    });
    const small = plan.models.find((m) => m.dir === "Small-4bit")!;
    const big = plan.models.find((m) => m.dir === "Big-4bit")!;

    expect(big.source).toEqual({ kind: "symlink", from: "~/.other/models/vendor--Big-4bit" });
    expect(small.source).toEqual({ kind: "download", repo: "vendor/Small-4bit" });
    // Both end up at the same path whatever their origin -- that is the point.
    expect(big.target).toBe("~/bench-models/Big-4bit");
    expect(small.target).toBe("~/bench-models/Small-4bit");
  });

  test("a model with no local copy and no repo is called out, not guessed at", () => {
    const plan = planFor({ models: [{ name: "Orphan", dir: "Orphan-4bit" }] });
    expect(plan.models[0]!.source.kind).toBe("unavailable");
  });

  test("only the environments this lane's models need", () => {
    expect(planFor().environments.map((e) => e.kind)).toEqual(["llm"]);
    const mixed = planFor({
      models: [
        { name: "Small", dir: "Small-4bit", hfRepo: "vendor/Small-4bit" },
        { name: "Picture", dir: "Picture", hfRepo: "vendor/Picture", kind: "image" },
      ],
    });
    expect(mixed.environments.map((e) => e.kind)).toEqual(["llm", "image"]);
  });

  test("a lane restricted to one model only prepares that one", () => {
    const plan = planFor({
      lanes: [
        {
          label: "Studio",
          baseUrl: "http://box.local:8090",
          ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          models: ["~/bench-models/Small-4bit"],
        },
      ],
    });
    expect(plan.models.map((m) => m.dir)).toEqual(["Small-4bit"]);
  });

  test("a manual lane and an unknown lane both refuse with a useful message", () => {
    expect(() => planFor({}, "Manual")).toThrow(/no ssh block/);
    expect(() => planFor({}, "Nope")).toThrow(/No lane called "Nope"/);
  });

  test("the disk it will demand is the model plus headroom", () => {
    const big = planFor().models.find((m) => m.dir === "Big-4bit")!;
    expect(big.needGb).toBe(60 + DISK_HEADROOM_GB);
    // A link needs nothing: the bytes are already on the disk.
    const linked = planFor({
      lanes: [
        {
          label: "Studio",
          baseUrl: "http://box.local:8090",
          ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          localPaths: { "Big-4bit": "~/have/it" },
        },
      ],
    }).models.find((m) => m.dir === "Big-4bit")!;
    expect(linked.needGb).toBe(0);
  });
});

// ------------------------------------------------------------------ commands

describe("the commands it would run", () => {
  test("the pins live in one file, and the install command uses exactly them", () => {
    // Asserted against pins.ts, not against a version written out here: a
    // deliberate bump should be a one-line change, not a test rewrite.
    expect(ENVIRONMENTS.llm.packages).toEqual(PINS.llm.packages);
    const command = installPackagesCommand("llm");
    for (const pin of PINS.llm.packages) expect(command).toContain(`'${pin}'`);
  });

  test("every pin names an exact version, never a range", () => {
    for (const pin of Object.values(PINS)) {
      for (const pkg of pin.packages) {
        expect(pkg).toMatch(/^[A-Za-z0-9_.-]+==[0-9]+\.[0-9]+\.[0-9]+$/);
      }
    }
  });

  test("everything runs as the user: no sudo, no brew, no system python", () => {
    const all = [
      uvVersionCommand(),
      installUvCommand(),
      createEnvCommand("llm"),
      installPackagesCommand("llm"),
      downloadModelCommand("vendor/Small-4bit", "~/bench-models/Small-4bit"),
      diskFreeCommand(),
    ].join("\n");
    expect(all).not.toMatch(/\bsudo\b/);
    expect(all).not.toMatch(/\bbrew\b/);
    expect(all).not.toMatch(/\/usr\/bin\/python/);
    // `uv pip install`, never a bare pip.
    expect(all.replace(/uv pip/g, "uvpip")).not.toMatch(/\bpip3?\s+install/);
  });

  test("uv comes from its own installer and nowhere else", () => {
    expect(installUvCommand()).toBe("curl -LsSf https://astral.sh/uv/install.sh | sh");
  });

  test("the environment is built on a pinned Python, under ~/bench-envs", () => {
    const command = createEnvCommand("llm");
    expect(command).toContain(`"$HOME"'/bench-envs/llm'`);
    expect(command).toContain("--python '3.12'");
    expect(envPath("llm")).toBe("~/bench-envs/llm");
    expect(envBinDir("llm")).toBe("~/bench-envs/llm/bin");
  });

  test("the download is the proven hf invocation, into the uniform path", () => {
    const command = downloadModelCommand("vendor/Small-4bit", "~/bench-models/Small-4bit");
    expect(command).toContain("uv tool run --from huggingface_hub hf download 'vendor/Small-4bit'");
    expect(command).toContain(`--local-dir "$HOME"'/bench-models/Small-4bit'`);
  });

  test("a link never destroys a real directory somebody filled", () => {
    const command = symlinkModelCommand("~/have/it", "~/bench-models/Big-4bit");
    expect(command).toContain("ALREADY_A_REAL_DIRECTORY");
    expect(command).toContain("if [ -L "); // only a symlink is replaced
    expect(command).not.toMatch(/rm -rf/);
  });

  test("a value that would not pass the validator never becomes a command", () => {
    expect(() => downloadModelCommand("vendor/Small; rm -rf ~", "~/bench-models/x")).toThrow();
    expect(() => symlinkModelCommand("~/have/$(id)", "~/bench-models/x")).toThrow();
  });

  test("the verify pass asks the machine, rather than trusting the steps", () => {
    const command = verifyCommand(planFor());
    expect(command).toContain("uv --version");
    expect(command).toContain("uv pip list");
    expect(command).toContain("safetensors");
    expect(command).toContain("du -skL");
    expect(command).toContain("FREE_KB");
  });
});

describe("reading the machine back", () => {
  test("parses versions, models and free disk", () => {
    const parsed = parseVerification(
      [
        "UV uv 0.9.9",
        "PYTHON llm Python 3.12.7",
        `PKG llm ${PINS.llm.packages[0]}`,
        `PKG llm ${PINS.llm.packages[1]}`,
        "MODEL Small-4bit 3 8388608 real",
        "MODEL Big-4bit 9 62914560 link",
        "FREE_KB 943718400",
      ].join("\n"),
    );
    expect(parsed.uv).toBe("uv 0.9.9");
    expect(parsed.pythons.llm).toBe("Python 3.12.7");
    expect(parsed.packages.llm).toEqual(PINS.llm.packages);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]).toEqual({ dir: "Big-4bit", safetensors: 9, kilobytes: 62914560, how: "link" });
    expect(parsed.freeGb).toBeCloseTo(900, 0);
  });

  test("a machine without uv reads back as not installed, not as blank", () => {
    expect(parseVerification("UV none\nFREE_KB 100\n").uv).toBeNull();
  });

  test("free disk is read in gigabytes", () => {
    expect(parseFreeGb("FREE_KB 1048576")).toBeCloseTo(1, 6);
    expect(parseFreeGb("nothing here")).toBeNull();
  });

  test("the pinned versions are compared exactly, never 'close enough'", () => {
    const exact = PINS.llm.packages.join("\n") + "\n";
    expect(packagesSatisfied(exact, ENVIRONMENTS.llm.packages)).toBe(true);
    expect(packagesSatisfied(exact.replace(/==[0-9.]+\n$/, "==0.0.1\n"), ENVIRONMENTS.llm.packages)).toBe(false);
    expect(packagesSatisfied(PINS.llm.packages[0]! + "\n", ENVIRONMENTS.llm.packages)).toBe(false);
    // pip normalises underscores; a match must survive that.
    expect(packagesSatisfied(exact.replace("mlx-lm", "mlx_lm"), ENVIRONMENTS.llm.packages)).toBe(true);
  });
});

// ------------------------------------------------------------------ running

describe("a fresh machine", () => {
  test("installs uv, builds the environment, pins the packages, fetches the models", async () => {
    const machine = new FakeMachine();
    const plan = planFor();
    const report = await runLaneSetup({ plan, run: machine.run });

    expect(report.ok).toBe(true);
    const did = report.steps.filter((s) => s.status === "did").map((s) => s.what);
    expect(did).toContain("uv");
    expect(did).toContain("llm environment");
    expect(did).toContain("llm packages");
    expect(did).toContain("model Small-4bit");
    expect(did).toContain("model Big-4bit");

    expect(report.verification!.packages.llm).toEqual(PINS.llm.packages);
    expect(verificationMatchesPlan(report.verification!, plan)).toEqual([]);
  });

  test("checks the disk BEFORE it starts downloading", async () => {
    const machine = new FakeMachine();
    await runLaneSetup({ plan: planFor(), run: machine.run });
    const firstDisk = machine.commands.findIndex((c) => c.includes("FREE_KB"));
    const firstDownload = machine.commands.findIndex((c) => c.includes("hf download"));
    expect(firstDisk).toBeGreaterThanOrEqual(0);
    expect(firstDisk).toBeLessThan(firstDownload);
  });
});

describe("running it a second time", () => {
  test("changes nothing", async () => {
    const machine = new FakeMachine();
    const plan = planFor();

    await runLaneSetup({ plan, run: machine.run });
    machine.commands.length = 0;

    const again = await runLaneSetup({ plan, run: machine.run });

    expect(again.ok).toBe(true);
    // Everything found, nothing done.
    expect(again.steps.filter((s) => s.status === "did")).toEqual([]);
    expect(again.steps.filter((s) => s.status === "found").length).toBeGreaterThan(3);

    // And it did not so much as reach for the things that change the machine.
    const changing = machine.commands.filter(
      (c) =>
        c.includes("hf download") ||
        c.includes("uv venv") ||
        c.includes("uv pip install") ||
        c.includes("ln -s") ||
        c.includes("install.sh"),
    );
    expect(changing).toEqual([]);
  });

  test("a machine that only half-finished gets exactly the missing half", async () => {
    const machine = new FakeMachine();
    machine.uvInstalled = true;
    machine.envs.add("llm");
    machine.packages.set("llm", [...PINS.llm.packages]);
    machine.models.set("Small-4bit", { safetensors: 3, kb: 8 * 1024 * 1024, how: "real" });

    const report = await runLaneSetup({ plan: planFor(), run: machine.run });

    const byWhat = new Map(report.steps.map((s) => [s.what, s.status]));
    expect(byWhat.get("uv")).toBe("found");
    expect(byWhat.get("llm environment")).toBe("found");
    expect(byWhat.get("llm packages")).toBe("found");
    expect(byWhat.get("model Small-4bit")).toBe("found");
    expect(byWhat.get("model Big-4bit")).toBe("did");
  });

  test("a package at the wrong version is reinstalled, not left alone", async () => {
    const machine = new FakeMachine();
    machine.uvInstalled = true;
    machine.envs.add("llm");
    machine.packages.set("llm", ["mlx==0.31.2", "mlx-lm==0.30.0"]); // drifted
    const report = await runLaneSetup({ plan: planFor(), run: machine.run });
    expect(report.steps.find((s) => s.what === "llm packages")!.status).toBe("did");
  });
});

describe("when the machine says no", () => {
  test("unreachable says so plainly and stops", async () => {
    const machine = new FakeMachine();
    machine.unreachable = true;
    const report = await runLaneSetup({
      plan: planFor(),
      run: machine.run,
      // The real thing pings and waits between tries; a test should not sit
      // through half a minute to prove it gave up.
      ping: async () => {},
      sleep: async () => {},
    });

    expect(report.ok).toBe(false);
    const failure = report.steps.find((s) => s.status === "failed")!;
    expect(failure.detail).toContain("Remote Login");
    expect(failure.detail).toContain("asleep");
    // Nothing but the probes was attempted: no setup work on a machine that
    // never answered.
    expect(new Set(machine.commands)).toEqual(new Set(["echo READY"]));
  });

  test("no disk space refuses BEFORE downloading, and says how much short it is", async () => {
    const machine = new FakeMachine();
    machine.freeKb = 30 * 1024 * 1024; // 30 GB, enough for the small one only
    const report = await runLaneSetup({ plan: planFor(), run: machine.run });

    const big = report.steps.find((s) => s.what === "model Big-4bit")!;
    expect(big.status).toBe("failed");
    expect(big.detail).toContain("80 GB free");
    expect(big.detail).toContain("30.0 GB");
    expect(big.detail).toContain("Nothing downloaded");
    expect(machine.commands.filter((c) => c.includes("hf download") && c.includes("Big-4bit"))).toEqual([]);

    // The one that DOES fit still gets fetched: one failure is not the end.
    expect(report.steps.find((s) => s.what === "model Small-4bit")!.status).toBe("did");
  });

  test("a download that stops partway says to run it again to resume", async () => {
    const machine = new FakeMachine();
    machine.failDownload = "Connection reset by peer";
    const report = await runLaneSetup({ plan: planFor(), run: machine.run });

    const step = report.steps.find((s) => s.what === "model Small-4bit")!;
    expect(step.status).toBe("failed");
    expect(step.detail).toContain("Connection reset");
    expect(step.detail).toContain("carry on from where it stopped");
    expect(report.ok).toBe(false);
  });

  test("a resumed download is pointed at the same directory, so it continues", async () => {
    // hf resumes into an existing --local-dir. Downloading into a fresh
    // directory each time would restart twenty gigabytes.
    const first = downloadModelCommand("vendor/Small-4bit", "~/bench-models/Small-4bit");
    const second = downloadModelCommand("vendor/Small-4bit", "~/bench-models/Small-4bit");
    expect(first).toBe(second);
    expect(first).not.toMatch(/rm -rf|--force|mktemp/);
  });

  test("a localPath that is not on the machine is named, not silently downloaded", async () => {
    const machine = new FakeMachine();
    const plan = planFor({
      lanes: [
        {
          label: "Studio",
          baseUrl: "http://box.local:8090",
          ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          localPaths: { "Big-4bit": "~/not/there" },
        },
      ],
    });
    const report = await runLaneSetup({ plan, run: machine.run });
    const step = report.steps.find((s) => s.what === "model Big-4bit")!;
    expect(step.status).toBe("failed");
    expect(step.detail).toContain("~/not/there");
  });

  test("a model with nowhere to come from fails that model and no other", async () => {
    const machine = new FakeMachine();
    const plan = planFor({
      models: [
        { name: "Orphan", dir: "Orphan-4bit" },
        { name: "Small", dir: "Small-4bit", hfRepo: "vendor/Small-4bit", approxGb: 8 },
      ],
    });
    const report = await runLaneSetup({ plan, run: machine.run });
    expect(report.steps.find((s) => s.what === "model Orphan-4bit")!.status).toBe("failed");
    expect(report.steps.find((s) => s.what === "model Small-4bit")!.status).toBe("did");
  });
});

describe("--plan changes nothing", () => {
  test("it reports what it would do and touches none of it", async () => {
    const machine = new FakeMachine();
    const report = await runLaneSetup({ plan: planFor(), run: machine.run, dryRun: true });

    expect(report.steps.filter((s) => s.status === "did")).toEqual([]);
    const changing = machine.commands.filter(
      (c) => c.includes("hf download") || c.includes("uv venv") || c.includes("uv pip install") || c.includes("ln -s"),
    );
    expect(changing).toEqual([]);
    expect(report.steps.some((s) => s.detail.includes("would download"))).toBe(true);
  });
});

// ------------------------------------------------------------------ output

describe("what it prints", () => {
  test("the plan names every environment and every model with its origin", () => {
    const text = renderPlan(
      planFor({
        lanes: [
          {
            label: "Studio",
            baseUrl: "http://box.local:8090",
            ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
            localPaths: { "Big-4bit": "~/have/Big" },
          },
        ],
      }),
    );
    expect(text).toContain('lane "Studio"');
    expect(text).toContain(PINS.llm.packages.join(", "));
    expect(text).toContain("link to ~/have/Big");
    expect(text).toContain("download vendor/Small-4bit");
  });

  test("the checklist says found, done and failed, then what the machine reports", async () => {
    const machine = new FakeMachine();
    const plan = planFor();
    const report = await runLaneSetup({ plan, run: machine.run });
    const text = renderReport(report, plan);

    expect(text).toContain("DONE");
    expect(text).toContain("already there");
    expect(text).toContain("What is actually on the machine now");
    expect(text).toContain("mlx-lm");
    expect(text).toContain("safetensors");
    expect(text).toContain("free disk");
    expect(text).toContain("Running setup-lane again will change nothing");
  });

  test("a failure is listed again at the end, so it cannot scroll past", async () => {
    const machine = new FakeMachine();
    machine.failDownload = "network is down";
    const plan = planFor();
    const text = renderReport(await runLaneSetup({ plan, run: machine.run }), plan);
    expect(text).toContain("step(s) failed");
    expect(text).toContain("network is down");
    expect(text).not.toContain("Running setup-lane again will change nothing");
  });

  test("a drifted version is reported against what was expected", async () => {
    const plan = planFor();
    const problems = verificationMatchesPlan(
      parseVerification(
        ["UV uv 0.9.9", "PYTHON llm Python 3.12.7", "PKG llm mlx==0.31.2", "PKG llm mlx-lm==0.30.0", "FREE_KB 1"].join("\n"),
      ),
      plan,
    );
    expect(problems.join(" ")).toContain("mlx-lm is 0.30.0");
    expect(problems.join(" ")).toContain("0.31.3");
  });

  test("an empty model directory counts as not ready", () => {
    const plan = planFor();
    const problems = verificationMatchesPlan(
      parseVerification(
        [
          "UV uv 0.9.9",
          "PYTHON llm Python 3.12.7",
          "PKG llm mlx==0.31.2",
          "PKG llm mlx-lm==0.31.3",
          "MODEL Small-4bit 0 0 real",
          "MODEL Big-4bit 4 100 link",
          "FREE_KB 1",
        ].join("\n"),
      ),
      plan,
    );
    expect(problems.join(" ")).toContain("Small-4bit");
    expect(problems.join(" ")).toContain("no safetensors");
  });
});

describe("changing a pin", () => {
  // The whole reason the versions live in one file: bumping mlx for the newer
  // machine's accelerator path has to reach BOTH machines, or the two lanes
  // are no longer running the same software and the difference reads as
  // hardware.
  test("an environment whose versions no longer match the pins is rebuilt", async () => {
    const machine = new FakeMachine();
    machine.uvInstalled = true;
    machine.envs.add("llm");
    machine.packages.set("llm", ["mlx==0.31.2", "mlx-lm==0.31.3"]); // the old pin

    const report = await runLaneSetup({ plan: planFor(), run: machine.run });
    const env = report.steps.find((s) => s.what === "llm environment")!;

    expect(env.status).toBe("did");
    expect(env.detail).toContain("rebuilt");
    expect(env.detail).toContain("no longer matched the pins");
    // Rebuilt from scratch, not upgraded in place.
    expect(machine.commands.some((c) => c.includes("uv venv") && c.includes("--clear"))).toBe(true);
    expect(report.steps.find((s) => s.what === "llm packages")!.status).toBe("did");
  });

  test("an environment that already matches is left alone and not cleared", async () => {
    const machine = new FakeMachine();
    machine.uvInstalled = true;
    machine.envs.add("llm");
    machine.packages.set("llm", [...PINS.llm.packages]);

    const report = await runLaneSetup({ plan: planFor(), run: machine.run });
    expect(report.steps.find((s) => s.what === "llm environment")!.status).toBe("found");
    expect(machine.commands.some((c) => c.includes("--clear"))).toBe(false);
  });

  test("a first build is a create, not a rebuild", async () => {
    const machine = new FakeMachine();
    machine.uvInstalled = true;
    const report = await runLaneSetup({ plan: planFor(), run: machine.run });
    const env = report.steps.find((s) => s.what === "llm environment")!;
    expect(env.detail).toContain("created");
    expect(machine.commands.some((c) => c.includes("--clear"))).toBe(false);
  });
});

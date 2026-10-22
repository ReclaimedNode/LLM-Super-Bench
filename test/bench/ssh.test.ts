/**
 * Managed mode's command building.
 *
 * Two things are being protected here. One: nothing the local side runs is ever
 * a shell string, so these tests assert on argument ARRAYS. Two: the remote
 * side of ssh is a shell by definition, so every config value that lands there
 * has passed the allow-pattern and is quoted, and a value that has not passed
 * must never produce a command at all.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  FILE_WRITTEN,
  THINKING_OFF_ARGS,
  engineBenchmarkCommand,
  parsePid,
  readAllBytes,
  remoteArg,
  sshArgs,
  startServerCommand,
  stopServerCommand,
  writeRemoteFileCommand,
} from "../../src/bench/ssh.ts";
import type { SshTarget } from "../../src/bench/types.ts";

const target: SshTarget = { host: "box.local", binDir: "~/bench-venv/bin", port: 8090 };

describe("the ssh command is an argument array, never a shell string", () => {
  test("carries BatchMode, the host, and the remote command as ONE argument", () => {
    const args = sshArgs(target, "echo hello");
    expect(args[0]).toBe("ssh");
    expect(args).toContain("-o");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("box.local");
    // The remote command is the last single element: the local shell never
    // sees it, because Bun.spawn is given this array.
    expect(args.at(-1)).toBe("echo hello");
  });

  test("a user and a non-standard ssh port are honoured", () => {
    const args = sshArgs({ ...target, user: "someone", sshPort: 2222 }, "true");
    expect(args).toContain("someone@box.local");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  test("a host that would not pass the allow-pattern never produces a command", () => {
    expect(() => sshArgs({ ...target, host: "box; curl evil.example" }, "true")).toThrow();
    expect(() => sshArgs({ ...target, user: "me$(id)" }, "true")).toThrow();
  });
});

describe("quoting a value for the remote shell", () => {
  test("an ordinary path is single quoted", () => {
    expect(remoteArg("/opt/models/thing")).toBe("'/opt/models/thing'");
  });

  test("a leading tilde becomes $HOME, because a quoted tilde is a literal tilde", () => {
    expect(remoteArg("~/venv/bin")).toBe(`"$HOME"'/venv/bin'`);
    expect(remoteArg("~")).toBe('"$HOME"');
  });

  test("anything that could change the command is refused, not escaped", () => {
    for (const bad of ["a b", "a;b", "a$b", "a`b`", "a&&b", "a|b", "a>b", "a'b", 'a"b', "a\nb"]) {
      expect(() => remoteArg(bad)).toThrow();
    }
  });
});

describe("starting a server", () => {
  const command = startServerCommand({ target, modelId: "~/models/Some-Model-4bit", chatTemplateArgs: THINKING_OFF_ARGS });

  test("runs the binary from the configured environment, on the configured port", () => {
    expect(command).toContain(`"$HOME"'/bench-venv/bin/mlx_lm.server'`);
    expect(command).toContain(`--model "$HOME"'/models/Some-Model-4bit'`);
    expect(command).toContain("--port '8090'");
    expect(command).toContain("--host '0.0.0.0'");
  });

  test("turns the server's prompt cache off, as well as busting it per run", () => {
    expect(command).toContain("--prompt-cache-size '0'");
  });

  test("passes the exact JSON the server's own help gives for turning thinking off", () => {
    expect(THINKING_OFF_ARGS).toBe('{"enable_thinking":false}');
    expect(command).toContain(`--chat-template-args '{"enable_thinking":false}'`);
  });

  test("leaves thinking alone when it was not asked for", () => {
    const left = startServerCommand({ target, modelId: "~/models/m", chatTemplateArgs: null });
    expect(left).not.toContain("--chat-template-args");
  });

  test("prints the pid, which is the only handle used to stop it later", () => {
    expect(command).toContain("echo PID:$!");
    expect(command.startsWith("nohup ")).toBe(true);
  });

  test("a model id with a shell character in it never produces a command", () => {
    expect(() => startServerCommand({ target, modelId: "~/models/m; rm -rf ~" })).toThrow();
    expect(() => startServerCommand({ target: { ...target, binDir: "~/my venv/bin" }, modelId: "~/m" })).toThrow();
  });
});

describe("stopping a server", () => {
  const command = stopServerCommand(4242);

  test("kills exactly the pid it started, and nothing that merely looks like it", () => {
    expect(command).toContain("kill 4242");
    // `pkill -f` on a shared machine matches other people's processes. On a
    // box that is also a node in a cluster, that is somebody else's job.
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("killall");
  });

  test("asks politely, waits, then insists, then says which happened", () => {
    expect(command).toContain("kill -0 4242");
    expect(command).toContain("kill -9 4242");
    expect(command).toContain("STOPPED");
    expect(command).toContain("STILL_RUNNING");
  });

  test("refuses a pid that is not a real one", () => {
    for (const bad of [0, 1, -1, 1.5, Number.NaN]) {
      expect(() => stopServerCommand(bad)).toThrow();
    }
  });
});

describe("the engine benchmark command", () => {
  test("uses the tool's real flags, confirmed against its own --help", () => {
    const command = engineBenchmarkCommand({
      target,
      modelId: "~/models/m",
      promptTokens: 512,
      generationTokens: 128,
      trials: 2,
    });
    expect(command).toContain(`"$HOME"'/bench-venv/bin/mlx_lm.benchmark'`);
    expect(command).toContain(`--model "$HOME"'/models/m'`);
    expect(command).toContain("-p '512'");
    expect(command).toContain("-g '128'");
    expect(command).toContain("-n '2'");
  });

  test("refuses sizes that are not positive whole numbers", () => {
    const base = { target, modelId: "~/m", promptTokens: 512, generationTokens: 128, trials: 2 };
    expect(() => engineBenchmarkCommand({ ...base, promptTokens: 0 })).toThrow();
    expect(() => engineBenchmarkCommand({ ...base, trials: -1 })).toThrow();
    expect(() => engineBenchmarkCommand({ ...base, generationTokens: 1.5 })).toThrow();
  });
});

describe("reading the pid back", () => {
  test("finds it among whatever else the shell printed", () => {
    expect(parsePid("some login noise\nPID:12345\n")).toBe(12345);
  });

  test("no pid means no pid, not a guess", () => {
    expect(parsePid("")).toBeNull();
    expect(parsePid("PID:")).toBeNull();
    expect(parsePid("command not found")).toBeNull();
    expect(parsePid("PID:1")).toBeNull();
  });
});

describe("copying a file back", () => {
  // Found on the first live image run: every picture came back empty and the
  // run warned "could not copy back" for all of them, while the file on the
  // machine was a perfectly good 1.5 MB PNG. Response.bytes() resolves to an
  // ArrayBuffer on this Bun, so `.length` was undefined and the guard threw
  // the bytes away. Read through arrayBuffer() and it cannot happen.
  test("reads every byte of a stream, as a Uint8Array", async () => {
    const source = resolve(import.meta.dir, "../fixtures/mlx_lm.benchmark-512-128-2.txt");
    const expected = await Bun.file(source).arrayBuffer();

    const proc = Bun.spawn(["cat", source], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const bytes = await readAllBytes(proc.stdout);
    await proc.exited;

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // The guard the bug hid behind: this must be a real number, not undefined.
    expect(typeof bytes.byteLength).toBe("number");
  });

  test("an empty stream reads as zero bytes, not as a failure to read", async () => {
    const proc = Bun.spawn(["true"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const bytes = await readAllBytes(proc.stdout);
    await proc.exited;
    expect(bytes.byteLength).toBe(0);
  });
});

describe("copying a file onto the machine", () => {
  test("it makes the folder, writes what is piped in, and says it did", () => {
    expect(writeRemoteFileCommand("~/bench-clips/20260920-183045/start.png")).toBe(
      `mkdir -p "$(dirname "$HOME"'/bench-clips/20260920-183045/start.png')" && ` +
        `cat > "$HOME"'/bench-clips/20260920-183045/start.png' && echo FILE_WRITTEN`,
    );
    expect(FILE_WRITTEN).toBe("FILE_WRITTEN");
  });

  test("a path a shell could act on is refused rather than quoted and hoped for", () => {
    expect(() => writeRemoteFileCommand("~/clips/$(whoami).png")).toThrow(/not allowed/);
    expect(() => writeRemoteFileCommand("~/clips/a b.png")).toThrow(/not allowed/);
  });
});

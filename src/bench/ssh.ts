/**
 * Managed mode: starting and stopping a model server on another machine.
 *
 * Two rules hold everywhere in this file.
 *
 * 1. On the LOCAL side nothing is ever a shell string. Bun.spawn is given an
 *    argument array, so the local shell never sees any of it and cannot be
 *    persuaded to interpret it.
 * 2. The REMOTE side of ssh is a shell by definition -- ssh joins its arguments
 *    and hands them to one. So every value that reaches it is checked against
 *    the allow-pattern in config.ts first AND single-quoted here. The check is
 *    what makes it safe; the quoting is what makes it work when a path is
 *    merely awkward.
 *
 * The runner stops only the process it started, by the pid that process
 * printed. Never `pkill -f`, which would match anything with a similar command
 * line -- on a machine that is also a node in a cluster, that is somebody
 * else's job.
 */

import { assertRemoteSafe } from "./config.ts";
import type { SshTarget } from "./types.ts";

/**
 * Wraps a value for the remote shell.
 *
 * A leading `~/` becomes `"$HOME"/...`, because a tilde inside single quotes is
 * a literal tilde and the path would not exist. Everything else is single
 * quoted verbatim. Values arriving here have already passed the allow-pattern,
 * so there is no quote inside them to escape.
 */
export function remoteArg(value: string, field = "value"): string {
  assertRemoteSafe(value, field);
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"'${value.slice(1)}'`;
  return `'${value}'`;
}

/** The ssh command as an argument array. Never a string, never a shell. */
export function sshArgs(target: SshTarget, remoteCommand: string, connectTimeoutSec?: number): string[] {
  assertRemoteSafe(target.host, "ssh.host");
  const args = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  // Only the CONNECT phase. A long command is unaffected; a machine that is
  // asleep answers nothing, and without this ssh sits there for the best part
  // of a minute before admitting it.
  if (connectTimeoutSec !== undefined) args.push("-o", `ConnectTimeout=${Math.max(1, Math.round(connectTimeoutSec))}`);
  if (target.sshPort !== undefined) args.push("-p", String(target.sshPort));
  args.push(target.user ? `${assertRemoteSafe(target.user, "ssh.user")}@${target.host}` : target.host);
  args.push(remoteCommand);
  return args;
}

export interface StartServerOptions {
  target: SshTarget;
  modelId: string;
  /** Turn the prompt cache off at the server, as well as busting it per run. */
  promptCacheSize?: number;
  /**
   * JSON for the tokenizer's apply_chat_template. mlx_lm.server's own --help
   * gives '{"enable_thinking":false}' as its example, which is the exact shape
   * used to turn a thinking model's thinking off.
   */
  chatTemplateArgs?: string | null;
  logFile?: string;
}

export const THINKING_OFF_ARGS = '{"enable_thinking":false}';

/**
 * The remote command that starts one model server and prints its pid.
 *
 * nohup + background + `echo PID:$!` is the whole trick: ssh returns as soon as
 * the pid is printed, and the pid is the only handle used to stop it later.
 */
export function startServerCommand(opts: StartServerOptions): string {
  const { target, modelId } = opts;
  const bin = remoteArg(`${target.binDir.replace(/\/+$/, "")}/mlx_lm.server`, "ssh.binDir");
  const model = remoteArg(modelId, "model id");
  const log = remoteArg(opts.logFile ?? `/tmp/llm-bench-server-${target.port}.log`, "log file");

  const parts = [
    "nohup",
    bin,
    "--model",
    model,
    "--host",
    "'0.0.0.0'",
    "--port",
    `'${target.port}'`,
    "--prompt-cache-size",
    `'${opts.promptCacheSize ?? 0}'`,
  ];

  // Not a config value: our own literal, quoted because it is full of JSON.
  if (opts.chatTemplateArgs) parts.push("--chat-template-args", `'${opts.chatTemplateArgs}'`);

  parts.push(">", log, "2>&1", "&", "echo", "PID:$!");
  return parts.join(" ");
}

/**
 * The remote command that stops one pid.
 *
 * TERM, wait, then KILL if it is still there, then say what happened. `kill -0`
 * is the check; `pkill -f` is never used, because a pattern match on a shared
 * machine can kill somebody else's process.
 */
export function stopPidCommand(pid: number, graceSeconds = 10): string {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to stop pid ${pid}`);
  return (
    `kill ${pid} 2>/dev/null; ` +
    `for i in $(seq 1 ${graceSeconds}); do kill -0 ${pid} 2>/dev/null || break; sleep 1; done; ` +
    `if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null; sleep 1; fi; ` +
    `if kill -0 ${pid} 2>/dev/null; then echo STILL_RUNNING; else echo STOPPED; fi`
  );
}

/** Stopping a model server is stopping its pid, and nothing else. */
export const stopServerCommand = stopPidCommand;

/** The remote command that runs the engine's own benchmark. */
export function engineBenchmarkCommand(opts: {
  target: SshTarget;
  modelId: string;
  promptTokens: number;
  generationTokens: number;
  trials: number;
}): string {
  const bin = remoteArg(`${opts.target.binDir.replace(/\/+$/, "")}/mlx_lm.benchmark`, "ssh.binDir");
  const model = remoteArg(opts.modelId, "model id");
  for (const [name, value] of [
    ["prompt tokens", opts.promptTokens],
    ["generation tokens", opts.generationTokens],
    ["trials", opts.trials],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`engine benchmark ${name} must be a positive integer`);
  }
  return [
    bin,
    "--model",
    model,
    "-p",
    `'${opts.promptTokens}'`,
    "-g",
    `'${opts.generationTokens}'`,
    "-n",
    `'${opts.trials}'`,
  ].join(" ");
}

export interface RemoteResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * How a remote command gets run.
 *
 * An interface rather than a direct call so the setup command can be driven
 * end to end against a fake in tests. Provisioning a machine is exactly the
 * kind of code that must be proven before it is pointed at real hardware,
 * and it is the kind that cannot be proven by pointing it at real hardware.
 */
export type RemoteRunner = (
  target: SshTarget,
  command: string,
  opts?: { timeoutMs?: number; connectTimeoutSec?: number },
) => Promise<RemoteResult>;

/** Runs one remote command and collects its output. Never throws on a non-zero exit. */
export async function runRemote(
  target: SshTarget,
  remoteCommand: string,
  opts: { timeoutMs?: number; connectTimeoutSec?: number } = {},
): Promise<RemoteResult> {
  const args = sshArgs(target, remoteCommand, opts.connectTimeoutSec);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : null;

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: code === 0 && !timedOut,
      code: timedOut ? null : code,
      stdout,
      stderr: timedOut ? `${stderr}\n[timed out after ${opts.timeoutMs}ms]` : stderr,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a remote command with something piped into its stdin.
 *
 * Used to put the timing shim on a machine without needing scp or a second
 * tool: the file goes down the same ssh the rest of this uses. Bytes are
 * accepted as well as text, because the same trick is how a picture gets onto
 * a machine, and a PNG put through a string would come out corrupt.
 */
export async function runRemoteWithInput(
  target: SshTarget,
  remoteCommand: string,
  input: string | Uint8Array,
  opts: { timeoutMs?: number } = {},
): Promise<RemoteResult> {
  const proc = Bun.spawn(sshArgs(target, remoteCommand), { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();

  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Every byte of a stream, as a Uint8Array.
 *
 * Deliberately via arrayBuffer() rather than Response.bytes(): on the Bun this
 * was written against, bytes() resolves to an ArrayBuffer, so reading `.length`
 * off it gives undefined. A caller checking `bytes.length > 0` then treats a
 * perfectly good 1.5 MB image as an empty read -- which is exactly what
 * happened on the first live image run, silently, for every picture.
 */
export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The remote command that writes whatever is piped into it to one path.
 *
 * The same trick the timing shim is installed with, and for the same reason:
 * a file gets onto a machine down the ssh connection this tool already has,
 * with no scp, no second tool and no second way in to keep working. The path
 * is checked by `remoteArg` like every other value that reaches a remote
 * shell, and the word at the end is what the caller looks for to know the
 * write happened rather than assuming it did.
 */
export function writeRemoteFileCommand(remotePath: string): string {
  const dest = remoteArg(remotePath, "remote file");
  return `mkdir -p "$(dirname ${dest})" && cat > ${dest} && echo FILE_WRITTEN`;
}

/** What `writeRemoteFileCommand` prints when the file landed. */
export const FILE_WRITTEN = "FILE_WRITTEN";

/** Copies one file onto the machine, as bytes. */
export async function sendRemoteFile(
  target: SshTarget,
  remotePath: string,
  bytes: Uint8Array,
  opts: { timeoutMs?: number } = {},
): Promise<RemoteResult> {
  return await runRemoteWithInput(target, writeRemoteFileCommand(remotePath), bytes, opts);
}

/** Copies one file off the machine, as bytes. Null when there was nothing to copy. */
export async function fetchRemoteFile(
  target: SshTarget,
  remotePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<Uint8Array | null> {
  const command = `cat ${remoteArg(remotePath, "remote file")}`;
  const proc = Bun.spawn(sshArgs(target, command), { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  try {
    const [bytes, code] = await Promise.all([readAllBytes(proc.stdout), proc.exited]);
    return code === 0 && bytes.byteLength > 0 ? bytes : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pulls `PID:1234` out of the start command's output. */
export function parsePid(stdout: string): number | null {
  const match = /PID:(\d+)/.exec(stdout);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

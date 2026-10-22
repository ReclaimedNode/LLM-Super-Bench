/**
 * Keeping a machine awake for the length of an operation.
 *
 * A freshly set up Mac can have system sleep set to ONE minute, and neither an
 * open ssh session nor a running download counts as activity: the machine
 * drops off the network mid-setup, repeatedly, and every symptom points
 * somewhere else. `pmset -g` shows `sleep 1` on such a machine where a
 * long-lived one shows `sleep 0`.
 *
 * `caffeinate -dimsu` fixes it with no sudo and no settings change, which is
 * what makes it the right tool: a benchmark has no business permanently
 * editing a borrowed machine's power settings. It holds the machine awake for
 * as long as it runs and then stops, leaving nothing behind.
 *
 * Two safety nets, because the failure this prevents is invisible:
 *  - `-t <seconds>` makes the hold expire on its own, so a runner that dies
 *    without cleaning up cannot leave a machine awake indefinitely;
 *  - the pid is recorded and exactly that pid is stopped afterwards, on the
 *    way out of a failure and an interrupt as well as a success. Never a
 *    pattern match: `pkill -f caffeinate` on a shared machine would kill
 *    somebody else's.
 */

import { runRemote, stopPidCommand } from "./ssh.ts";
import type { RemoteRunner } from "./ssh.ts";
import type { SshTarget } from "./types.ts";

/** Longest a single hold may last, whatever the caller asks for. */
export const MAX_HOLD_SECONDS = 12 * 60 * 60;
/** Slack past the operation's own timeout, so the hold outlives the work. */
export const HOLD_MARGIN_SECONDS = 5 * 60;

/** What `caffeinate` is asked to prevent: display, idle, disk, system, user. */
export function caffeinateCommand(seconds: number): string {
  const held = Math.max(60, Math.min(Math.round(seconds), MAX_HOLD_SECONDS));
  return `nohup caffeinate -dimsu -t ${held} > /dev/null 2>&1 & echo AWAKE_PID:$!`;
}

export function parseAwakePid(stdout: string): number | null {
  const match = /AWAKE_PID:(\d+)/.exec(stdout);
  const pid = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** Reads the system sleep setting, in minutes. Zero means never. */
export function sleepSettingCommand(): string {
  return `pmset -g | grep -E '^[[:space:]]*sleep[[:space:]]' || echo NO_PMSET`;
}

export interface SleepSetting {
  /** Minutes before the machine sleeps. 0 is never. Null when unreadable. */
  minutes: number | null;
  /** True when something is already holding it awake. */
  prevented: boolean;
}

export function parseSleepSetting(stdout: string): SleepSetting {
  const match = /^\s*sleep\s+(\d+)/m.exec(stdout);
  return {
    minutes: match ? Number(match[1]) : null,
    prevented: /sleep prevented by/i.test(stdout),
  };
}

/**
 * The warning a plan or a preflight prints. Null when there is nothing to say.
 *
 * A machine set to sleep in a minute will not finish anything, and the way it
 * fails -- dropping off the network partway through -- looks like a network
 * fault, not a power setting.
 *
 * No lane label: some callers print these under a lane heading and some print
 * them in a list of lanes, so whoever needs the label puts it on the front.
 */
export function sleepWarning(setting: SleepSetting): string | null {
  if (setting.minutes === null) {
    return `could not read this machine's sleep setting, so it may sleep mid-run.`;
  }
  if (setting.minutes === 0) return null;
  return (
    `this machine is set to sleep after ${setting.minutes} minute${setting.minutes === 1 ? "" : "s"}. ` +
    `Anything longer than that would be cut off partway through, and it looks like a network fault when it happens. ` +
    `Each operation holds it awake with caffeinate for its own duration; nothing about the machine's settings is changed.`
  );
}

export interface AwakeHold {
  /** Null when nothing is holding the machine, for whatever reason. */
  pid: number | null;
  /** One line about what happened, worth printing. */
  note: string;
  /** Stops exactly the process this started. Safe to call twice. */
  release: () => Promise<void>;
}

const NOT_HELD: AwakeHold = { pid: null, note: "", release: async () => {} };

export interface HoldOptions {
  target: SshTarget;
  /** How long the work might take. The hold is this plus a margin. */
  seconds: number;
  run?: RemoteRunner;
  /** Skip the hold, for a dry run. */
  dryRun?: boolean;
}

/**
 * Holds one machine awake and hands back the means to let it go.
 *
 * Never throws and never fails an operation: a machine that cannot be held
 * awake is a machine that might sleep, which is worth saying, but refusing to
 * run at all would be worse than running and possibly being interrupted.
 */
export async function holdAwake(opts: HoldOptions): Promise<AwakeHold> {
  if (opts.dryRun) return NOT_HELD;
  const run = opts.run ?? runRemote;
  const seconds = opts.seconds + HOLD_MARGIN_SECONDS;

  let started;
  try {
    started = await run(opts.target, caffeinateCommand(seconds), { timeoutMs: 60_000 });
  } catch (err) {
    return { ...NOT_HELD, note: `could not hold this machine awake (${String(err)}).` };
  }

  const pid = parseAwakePid(started.stdout);
  if (pid === null) {
    return {
      ...NOT_HELD,
      note:
        `could not hold this machine awake, so it may sleep mid-run. ` +
        `caffeinate said: ${(started.stderr || started.stdout).trim().slice(0, 160) || "nothing"}`,
    };
  }

  let released = false;
  return {
    pid,
    note: `holding this machine awake for up to ${Math.round(seconds / 60)} minutes (caffeinate pid ${pid}).`,
    release: async () => {
      if (released) return;
      released = true;
      // Exactly this pid, never a pattern: on a shared machine `pkill -f
      // caffeinate` would stop somebody else's hold as well as ours.
      await run(opts.target, stopPidCommand(pid), { timeoutMs: 60_000 }).catch(() => undefined);
    },
  };
}

/**
 * Runs `work` with the machine held awake, and lets go afterwards whatever
 * happens -- success, failure, or the process being interrupted.
 */
export async function whileAwake<T>(opts: HoldOptions & { log?: (m: string) => void }, work: () => Promise<T>): Promise<T> {
  const hold = await holdAwake(opts);
  if (hold.note && opts.log) opts.log(hold.note);

  const release = () => {
    void hold.release();
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);

  try {
    return await work();
  } finally {
    process.off("SIGINT", release);
    process.off("SIGTERM", release);
    await hold.release();
  }
}

/** Reads a lane's sleep setting and returns the warning, if any. */
export async function checkSleep(
  target: SshTarget,
  run: RemoteRunner = runRemote,
  timeoutMs = 30_000,
): Promise<{ setting: SleepSetting; warning: string | null }> {
  try {
    const result = await run(target, sleepSettingCommand(), { timeoutMs });
    const setting = parseSleepSetting(result.stdout);
    return { setting, warning: sleepWarning(setting) };
  } catch {
    const setting: SleepSetting = { minutes: null, prevented: false };
    return { setting, warning: sleepWarning(setting) };
  }
}

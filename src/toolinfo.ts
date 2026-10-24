/** Which version of this tool made a run, so two people's files can be told apart. */

import { PROJECT_ROOT } from "./config.ts";
import { gitCommit } from "./update.ts";

export interface ToolInfo {
  version: string;
  /** The git commit, or null for a download that is not a clone. */
  commit: string | null;
}

let cached: Promise<ToolInfo> | null = null;

export function toolInfo(): Promise<ToolInfo> {
  cached ??= (async () => {
    let version = "unknown";
    try {
      const pkg = (await Bun.file(`${PROJECT_ROOT}/package.json`).json()) as { version?: unknown };
      if (typeof pkg.version === "string") version = pkg.version.slice(0, 20);
    } catch {
      /* keep "unknown" */
    }
    return { version, commit: await gitCommit() };
  })();
  return cached;
}

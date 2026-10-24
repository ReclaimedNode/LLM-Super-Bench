/**
 *   bun run probe http://192.168.1.50:8000
 *   bun run probe http://host:8000 --api-key SECRET
 *   bun run probe http://host:8000 --raw        (do not mask addresses and folders)
 */

import { normalizeAddress } from "./init.ts";
import { probeReport } from "./probe.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--api-key");
const address = positional[0] ? normalizeAddress(positional[0]) : null;

if (!address) {
  console.error("Usage: bun run probe http://host:8000 [--api-key KEY] [--raw]");
  process.exit(2);
}

const report = await probeReport(address, { apiKey: value("--api-key"), raw: flag("--raw") });
console.log(report);
if (!flag("--raw")) console.log("Addresses and home folders are masked above, so this is safe to paste into an issue. Look it over first.");

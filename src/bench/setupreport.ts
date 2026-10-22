/**
 * What `setup-lane` prints.
 *
 * Its own file because it is the part a person actually reads, and because a
 * renderer with no side effects can be tested against a fixed report rather
 * than by squinting at a terminal after a twenty-minute download.
 */

import { ENVIRONMENTS } from "./setup.ts";
import type { LaneSetupPlan, SetupReport, SetupStep, Verification } from "./setup.ts";

const MARK: Record<SetupStep["status"], string> = {
  found: "already there",
  did: "DONE",
  skipped: "skipped",
  failed: "FAILED",
};

function gb(kilobytes: number): string {
  return `${(kilobytes / 1024 / 1024).toFixed(1)} GB`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The plan, before anything is touched. */
export function renderPlan(plan: LaneSetupPlan): string {
  const lines = ["", `  SETUP PLAN — lane "${plan.lane.label}"`, ""];

  lines.push(`  Environments under ~/bench-envs:`);
  for (const env of plan.environments) {
    const packages = env.packages.length > 0 ? env.packages.join(", ") : "(nothing pinned yet)";
    lines.push(`    ${pad(env.kind, 7)} Python ${env.python}   ${packages}`);
  }
  lines.push("");

  lines.push(`  Models at ~/bench-models, the same path on every machine:`);
  for (const step of plan.models) {
    const how =
      step.source.kind === "symlink"
        ? `link to ${step.source.from}`
        : step.source.kind === "download"
          ? `download ${step.source.repo} (about ${step.model.approxGb ?? "?"} GB)`
          : `CANNOT: ${step.source.why}`;
    lines.push(`    ${pad(step.dir, 28)} ${how}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderVerification(verification: Verification, plan: LaneSetupPlan): string[] {
  const lines = ["  What is actually on the machine now:", ""];
  lines.push(`    uv             ${verification.uv ?? "NOT INSTALLED"}`);

  for (const env of plan.environments) {
    const python = verification.pythons[env.kind] ?? "missing";
    lines.push(`    ${pad(env.kind, 7)} python ${python}`);

    const installed = verification.packages[env.kind] ?? [];
    for (const pin of ENVIRONMENTS[env.kind].packages) {
      const [name, wanted] = pin.split("==");
      const found = installed.find((spec) => spec.toLowerCase().startsWith(`${name!.toLowerCase()}==`));
      const version = found?.split("==")[1];
      const ok = version === wanted;
      lines.push(`    ${pad("", 7)} ${pad(name!, 12)} ${version ?? "MISSING"}${ok ? "" : `   EXPECTED ${wanted}`}`);
    }
  }

  lines.push("");
  for (const model of verification.models) {
    const state =
      model.how === "missing"
        ? "MISSING"
        : `${model.safetensors} safetensors, ${gb(model.kilobytes)}, ${model.how === "link" ? "linked" : "on disk"}`;
    lines.push(`    ${pad(model.dir, 28)} ${state}`);
  }

  lines.push("");
  lines.push(`    free disk      ${verification.freeGb === null ? "unknown" : `${verification.freeGb.toFixed(1)} GB`}`);
  return lines;
}

/**
 * The checklist: what was found, what was done, what was skipped, then what
 * the machine says about itself afterwards.
 */
export function renderReport(report: SetupReport, plan: LaneSetupPlan): string {
  const lines = ["", `  SETUP — lane "${report.laneLabel}"`, ""];

  for (const step of report.steps) {
    lines.push(`    ${pad(MARK[step.status], 13)} ${pad(step.what, 26)} ${step.detail}`);
  }
  lines.push("");

  if (report.verification) {
    lines.push(...renderVerification(report.verification, plan));
    lines.push("");
  }

  const failures = report.steps.filter((s) => s.status === "failed");
  if (failures.length === 0) {
    lines.push(`  This lane is ready. Running setup-lane again will change nothing.`);
  } else {
    lines.push(`  ${failures.length} step(s) failed:`);
    for (const failure of failures) lines.push(`    - ${failure.what}: ${failure.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Does what is on the machine match what the config asked for?
 *
 * Read off the VERIFICATION, not off the steps: a step that reported success
 * and a machine that is correctly set up are two different claims.
 */
export function verificationMatchesPlan(verification: Verification, plan: LaneSetupPlan): string[] {
  const problems: string[] = [];
  if (verification.uv === null) problems.push("uv is not installed");

  for (const env of plan.environments) {
    if (!verification.pythons[env.kind] || verification.pythons[env.kind] === "missing") {
      problems.push(`the ${env.kind} environment has no python`);
      continue;
    }
    const installed = verification.packages[env.kind] ?? [];
    for (const pin of ENVIRONMENTS[env.kind].packages) {
      const [name, wanted] = pin.split("==");
      const found = installed.find((spec) => spec.toLowerCase().startsWith(`${name!.toLowerCase()}==`));
      const version = found?.split("==")[1];
      if (version !== wanted) {
        problems.push(`${name} is ${version ?? "missing"} in the ${env.kind} environment, not the pinned ${wanted}`);
      }
    }
  }

  for (const step of plan.models) {
    const model = verification.models.find((m) => m.dir === step.dir);
    if (!model || model.how === "missing") problems.push(`${step.dir} is not at ${step.target}`);
    else if (model.safetensors === 0) problems.push(`${step.dir} is at ${step.target} but holds no safetensors files`);
  }

  return problems;
}

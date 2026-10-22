/**
 * Turning image runs into the cell summaries the board and report draw.
 *
 * Same rules as the language-model side: the median is the headline, the range
 * goes beside it, the warm-up never counts, and anything excluded is named.
 */

import { stat3 } from "./stats.ts";
import type { ImageCell, ImageCellStat, ImageRunRecord } from "./image.ts";

export function imageCellKeyOf(record: { laneLabel: string; modelId: string }): string {
  return JSON.stringify([record.laneLabel, record.modelId]);
}

export function summariseImageCell(cell: ImageCell, records: ImageRunRecord[]): ImageCellStat {
  const measured = records.filter((r) => !r.warmup);
  const used = measured.filter((r) => r.error === null && r.seconds !== null);
  const notes: string[] = [];

  const failed = measured.filter((r) => r.error !== null).length;
  if (failed > 0) notes.push(`${failed} of ${measured.length} images failed.`);

  // Every lane drew from the same seed, so within a cell every image should be
  // the same picture. If they are not, the seed is not doing what the method
  // assumes and the numbers are not comparing like with like.
  const checksums = [...new Set(used.map((r) => r.sha256).filter((s) => s !== ""))];
  if (checksums.length > 1) {
    // Say what was actually compared. Hashing the FILE reports a difference
    // whenever the encoder embeds a timestamp, which is not the machine
    // drawing a different picture -- measured live: byte-different files,
    // 0 of 1,048,576 pixels different.
    const what = used[0]?.checksumOf === "pixels" ? "pictures" : "files, compared by bytes rather than pixels";
    notes.push(
      `This lane's ${used.length} images are not identical despite a fixed seed (${checksums.length} different ${what}).`,
    );
  }

  let status: ImageCellStat["status"];
  if (measured.length === 0) status = "not-run";
  else if (used.length === 0) status = "failed";
  else if (used.length < measured.length) status = "partial";
  else status = "ok";

  const withLoad = records.find((r) => r.loadSeconds !== null);
  const withPeak = records.find((r) => r.peakMemoryGb !== null);
  const withVersions = records.find((r) => r.mfluxVersion !== null);
  const sample = used.find((r) => r.localFile !== null) ?? measured.find((r) => r.localFile !== null);

  return {
    laneLabel: cell.laneLabel,
    modelId: cell.modelId,
    modelName: cell.modelName,
    dir: cell.dir,
    kind: cell.kind,
    status,
    imagesRecorded: measured.length,
    imagesUsed: used.length,
    secondsPerImage: stat3(used.map((r) => r.seconds).filter((v): v is number => v !== null)),
    loadSeconds: withLoad?.loadSeconds ?? null,
    peakMemoryGb: withPeak?.peakMemoryGb ?? null,
    sha256: checksums.length === 1 ? checksums[0]! : null,
    sampleImage: sample?.localFile ?? null,
    mfluxVersion: withVersions?.mfluxVersion ?? null,
    mlxVersion: withVersions?.mlxVersion ?? null,
    notes,
  };
}

export function summariseImageCells(cells: ImageCell[], records: ImageRunRecord[]): ImageCellStat[] {
  const byCell = new Map<string, ImageRunRecord[]>();
  for (const record of records) {
    const key = imageCellKeyOf(record);
    const list = byCell.get(key);
    if (list) list.push(record);
    else byCell.set(key, [record]);
  }
  return cells.map((cell) => summariseImageCell(cell, byCell.get(imageCellKeyOf(cell)) ?? []));
}

/**
 * Do the lanes agree on what the picture looks like?
 *
 * With one seed on every lane they should. Where they do not, the board says
 * so rather than showing two different pictures under one heading as though
 * they were the same test.
 */
export function checksumDisagreements(stats: ImageCellStat[]): string[] {
  const byModel = new Map<string, ImageCellStat[]>();
  for (const stat of stats) {
    const list = byModel.get(stat.modelId);
    if (list) list.push(stat);
    else byModel.set(stat.modelId, [stat]);
  }

  const out: string[] = [];
  for (const [, cells] of byModel) {
    const known = cells.filter((c) => c.sha256 !== null);
    const distinct = [...new Set(known.map((c) => c.sha256))];
    if (distinct.length > 1) {
      out.push(
        `${known[0]!.modelName}: the lanes did not draw the same picture from the same seed ` +
          `(${known.map((c) => `${c.laneLabel} ${c.sha256!.slice(0, 8)}`).join(", ")}). ` +
          `Compare the pictures below before trusting the times.`,
      );
    }
  }
  return out;
}

/** Each machine's slots and reported setup, asked now, for the machines that will run. */

import { probeDetails, setupOf } from "./details.ts";
import type { MachineSetup } from "./details.ts";
import type { RaceConfig } from "./types.ts";

export async function setupFor(
  raceConfig: Pick<RaceConfig, "lanes">,
  ids: string[],
): Promise<{ slots: Record<string, number | null>; setups: Record<string, MachineSetup> }> {
  const picked = raceConfig.lanes
    .map((lane, i) => ({ laneId: `lane-${i}`, lane }))
    .filter(({ laneId }) => ids.includes(laneId));
  const found = await Promise.all(picked.map(({ lane, laneId }) => probeDetails(lane, laneId)));
  const slots: Record<string, number | null> = {};
  const setups: Record<string, MachineSetup> = {};
  found.forEach((d) => {
    slots[d.laneId] = d.slots;
    setups[d.laneId] = setupOf(d);
  });
  return { slots, setups };
}

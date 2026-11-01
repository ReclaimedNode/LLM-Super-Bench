import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const js = await Bun.file(join(root, "public", "app.js")).text();
const html = await Bun.file(join(root, "public", "index.html")).text();

describe("head to head races two of the saved machines, solo races one", () => {
  test("head to head picks two and solo one, never every saved machine", () => {
    expect(js).toMatch(/function pickCount\(m = mode\) \{\n\s+return m === "head" \? 2 : 1;/);
    expect(js).toMatch(/\.slice\(0, pickCount\(\)\)/);
    expect(js).not.toContain("selectedMachine");
    expect(js).toMatch(/function selectedLaneIds\(\) \{\n\s+return \[\.\.\.picked\];/);
  });

  test("races and sweeps send only the picked machines", () => {
    const sends = [...js.matchAll(/lanes: (selectedLaneIds\(\)|configLanes\.map)/g)].map((m) => m[1]);
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends.every((s) => s === "selectedLaneIds()")).toBe(true);
  });

  test("the machine buttons sit under MACHINES and appear only when there are more machines than the mode races", () => {
    const control = html.slice(html.indexOf('id="machines-name"'), html.indexOf("</div>\n\n", html.indexOf('id="machines-name"')));
    expect(control).toContain('id="machine-picks"');
    expect(js).toContain("el.machinePicks.hidden = configLanes.length <= need");
  });

  test("saving from the editor keeps machines past the rows it shows", () => {
    expect(js).toContain("for (const l of savedLanes.slice(editorSlots.length))");
  });

  test("the pick is remembered by machine name, and storage failing is harmless", () => {
    expect(js).toContain('const PICK_KEY = "llm-super-bench.picked"');
    const remembered = js.slice(js.indexOf("function rememberedPicks"), js.indexOf("function settlePicks"));
    expect(remembered.match(/try \{/g)?.length).toBe(2);
  });
});

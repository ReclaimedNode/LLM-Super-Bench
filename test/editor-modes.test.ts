import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const js = await Bun.file(join(import.meta.dir, "..", "public", "app.js")).text();

describe("the machine rows follow HEAD TO HEAD or SOLO", () => {
  test("the picker has exactly two choices, not one per machine", () => {
    expect(js).toContain('label: "HEAD TO HEAD"');
    expect(js).toContain('label: "SOLO"');
    expect(js).not.toContain("for (const lane of lanes) {\n    options.push");
  });

  test("head to head shows two rows and solo shows one", () => {
    expect(js).toMatch(/const count = mode === "head" \? 2 : 1/);
  });

  test("two loads that start together cannot both draw rows", () => {
    expect(js).toContain("++editorLoadToken");
    expect(js).toContain("token !== editorLoadToken");
  });
});

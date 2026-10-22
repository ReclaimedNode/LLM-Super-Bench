import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "public");
const html = await Bun.file(join(dir, "index.html")).text();
const js = await Bun.file(join(dir, "app.js")).text();

describe("the page has the controls, and every id they use exists", () => {
  test("reply length and thinking are in the header", () => {
    for (const id of ["reply-length", "reply-note", "thinking-switch", "thinking-note"]) {
      expect(html).toContain(`id="${id}"`);
      expect(js).toContain(`getElementById("${id}")`);
    }
  });

  test("a machine that only thought gets told, with the way out", () => {
    expect(js).toContain("view.sawThinking && !view.sawReply");
    expect(js).toContain("Set THINKING to OFF");
  });

  test("the streams-at-once box is sent as a number or null", () => {
    expect(js).toContain("slots: slotsOf(r)");
    expect(js).toMatch(/text === "" \? null : Number\(text\)/);
  });
});

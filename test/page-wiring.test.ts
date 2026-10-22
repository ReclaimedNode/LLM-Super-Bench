import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const html = readFileSync(resolve(PROJECT_ROOT, "public/index.html"), "utf8");
const script = readFileSync(resolve(PROJECT_ROOT, "public/app.js"), "utf8");
const css = readFileSync(resolve(PROJECT_ROOT, "public/style.css"), "utf8");

function classesIn(markup: string): Set<string> {
  const out = new Set<string>();
  for (const m of markup.matchAll(/class="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/)) if (c) out.add(c);
  return out;
}

describe("the race page and its script agree", () => {
  test("every id the script looks up is in the page", () => {
    const wanted = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(wanted.length).toBeGreaterThan(5);
    for (const id of wanted) expect(html).toContain(`id="${id}"`);
  });

  test("every lane element the script looks up is in the lane template", () => {
    const template = html.slice(html.indexOf('<template id="lane-template">'), html.indexOf("</template>"));
    const have = classesIn(template);
    const wanted = [...script.matchAll(/\bq\("\.([a-z-]+)"\)/g)].map((m) => m[1]!);
    expect(wanted).toContain("throughput");
    expect(wanted).toContain("stream-note");
    for (const cls of wanted) expect(have.has(cls)).toBe(true);
  });

  test("the three choice rows are there, each labelled", () => {
    for (const id of ["machines", "presets", "streams"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`aria-labelledby="${id}-name"`);
      expect(html).toContain(`id="${id}-name"`);
    }
  });

  test("a hidden lane really disappears, which a bare `hidden` does not do against display:flex", () => {
    expect(css).toMatch(/\.lane\[hidden\]\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.stat\[hidden\]\s*\{\s*display:\s*none/);
  });

  test("the stream choices are redrawn from what the machines say they can run", () => {
    expect(html).toContain('id="streams-note"');
    expect(script).toContain("/api/capacity?lanes=");
    expect(script).toContain("refreshCapacity()");
    expect(css).toMatch(/\.control-note:empty\s*\{\s*display:\s*none/);
  });

  test("the machine editor is wired to its endpoints", () => {
    for (const id of ["editor-panel", "editor-rows", "editor-add", "editor-save", "editor-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const path of ["/api/lanes-config", "/api/lanes/check", "/api/lanes/save"]) {
      expect(script).toContain(path);
    }
  });
});

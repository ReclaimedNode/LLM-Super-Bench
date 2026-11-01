import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const read = (p: string) => readFileSync(resolve(PROJECT_ROOT, p), "utf8");

describe("the compare-run-files tab", () => {
  test("the race page always links to an empty results tab", () => {
    const html = read("public/index.html");
    const link = html.match(/<a[^>]*id="compare-files"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/results.html?compare"');
    expect(link).toContain('target="_blank"');
    // In the header, as its own RESULTS control beside MACHINES.
    const header = html.slice(html.indexOf('<header class="bar">'), html.indexOf("</header>"));
    expect(header).toContain('id="compare-files"');
    // Not inside the results bar, which stays hidden until a run finishes.
    const bar = html.slice(html.indexOf('id="resultsbar"'), html.indexOf("</div>", html.indexOf('id="resultsbar"')));
    expect(bar).not.toContain("compare-files");
  });

  test("compare mode never adds this server's latest run, and that run can be removed otherwise", () => {
    const js = read("public/results.js");
    expect(js).toContain('new URLSearchParams(location.search).has("compare")');
    expect(js).toMatch(/if \(!compareMode\) sources\.push\(\{ name: "This server", file: result\.file, removable: true \}\)/);
  });

  test("every id the results script looks up is in the results page", () => {
    const html = read("public/results.html");
    const js = read("public/results.js");
    for (const m of js.matchAll(/\$\("([^"]+)"\)/g)) expect(html).toContain(`id="${m[1]}"`);
  });
});

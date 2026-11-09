import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PROJECT_ROOT, configPathFrom } from "../src/config.ts";

describe("RACE_CONFIG", () => {
  test("defaults to race.config.json in the project folder", () => {
    expect(configPathFrom({})).toBe(resolve(PROJECT_ROOT, "race.config.json"));
    expect(configPathFrom({ RACE_CONFIG: "   " })).toBe(resolve(PROJECT_ROOT, "race.config.json"));
  });

  test("a relative name is read from the project folder", () => {
    expect(configPathFrom({ RACE_CONFIG: "race.config.dsv41.json" })).toBe(resolve(PROJECT_ROOT, "race.config.dsv41.json"));
  });

  test("an absolute path is used as given", () => {
    expect(configPathFrom({ RACE_CONFIG: "/tmp/other.json" })).toBe("/tmp/other.json");
  });
});

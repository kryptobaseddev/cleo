/**
 * `caamp pi` verbs are deprecated (T13996, ADR-098): each one warns on
 * stderr before it runs and otherwise behaves as before.
 *
 * @task T13996
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_VERBS_DEPRECATION_NOTICE,
  registerPiCommands,
} from "../../../../src/commands/pi/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("caamp pi deprecation (T13996)", () => {
  it("warns naming ADR-098 before a pi verb runs, and still runs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerPiCommands(program);
    const pi = program.commands.find((c) => c.name() === "pi");
    if (!pi) throw new Error("pi group is not registered");
    const ran = vi.fn();
    pi.command("noop").action(ran);
    await program.parseAsync(["node", "caamp", "pi", "noop"]);
    expect(warn).toHaveBeenCalledWith(PI_VERBS_DEPRECATION_NOTICE);
    expect(PI_VERBS_DEPRECATION_NOTICE).toContain("ADR-098");
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

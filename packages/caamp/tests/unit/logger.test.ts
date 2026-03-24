import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debug, error, info, isQuiet, isVerbose, setQuiet, setVerbose, warn } from "../../src/core/logger.js";

describe("logger", () => {
  beforeEach(() => {
    setVerbose(false);
    setQuiet(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggles verbose mode", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
  });

  it("toggles quiet mode", () => {
    expect(isQuiet()).toBe(false);
    setQuiet(true);
    expect(isQuiet()).toBe(true);
  });

  it("emits debug only in verbose mode", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug("hidden");
    expect(spy).not.toHaveBeenCalled();

    setVerbose(true);
    debug("shown");
    expect(spy).toHaveBeenCalledWith("[debug]", "shown");
  });

  it("suppresses info and warn in quiet mode", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    info("visible");
    warn("visible");
    expect(logSpy).toHaveBeenCalledWith("visible");
    expect(warnSpy).toHaveBeenCalledWith("visible");

    logSpy.mockClear();
    warnSpy.mockClear();

    setQuiet(true);
    info("hidden");
    warn("hidden");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("always emits error output", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setQuiet(true);
    error("always");
    expect(spy).toHaveBeenCalledWith("always");
  });
});

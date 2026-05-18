import { describe, expect, it } from "vitest";
import { hello } from "./index.js";

describe("hello", () => {
  it("returns 'hello'", () => {
    expect(hello()).toBe("hello");
  });
});

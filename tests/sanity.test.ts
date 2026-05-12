import { describe, expect, it } from "vitest";

describe("toolchain sanity", () => {
  it("vitest runs and arithmetic still works", () => {
    expect(1 + 1).toBe(2);
  });
});

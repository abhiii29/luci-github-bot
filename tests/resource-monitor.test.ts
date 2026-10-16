import { describe, it, expect } from "vitest";
import { parseVmStatPressure } from "../src/resource-monitor.js";

const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    68120.
Pages active:                                 439637.
Pages inactive:                               435909.
Pages wired down:                             199275.
Pages occupied by compressor:                  50000.`;

describe("parseVmStatPressure", () => {
  it("reads Apple Silicon vm_stat (16 KB pages) — was always 0% before", () => {
    const total = 32 * 1024 ** 3;
    const expected = (((439637 + 199275 + 50000) * 16384) / total) * 100;
    expect(parseVmStatPressure(sample, total)).toBeCloseTo(expected, 5);
    expect(parseVmStatPressure(sample, total)).toBeGreaterThan(30);
  });
  it("uses the page size from the header", () => {
    const intel = sample.replace("16384", "4096");
    expect(parseVmStatPressure(intel, 32 * 1024 ** 3)).toBeCloseTo(parseVmStatPressure(sample, 32 * 1024 ** 3) / 4, 5);
  });
});

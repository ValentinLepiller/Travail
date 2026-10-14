import { requiredUsages } from "./promotion.ts";

/** Stable commands copied with each candidate; live phone/account probes remain explicit promotion gates. */
export function defaultChecks(node: string) {
  return Object.fromEntries(
    requiredUsages.map((usage) => [
      usage,
      [{ program: node, args: ["scripts/harness-runtime-check.ts", usage] }],
    ]),
  );
}

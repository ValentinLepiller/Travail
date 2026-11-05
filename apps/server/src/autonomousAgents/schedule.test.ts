import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { AutonomousAgentConfig } from "@t3tools/contracts";
import { nextAgentRunAt } from "./schedule.ts";

const decodeConfig = Schema.decodeUnknownSync(AutonomousAgentConfig);
const config = decodeConfig({
  id: "review",
  name: "Review",
  mission: "Review exclusions",
  projectId: null,
  modelSelection: { instanceId: "codex", model: "gpt-test" },
  intervalSeconds: 86400,
  trigger: "interval",
  x: 0,
  y: 0,
  dailySchedule: { timeOfDay: "09:00", timeZone: "Europe/Paris" },
});
it.each([
  ["2026-03-28T09:00:00Z", "2026-03-29T07:00:00.000Z"],
  ["2026-10-24T09:00:00Z", "2026-10-25T08:00:00.000Z"],
  ["2026-11-02T08:00:00Z", "2026-11-03T08:00:00.000Z"],
])("keeps daily local time across DST from %s", (from, expected) => {
  expect(
    DateTime.formatIso(
      DateTime.makeUnsafe(
        nextAgentRunAt(config, DateTime.toEpochMillis(DateTime.makeUnsafe(from))),
      ),
    ),
  ).toBe(expected);
});
it("keeps interval schedules and makes task-triggered work immediately eligible", () => {
  const { dailySchedule: _dailySchedule, ...intervalConfig } = config;
  expect(nextAgentRunAt(intervalConfig, 1000)).toBe(86401000);
  expect(nextAgentRunAt({ ...config, trigger: "todo" }, 1000)).toBe(1000);
  expect(nextAgentRunAt({ ...config, trigger: "unqualified" }, 1000)).toBe(1000);
});
it("rejects invalid daily configuration", () => {
  for (const dailySchedule of [
    { timeOfDay: "25:00", timeZone: "Europe/Paris" },
    { timeOfDay: "09:00", timeZone: "invalid" },
  ]) {
    expect(() => decodeConfig({ ...config, dailySchedule })).toThrow();
  }
});

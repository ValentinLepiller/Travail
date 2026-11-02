import type { AutonomousAgentConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";

export function nextAgentRunAt(agent: AutonomousAgentConfig, now: number): number {
  if (!agent.dailySchedule || agent.trigger !== "interval")
    return now + agent.intervalSeconds * 1000;
  return DateTime.toEpochMillis(
    nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: agent.dailySchedule.timeOfDay },
      DateTime.makeZonedUnsafe(now, { timeZone: agent.dailySchedule.timeZone }),
    )!,
  );
}

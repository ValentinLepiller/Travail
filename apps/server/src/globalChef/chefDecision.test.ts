import { expect, it } from "vite-plus/test";
import type { ChefMemory } from "@t3tools/contracts";
import { authorizedRule, type ChefPlan, type ScopeContext } from "./chefDecision.ts";

const target: ScopeContext = {
  context: null,
  projectId: "cotily",
  chantierId: "notifications",
  senders: ["gmail:apple@example.com"],
};
const rule = (id: string, extra: Partial<ChefMemory> = {}): ChefMemory => ({
  id,
  version: 1,
  enabled: true,
  kind: "rule",
  text: "Phrase validée",
  scope: { kind: "global", id: null },
  topic: "Newsletters",
  action: "ignore",
  sourceRequestId: "approval",
  createdAt: "",
  updatedAt: "",
  ...extra,
});
const plan = (extra: Partial<ChefPlan> = {}): ChefPlan => ({
  kind: "ignore",
  title: "Annonce Apple",
  description: "",
  taskId: null,
  threadId: null,
  reason: "Règle applicable",
  uncertain: false,
  memory: null,
  ruleId: "global",
  matchingRuleIds: ["global"],
  ...extra,
});

it("a project exception overrides a global rule even with a different topic", () => {
  const rules = [
    rule("global"),
    rule("apple-cotily", {
      scope: { kind: "project", id: "cotily" },
      topic: "Annonces Apple",
      action: "handoff",
    }),
  ];
  const matchingRuleIds = rules.map((r) => r.id);
  expect(authorizedRule(plan({ matchingRuleIds }), rules, target)).toBeNull();
  expect(
    authorizedRule(
      plan({ kind: "handoff", ruleId: "apple-cotily", matchingRuleIds }),
      rules,
      target,
    )?.id,
  ).toBe("apple-cotily");
});
it("a chantier exception takes precedence inside its project only", () => {
  const rules = [
    rule("project", { scope: { kind: "project", id: "cotily" } }),
    rule("chantier", { scope: { kind: "chantier", id: "notifications" }, action: "complete" }),
  ];
  expect(
    authorizedRule(
      plan({ ruleId: "project", matchingRuleIds: ["project", "chantier"] }),
      rules,
      target,
    ),
  ).toBeNull();
  expect(
    authorizedRule(
      plan({ kind: "complete", ruleId: "chantier", matchingRuleIds: ["project", "chantier"] }),
      rules,
      target,
    )?.id,
  ).toBe("chantier");
  expect(
    authorizedRule(
      plan({ kind: "complete", ruleId: "chantier", matchingRuleIds: ["chantier"] }),
      rules,
      { ...target, chantierId: "other" },
    ),
  ).toBeNull();
});
it("incomparable conflicting scopes require a decision instead of an arbitrary priority", () => {
  const rules = [
    rule("project", { scope: { kind: "project", id: "cotily" } }),
    rule("sender", { scope: { kind: "sender", id: "gmail:apple@example.com" }, action: "create" }),
  ];
  expect(
    authorizedRule(
      plan({ ruleId: "project", matchingRuleIds: ["project", "sender"] }),
      rules,
      target,
    ),
  ).toBeNull();
});
it("facts, uncertain decisions, disabled or unknown rules never authorize an action", () => {
  expect(
    authorizedRule(plan(), [rule("global", { kind: "fact", action: null })], target),
  ).toBeNull();
  expect(authorizedRule(plan(), [rule("global", { enabled: false })], target)).toBeNull();
  expect(authorizedRule(plan({ uncertain: true }), [rule("global")], target)).toBeNull();
  expect(
    authorizedRule(plan({ matchingRuleIds: ["unknown"] }), [rule("global")], target),
  ).toBeNull();
});

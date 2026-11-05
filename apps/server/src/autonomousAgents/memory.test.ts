import { expect, it } from "vite-plus/test";
import { appendLearning, splitQualificationMemory, preservePersonality } from "./memory.ts";
it("keeps the configured personality when learned memory omits or rewrites it", () => {
  const previous = "## Personnalité\nDirect, patient et curieux.\n\n## Connaissances\nAvant";
  expect(preservePersonality(previous, "## Connaissances\nAprès")).toBe(
    "## Personnalité\nDirect, patient et curieux.\n\n## Connaissances\nAprès",
  );
  expect(
    preservePersonality(previous, "## Personnalité\nAutre ton\n\n## Connaissances\nAprès"),
  ).toBe("## Personnalité\nDirect, patient et curieux.\n\n## Connaissances\nAprès");
});
it("keeps a final personality section and leaves memories without personality editable", () => {
  expect(preservePersonality("## Connaissances\nAvant\n\n## Personnalité\nDiscret.", "Après")).toBe(
    "## Personnalité\nDiscret.\n\nAprès",
  );
  expect(preservePersonality("Avant", "Après")).toBe("Après");
});

it("separates shared additions from private run state and accepts legacy snapshots safely", () => {
  expect(
    splitQualificationMemory(
      "## Apprentissages communs\nRègle approuvée\n\n## État du passage\nAttente",
    ),
  ).toEqual({ learning: "Règle approuvée", state: "## État du passage\nAttente" });
  expect(splitQualificationMemory("Ancienne mémoire complète")).toEqual({
    learning: "",
    state: "Ancienne mémoire complète",
  });
});
it("preserves prior decisions and deduplicates retried additions", () => {
  const base = "# Mémoire\n\nDécision A\n";
  const updated = appendLearning(base, "Décision B\n\nDécision A\n\nDécision B");
  expect(updated).toBe("# Mémoire\n\nDécision A\n\nDécision B\n");
  expect(appendLearning(updated, "Décision B")).toBe(updated);
  expect(appendLearning(updated, "")).toBe(updated);
});

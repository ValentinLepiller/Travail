import { expect, it } from "vite-plus/test";
import { preservePersonality } from "./memory.ts";
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

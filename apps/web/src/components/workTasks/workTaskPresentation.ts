import type { WorkTask } from "@t3tools/contracts";

export const STATUS_LABELS = {
  unqualified: "À qualifier",
  todo: "À préparer",
  ready: "À démarrer",
  doing: "En cours",
  review: "À valider",
  done: "Terminée",
  rejected: "Refusée",
  merged: "Fusionnée",
} satisfies Record<WorkTask["status"], string>;
export const STATUS_PRESENTATION = {
  done: { rank: 0, color: "#34b583" },
  review: { rank: 1, color: "#b696e8" },
  doing: { rank: 2, color: "#64a6e8" },
  ready: { rank: 3, color: "#91bc63" },
  todo: { rank: 4, color: "#d4ac63" },
  unqualified: { rank: 5, color: "#94a3b8" },
  merged: { rank: 6, color: "#69b8ba" },
  rejected: { rank: 7, color: "#dd929e" },
} satisfies Record<WorkTask["status"], { rank: number; color: string }>;

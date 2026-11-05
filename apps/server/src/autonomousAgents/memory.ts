const personalitySection = /^## Personnalité[^\S\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/mu;

/** Personality is user-owned; learned facts must not overwrite it. */
export function preservePersonality(previous: string, updated: string): string {
  const section = previous.match(personalitySection)?.[0].trimEnd();
  if (!section) return updated;
  return personalitySection.test(updated)
    ? updated.replace(personalitySection, () => `${section}\n\n`)
    : `${section}\n\n${updated}`;
}

/** Finish accepts only new shared facts; a legacy full snapshot remains private. */
export function splitQualificationMemory(text: string) {
  const match = /^## Apprentissages communs\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(text);
  return {
    learning: match?.[1]?.trim() ?? "",
    state: match ? text.replace(match[0], "").trim() : text,
  };
}

/** Append-only facts preserve concurrent additions and make identical retries harmless. */
export function appendLearning(current: string, learning: string): string {
  const known = new Set(current.split(/\n\s*\n/u).map((part) => part.trim()));
  const additions = learning
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || known.has(part)) return false;
      known.add(part);
      return true;
    });
  return additions.length ? `${current.trimEnd()}\n\n${additions.join("\n\n")}\n` : current;
}

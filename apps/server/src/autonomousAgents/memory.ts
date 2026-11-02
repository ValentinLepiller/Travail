const personalitySection = /^## Personnalité[^\S\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/mu;

/** Personality is user-owned; learned facts must not overwrite it. */
export function preservePersonality(previous: string, updated: string): string {
  const section = previous.match(personalitySection)?.[0].trimEnd();
  if (!section) return updated;
  return personalitySection.test(updated)
    ? updated.replace(personalitySection, () => `${section}\n\n`)
    : `${section}\n\n${updated}`;
}

import { join } from 'node:path';

export interface FeatureEntry {
  name: string;
  description: string;
  passes: boolean;
}

export interface SessionPromptContext {
  basePrompt: string;
  issueKey: string;
}

export function buildInitializerPrompt(ctx: SessionPromptContext): string {
  return ctx.basePrompt + `

---

## Session Mode: Initializer

This is your FIRST session on this task. You have never seen this codebase before.

Follow these steps in order:

1. **Read the design document** above carefully. Understand every requirement.
2. **Explore the codebase** — read the project structure, key files, and existing patterns.
3. **Create \`.agent-state/features.json\`** with this exact structure:
   \`\`\`json
   [
     { "name": "short-kebab-name", "description": "What to implement", "passes": false },
     ...
   ]
   \`\`\`
   Extract each distinct requirement from the design document as a separate feature entry.
4. **Start implementing** — pick the first feature(s) and write the code.
5. **Run tests** to verify your changes work and don't break existing functionality.
6. **Commit your work** with conventional commit messages referencing the issue key.
7. **Update \`.agent-state/features.json\`** — set \`passes: true\` for any completed features.
8. **Write \`.agent-state/progress.md\`** before finishing, summarizing:
   - What you accomplished
   - What's left to do
   - Any decisions made or blockers encountered

Do as much as you can in this session. The next session will pick up where you left off.`;
}

export function buildCodingPrompt(ctx: SessionPromptContext): string {
  return ctx.basePrompt + `

---

## Session Mode: Coding (Continuation)

This is a CONTINUATION session. Previous session(s) already worked on this task.
You have NO memory of previous sessions — all context is in the files below.

Follow these steps in order:

1. **Read \`.agent-state/features.json\`** to see which features are done (\`passes: true\`) and which remain.
2. **Read \`.agent-state/progress.md\`** for context from the last session.
3. **Run \`git log --oneline -20\`** to see what was committed recently.
4. **Pick the next incomplete feature** (\`passes: false\`) and implement it.
5. **Run tests** to verify your changes work and don't break existing functionality.
6. **Commit your work** with conventional commit messages referencing the issue key.
7. **Update \`.agent-state/features.json\`** — set \`passes: true\` for completed features.
8. **Update \`.agent-state/progress.md\`** with:
   - What you accomplished this session
   - What's left to do
   - Any decisions made or blockers encountered

Do as much as you can in this session. If features remain, another session will continue after you.`;
}

export async function readFeatureList(worktreePath: string): Promise<FeatureEntry[] | null> {
  const filePath = join(worktreePath, '.agent-state', 'features.json');
  try {
    const text = await Bun.file(filePath).text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed)) return null;

    for (const entry of parsed) {
      if (
        typeof entry.name !== 'string' ||
        typeof entry.description !== 'string' ||
        typeof entry.passes !== 'boolean'
      ) {
        return null;
      }
    }

    return parsed as FeatureEntry[];
  } catch {
    return null;
  }
}

export function isAllFeaturesDone(features: FeatureEntry[] | null): boolean {
  if (!features || features.length === 0) return false;
  return features.every((f) => f.passes === true);
}

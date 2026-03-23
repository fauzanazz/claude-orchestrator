# Memory System — obsidian-memory

This project uses **obsidian-memory** for persistent, cross-agent memory stored in an Obsidian vault.
All session context, decisions, conventions, and progress are stored in the vault and accessible
to any AI coding agent that reads this file.

**Vault:** `DevMemory`
**Project:** `claude-orchestrator`

---

## Session Start Protocol

At the beginning of every session, run:

```bash
obsidian-memory load-context
```

This outputs the project context, recent decisions, conventions, and the last few session summaries.
Read the output carefully before starting work — it contains decisions and context from prior sessions.

---

## During Work

### Saving Decisions

When you make a significant architectural or design decision, note it. You will save it at session end.

### Searching Memory

If you need to recall past context, decisions, or work:

```bash
obsidian-memory search "your query here"
```

This searches the entire memory vault. Use it when:
- You need to recall why a decision was made
- You want to check if something was already attempted
- You need context from a previous session by a different agent

---

## Session End Protocol

Before ending a session (or when context is about to be compacted), save a session summary:

```bash
obsidian-memory save-session \
  --agent <your-agent-name> \
  --summary "Brief description of what was accomplished" \
  --decisions "Decision 1" "Decision 2" \
  --files "file1.ts" "file2.ts" \
  --blockers "Any open questions" \
  --next "Next step 1" "Next step 2"
```

**Agent names:** `claude-code`, `cursor`, `antigravity`, `opencode`, `forgecode`

The summary should be concise but complete enough for a different agent to continue the work.

---

## Cross-Agent Handoff

When you save a session, the note is stored in the vault with wikilinks to the project context
and decision log. The next agent (regardless of which tool it is) will see your session summary
when it runs `obsidian-memory load-context`.

**To ensure smooth handoffs:**
1. Always save a session summary before ending
2. Include any blockers or open questions
3. List concrete next steps
4. Mention files that were modified

---

## Memory Consolidation

If the vault has many old session notes, suggest running:

```bash
obsidian-memory consolidate --auto
```

This merges sessions older than 30 days into monthly journal entries, keeping the vault lean.

---

## Documentation Protocol

This project maintains structured documentation in the memory vault to prevent feature duplication
and enable surgical debugging. Generate docs with `obsidian-memory document`, then maintain them
during sessions.

### Before Creating New Code

Search the documentation before implementing anything new:

```bash
obsidian-memory search "feature name or concept"
```

If the feature already exists, work with the existing implementation instead of creating a duplicate.
The Features doc lists what's been built; the Modules doc maps directories to their purpose.

### Before Debugging

Read the module documentation to know exactly where to look:

```bash
obsidian-memory search "module or area related to the bug"
```

The Modules doc maps directories to their purpose and entry points — use it to go straight
to the right file instead of exploring blindly.

### After Implementing

Update the relevant documentation:
- Add new features to the Features inventory
- Update module descriptions if you changed a module's purpose
- Add patterns or gotchas to Conventions
- Update Architecture if you changed the system structure

---

## Troubleshooting

### "Obsidian is not running"
The memory system requires the Obsidian desktop app to be running. Ask the user to start Obsidian.

### "No .obsidian-memory.json found"
Run `obsidian-memory init` to set up the project.

### "vault not found"
The vault `DevMemory` may not exist in Obsidian. Ask the user to open it in Obsidian.

---

## Command Reference

| Command | Description |
|---------|-------------|
| `obsidian-memory status` | Check system health |
| `obsidian-memory load-context` | Load project context |
| `obsidian-memory save-session` | Save a session summary |
| `obsidian-memory search <query>` | Search memory vault |
| `obsidian-memory consolidate` | Merge old sessions |
| `obsidian-memory document` | Scan project and generate docs |
| `obsidian-memory init` | Set up a new project |

# AGENTS.md

- Test with `bun test` (bun:test, real temp dirs; see tests/). No tsconfig: typecheck by running `bun run build` and delete the `index.js` artifact it leaves in the repo root (it is not committed).
- This directory is a live-installed extension: editing files here changes the user's running pi. Live-check features with `pi -p --session-dir <tmp> --session-id <id> --model <provider/model>` and read usage from the session JSONL (`.message.usage`).
- pi API facts learned the hard way (pi 0.84.x): at `before_agent_start`, `event.systemPrompt` is the base prompt without the skills section (pi appends it after handlers run), while `event.systemPromptOptions.skills` is the authoritative loaded set. `systemPromptOptions.selectedTools` does not reflect the prompt-build toolset (an exec_command-based toolset lists no "read" yet still renders skills) — do not gate on it. Extension `skillPaths` bypass `--no-skills`; honor the flag yourself.
- The pi-docs block template lives in pi's `dist/core/system-prompt.js`; when the strip stops matching after a pi update, update the anchors in `pi-docs.ts` and the `REAL_BLOCK` fixture in `tests/pi-docs.test.ts`.

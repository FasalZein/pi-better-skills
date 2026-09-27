# pi-better-skills

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

`pi-better-skills` makes Pi skills resolve their bundled files from the skill directory, not from whatever project you are working in.

Pi implements the [Agent Skills standard](https://agentskills.io): small capability packages with a `SKILL.md`, helper scripts, reference files, templates, and assets. Many skills assume relative paths start at the skill folder. Pi runs tools from your current workspace, so a skill can say:

```bash
scripts/search.sh "query"
```

and the agent may try `./scripts/search.sh` in your project instead of the skill's own `scripts/search.sh`.

This extension gives the model the missing path context.

## Install

```bash
pi install git:github.com/edxeth/pi-better-skills
```

`pi-better-skills` needs a POSIX environment (macOS, Linux). Windows paths are not supported.

New sessions load it automatically. Existing sessions need:

```text
/reload
```

## What it solves

### Skills can bundle real tools

Good skills are more than prompt text. They often include scripts, examples, templates, reference markdown, or small CLIs. `pi-better-skills` helps the agent find those bundled resources from any project directory.

That means a skill can safely say:

```bash
scripts/exa.sh search "agent skills" 5
```

or:

```md
Read reference/troubleshooting.md before continuing.
```

If the relative path does not exist in the workspace, the native `read` and `bash` tools fall back to the skill resource. Existing workspace files and directories take precedence, even when a skill contains the same path. Use `$PI_SKILL_DIR/path` or an absolute skill path to select the bundled resource explicitly.

Path checks use Pi's workspace directory. They do not interpret directory changes inside shell commands. Custom tools keep their own path semantics.

### Less path babysitting

Without this extension, users and skill authors have to over-explain paths:

- “First cd into the skill directory.”
- “Use the absolute path to this script.”
- “Do not run this from the project root.”
- “If it fails, retry with `/home/.../skills/...`.”

`pi-better-skills` injects a small `<skill_context>` block when a `SKILL.md` is loaded, so the model sees where the skill lives and which paths belong to the skill versus the workspace.

The path and command guidance travels in two places:

- **System prompt.** A short `<agent_skills>` section sits in the system prompt of every request. It stays exactly the same for the whole conversation, so nothing appears and disappears between replies. It is added as each request is sent and never written into your session files. When another extension forces a whole system prompt for a turn (a `before_agent_start` return, applied after the request transforms), the section is re-asserted on the final payload — but only when the forced text was built from Pi's own prompt (it contains Pi's `<skills>` section); prompts owned entirely by another extension are left untouched.
- **Skill bodies.** Each delivered skill body carries a small `<skill_context>` block naming the skill's folder and your project folder, so the rules point at the right places.

The extension does not modify the original `SKILL.md` file. If compaction removes the skill text, loading it again restores the directory context too.

### Better compatibility with Agent Skills

Pi implements the Agent Skills standard, where `SKILL.md` can refer to bundled scripts, references, templates, and assets.

Pi core keeps skills simple and asks the model to resolve relative paths itself. `pi-better-skills` adds the path ergonomics skill authors expect:

- skill-local directory awareness
- safer skill-resource path resolution
- `PI_SKILL_DIR` and `PI_WORKSPACE`
- dynamic `SKILL.md` shell placeholders for trusted skills

### Skills load whole the first time

Models often load a `SKILL.md` with a line range, for example `offset=1, limit=200`, and sometimes never read the rest. Rules at the end of the file then never reach the model.

The first time a `SKILL.md` loads in a session, the model gets the whole file:

- A `read` of the file loses its `offset`/`limit`, and its result is the complete file, even past pi's 2000-line/50KB read cap.
- Any other tool whose output shows part of the file gets the skill's complete body appended as an extra block. This works whatever the tool is called and however it names the file: `head` or `sed` in bash, a notebook or code-mode cell, an MCP wrapper, or a tool that keeps only the end of long output. "Part of the file" means at least three consecutive non-blank lines of it (at least 40 characters), in any position. Line-number prefixes (`cat -n`) and text inside escaped strings (JSON, nested JSON, single-quoted) are recognized. A single `grep` hit is not a load.
- The appended block holds the body, not the frontmatter, like the skill tools of other agents. It uses the same `<skill name="…" location="…">` tag as pi's own skill blocks, so the file is named even when the tool call did not name it. A one-line note says the frontmatter is omitted, gives the file line where the body starts, and says to read the file only for its exact contents, for example to edit the skill. That read is a later load, so it returns the exact lines.

Every later load of the same file comes back exactly as the tool returned it: no `<skill_context>`, no dynamic shell output, no model or thinking switch, and no referenced skills. The agent sees the file's real lines, so it can page through or edit a skill safely. The one exception is the active skill used for resolving relative paths, which a later load still updates. Compaction starts a new session for this purpose. Tree navigation and resumed sessions count only loads on the active branch since its latest compaction. A failed or blocked read does not count.

To keep pi's native partial reads:

```bash
PI_BETTER_SKILLS_PARTIAL_SKILL_READS=1 pi
```

## Optional: trim pi's built-in docs prompt (`pi-docs`)

Pi core injects a "Pi documentation" block (~280 tokens) into every system prompt, pointing the model at the installed package's README, `docs/`, and `examples/`. `pi-better-skills` can convert that block into a generated skill so its content loads on demand instead:

- The block is removed from every request sent to the model, including replies started by background helpers or by tool results. A `pi-docs` skill is registered whose body is inherited verbatim from the live block, matching the installed Pi's wording and paths.
- Removal happens in two stages. The request stage (`context_with_system`) trims pi's own head. The payload stage (`before_provider_request`) re-enforces the strip after a forced prompt — another extension's `before_agent_start` return, which Pi applies after the request transforms — rebuilds the head from the base prompt. Exact-text removal in both stages keeps the surviving prompt byte-stable across turns for provider caching, and forced prompts that do not contain Pi's exact block ship byte-exact.
- The payload stage recognizes the system-text carriers of the pi-ai 0.87.1 API families: openai-completions/Mistral `messages[0]` (role `system` or `developer`), openai-responses/Azure `input[0]`, Anthropic `system[]` text blocks (OAuth identity block included), Bedrock `system[]` text blocks, Codex `instructions`, and Google/Vertex `config.systemInstruction`. Unknown payload shapes are left untouched (fail open), and `PI_BETTER_SKILLS_DEBUG=1` prints a watchdog line when the block survives a recognized slot.
- The skill file lives at `<agent-dir>/cache/pi-better-skills/pi-docs/SKILL.md`, outside pi's native skill roots, and is rewritten only when pi's block changes.
- One gate: the strip happens only when the skill actually loaded at that path. If pi's prompt drifts past the structural anchors (header line and first bullet), the session falls back to completely stock behavior — no strip, no skill, nothing broken. Uninstalling the extension removes the feature and the file together.
- A user's own `pi-docs` skill wins name collisions; the extension stands down.

The feature is on by default. To opt out:

```bash
PI_BETTER_SKILLS_NO_PI_DOCS=1 pi   # or export it, or write it inline per command
```

`PI_BETTER_SKILLS_NO_PI_DOCS=1 pi ...` also works for one-off runs. Set `PI_BETTER_SKILLS_DEBUG=1` for maintainer diagnostics on stderr.

Pi's saved session files keep the original block; only what gets sent to the model is trimmed. Everything else in the prompt is left untouched.

## When to use it

Install this if you use skills that include any of the following:

- `scripts/` helpers
- `references/` markdown
- templates, assets, examples, fixtures, or config files
- composite skills that call sibling skills
- skills authored for the Agent Skills standard
- dynamic prompt content such as ``!`git branch --show-current` `` inside `SKILL.md`

You probably do not need it for skills that are only a short prompt with no bundled files.

## How to use it well

### As a user

Use skills normally:

```text
/skill:deep-research compare current browser automation libraries
```

or ask pi naturally:

```text
Research the latest approaches to browser-use agents.
```

When the agent loads a matching skill, `pi-better-skills` adds the missing path context automatically. You should not need to tell the model where the skill folder is.

You can mention multiple skills in one message:

```text
/skill:visual-explainer What's docs.lakebed.dev about? /skill:firecrawl
```

For multi-skill messages, `pi-better-skills` handles the skill expansion itself: each resolvable skill appears as its own `[skill] <name>` conversation row before the cleaned user prompt, and the model receives the skill content before the question. A leading `/skill:name` declaration is stripped from the sent prompt (like vanilla pi); skills mentioned later keep their bare name in the sentence. Ordinary single leading `/skill:name` commands retain Pi's single-skill message layout and receive the same saved guidance as file reads.

After installing or editing the extension in an existing pi session, reload pi:

```text
/reload
```

### As a skill author

Write skills as if `SKILL.md` is the home base for bundled resources.

Good:

````md
Run the helper:

```bash
scripts/search.sh "{{query}}"
```

If it fails, read reference/troubleshooting.md.
````

Also good when you want to be explicit:

```bash
$PI_SKILL_DIR/scripts/search.sh "query"
```

Use `$PI_WORKSPACE` when you mean the user's current working dir:

```bash
$PI_WORKSPACE/scripts/build.sh
```

Keep ordinary project commands ordinary:

```bash
git status
bun test
```

Those should still run in the user's workspace, not in the skill folder.

### For dynamic skill content

Trusted global skills can include shell placeholders that are evaluated when the agent reads `SKILL.md`:

```md
Current branch: !`git branch --show-current`
```

or:

````md
Changed files:
```!
git diff --name-only
```
````

Dynamic commands run from the current workspace and receive:

- `PI_SKILL_DIR` — the active skill directory
- `PI_WORKSPACE` — the current pi workspace

Skill commands such as `/skill:name`, automatic loading, and referenced skills do not execute these placeholders. They show a skipped notice instead. The system-level guidance tells the model not to run the placeholders or repeat their commands unless you ask.

Use this for lightweight context that genuinely helps the workflow. Do not use it for slow setup, long-running processes, or surprising side effects.

## Model and thinking overrides

Skills can request a model switch or thinking level change by adding frontmatter fields to `SKILL.md`:

```yaml
---
name: my-skill
description: Heavy analysis task.
model: anthropic/claude-sonnet-4-6
thinking: high
---
```

When the agent loads the skill, `pi-better-skills` switches to that model and thinking level. Both fields are optional. Omit one to leave it unchanged.

Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

The switch lasts for one user request. After the agent finishes responding, the original model and thinking level are restored. Sequential skill reads within one request stack correctly — restoring walks back through each override.

### What gets skipped

| Condition | Behavior |
|-----------|----------|
| Model doesn't exist in registry | Skipped, no crash |
| No auth configured for model | Skipped, no crash |
| Invalid thinking level | Skipped, no crash |
| Current context exceeds target model's window | Skipped, no crash |

Invalid values produce a UI notification when pi runs interactively. In print or RPC mode they fail silently.

### Model naming

Use `provider/model-id` format. Match the string you'd pass to `--model`:

```yaml
model: anthropic/claude-sonnet-4-6
model: openai/gpt-5.4-mini
model: google/gemini-3.1-pro-preview
```

### Context window safety

If the running session has more tokens than the target model's `contextWindow`, the model switch is skipped. You can't accidentally shrink the window and lose context.

## Auto-injecting skills with `globs`

Skills with a `globs` field in their frontmatter get injected when a tool call names a matching file, whatever the tool. You don't need to load the skill manually.

### Frontmatter format

```yaml
---
name: react-patterns
description: React component best practices
globs: ["**/*.tsx", "**/*.jsx"]
---
```

You can also use YAML list format:

```yaml
---
name: react-patterns
description: React component best practices
globs:
  - "**/*.tsx"
  - "**/*.jsx"
---
```

Or a single pattern:

```yaml
---
name: docker-tips
description: Dockerfile and compose conventions
globs: "Dockerfile*"
---
```

### Deduplication

A skill injects once while its body is in the conversation. If compaction or tree navigation removes it, it can inject again.

### Supported glob patterns

| Pattern | Matches | Example match |
|---------|---------|---------------|
| `*.tsx` | Files ending in `.tsx` in any directory | `src/Button.tsx` |
| `**/*.tsx` | `.tsx` files at any depth | `src/components/Button.tsx` |
| `src/**/*.ts` | `.ts` files under `src/` | `src/utils/parse.ts` |
| `Dockerfile` | Files named `Dockerfile` anywhere | `project/Dockerfile` |
| `*.{ts,tsx}` | `.ts` or `.tsx` files | `src/utils.ts`, `src/Button.tsx` |
| `**/*.css` | `.css` files at any depth | `src/styles.css` |
| `**/*.test.ts` | Test files at any depth | `src/Button.test.ts` |
| `docs/**` | Everything under `docs/` | `docs/api/overview.md` |
| `**/fixtures/**` | Everything under any `fixtures/` dir | `tests/fixtures/data.json` |

Dot files are matched. Bare patterns without a `/` match against the filename, so `*.tsx` works the same as `**/*.tsx`.

### What gets injected

The extension reads the skill's `SKILL.md`, adds a `<skill_context>` block naming the skill's directory and the workspace, and prepends the result. Dynamic shell placeholders (`!`backtick) are **not** executed for auto-injected skills — they are neutralized with a visible note. They only run when you read the skill directly.

Skills with `disable-model-invocation: true` are not auto-injected by `globs`. They remain available through explicit `/skill:name` commands, matching Pi's opt-out semantics for model-driven invocation.

### When globs don't match

The extension is a no-op. Skills without `globs` behave like before.

## Composing skills with inline references

A `SKILL.md` body can include backticked slash references to other skills. The extension recognizes two token forms:

- `` `/<skill-name>` `` — for example `` `/grilling` ``
- `` `/skill:<skill-name>` `` — for example `` `/skill:grilling` ``

```md
Run a `/grilling` session, using the `/skill:prototype` skill.
```

When that skill loads, `pi-better-skills` injects the body of each referenced skill alongside it. The extension never rewrites a body. Injection is purely additive: references stay exactly as the author wrote them.

The entire backticked content must be the token. Anything else — `` `git status` ``, `` `/usr/bin/env` ``, `` `./scripts/foo.sh` `` — is ordinary text and never matches.

### Where references expand

References expand wherever a skill body enters context:

| Load path | Behavior |
|----------|----------|
| `/skill:name` command | The extension attaches guidance to every resolvable skill. Skills with references get extra `[skill]` rows before your prompt; ordinary single-skill commands keep Pi's single-block layout. |
| Model reads a `SKILL.md` | Referenced skill bodies are appended to the read result. |
| `globs` auto-injection | Referenced skill bodies are appended to the injected block. |
| Multi-skill input (`/skill:a ... /skill:b`) | Referenced skills arrive as their own `[skill]` rows. |
| Any tool reading a `SKILL.md` | Detection is tool-agnostic: if a tool's input strings (for example the `cmd` of an `exec_command`) name a known `SKILL.md` path, the result gets the same enrichment as a core `read`. |

### Rules

- **Transitive, cycle-safe.** References of references expand too. One expansion never injects the same skill twice (diamonds collapse).
- **Referenced skills can set `disable-model-invocation: true`.** Unlike passive `globs` injection, a backticked reference is an explicit author choice, so those skills inject anyway.
- **No duplicates.** A referenced skill injects once while its body is in the context; compaction or tree navigation can make it eligible again.
- **Unresolvable references inject nothing.** `` `/typo` `` stays as written and no block is appended when the name does not match an installed skill.
- **Dynamic shell placeholders never run in referenced bodies.** The extension neutralizes them with a visible note. This keeps the promise that loaded content already contains command output.
- **No model/thinking overrides from referenced skills.** Frontmatter `model`/`thinking` only apply to the skill you explicitly load.

### Enabled state and session flags

Resolution asks one question: does the skill exist at a known location? A reference injects even when pi did not load the skill for the current session. These cases include:

- a session started with `--no-skills`,
- a package skill excluded by its `skills` filter,
- a skill that pi hides from the system prompt.

`--no-skills` and package filters control discovery. They do not control access to files on disk. When you invoke a skill explicitly, you also ask for the skills that it references. If the extension refused a disabled dependency, the parent skill would operate without a skill that its author declared as necessary.

Project trust still applies. The extension does not discover skills from a project that you did not trust, disabled or not. Dynamic shell placeholders in injected bodies never execute.

## Trust and safety

Skills can instruct the model to run commands, and dynamic skill placeholders can run shell commands when a skill is first read in a session.

Project-scoped skills (`.pi/skills`, project `.agents/skills`, skill entries in project `.pi/settings.json`) are discovered only after you trust the project. This matches the boundary of pi itself. Global skills, packages, entries in `~/.pi/agent/settings.json`, and explicit CLI `--skill` paths are always discoverable.

For that reason, dynamic shell execution is enabled by default only for user/global skill roots:

- `~/.pi/agent/skills`
- `~/.agents/skills`

Project-local skill shell execution is disabled by default because cloned repositories can contain untrusted `.pi/skills` content.

To opt in for project-local dynamic shell placeholders:

```bash
export PI_TRUST_PROJECT_SKILL_SHELL=1
```

Only do this in repositories you trust.

## For extension authors

Other extensions can ask this extension to suggest and deliver skills. They use Pi's shared `pi.events` bus, so they do not import this package.

### Protocol

- **Channel:** `pi-better-skills:request`. The channel name does not change between versions.
- **Version:** every request and reply carries `version: 1`. This extension ignores a request with a version that it does not support.
- **Replies:** each request carries a `reply` callback. This extension calls it synchronously, before `pi.events.emit` returns.
- **No reply:** a malformed request, an unsupported version, or a handler error gets no reply. A missing reply also means that this extension is not installed.
- **Compatibility rule:** new optional reply fields and new operations do not change the version. A change that removes or renames a field, changes a field type or meaning, or changes an outcome status bumps the version. This extension keeps answering every version listed in the probe reply `versions`.

### Operations

- **`probe`**: confirms that this extension is loaded and lists the supported `versions`. Probe once before other requests. A probe reply proves that the bus delivers replies synchronously. Without that proof, a late `deliver` reply could arrive after your fallback already injected the same skill, and the model would get the body twice. If the probe gets no reply, do not send `deliver` or `suggest`; use your fallback. If the reply does not list version 1, the installed provider is too new for your consumer.
- **`suggest`**: returns skill completions for a query, optionally prefixed with `skill:`. The order is the same ranking as the main editor. Each `value` is `skill:<name>`.
- **`deliver`**: sends skill bodies to the model as one `skill` message. The message includes `<skill_context>` and the skills that each body references. Outcomes follow request order:
  - `delivered`: this extension accepted the skill and owns its delivery.
  - `already-resident`: the body is already in the active session branch, or an earlier delivery is still pending.
  - `unknown`: this extension did not deliver the skill. The cause can be that no session has started yet, that the skill does not exist, or that its `SKILL.md` body is unreadable. Use your fallback for that name.

Do not also put a `delivered` body in your own tool result.

### Delivery timing

- **Idle agent:** Pi appends the message to the session at once and starts no turn. The model sees it with the next prompt.
- **Running agent (for example, during your tool call):** this extension holds the message until the current turn ends, after all tool results of that turn are stored. Then Pi appends it. The next response in the same run sees it. If the run ends first, the model sees it with the next prompt. The message never modifies your tool result.
- If a parallel tool in the same turn already returns the same `SKILL.md`, this extension drops the queued copy, so the model gets one body.

### Types

```ts
type SkillDeliveryStatus = "delivered" | "already-resident" | "unknown";

type ProbeReply = { version: 1; operation: "probe"; available: true; versions: number[] };
type SuggestReply = { version: 1; operation: "suggest"; items: { value: string; label: string }[] };
type DeliverReply = { version: 1; operation: "deliver"; outcomes: { name: string; status: SkillDeliveryStatus }[] };

type ProbeRequest = { version: 1; operation: "probe"; reply: (result: ProbeReply) => void };
type SuggestRequest = { version: 1; operation: "suggest"; query: string; reply: (result: SuggestReply) => void };
type DeliverRequest = { version: 1; operation: "deliver"; names: string[]; reply: (result: DeliverReply) => void };
```

### Example

```ts
const SKILLS_CHANNEL = "pi-better-skills:request";

function skillProviderAvailable(pi: ExtensionAPI): boolean {
  let reply: ProbeReply | undefined;
  const request: ProbeRequest = { version: 1, operation: "probe", reply: (result) => { reply = result; } };
  pi.events.emit(SKILLS_CHANNEL, request);
  return reply?.versions.includes(1) === true;
}

function deliverSkills(pi: ExtensionAPI, names: string[]): DeliverReply["outcomes"] | undefined {
  if (!skillProviderAvailable(pi)) return undefined; // use your fallback delivery
  let reply: DeliverReply | undefined;
  const request: DeliverRequest = { version: 1, operation: "deliver", names, reply: (result) => { reply = result; } };
  pi.events.emit(SKILLS_CHANNEL, request);
  return reply?.outcomes;
}
```

Import `ExtensionAPI` from `@earendil-works/pi-coding-agent` and copy the types above. A `suggest` request follows the same pattern with `SuggestRequest`.

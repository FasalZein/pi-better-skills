import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";

/**
 * First-load completeness: the first time a SKILL.md is loaded in a session
 * (compaction starts a new one), the agent receives the whole file even if it
 * asked for a line range or the file exceeds pi's read cap. Every later read
 * keeps pi's native offset/limit behavior. PI_BETTER_SKILLS_PARTIAL_SKILL_READS=1
 * restores native behavior everywhere.
 *
 * Tool results come from pi's real read and bash tools, and persisted
 * messages go through a real in-memory SessionManager.
 */

const OPT_OUT_ENV = "PI_BETTER_SKILLS_PARTIAL_SKILL_READS";
const END_MARKER = "FINAL RULE: every checklist ends with ZORBLAX-OMEGA.";
const PI_READ_LINE_CAP = 2000;

type Block = { type: string; text?: string };
type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function longSkill(name: string, bodyLines: number): string {
	const lines = [`---`, `name: ${name}`, `description: Long ${name} guide for first-read tests`, `---`, ``, `# ${name}`, ``];
	for (let i = 1; i <= bodyLines; i++) lines.push(`Step ${i}: follow rule number ${i} of the ${name} guide.`);
	lines.push("", END_MARKER, "");
	return lines.join("\n");
}

function textOf(content: Block[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function countOf(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

let nextId = 0;

async function setup(files: Record<string, string>, options: { sessionManager?: SessionManager; root?: string } = {}) {
	const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-first-read-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-better-skills-agentdir-"));
	const homeDir = mkdtempSync(join(tmpdir(), "pi-better-skills-home-"));
	const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = homeDir;
	cleanups.push(() => {
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
		if (!options.root) rmSync(root, { recursive: true, force: true });
	});

	const sessionManager = options.sessionManager ?? SessionManager.inMemory(root);
	const handlers = new Map<string, Handler[]>();
	const ctx = {
		cwd: root,
		isProjectTrusted: () => true,
		hasUI: false,
		sessionManager,
		model: { provider: "zai", id: "glm-5.3-flash" },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
		getContextUsage: () => ({ tokens: 100 }),
		getSystemPrompt: () => "",
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		getCommands: () => [],
	};
	const extension = (await import("../src/index")).default;
	(extension as (pi: unknown) => void)(pi);

	async function emit(event: string, payload: any): Promise<any> {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}

	const tools = { read: createReadTool(root), bash: createBashTool(root) };

	type Call = { id: string; toolName: "read" | "bash"; original: Record<string, unknown>; args: Record<string, unknown>; blocked: boolean };

	/** Pi runs every tool_call hook of a batch (sequentially) before any tool executes. */
	async function prepare(toolName: "read" | "bash", input: Record<string, unknown>): Promise<Call> {
		const id = `call-${++nextId}`;
		const args = { ...input };
		const decision = (await emit("tool_call", { type: "tool_call", toolName, toolCallId: id, input: args })) as { block?: boolean } | undefined;
		return { id, toolName, original: input, args, blocked: Boolean(decision?.block) };
	}

	/** Execute with the real tool, run the tool_result chain, and return the final model-facing content. */
	async function finish(call: Call, options: { failWith?: string } = {}): Promise<{ content: Block[]; isError: boolean }> {
		let content: Block[];
		let isError = false;
		if (call.blocked || options.failWith) {
			content = [{ type: "text", text: options.failWith ?? "blocked" }];
			isError = true;
		} else {
			const result = await (tools[call.toolName] as any).execute(call.id, call.args);
			content = result.content;
		}
		let current = content;
		for (const handler of handlers.get("tool_result") ?? []) {
			const replaced = (await handler(
				{ type: "tool_result", toolName: call.toolName, toolCallId: call.id, input: call.args, content: current, isError },
				ctx,
			)) as { content?: Block[] } | undefined;
			if (replaced?.content) current = replaced.content;
		}
		return { content: current, isError };
	}

	/** Persist one assistant message with the batch's calls, then each result, then end the turn. */
	async function persist(results: Array<{ call: Call; content: Block[]; isError: boolean }>) {
		sessionManager.appendMessage({
			role: "assistant",
			content: results.map(({ call }) => ({ type: "toolCall", id: call.id, name: call.toolName, arguments: call.original })),
			timestamp: Date.now(),
		} as never);
		for (const { call, content, isError } of results) {
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.toolName,
				content,
				isError,
				timestamp: Date.now(),
			} as never);
		}
		await emit("turn_end", {});
	}

	/** One complete single-call turn. */
	async function run(toolName: "read" | "bash", input: Record<string, unknown>, options: { failWith?: string } = {}) {
		const call = await prepare(toolName, input);
		const result = await finish(call, options);
		await persist([{ call, ...result }]);
		return { args: call.args, text: textOf(result.content), content: result.content, isError: result.isError };
	}

	await emit("session_start", {});
	return { root, sessionManager, emit, prepare, finish, persist, run };
}

const SKILL_REL = ".pi/skills/long-guide/SKILL.md";

describe("first SKILL.md read in a session", () => {
	it("drops a requested line range and returns the whole file", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const first = await project.run("read", { path, offset: 1, limit: 200 });

		expect(first.args).toEqual({ path });
		expect(first.text).toContain("Step 1: follow rule number 1");
		expect(first.text).toContain(END_MARKER);
		expect(first.text).not.toContain("Use offset=");
		expect(first.text).toContain("<skill_context>");
	});

	it("returns files past pi's 2000-line read cap in one result", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 2500) });
		const path = join(project.root, SKILL_REL);
		expect(readFileSync(path, "utf-8").split("\n").length).toBeGreaterThan(PI_READ_LINE_CAP);

		const first = await project.run("read", { path });

		expect(first.text).toContain("Step 2500: follow rule number 2500");
		expect(first.text).toContain(END_MARKER);
		expect(first.text).not.toContain("Use offset=");
	});

	it("also completes a first read given as a workspace-relative path", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });

		const first = await project.run("read", { path: SKILL_REL, offset: 5, limit: 10 });

		expect(first.args.offset).toBeUndefined();
		expect(first.args.limit).toBeUndefined();
		expect(first.text).toContain(END_MARKER);
	});

	it("leaves every later read of the same SKILL.md native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 200 });

		const second = await project.run("read", { path, offset: 201, limit: 20 });

		expect(second.args).toEqual({ path, offset: 201, limit: 20 });
		expect(second.text).toContain("Step 195: follow rule number 195");
		expect(second.text).not.toContain(END_MARKER);
		expect(second.text).toContain("Use offset=221 to continue.");
	});

	it("completes only the first of parallel reads of one SKILL.md in one batch", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const a = await project.prepare("read", { path, offset: 1, limit: 100 });
		const b = await project.prepare("read", { path, offset: 101, limit: 100 });
		const results = [
			{ call: a, ...(await project.finish(a)) },
			{ call: b, ...(await project.finish(b)) },
		];
		await project.persist(results);

		expect(a.args).toEqual({ path });
		expect(textOf(results[0]!.content)).toContain(END_MARKER);
		expect(b.args).toEqual({ path, offset: 101, limit: 100 });
		expect(textOf(results[1]!.content)).not.toContain(END_MARKER);
	});

	it("tracks each SKILL.md separately", async () => {
		const project = await setup({
			[SKILL_REL]: longSkill("long-guide", 400),
			".pi/skills/other-guide/SKILL.md": longSkill("other-guide", 400),
		});
		await project.run("read", { path: join(project.root, SKILL_REL), offset: 1, limit: 50 });

		const other = await project.run("read", { path: join(project.root, ".pi/skills/other-guide/SKILL.md"), offset: 1, limit: 50 });

		expect(other.args.limit).toBeUndefined();
		expect(other.text).toContain(END_MARKER);
	});

	it("does not touch ranged reads of files other than SKILL.md", async () => {
		const project = await setup({ "notes/long.md": longSkill("notes", 400) });
		const path = join(project.root, "notes/long.md");

		const read = await project.run("read", { path, offset: 1, limit: 20 });

		expect(read.args).toEqual({ path, offset: 1, limit: 20 });
		expect(read.text).not.toContain(END_MARKER);
	});

	it("does not count a failed first read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 20 }, { failWith: "EACCES" });

		const retry = await project.run("read", { path, offset: 1, limit: 20 });

		expect(retry.args).toEqual({ path });
		expect(retry.text).toContain(END_MARKER);
	});

	it("does not count a first read that never produced a result", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		// Another extension blocked the call after our hook ran: pi emits no tool_result.
		await project.prepare("read", { path, offset: 1, limit: 20 });
		await project.emit("turn_end", {});

		const retry = await project.run("read", { path, offset: 1, limit: 20 });

		expect(retry.args).toEqual({ path });
		expect(retry.text).toContain(END_MARKER);
	});
});

describe("session boundaries", () => {
	it("treats compaction as a new session", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 200 });
		// Keep the earlier read in the retained tail: compaction still resets.
		const firstKept = project.sessionManager.getBranch()[0]!.id;
		project.sessionManager.appendCompaction("Summary.", firstKept, 1000);
		await project.emit("session_compact", {});

		const afterCompaction = await project.run("read", { path, offset: 1, limit: 200 });

		expect(afterCompaction.args).toEqual({ path });
		expect(afterCompaction.text).toContain(END_MARKER);
	});

	it("remembers reads from a resumed session branch", async () => {
		const first = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(first.root, SKILL_REL);
		await first.run("read", { path, offset: 1, limit: 200 });

		const resumed = await setup({}, { sessionManager: first.sessionManager, root: first.root });
		const again = await resumed.run("read", { path, offset: 1, limit: 30 });

		expect(again.args).toEqual({ path, offset: 1, limit: 30 });
		expect(again.text).not.toContain(END_MARKER);
	});

	it("forgets reads that only happened before the branch's latest compaction on resume", async () => {
		const first = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(first.root, SKILL_REL);
		await first.run("read", { path, offset: 1, limit: 200 });
		first.sessionManager.appendCompaction("Summary.", first.sessionManager.getBranch()[0]!.id, 1000);

		const resumed = await setup({}, { sessionManager: first.sessionManager, root: first.root });
		const again = await resumed.run("read", { path, offset: 1, limit: 30 });

		expect(again.args).toEqual({ path });
		expect(again.text).toContain(END_MARKER);
	});

	it("follows tree navigation to a branch without the read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		project.sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() } as never);
		const beforeRead = project.sessionManager.getLeafId()!;
		await project.run("read", { path, offset: 1, limit: 200 });

		project.sessionManager.branch(beforeRead);
		await project.emit("session_tree", {});
		const onOtherBranch = await project.run("read", { path, offset: 1, limit: 30 });

		expect(onOtherBranch.args).toEqual({ path });
		expect(onOtherBranch.text).toContain(END_MARKER);
	});
});

describe("bash loads", () => {
	it("appends the whole file to a first partial bash read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const command = `sed -n '1,60p' ${SKILL_REL}`;

		const first = await project.run("bash", { command });

		expect(first.args).toEqual({ command });
		expect(first.content.length).toBe(2);
		expect(first.content[0]!.text).not.toContain(END_MARKER);
		expect(first.content[1]!.text).toContain(END_MARKER);
		expect(first.content[1]!.text).toContain("<skill_context>");
	});

	it("leaves a later partial bash read native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		const second = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(second.content.length).toBe(1);
		expect(second.text).not.toContain(END_MARKER);
	});

	it("does not duplicate a complete bash read, and counts it", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const cat = await project.run("bash", { command: `cat ${SKILL_REL}` });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(countOf(cat.text, END_MARKER)).toBe(1);
		expect(read.args).toEqual({ path, offset: 1, limit: 30 });
		expect(read.text).not.toContain(END_MARKER);
	});

	it("ignores commands whose output is not the skill's opening", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const grep = await project.run("bash", { command: `grep -n 'rule number 7 ' ${SKILL_REL}` });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(grep.text).not.toContain(END_MARKER);
		expect(read.args).toEqual({ path });
		expect(read.text).toContain(END_MARKER);
	});

	it("counts a first read tool load, so a later bash read stays native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		await project.run("read", { path: join(project.root, SKILL_REL), offset: 1, limit: 30 });

		const bash = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(bash.content.length).toBe(1);
		expect(bash.text).not.toContain(END_MARKER);
	});
});

describe(`${OPT_OUT_ENV}=1`, () => {
	it("keeps native partial reads for read and bash", async () => {
		const previous = process.env[OPT_OUT_ENV];
		process.env[OPT_OUT_ENV] = "1";
		cleanups.push(() => {
			if (previous === undefined) delete process.env[OPT_OUT_ENV];
			else process.env[OPT_OUT_ENV] = previous;
		});
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const read = await project.run("read", { path, offset: 1, limit: 30 });
		const bash = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(read.args).toEqual({ path, offset: 1, limit: 30 });
		expect(read.text).not.toContain(END_MARKER);
		expect(bash.text).not.toContain(END_MARKER);
	});

	it("treats 0/false/no/off as not opted out", async () => {
		const previous = process.env[OPT_OUT_ENV];
		process.env[OPT_OUT_ENV] = "off";
		cleanups.push(() => {
			if (previous === undefined) delete process.env[OPT_OUT_ENV];
			else process.env[OPT_OUT_ENV] = previous;
		});
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(read.text).toContain(END_MARKER);
	});
});

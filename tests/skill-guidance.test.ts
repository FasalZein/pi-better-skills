import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, createBashTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import registerExtension from "../src/index";

// Contract (guidance split): every delivered skill body carries a dirs-only
// <skill_context> (skill_dir + workspace_dir) and NOT the general rules; the
// general path_policy/dynamic_skill_shell guidance rides in the system-level
// <agent_skills> section on every request (pinned end-to-end in
// tests/agent-skills.test.ts). These tests pin the body side at the read and
// /skill:name delivery seams, plus the system-block presence at those seams.

const BODY = "# Fixture skill\nRead references/guide.md before responding.";
const ABSOLUTE_RULE = "Absolute paths are exact and should not be reinterpreted.";
const SHELL_RULE = "Do not run dynamic shell placeholders yourself";
const AGENT_SKILLS_TAG = "<agent_skills>";

function addCollidingResources(cwd: string, skillDir: string): void {
	for (const [dir, marker] of [[cwd, "WORKSPACE_ONLY\n"], [skillDir, "SKILL_ONLY\n"]]) {
		mkdirSync(join(dir, "docs"), { recursive: true });
		writeFileSync(join(dir, "docs/guide.md"), marker);
		writeFileSync(join(dir, "guide.md"), marker);
	}
	mkdirSync(join(cwd, "docs/internals"));
	writeFileSync(join(cwd, "docs/internals/WORKSPACE_ONLY"), "");
}

async function fixture(body = BODY) {
	const root = mkdtempSync(join(tmpdir(), "skill-guidance-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const skillDir = join(agentDir, "skills", "fixture");
	const skillPath = join(skillDir, "SKILL.md");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(skillPath, `---\nname: fixture\ndescription: Test fixture\n---\n\n${body}\n`);
	writeFileSync(join(skillDir, "references", "guide.md"), "REFERENCE_OK\n");
	const original = readFileSync(skillPath, "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
	const previousPathVars = { PI_WORKSPACE: process.env.PI_WORKSPACE, PI_SKILL_DIR: process.env.PI_SKILL_DIR };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
	let session: AgentSession | undefined;
	const cleanup = () => {
		try {
			session?.dispose();
			rmSync(root, { recursive: true, force: true });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = previousOptOut;
			for (const [key, value] of Object.entries(previousPathVars)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
	try {
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, skillsOverride: result => ({ ...result, skills: result.skills.filter(skill => skill.filePath.startsWith(agentDir + "/")) }), extensionFactories: [registerExtension] });
		await loader.reload();
		const manager = SessionManager.inMemory(cwd);
		const { session: activeSession } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["read", "bash", "shell_cell"], customTools: [{ ...createBashTool(cwd), name: "shell_cell" }] });
		session = activeSession;
		const errors: unknown[] = [];
		await activeSession.bindExtensions({ onError: error => errors.push(error) });
		const requests: TranscriptContext[] = [];
		const reply = (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("OK");
		};
		return {
			session: activeSession, manager, faux, requests, reply, cwd, skillDir, skillPath,
			cleanup() {
				try {
					expect(readFileSync(skillPath, "utf8")).toBe(original);
					expect(errors).toEqual([]);
				} finally {
					cleanup();
				}
			},
		};
	} catch (error) {
		try { cleanup(); } finally { throw error; }
	}
}

function textOf(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

it.each(["loaded", "not loaded"].flatMap(skill =>
	["docs/guide.md", "./docs/guide.md", "guide.md"].map(path => ({ skill, path })),
))("reads workspace $path when a colliding skill is $skill", async ({ skill, path }) => {
	const built = await fixture();
	try {
		addCollidingResources(built.cwd, built.skillDir);
		built.faux.setResponses([
			...(skill === "loaded" ? [() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })])] : []),
			() => fauxAssistantMessage([fauxToolCall("read", { path })]),
			built.reply,
		]);
		await built.session.prompt("Read the skill, then read the workspace guide.");
		const results = built.session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(skill === "loaded" ? 2 : 1);
		const result = results[results.length - 1];
		expect(result.isError).toBe(false);
		expect(textOf(result)).toBe("WORKSPACE_ONLY\n");
	} finally {
		built.cleanup();
	}
});

it.each(["loaded", "not loaded"].flatMap(skill =>
	["ls ./docs ./docs/internals", "grep WORKSPACE docs/guide.md", 'cat "./docs/guide.md"'].map(command => ({ skill, command })),
))("keeps workspace paths in $command when a colliding skill is $skill", async ({ skill, command }) => {
	const built = await fixture();
	try {
		addCollidingResources(built.cwd, built.skillDir);
		built.faux.setResponses([
			...(skill === "loaded" ? [() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })])] : []),
			() => fauxAssistantMessage([fauxToolCall("bash", { command })]),
			built.reply,
		]);
		await built.session.prompt("Read the skill, then inspect workspace directories.");
		const results = built.session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(skill === "loaded" ? 2 : 1);
		const result = results[results.length - 1];
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("WORKSPACE_ONLY");
	} finally {
		built.cleanup();
	}
});

it.each(["loaded", "not loaded"])("resolves missing workspace resources when the skill is %s", async skill => {
	const built = await fixture();
	try {
		built.faux.setResponses([
			...(skill === "loaded" ? [() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })])] : []),
			() => fauxAssistantMessage([fauxToolCall("read", { path: "references/guide.md" })]),
			() => fauxAssistantMessage([fauxToolCall("bash", { command: "cat references/guide.md" })]),
			built.reply,
		]);
		await built.session.prompt("Read a resource absent from the workspace, then try it through bash.");
		const results = built.session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(skill === "loaded" ? 3 : 2);
		const read = results[results.length - 2];
		const bash = results[results.length - 1];
		expect(read.isError).toBe(false);
		expect(textOf(read)).toBe("REFERENCE_OK\n");
		expect(bash.isError).toBe(true);
		expect(textOf(bash)).toBe(`Blocked unresolved skill-relative resource path. Retry with the resolved command: cat ${join(built.skillDir, "references/guide.md")}`);
	} finally {
		built.cleanup();
	}
});

it("keeps explicit workspace and skill paths unambiguous despite collisions", async () => {
	const built = await fixture();
	try {
		addCollidingResources(built.cwd, built.skillDir);
		built.faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]),
			...[
				fauxToolCall("read", { path: join(built.cwd, "docs/guide.md") }),
				fauxToolCall("read", { path: join(built.skillDir, "docs/guide.md") }),
				fauxToolCall("bash", { command: 'cat "$PI_WORKSPACE/docs/guide.md"' }),
				fauxToolCall("bash", { command: 'cat "$PI_SKILL_DIR/docs/guide.md"' }),
				fauxToolCall("read", { path: "$PI_WORKSPACE/docs/guide.md" }),
				fauxToolCall("read", { path: "$PI_SKILL_DIR/docs/guide.md" }),
			].map(call => () => fauxAssistantMessage([call])),
			built.reply,
		]);
		await built.session.prompt("Read both explicit locations through native tools.");
		const results = built.session.messages.filter(message => message.role === "toolResult").slice(1);
		expect(results.map(result => ({ isError: result.isError, text: textOf(result) }))).toEqual([
			{ isError: false, text: "WORKSPACE_ONLY\n" },
			{ isError: false, text: "SKILL_ONLY\n" },
			{ isError: false, text: "WORKSPACE_ONLY\n" },
			{ isError: false, text: "SKILL_ONLY\n" },
			{ isError: true, text: `Blocked unresolved PI path variable. Retry read with the resolved path: ${join(built.cwd, "docs/guide.md")}` },
			{ isError: true, text: `Blocked unresolved PI path variable. Retry read with the resolved path: ${join(built.skillDir, "docs/guide.md")}` },
		]);
	} finally {
		built.cleanup();
	}
});

it("recognizes a skill loaded by a custom tool without changing that tool's workspace paths", async () => {
	const built = await fixture("# Fixture skill\nRead references/guide.md for the bundled reference.\nKeep workspace files at their original location.");
	try {
		addCollidingResources(built.cwd, built.skillDir);
		built.faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("shell_cell", { command: `cat '${built.skillPath}'` })]),
			() => fauxAssistantMessage([fauxToolCall("shell_cell", { command: "cat docs/guide.md" })]),
			() => fauxAssistantMessage([fauxToolCall("read", { path: "docs/guide.md" })]),
			built.reply,
		]);
		await built.session.prompt("Load the skill through the custom shell, then read the workspace guide with both tools.");
		const results = built.session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(textOf(results[0])).toContain(`<skill_dir>${built.skillDir}</skill_dir>`);
		for (const result of results.slice(1)) {
			expect(result.isError).toBe(false);
			expect(textOf(result)).toBe("WORKSPACE_ONLY\n");
		}
	} finally {
		built.cleanup();
	}
});

/** The delivered body side of the split: dirs present, general rules absent. */
function expectDirsOnlyBody(text: string, built: ReturnType<typeof fixture> extends Promise<infer T> ? T : never): void {
	expect(text).toContain(BODY);
	expect(text).toContain(`<skill_dir>${built.skillDir}</skill_dir>`);
	expect(text).toContain(`<workspace_dir>${built.cwd}</workspace_dir>`);
	expect(text).not.toContain(ABSOLUTE_RULE);
	expect(text).not.toContain(SHELL_RULE);
}

/** The system side of the split: the general rules ride in <agent_skills>. */
function expectSystemBlock(prompt: string): void {
	expect(prompt.split(AGENT_SKILLS_TAG).length - 1).toBe(1);
	expect(prompt).toContain("Existing relative paths under workspace_dir keep their workspace meaning, even when a skill has the same path.");
	expect(prompt).toContain(ABSOLUTE_RULE);
	expect(prompt).toContain(SHELL_RULE);
}

it("saves directory context with a read skill, without changing its source file", async () => {
	const built = await fixture();
	try {
		built.faux.setResponses([
			(context: TranscriptContext) => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]);
			},
			built.reply,
		]);
		await built.session.prompt("Read the fixture skill.");
		const result = built.session.messages.find(message => message.role === "toolResult");
		expect(result).toBeDefined();
		if (!result) throw new Error("Skill read produced no tool result");
		expectDirsOnlyBody(textOf(result), built);
		// The first request already carries the general rules at system level.
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it("keeps dirs-only bodies and a byte-stable system block through idle helper and tool turns", async () => {
	const built = await fixture();
	try {
		built.faux.setResponses([
			context => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]);
			},
			built.reply,
			context => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("bash", { command: "printf helper-tool-ok" })]);
			},
			built.reply,
			built.reply,
		]);
		await built.session.prompt("Read the fixture skill.");
		await built.session.sendCustomMessage({ customType: "helper", content: "Helper finished.", display: false }, { triggerTurn: true, deliverAs: "steer" });
		await built.session.prompt("Continue using the same skill.");
		expect(built.requests).toHaveLength(5);
		const prompts = built.requests.map(request => getCurrentSystemPrompt(request.messages));
		// One identical system prompt across normal, tool, idle, and next-user
		// requests, always carrying the general block.
		expect(new Set(prompts).size).toBe(1);
		expectSystemBlock(prompts[0]);
		for (const request of built.requests.slice(1)) {
			const bodies = request.messages.map(textOf).filter(text => text.includes(BODY));
			expect(bodies).toHaveLength(1);
			expectDirsOnlyBody(bodies[0], built);
		}
	} finally {
		built.cleanup();
	}
});

it.each(["/skill:fixture", "/skill:fixture Keep this request."])("delivers dirs-only context on a single skill command: %s", async prompt => {
	const built = await fixture();
	try {
		built.faux.setResponses([built.reply]);
		await built.session.prompt(prompt);
		const bodies = built.session.messages.map(textOf).filter(text => text.includes(BODY));
		expect(bodies).toHaveLength(1);
		expectDirsOnlyBody(bodies[0], built);
		if (prompt.includes("Keep this request.")) expect(bodies[0]).toContain("Keep this request.");
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it("marks unevaluated command placeholders as skipped in a skill command", async () => {
	const built = await fixture("# Fixture skill\nDynamic value: !`printf PLACEHOLDER_EXECUTED`");
	try {
		built.faux.setResponses([built.reply]);
		await built.session.prompt("/skill:fixture");
		const text = built.requests[0].messages.map(textOf).join("\n");
		expect(text).toContain("[dynamic shell skipped: passive reference injection]");
		expect(text).not.toContain("!`printf PLACEHOLDER_EXECUTED`");
		// The shell rule that explains the skipped notice lives at system level.
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it.each(["read", "command"])("keeps authored context examples without skipping guidance on %s", async route => {
	const authored = `${BODY}\n\nExample: <skill_context>authored example</skill_context>.`;
	const built = await fixture(authored);
	try {
		built.faux.setResponses(route === "read"
			? [() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]), built.reply]
			: [built.reply]);
		await built.session.prompt(route === "read" ? "Read the fixture skill." : "/skill:fixture");
		const text = built.requests[0].messages.map(textOf).join("\n");
		// The authored example stays verbatim and does not suppress our block:
		// the message carrying it still gains the dirs-only <skill_context>.
		expect(text).toContain(authored);
		const bodyMessage = built.requests[0].messages.map(textOf).find(text => text.includes(BODY));
		expect(bodyMessage).toBeDefined();
		expectDirsOnlyBody(bodyMessage!, built);
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

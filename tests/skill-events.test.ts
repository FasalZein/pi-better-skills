import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import extension from "../src/index";
import { SKILL_API_CHANNEL, type SkillApiReply } from "../src/skill-events";

const PARENT = `---\nname: parent\ndescription: parent\n---\n\nParent instructions. Read \`/skill:child\`.\n`;
const CHILD = `---\nname: child\ndescription: child\n---\n\nChild instructions.\n`;

test("probe detects absence and ignores unsupported versions regardless of load order", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-events-")));
	try {
		const events = createEventBus();
		let reply: SkillApiReply | undefined;
		const probe = () => events.emit(SKILL_API_CHANNEL, { version: 1, operation: "probe", reply: (value: SkillApiReply) => { reply = value; } });
		probe();
		expect(reply).toBeUndefined();
		const pi = fakePi(root, events);
		extension(pi.api as never);
		probe();
		expect(reply).toEqual({ version: 1, operation: "probe", available: true });
		reply = undefined;
		events.emit(SKILL_API_CHANNEL, { version: 2, operation: "probe", reply: (value: SkillApiReply) => { reply = value; } });
		expect(reply).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function fakePi(root: string, events = createEventBus()) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const sessionManager = SessionManager.inMemory(root);
	let providerFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	const ctx = { cwd: root, isProjectTrusted: () => true, hasUI: true, sessionManager, ui: {
		addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => { providerFactory = factory; },
		getEditorComponent: () => true,
	} }; 
	const sent: Array<{ content: string; details: { skills: Array<{ name: string }> }; options: unknown }> = [];
	const api = {
		events,
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerMessageRenderer: () => {},
		sendMessage: (message: { content: string; details: { skills: Array<{ name: string }> } }, options: unknown) => {
			sent.push({ ...message, options });
		},
	};
	return {
		api, events, sent, sessionManager,
		getProvider: () => providerFactory!({ getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) }),
		start: async () => { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); },
		turnEnd: async () => { for (const handler of handlers.get("turn_end") ?? []) await handler({}, ctx); },
		request: (operation: string, fields: object = {}): SkillApiReply | undefined => {
			let reply: SkillApiReply | undefined;
			events.emit(SKILL_API_CHANNEL, { version: 1, operation, ...fields, reply: (value: SkillApiReply) => { reply = value; } });
			return reply;
		},
	};
}

test("delivery uses inline blocks, references, and persisted session residency", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-delivery-")));
	try {
		for (const [name, text] of [["parent", PARENT], ["child", CHILD]]) {
			const path = join(root, ".pi/skills", name, "SKILL.md");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		expect(pi.request("deliver", { names: ["missing", "parent", "parent"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [
				{ name: "missing", status: "unknown" },
				{ name: "parent", status: "delivered" },
				{ name: "parent", status: "already-resident" },
			],
		});
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
		expect(pi.sent[0].details.skills.map((skill) => skill.name)).toEqual(["parent", "child"]);
		expect(pi.sent[0].content).toContain(`<skill_dir>${join(root, ".pi/skills/parent")}</skill_dir>`);
		expect(pi.sent[0].content).toContain(`<workspace_dir>${root}</workspace_dir>`);
		// Pi persists the queued custom message after the tool result. A new
		// request must detect this through the public session context APIs.
		pi.sessionManager.appendCustomMessageEntry("skill", pi.sent[0].content, true, pi.sent[0].details);
		expect(pi.request("deliver", { names: ["parent", "child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [
				{ name: "parent", status: "already-resident" },
				{ name: "child", status: "already-resident" },
			],
		});
		expect(pi.sent).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a queued skill stays reserved after turn_end until Pi persists the steer message", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-pending-")));
	try {
		const path = join(root, ".pi/skills/child/SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		await pi.turnEnd();
		// Another steer message may arrive first, so the skill remains queued
		// while the real SessionManager still has no persisted skill message.
		expect(pi.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "already-resident" }],
		});
		expect(pi.sent).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("API suggestions rank exactly like the main editor provider", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-suggest-")));
	try {
		for (const name of ["alpha", "alpine", "beta"]) {
			const path = join(root, ".pi/skills", name, "SKILL.md");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `---\nname: ${name}\ndescription: sample\n---\n\n${name} instructions.\n`);
		}
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		const provider = pi.getProvider();
		const main = await provider.getSuggestions(["use /skill:al"], 0, 13, { signal: new AbortController().signal });
		const result = pi.request("suggest", { query: "skill:al" });
		expect(result).toEqual({ version: 1, operation: "suggest", items: main?.items });
		expect((result as { items: Array<{ value: string }> }).items.map((item) => item.value)).toContain("skill:alpha");
		const all = await provider.getSuggestions(["use /"], 0, "use /".length, { signal: new AbortController().signal });
		const empty = pi.request("suggest", { query: "" });
		expect(empty).toEqual({ version: 1, operation: "suggest", items: all?.items });
		expect((empty as { items: Array<{ value: string }> }).items.length).toBeGreaterThan(3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

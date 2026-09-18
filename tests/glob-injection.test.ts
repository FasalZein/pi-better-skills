import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Globs auto-injection through the registered tool_result handler. The trigger
 * is a structured path key in any tool's input, not tool identity, so sessions
 * whose read tool was replaced or wrapped by another extension (MCP file tools,
 * wrapped editors) keep working. Free-form strings such as shell commands are
 * not scanned: a command line mentions paths it never opens.
 */

type TextBlock = { type: "text"; text: string };
type ToolResultEvent = {
	type: "tool_result";
	toolName: string;
	input: Record<string, unknown>;
	content: TextBlock[];
	isError: boolean;
};
type FakeContext = {
	cwd: string;
	isProjectTrusted: () => boolean;
	hasUI: boolean;
};
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;

async function loadExtension() {
	return (await import("../index")).default;
}

function makeFakePi(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const ctx: FakeContext = { cwd, isProjectTrusted: () => true, hasUI: false };
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerMessageRenderer: () => {},
	};
	return {
		pi,
		ctx,
		emit: async (event: string, payload: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		},
	};
}

async function setupProject(files: Record<string, string>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-globs-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const extension = await loadExtension();
	const { pi, ctx, emit } = makeFakePi(root);
	(extension as (pi: unknown) => void)(pi);
	await emit("session_start", {});
	return { root, ctx, emit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function toolResult(toolName: string, input: Record<string, unknown>, text = "tool output"): ToolResultEvent {
	return { type: "tool_result", toolName, input, content: [{ type: "text", text }], isError: false };
}

function resultText(result: unknown): string {
	if (typeof result !== "object" || result === null || !Array.isArray((result as { content?: unknown }).content)) {
		return "";
	}
	return ((result as { content: TextBlock[] }).content ?? [])
		.map((block) => block.text)
		.join("\n");
}

const WIDGET_SKILL = `---
name: widget-patterns
description: Widget component conventions
globs: ["**/*.widget"]
---

Widget body marker.
`;

describe("globs auto-injection via arbitrary tools", () => {
	it("injects from a structured path key on a foreign tool result", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit("tool_result", toolResult("mcp__fs__view", { file_path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
			expect(resultText(result)).toContain("tool output");
		} finally {
			project.cleanup();
		}
	});

	it("resolves a structured path key against a workdir base key", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit(
				"tool_result",
				toolResult("mcp__fs__view", { file: "Button.widget", workdir: join(project.root, "src") }),
			);
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("still injects for the built-in read tool", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("never injects from a command line that only names a matching path", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			// `ls`/`grep -c` put no file content in context, and a shell tool is not a
			// file visit. Scanning command strings made every such call cost a full
			// skill body.
			const listing = await project.emit("tool_result", toolResult("bash", { command: "ls -la src/Button.widget" }));
			expect(listing).toBeUndefined();

			const counted = await project.emit("tool_result", toolResult("bash", { command: "grep -c . src/Button.widget" }));
			expect(counted).toBeUndefined();

			const foreign = await project.emit("tool_result", toolResult("exec_command", { command: "cat src/Button.widget" }));
			expect(foreign).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("lets write tool paths participate in globs matching", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit(
				"tool_result",
				toolResult("write", { path: "src/Button.widget", content: "rewritten" }),
			);
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("injects a skill once per session, not once per turn", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
			"src/Icon.widget": "icon content",
		});
		try {
			const first = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			const second = await project.emit("tool_result", toolResult("read", { path: "src/Icon.widget" }));
			expect(second).toBeUndefined();

			// A later turn must not pay for the body again: the modified tool result
			// is persisted in session history, so the first copy is still in context.
			await project.emit("agent_end", {});
			const nextTurn = await project.emit("tool_result", toolResult("read", { path: "src/Icon.widget" }));
			expect(nextTurn).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("re-injects after compaction summarizes the body out of context", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const first = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			await project.emit("session_compact", {});
			const afterCompact = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(afterCompact)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("injects from a list-valued path key", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit(
				"tool_result",
				toolResult("mcp__fs__read_multiple_files", { paths: ["README.md", "src/Button.widget"] }),
			);
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not inject a skill the user already loaded with /skill:name", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			// pi core expands an ordinary leading `/skill:name` itself, so the body is
			// in context even though this extension declines to rewrite the prompt.
			await project.emit("input", { source: "user", text: "/skill:widget-patterns build the button" });

			const result = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("requires candidates to exist on disk", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
		});
		try {
			const result = await project.emit("tool_result", toolResult("mcp__fs__view", { file_path: "src/Missing.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("never injects on error results", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const event = toolResult("mcp__fs__view", { file_path: "src/Button.widget" });
			event.isError = true;
			const result = await project.emit("tool_result", event);
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("skips skills with disable-model-invocation", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL.replace('globs: ["**/*.widget"]', 'globs: ["**/*.widget"]\ndisable-model-invocation: true'),
			"src/Button.widget": "button content",
		});
		try {
			const result = await project.emit("tool_result", toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("trusts bare filename reads through a path key but not through a command string", async () => {
		const project = await setupProject({
			".pi/skills/docker-tips/SKILL.md": `---
name: docker-tips
description: Dockerfile conventions
globs: "Dockerfile*"
---

Docker tips marker.
`,
			"Dockerfile": "FROM node:22",
		});
		try {
			const viaCommand = await project.emit("tool_result", toolResult("exec_command", { command: "cat Dockerfile" }));
			expect(viaCommand).toBeUndefined();

			const viaRead = await project.emit("tool_result", toolResult("read", { path: "Dockerfile" }));
			expect(resultText(viaRead)).toContain("Docker tips marker.");
		} finally {
			project.cleanup();
		}
	});

	it("still enriches a direct SKILL.md read through a foreign tool", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
		});
		try {
			const skillPath = join(project.root, ".pi/skills/widget-patterns/SKILL.md");
			const result = await project.emit(
				"tool_result",
				toolResult("exec_command", { command: `cat ${skillPath}` }, "Widget body marker."),
			);
			expect(resultText(result)).toContain("<skill_context>");
		} finally {
			project.cleanup();
		}
	});
});

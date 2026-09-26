import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

/**
 * Wire-level tests for the payload stage of the pi-docs strip and the
 * agent_skills re-assertion. The faux provider used by the lifecycle tests
 * never calls onPayload, so before_provider_request does not fire under faux
 * and those tests cannot observe this stage. Here the model is a REAL pi-ai
 * API client (openai-completions and anthropic-messages) pointed at a local
 * Bun.serve SSE server, so the recorded request bodies are the true wire
 * payloads after every extension transform, including the forced-prompt
 * projection that pi applies after context_with_system.
 */

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const DOCS_MARKER = "Pi documentation (read only";
const TASK_SUFFIX = "<task_policy_probe>forcing-extension policy suffix</task_policy_probe>";

/** Load the actual shipped extension (src/index.ts) through pi's real jiti pipeline. */
const REAL_EXTENSION_LOADER = `export { default } from "${SRC_DIR}/index.ts";\n`;

/** A sibling extension that forces the whole prompt every turn: base prompt + policy suffix. */
const PROMPT_FORCING_EXTENSION = `
export default function (pi) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: (event.systemPrompt ?? "") + ${JSON.stringify(`\n\n${TASK_SUFFIX}`)},
	}));
}
`;

/** A sibling extension forcing a fully foreign prompt: no pi base, no skills catalog, fake docs text. */
const FOREIGN_FORCER = `
const FOREIGN = ${JSON.stringify(
	[
		"Overridden full prompt: another extension owns the whole system prompt for this session.",
		"",
		"<docs>",
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, or TUI):",
		"- Main documentation: /opt/pi/README.md",
		"</docs>",
	].join("\n"),
)};
export default function (pi) {
	pi.on("before_agent_start", async () => ({ systemPrompt: FOREIGN }));
}
`;

function openaiCompletionSse(reply: string): string {
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "wire",
			object: "chat.completion.chunk",
			created: 0,
			model: "wire-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	return (
		chunk({ role: "assistant", content: "" }, null) +
		chunk({ content: reply }, null) +
		chunk({}, "stop") +
		`data: ${JSON.stringify({
			id: "wire",
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		})}\n\n` +
		"data: [DONE]\n\n"
	);
}

function anthropicSse(reply: string): string {
	const block = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	return (
		block("message_start", {
			type: "message_start",
			message: { id: "m1", type: "message", role: "assistant", model: "wire-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
		}) +
		block("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
		block("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } }) +
		block("content_block_stop", { type: "content_block_stop", index: 0 }) +
		block("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
		block("message_stop", { type: "message_stop" })
	);
}

interface WireHarness {
	session: AgentSession;
	/** Parsed request bodies in arrival order. */
	bodies: Array<Record<string, unknown>>;
	cleanup: () => void;
}

/**
 * One real session against a local SSE server. `sseFor` maps the n-th wire
 * request to its scripted provider reply.
 */
async function startWireSession(options: {
	api: "openai-completions" | "anthropic-messages";
	extensionSources: Array<{ file: string; code: string }>;
	requestCount: number;
	reply?: string;
}): Promise<WireHarness> {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const body = (await request.json()) as Record<string, unknown>;
			const index = bodies.length;
			bodies.push(body);
			if (index >= options.requestCount) return new Response("unexpected request", { status: 500 });
			const sse =
				options.api === "openai-completions"
					? openaiCompletionSse(options.reply ?? `reply ${index}`)
					: anthropicSse(options.reply ?? `reply ${index}`);
			return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
		},
	});
	const bodies: Array<Record<string, unknown>> = [];

	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-wire-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-docs-wire-cwd-"));
	const sessionDir = join(agentDir, "sessions");
	let session: AgentSession | undefined;
	const cleanup = () => {
		try {
			session?.dispose();
			server.stop(true);
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		}
	};

	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		for (const source of options.extensionSources) {
			writeFileSync(join(agentDir, "extensions", source.file), source.code, "utf8");
		}
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					wiretest: {
						api: options.api,
						baseUrl: `http://127.0.0.1:${server.port}`,
						apiKey: "wire-test-key",
						models: [{ id: "wire-model", name: "Wire Model", contextWindow: 128000, maxTokens: 4096 }],
					},
				},
			}),
			"utf8",
		);

		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const model = modelRuntime.getModel("wiretest", "wire-model");
		if (!model) throw new Error("wire model did not load from models.json");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			skillsOverride: (result) => ({ ...result, skills: result.skills.filter((skill) => skill.filePath.startsWith(agentDir + "/")) }),
		});
		await resourceLoader.reload();
		const manager = SessionManager.create(cwd, sessionDir);
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: manager,
			model,
		});
		session = created.session;
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(errors).toEqual([]);
		return { session, bodies, cleanup };
	} catch (error) {
		try {
			cleanup();
		} finally {
			throw error;
		}
	}
}

function leadingSystemContent(body: Record<string, unknown>): string {
	const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
	const head = messages?.[0];
	if (!head || head.role !== "system" || typeof head.content !== "string") {
		throw new Error(`openai payload has no leading system message: ${JSON.stringify(body).slice(0, 300)}`);
	}
	return head.content;
}

describe("pi-docs payload strip + agent_skills re-assertion (wire level)", () => {
	it(
		"strips the docs block from forced-turn payloads and re-asserts agent_skills (openai-completions)",
		async () => {
			const built = await startWireSession({
				api: "openai-completions",
				extensionSources: [
					{ file: "under-test.ts", code: REAL_EXTENSION_LOADER },
					{ file: "forcer.ts", code: PROMPT_FORCING_EXTENSION },
				],
				requestCount: 3,
			});
			try {
				// Normal prompt (forced), idle-triggered turn (not forced), normal prompt (forced).
				await built.session.prompt("normal one");
				await built.session.sendCustomMessage({ customType: "note", content: "idle ping", display: false }, { triggerTurn: true });
				await built.session.waitForIdle();
				await built.session.prompt("normal two");
				await built.session.waitForIdle();

				expect(built.bodies).toHaveLength(3);
				for (const [index, body] of built.bodies.entries()) {
					const content = leadingSystemContent(body);
					expect(content).not.toContain(DOCS_MARKER);
					expect(content).not.toContain("<docs>");
					expect(content).toContain("<agent_skills>");
				}
				// Forced turns carry the forcer suffix; the idle turn does not.
				expect(leadingSystemContent(built.bodies[0])).toContain(TASK_SUFFIX);
				expect(leadingSystemContent(built.bodies[1])).not.toContain(TASK_SUFFIX);
				// Byte-stable system content across forced turns: cache parity.
				expect(leadingSystemContent(built.bodies[2])).toBe(leadingSystemContent(built.bodies[0]));
			} finally {
				built.cleanup();
			}
		},
		30000,
	);

	it(
		"ships a foreign forced prompt byte-exact: no docs strip, no agent_skills append",
		async () => {
			const built = await startWireSession({
				api: "openai-completions",
				extensionSources: [
					{ file: "under-test.ts", code: REAL_EXTENSION_LOADER },
					{ file: "forcer.ts", code: FOREIGN_FORCER },
				],
				requestCount: 1,
			});
			try {
				await built.session.prompt("normal one");
				await built.session.waitForIdle();
				const content = leadingSystemContent(built.bodies[0]);
				expect(content).toBe(
					[
						"Overridden full prompt: another extension owns the whole system prompt for this session.",
						"",
						"<docs>",
						"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, or TUI):",
						"- Main documentation: /opt/pi/README.md",
						"</docs>",
					].join("\n"),
				);
			} finally {
				built.cleanup();
			}
		},
		30000,
	);

	it(
		"strips the docs block from anthropic system[] text blocks and keeps block structure",
		async () => {
			const built = await startWireSession({
				api: "anthropic-messages",
				extensionSources: [
					{ file: "under-test.ts", code: REAL_EXTENSION_LOADER },
					{ file: "forcer.ts", code: PROMPT_FORCING_EXTENSION },
				],
				requestCount: 1,
			});
			try {
				await built.session.prompt("normal one");
				await built.session.waitForIdle();
				const system = built.bodies[0].system as Array<Record<string, unknown>>;
				expect(Array.isArray(system)).toBeTrue();
				const textBlocks = system.filter((block) => typeof block.text === "string");
				expect(textBlocks.length).toBeGreaterThanOrEqual(1);
				for (const block of textBlocks) {
					expect(block.type).toBe("text");
					expect(block.text as string).not.toContain(DOCS_MARKER);
				}
				const prompt = textBlocks.map((block) => block.text as string).join("\n");
				expect(prompt).toContain(TASK_SUFFIX);
				expect(prompt).toContain("<agent_skills>");
			} finally {
				built.cleanup();
			}
		},
		30000,
	);
});

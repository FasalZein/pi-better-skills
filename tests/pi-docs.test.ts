import { describe, it, expect } from "bun:test";
import { stripPiDocsBlock } from "../pi-docs";

/** Mirrors pi core's built-in block (dist/core/system-prompt.js) — independent source of truth. */
const REAL_BLOCK = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/pi-coding-agent/README.md
- Additional docs: /opt/pi/pi-coding-agent/docs
- Examples: /opt/pi/pi-coding-agent/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

function promptWithBlock(block: string): string {
	return `You are an expert coding assistant operating inside pi.\n\nGuidelines:\n- Be concise in your responses\n\n${block}\n\nCurrent working directory: /tmp`;
}

describe("stripPiDocsBlock", () => {
	it("returns undefined when the prompt has no pi-docs block", () => {
		expect(stripPiDocsBlock("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp")).toBeUndefined();
	});

	it("strips the block and returns it captured", () => {
		const result = stripPiDocsBlock(promptWithBlock(REAL_BLOCK));
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).not.toContain("Pi documentation (read only");
		expect(result!.prompt).toContain("Guidelines:");
		expect(result!.prompt).toContain("Current working directory: /tmp");
	});
});

describe("stripPiDocsBlock drift tolerance", () => {
	it("still strips when pi rewords bullets or appends new ones", () => {
		const evolved = REAL_BLOCK
			.replace("- When working on pi topics", "- When building anything pi-related")
			+ "\n- Brand new bullet about docs/widgets.md and its cross-references";
		const result = stripPiDocsBlock(promptWithBlock(evolved));
		expect(result).toBeDefined();
		expect(result!.block).toBe(evolved);
		expect(result!.prompt).not.toContain("Pi documentation (read only");
	});

	it("fails open when the header line is renamed", () => {
		const renamed = REAL_BLOCK.replace(
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
			"Pi manual (consult for pi internals):",
		);
		expect(stripPiDocsBlock(promptWithBlock(renamed))).toBeUndefined();
	});

	it("fails open when the first bullet label changes", () => {
		const reordered = REAL_BLOCK.replace("- Main documentation: ", "- Primary manual: ");
		expect(stripPiDocsBlock(promptWithBlock(reordered))).toBeUndefined();
	});
});

describe("renderPiDocsSkillMd", () => {
	it("wraps the captured block in valid frontmatter with the inherited body", async () => {
		const { renderPiDocsSkillMd, PI_DOCS_SKILL_NAME } = await import("../pi-docs");
		const md = renderPiDocsSkillMd(REAL_BLOCK);
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain(`name: ${PI_DOCS_SKILL_NAME}`);
		const description = md.match(/description: (.+)/)?.[1];
		expect(description).toBeDefined();
		expect(description!).toMatch(/[Pp]i/);
		expect(description!).not.toContain(": "); // plain YAML scalar, no nested colons
		expect(md).toContain(`# Pi documentation`);
		expect(md).toContain(REAL_BLOCK);
		expect(md.endsWith("\n")).toBe(true);
	});
});

describe("syncPiDocsSkillFile", () => {
	it("writes the skill on first call, then skips identical content, then updates on change", async () => {
		const { syncPiDocsSkillFile, piDocsSkillDirPath } = await import("../pi-docs");
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-sync-"));
		try {
			const first = syncPiDocsSkillFile(agentDir, REAL_BLOCK);
			const path = join(piDocsSkillDirPath(agentDir), "SKILL.md");
			expect(first.written).toBe(true);
			expect(first.path).toBe(path);
			expect(readFileSync(path, "utf8")).toContain(REAL_BLOCK);

			expect(syncPiDocsSkillFile(agentDir, REAL_BLOCK).written).toBe(false);

			const evolved = `${REAL_BLOCK}\n- New bullet appended by a pi update`;
			const third = syncPiDocsSkillFile(agentDir, evolved);
			expect(third.written).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("New bullet appended by a pi update");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("piDocsFeatureEnabled", () => {
	it("is on by default and opts out via PI_BETTER_SKILLS_NO_PI_DOCS", async () => {
		const { piDocsFeatureEnabled } = await import("../pi-docs");
		expect(piDocsFeatureEnabled({})).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "0" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "false" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "1" })).toBe(false);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "TRUE" })).toBe(false);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "yes" })).toBe(false);
	});
});

describe("piDocsSkillRegistration", () => {
	it("registers and syncs only when the feature is on and the block is present", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-reg-"));
		try {
			const withBlock = piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir);
			expect(withBlock?.skillPaths).toEqual([join(agentDir, "cache", "pi-better-skills", "pi-docs")]);
			expect(existsSync(join(withBlock!.skillPaths[0], "SKILL.md"))).toBe(true);

			expect(piDocsSkillRegistration("no block here", agentDir)).toBeUndefined();

			const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
			try {
				expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeUndefined();
			} finally {
				if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
				else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("pi-docs gate integrity (review findings)", () => {
	it("real layout strips: no blank line before Current working directory", async () => {
		const { stripPiDocsBlock } = await import("../pi-docs");
		const realLayout = `Guidelines:\n- Be concise\n\n${REAL_BLOCK}\nCurrent working directory: /tmp`;
		const result = stripPiDocsBlock(realLayout);
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).toBe("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp");
	});

	it("returns undefined when the prompt starts with the block (no \\n\\n anchor)", async () => {
		const { stripPiDocsBlock } = await import("../pi-docs");
		expect(stripPiDocsBlock(`${REAL_BLOCK}\n\nNext section`)).toBeUndefined();
	});

	it("registration fails open on unwritable agentDir", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, chmodSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-ro-"));
		try {
			chmodSync(agentDir, 0o500);
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeUndefined();
		} finally {
			chmodSync(agentDir, 0o700);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registration honors --no-skills", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-ns-"));
		try {
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "--no-skills", "-p", "hi"])).toBeUndefined();
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "-ns"])).toBeUndefined();
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "--", "--no-skills"])).toBeDefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("applyPiDocsStrip (strip follows the authoritative loaded skill)", () => {
	it("strips only when our skill is the loaded one at our path and read is active", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-strip-"));
		try {
			const stock = promptWithBlock(REAL_BLOCK);
			expect(piDocsSkillRegistration(stock, agentDir)).toBeDefined();

			const ourPath = piDocsSkillFilePath(agentDir);
			const loaded = [
				{ name: "other", filePath: "/home/x/.pi/agent/skills/other/SKILL.md" },
				{ name: "pi-docs", filePath: ourPath },
			];
			const stripped = applyPiDocsStrip(stock, { skills: loaded, selectedTools: ["read", "bash"] }, agentDir);
			expect(stripped).toBeDefined();
			expect(stripped!).not.toContain("Pi documentation (read only");

			// not loaded at our path (user's own pi-docs won the first-wins collision): stock stays
			const colliding = [{ name: "pi-docs", filePath: "/home/x/.pi/agent/skills/pi-docs/SKILL.md" }];
			expect(applyPiDocsStrip(stock, { skills: colliding }, agentDir)).toBeUndefined();

			// selectedTools without "read" still strips: verified live that the event's
			// selectedTools does not reflect the prompt-build toolset (exec_command reads)
			const noReadListed = applyPiDocsStrip(stock, { skills: loaded, selectedTools: ["exec_command"] }, agentDir);
			expect(noReadListed).toBeDefined();

			// no authoritative skill set at all: stock stays
			expect(applyPiDocsStrip(stock, {}, agentDir)).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

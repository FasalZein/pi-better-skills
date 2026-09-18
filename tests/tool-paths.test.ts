import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { extractPathCandidates } from "../tool-paths";

describe("extractPathCandidates (structured keys)", () => {
	it("resolves a relative path key against the base dir", () => {
		expect(extractPathCandidates({ path: "src/components/Button.widget" }, "/repo")).toEqual([
			resolve("/repo/src/components/Button.widget"),
		]);
	});

	it("keeps absolute paths and dedupes repeated candidates", () => {
		expect(extractPathCandidates({ path: "/repo/a.ts", file_path: "/repo/a.ts" }, "/repo")).toEqual(["/repo/a.ts"]);
	});

	it("ignores non-string and empty values", () => {
		expect(extractPathCandidates({ path: 7, filePath: "", nested: { path: null } }, "/repo")).toEqual([]);
	});

	it("reads every entry of a list-valued path key", () => {
		// MCP read_multiple_files and friends pass a list, not a single string.
		expect(extractPathCandidates({ paths: ["src/App.tsx", "src/Other.tsx"] }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
			resolve("/repo/src/Other.tsx"),
		]);
		expect(extractPathCandidates({ files: ["a.css"], file_paths: ["b.css"] }, "/repo")).toEqual([
			resolve("/repo/a.css"),
			resolve("/repo/b.css"),
		]);
	});

	it("resolves a list-valued path key against a workdir base key", () => {
		expect(extractPathCandidates({ workdir: "src", paths: ["App.tsx"] }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/App.tsx"),
		]);
	});

	it("skips non-string entries inside a list-valued path key", () => {
		expect(extractPathCandidates({ paths: [7, null, "src/App.tsx", { path: "nested.tsx" }] }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
		]);
	});

	it("does not treat a list under a non-path key as paths", () => {
		expect(extractPathCandidates({ args: ["src/App.tsx"] }, "/repo")).toEqual([]);
	});
});

describe("extractPathCandidates (free-form strings)", () => {
	it("never extracts paths from a command string", () => {
		// A command line names paths it may only mention (ls, git log, rm), so a
		// token there is not evidence that the file was opened.
		expect(extractPathCandidates({ command: "cat src/components/Button.widget" }, "/repo")).toEqual([]);
		expect(extractPathCandidates({ cmd: "ls -la src/App.tsx" }, "/repo")).toEqual([]);
	});

	it("still resolves a structured path key against a workdir in the same record", () => {
		expect(extractPathCandidates({ cmd: "sed -n 1,5p tests/helper.ts", workdir: "/repo/src", file: "tests/helper.ts" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/tests/helper.ts"),
		]);
	});

	it("ignores blank base keys", () => {
		expect(extractPathCandidates({ command: "   ", workdir: "  " }, "/repo")).toEqual([]);
	});

	it("does not re-emit a relative workdir as its own child path", () => {
		expect(extractPathCandidates({ workdir: "src", path: "helper.ts" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/helper.ts"),
		]);
	});
});

describe("extractPathCandidates (nesting and budgets)", () => {
	it("walks nested records with their base and stops at the depth limit", () => {
		expect(
			extractPathCandidates(
				{
					details: {
						cwd: "/repo/src",
						path: "helper.ts",
						deeper: { ignored: { path: "not-reached.ts" } },
					},
				},
				"/repo",
			),
		).toEqual([resolve("/repo/src"), resolve("/repo/src/helper.ts")]);
	});

	it("includes candidates at the maximum nested-record depth", () => {
		expect(extractPathCandidates({ level1: { level2: { path: "files/depth-two.ts" } } }, "/repo")).toEqual([
			resolve("/repo/files/depth-two.ts"),
		]);
	});

	it("enforces the candidate budget", () => {
		const input = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`nested${index}`, { path: `files/${index}.ts` }]),
		);
		expect(extractPathCandidates(input, "/repo")).toHaveLength(16);
	});
});

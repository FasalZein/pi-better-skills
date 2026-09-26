/**
 * Bounded map of where pi-ai 0.87.1 puts the system prompt text in a wire
 * payload, verified against the installed dist/api/*.js builders:
 *
 * - openai-completions / mistral-conversations: `messages[0]` with role
 *   "system", or "developer" for reasoning models (same instruction text).
 * - openai-responses / azure-openai-responses: `input[0]`, same role split.
 * - anthropic-messages: `system` is an array of `{type:"text", text,
 *   cache_control?}` blocks; under OAuth, `system[0]` is the Claude Code
 *   identity and the prompt sits in `system[1]`.
 * - bedrock-converse: `system` is an array of `{text}` blocks followed by a
 *   `{cachePoint}` block.
 * - openai-codex-responses: `instructions` is a string.
 * - google-generative-ai / google-vertex: `config.systemInstruction` is a
 *   string.
 *
 * The pi-docs strip and the agent_skills re-assertion enforce their contracts
 * at before_provider_request, which runs after pi applies any
 * before_agent_start forced prompt (that projection replaces the leading
 * system message with flat text built from the base prompt, discarding every
 * context_with_system head edit). A payload holds at most one of the shapes
 * above; unknown shapes yield no slots and callers must fail open rather than
 * guess. This table is provider coupling by design: extend it only when pi-ai
 * adds or moves a system-text carrier, and keep every entry mechanical.
 */

export interface PayloadTextSlot {
	/** Current text of the slot; undefined when the slot carries no text. */
	read(): string | undefined;
	/** Replace the slot's text in place, leaving sibling fields untouched. */
	write(text: string): void;
}

/** A leading `{role, content}` instruction message; role varies by model, not by slot. */
function instructionMessageSlot(message: unknown): PayloadTextSlot | undefined {
	if (!message || typeof message !== "object") return undefined;
	const head = message as { role?: unknown; content?: unknown };
	if ((head.role !== "system" && head.role !== "developer") || typeof head.content !== "string") return undefined;
	const instruction = message as { role: string; content: string };
	return {
		read: () => instruction.content,
		write: (text: string) => {
			instruction.content = text;
		},
	};
}

/** Every system-text slot this payload shape exposes; empty for unknown shapes. */
export function payloadSystemSlots(payload: unknown): PayloadTextSlot[] {
	if (!payload || typeof payload !== "object") return [];
	const record = payload as Record<string, unknown>;
	const slots: PayloadTextSlot[] = [];

	// openai-completions / mistral: messages[0]; openai-responses / azure: input[0].
	const byMessage = instructionMessageSlot(
		Array.isArray(record.messages) ? (record.messages as unknown[])[0] : undefined,
	) ?? instructionMessageSlot(Array.isArray(record.input) ? (record.input as unknown[])[0] : undefined);
	if (byMessage) slots.push(byMessage);

	// anthropic-messages ({type:"text",text}) and bedrock-converse ({text});
	// anthropic OAuth puts a fixed identity block first, cachePoint blocks carry no text.
	if (Array.isArray(record.system)) {
		for (const block of record.system as Array<Record<string, unknown>>) {
			if (
				block &&
				typeof block === "object" &&
				typeof block.text === "string" &&
				(block.type === undefined || block.type === "text")
			) {
				const textBlock = block as { text: string };
				slots.push({
					read: () => textBlock.text,
					write: (text: string) => {
						textBlock.text = text;
					},
				});
			}
		}
	}

	// openai-codex-responses.
	if (typeof record.instructions === "string") {
		const instructions = record as { instructions: string };
		slots.push({
			read: () => instructions.instructions,
			write: (text: string) => {
				instructions.instructions = text;
			},
		});
	}

	// google-generative-ai / google-vertex.
	const config = record.config;
	if (config && typeof config === "object" && typeof (config as { systemInstruction?: unknown }).systemInstruction === "string") {
		const googleConfig = config as { systemInstruction: string };
		slots.push({
			read: () => googleConfig.systemInstruction,
			write: (text: string) => {
				googleConfig.systemInstruction = text;
			},
		});
	}

	return slots;
}

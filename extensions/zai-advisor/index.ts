/**
 * ZAI Advisor Strategy Extension
 *
 * Implements the "advisor strategy" (https://claude.com/blog/the-advisor-strategy)
 * using Zhipu AI GLM-5 and GLM-5.1 models.
 *
 * Architecture:
 *   - GLM-5 (or GLM-5-Turbo) runs as the **executor** — calling tools, reading files,
 *     iterating toward a solution.
 *   - When the executor hits a decision it can't solve, it calls the `advisor` tool.
 *   - GLM-5.1 acts as the **advisor** — it receives curated context, returns a plan,
 *     correction, or stop signal. It never calls tools or produces user-facing output.
 *   - The executor resumes with the advisor's guidance.
 *
 * This inverts the common orchestrator→worker pattern: the smaller model drives and
 * escalates only when needed, keeping most of the run at executor-level cost.
 *
 * Usage:
 *   1. Set ZAI_API_KEY in your environment or auth.json
 *   2. Switch to a ZAI executor model: `/model zai/glm-5` or `/model zai/glm-5-turbo`
 *   3. The `advisor` tool becomes available automatically
 *   4. The executor model will consult GLM-5.1 when it needs guidance
 *
 * Configuration via environment variables:
 *   ZAI_ADVISOR_MODEL    - Advisor model ID (default: glm-5.1)
 *   ZAI_ADVISOR_MAX_USES - Max advisor calls per turn (default: 5)
 *   ZAI_API_KEY          - ZAI API key (used for both executor and advisor)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ADVISOR_MODEL = process.env.ZAI_ADVISOR_MODEL ?? "glm-5.1";
const MAX_ADVISOR_USES = parseInt(process.env.ZAI_ADVISOR_MAX_USES ?? "3", 10);
const ADVISOR_SYSTEM_PROMPT = `You are an expert advisor model. Your role is to provide high-level guidance, strategic direction, and corrections to an executor agent that is working on a coding task.

Rules:
- Analyze the executor's current state and the problem description
- Provide clear, actionable guidance
- If the executor is on the right track, confirm and suggest next steps
- If the executor is going wrong, provide a correction
- If the task is complete or impossible, say so explicitly
- Be concise — aim for 400-700 tokens of guidance
- Do NOT write code yourself; guide the executor
- Focus on strategy, architecture decisions, and debugging approaches
- If you see the executor is in a loop or stuck, suggest an alternative approach`;

// Track advisor usage per turn
let advisorUseCount = 0;
let currentTurnIndex = -1;

// ---------------------------------------------------------------------------
// Advisor API call
// ---------------------------------------------------------------------------

async function callAdvisor(
	apiKey: string,
	context: string,
	question: string,
	signal?: AbortSignal,
): Promise<{ guidance: string; tokens: { input: number; output: number } }> {
	const response = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: ADVISOR_MODEL,
			messages: [
				{ role: "system", content: ADVISOR_SYSTEM_PROMPT },
				{
					role: "user",
					content: `## Current Context\n\n${context}\n\n## Question for Advisor\n\n${question}`,
				},
			],
			max_tokens: 2048,
			temperature: 0.3,
		}),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw new Error(`Advisor API call failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		choices: Array<{ message: { content: string } }>;
		usage?: { prompt_tokens: number; completion_tokens: number };
	};

	const guidance = data.choices?.[0]?.message?.content ?? "(advisor returned no guidance)";
	const tokens = {
		input: data.usage?.prompt_tokens ?? 0,
		output: data.usage?.completion_tokens ?? 0,
	};

	return { guidance, tokens };
}

// ---------------------------------------------------------------------------
// Helper: get API key
// ---------------------------------------------------------------------------

function getZaiApiKey(): string | null {
	// Check environment variable first
	if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
	return null;
}

// ---------------------------------------------------------------------------
// Helper: build context summary from session
// ---------------------------------------------------------------------------

function buildContextSummary(ctx: any): string {
	const entries = ctx.sessionManager.getEntries();
	const recentEntries = entries.slice(-20); // Last 20 entries for context

	const parts: string[] = [];
	for (const entry of recentEntries) {
		if (entry.type === "user") {
			const text =
				typeof entry.message?.content === "string"
					? entry.message.content
					: Array.isArray(entry.message?.content)
						? entry.message.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: "";
			if (text) parts.push(`[User]: ${text.slice(0, 500)}`);
		} else if (entry.type === "assistant") {
			const text =
				typeof entry.message?.content === "string"
					? entry.message.content
					: Array.isArray(entry.message?.content)
						? entry.message.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: "";
			if (text) parts.push(`[Assistant]: ${text.slice(0, 500)}`);
		}
	}
	return parts.join("\n\n").slice(0, 8000); // Cap context size
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Track turn resets
	pi.on("turn_start", async (event) => {
		if (event.turnIndex !== currentTurnIndex) {
			currentTurnIndex = event.turnIndex;
			advisorUseCount = 0;
		}
	});

	// Inject advisor guidance into system prompt when using ZAI executor
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		// Only inject for ZAI provider models (glm-5, glm-5-turbo, etc.)
		const isZaiExecutor =
			model.provider === "zai" && (model.id.includes("glm-5") || model.id.includes("glm-4"));

		if (!isZaiExecutor) return;

		const advisorInstructions = `

## Advisor Tool

You have access to an \`advisor\` tool powered by ${ADVISOR_MODEL} (a more capable model). Use it when:

1. **You're stuck** — you've tried an approach and it's not working, and you need a fresh perspective
2. **Complex decisions** — architectural choices, trade-offs between multiple approaches
3. **Debugging dead-ends** — you can't figure out why something isn't working after 2-3 attempts
4. **Planning** — before starting a large refactoring or multi-step task, consult the advisor for a plan

Do NOT use the advisor for:
- Simple lookups or reads
- Straightforward edits you're confident about
- Tasks where you already know the exact steps

When calling the advisor, provide:
- A clear description of the current state
- What you've tried so far
- The specific question or decision you need help with

You may call the advisor up to ${MAX_ADVISOR_USES} times per conversation turn.`;

		return {
			systemPrompt: event.systemPrompt + advisorInstructions,
		};
	});

	// Register the advisor tool
	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description: `Consult the ${ADVISOR_MODEL} advisor model for guidance on complex decisions, debugging dead-ends, or strategic planning. The advisor analyzes your context and returns actionable guidance.`,
		promptSnippet: `Consult ${ADVISOR_MODEL} advisor for guidance on complex decisions or when stuck`,
		promptGuidelines: [
			"Use advisor when stuck after multiple attempts, facing architectural decisions, or needing a strategic plan.",
			"Do NOT use advisor for simple tasks you can handle confidently.",
			"Provide clear context and a specific question when calling advisor.",
		],
		parameters: Type.Object({
			context: Type.String({
				description:
					"Description of the current state: what you've done, what's working, what's not. Include relevant code snippets or error messages.",
			}),
			question: Type.String({
				description:
					"The specific question or decision you need the advisor's help with. Be precise about what guidance you need.",
			}),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			// Check usage limit
			if (advisorUseCount >= MAX_ADVISOR_USES) {
				return {
					content: [
						{
							type: "text",
							text: `Advisor call limit reached (${MAX_ADVISOR_USES} per turn). Continue with your best judgment or wait for the next turn.`,
						},
					],
					details: { limitReached: true, maxUses: MAX_ADVISOR_USES },
					isError: false,
				};
			}

			// Get API key
			const apiKey = getZaiApiKey();
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Advisor unavailable: ZAI_API_KEY not set. Set it in your environment or ~/.pi/agent/auth.json.",
						},
					],
					details: { error: "missing_api_key" },
					isError: true,
				};
			}

			advisorUseCount++;

			// Enrich context with session history
			const sessionContext = buildContextSummary(ctx);
			const fullContext = sessionContext
				? `## Session History (recent)\n${sessionContext}\n\n## Executor's Context\n${params.context}`
				: params.context;

			try {
				const result = await callAdvisor(apiKey, fullContext, params.question, signal);

				return {
					content: [
						{
							type: "text",
							text: result.guidance,
						},
					],
					details: {
						model: ADVISOR_MODEL,
						tokens: result.tokens,
						useCount: advisorUseCount,
						maxUses: MAX_ADVISOR_USES,
						remainingUses: MAX_ADVISOR_USES - advisorUseCount,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Advisor call failed: ${message}. Continue with your best judgment.`,
						},
					],
					details: { error: message, useCount: advisorUseCount },
					isError: false, // Not a blocking error — executor should continue
				};
			}
		},

		// Custom rendering for the tool call
		renderCall(args, theme) {
			const preview =
				args.question?.length > 80
					? `${args.question.slice(0, 80)}...`
					: args.question ?? "(no question)";
			return new Text(
				[
					theme.fg("toolTitle", theme.bold("advisor ")) +
						theme.fg("accent", ADVISOR_MODEL) +
						theme.fg("muted", ` [${advisorUseCount}/${MAX_ADVISOR_USES}]`),
					`  ${theme.fg("dim", preview)}`,
				].join("\n"),
				0,
				0,
			);
		},

		// Custom rendering for the tool result
		renderResult(result, _options, theme) {
			const details = result.details as {
				model?: string;
				tokens?: { input: number; output: number };
				useCount?: number;
				remainingUses?: number;
				limitReached?: boolean;
				error?: string;
			} | undefined;

			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "(no output)";

			const header = details?.limitReached
				? theme.fg("warning", "advisor") + theme.fg("muted", " (limit reached)")
				: details?.error
					? theme.fg("error", "advisor") + theme.fg("muted", ` (error)`)
					: theme.fg("success", "advisor") +
						theme.fg("muted", ` (${details?.model ?? ADVISOR_MODEL})`);

			const parts = [header];

			if (details?.tokens) {
				parts.push(
					theme.fg(
						"dim",
						`tokens: ↑${details.tokens.input} ↓${details.tokens.output} | uses: ${details.useCount}/${MAX_ADVISOR_USES}`,
					),
				);
			}

			// Show guidance (truncated in collapsed view)
			const lines = output.split("\n");
			const preview = lines.slice(0, 8).join("\n");
			parts.push("");
			parts.push(theme.fg("toolOutput", preview));
			if (lines.length > 8) {
				parts.push(theme.fg("muted", `... +${lines.length - 8} more lines (Ctrl+O to expand)`));
			}

			return new Text(parts.join("\n"), 0, 0);
		},
	});

	// Register a command to check advisor status
	pi.registerCommand("advisor-status", {
		description: "Show advisor strategy status and configuration",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const isZai = model?.provider === "zai";
			const apiKeySet = !!getZaiApiKey();

			ctx.ui.notify(
				[
					`Advisor Strategy Status`,
					`  Executor: ${model ? `${model.provider}/${model.id}` : "none"}`,
					`  Advisor model: ${ADVISOR_MODEL}`,
					`  Advisor available: ${isZai && apiKeySet ? "✓" : "✗"}`,
					`  API key: ${apiKeySet ? "set" : "NOT SET"}`,
					`  Uses this turn: ${advisorUseCount}/${MAX_ADVISOR_USES}`,
					``,
					`  ${isZai ? "Running with ZAI executor — advisor tool is active." : "Not using ZAI executor — switch to zai/glm-5 with /model"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

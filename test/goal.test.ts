import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxContentBlock,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getSystemMessageText,
	type Message,
} from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension, { GOAL_NOTE, type Goal, MAX_STALLS, parseVerdict, remindOfGoal } from "../src/goal.ts";

const look: ToolDefinition = {
	name: "look",
	label: "look",
	description: "Look at something",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "seen" }], details: {} }),
};

interface Pi {
	session: AgentSession;
	faux: FauxProviderRegistration;
	dir: string;
}

const running: Pi[] = [];

/** A pi session through the SDK, on a scripted model, with the goal extension unless told otherwise. */
async function start(
	options: { goal?: boolean; sessionManager?: SessionManager; tokensPerSecond?: number } = {},
): Promise<Pi> {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-"));
	const faux = registerFauxProvider({ tokensPerSecond: options.tokensPerSecond });
	const model = faux.getModel();
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				[model.provider]: {
					baseUrl: model.baseUrl,
					apiKey: "faux",
					api: faux.api,
					models: faux.models.map(({ id, name, api, reasoning, input, contextWindow, maxTokens, cost }) => ({
						id,
						name,
						api,
						reasoning,
						input,
						contextWindow,
						maxTokens,
						cost,
					})),
				},
			},
		}),
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: options.goal === false ? [] : [{ name: "goal", factory: goalExtension }],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		resourceLoader,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory(),
		noTools: "builtin",
		customTools: [look],
	});
	await session.bindExtensions({});
	const pi = { session, faux, dir };
	running.push(pi);
	return pi;
}

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Until every scripted reply is used and the session has nothing left to run. */
async function done(pi: Pi): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (pi.faux.getPendingResponseCount() === 0 && pi.session.isIdle) break;
		await settle();
	}
	await pi.session.waitForIdle();
	await settle(50);
}

function goalState(pi: Pi): Goal | null | undefined {
	const entries = pi.session.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === "goal-state") return entry.data as Goal | null;
	}
	return undefined;
}

function text(message: Message | undefined): string {
	if (!message || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** A reply that records the request it answers. */
function reply(requests: Message[][], content: FauxContentBlock[] | string): FauxResponseFactory {
	return (context) => {
		requests.push([...context.messages]);
		const blocks = typeof content === "string" ? [fauxText(content)] : content;
		return fauxAssistantMessage(blocks, {
			stopReason: blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		});
	};
}

describe("/goal", () => {
	afterEach(() => {
		for (const pi of running.splice(0)) {
			pi.session.dispose();
			pi.faux.unregister();
			rmSync(pi.dir, { recursive: true, force: true });
		}
	});

	it("keeps the model working until the reviewer finds the goal met, the reviewer's word leading each round", async () => {
		const pi = await start();
		const requests: Message[][] = [];
		pi.faux.setResponses([
			reply(requests, [fauxToolCall("look", {})]),
			reply(requests, "fixed the first test"),
			reply(requests, '{"verdict":"continue","reason":"the second test still fails","next_step":"fix the second"}'),
			reply(requests, [fauxToolCall("look", {})]),
			reply(requests, "fixed the second test too"),
			reply(requests, 'Here: {"verdict":"done","reason":"both tests pass in the output"}'),
		]);
		await pi.session.prompt("/goal make both tests pass");
		await done(pi);

		expect(goalState(pi)).toMatchObject({ status: "complete", reason: "both tests pass in the output" });
		// the kickoff carries the objective; the model reads it as the user's
		expect(text(requests[0]?.at(-1))).toContain("<objective>\nmake both tests pass\n</objective>");
		// the reviewer's request is the model's own, its reply and the question after it
		const [worker, reviewer] = [requests[1]!, requests[2]!];
		expect(reviewer.slice(0, worker.length)).toEqual(worker);
		expect(text(reviewer.at(-2))).toBe("fixed the first test");
		expect(text(reviewer.at(-1))).toContain("you are now the reviewer");
		// the next round starts from what the reviewer found missing
		expect(text(requests[3]?.at(-1))).toContain("the second test still fails\nNext step: fix the second");
		// and the reviewer's answers stay out of the session
		expect(JSON.stringify(pi.session.messages)).not.toContain('"verdict"');
	});

	it("adds nothing to the system prompt or the tools, with or without a goal", async () => {
		const plain = await start({ goal: false });
		const withGoal = await start();
		const prompts: string[] = [];
		const system: FauxResponseFactory = (context) => {
			prompts.push(
				context.messages
					.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
					.join(),
			);
			return fauxAssistantMessage(prompts.length === 3 ? '{"verdict":"done","reason":"said"}' : "hello");
		};
		plain.faux.setResponses([system]);
		withGoal.faux.setResponses([system, system]);
		await plain.session.prompt("say hello");
		await done(plain);
		await withGoal.session.prompt("/goal say hello");
		await done(withGoal);
		// each session has its own directory
		expect(prompts[1]?.replaceAll(withGoal.dir, "<cwd>")).toBe(prompts[0]?.replaceAll(plain.dir, "<cwd>"));
		expect(withGoal.session.getActiveToolNames()).toEqual(plain.session.getActiveToolNames());
	});

	it(`pauses after ${MAX_STALLS} rounds that call no tools or draw the same complaint`, async () => {
		const pi = await start();
		const requests: Message[][] = [];
		const complaint = '{"verdict":"continue","reason":"nothing was run","next_step":"run the tests"}';
		pi.faux.setResponses([
			reply(requests, "thinking about it"),
			reply(requests, complaint),
			reply(requests, "still thinking"),
			reply(requests, complaint),
			reply(requests, "almost"),
			reply(requests, complaint),
		]);
		await pi.session.prompt("/goal make the tests pass");
		await done(pi);
		expect(goalState(pi)).toMatchObject({ status: "paused", reason: "not getting anywhere: nothing was run" });
		expect(requests).toHaveLength(6);
	});

	it("pauses when the model is blocked, goes on after /goal resume, and drops the goal on /goal clear", async () => {
		const pi = await start();
		const requests: Message[][] = [];
		pi.faux.setResponses([
			reply(requests, "I need the API key"),
			reply(requests, '{"verdict":"blocked","reason":"needs the API key from the user"}'),
		]);
		await pi.session.prompt("/goal deploy it");
		await done(pi);
		expect(goalState(pi)).toMatchObject({ status: "paused", reason: "needs the API key from the user" });

		pi.faux.setResponses([
			reply(requests, [fauxToolCall("look", {})]),
			reply(requests, "deployed"),
			reply(requests, '{"verdict":"done","reason":"the deploy log says live"}'),
		]);
		await pi.session.prompt("/goal resume");
		await done(pi);
		expect(text(requests[2]?.at(-1))).toContain("The user resumed the goal.");
		expect(goalState(pi)).toMatchObject({ status: "complete", rounds: 0 });

		await pi.session.prompt("/goal clear");
		expect(goalState(pi)).toBeNull();
	});

	it("pauses the goal when the run is interrupted", async () => {
		const pi = await start({ tokensPerSecond: 20 });
		pi.faux.setResponses([fauxAssistantMessage("working on it, slowly, one word at a time, for quite a while now")]);
		await pi.session.prompt("/goal finish the report");
		for (let attempt = 0; attempt < 100 && !pi.session.isStreaming; attempt++) await settle();
		await pi.session.abort();
		await done(pi);
		expect(goalState(pi)).toMatchObject({ status: "paused", reason: "stopped by the user" });
	});

	it("pauses a goal it finds active as a session starts, since no run drives it", async () => {
		const sessionManager = SessionManager.inMemory();
		const active: Goal = { id: "g1", objective: "ship it", status: "active", rounds: 2, stalls: 0 };
		sessionManager.appendCustomEntry("goal-state", active);
		const pi = await start({ sessionManager });
		expect(goalState(pi)).toMatchObject({
			id: "g1",
			status: "paused",
			reason: "pi stopped while the goal was active",
		});
	});

	it("puts the objective at the end of a request that no longer shows the goal's notes", () => {
		const goal: Goal = { id: "g1", objective: "keep <tests> green", status: "active", rounds: 4, stalls: 0 };
		const summary = { role: "user" as const, content: "summary of earlier work", timestamp: 1 };
		expect(remindOfGoal([summary], goal)?.at(-1)).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "summary of earlier work" },
				{ type: "text", text: expect.stringContaining("<objective>\nkeep &lt;tests&gt; green\n</objective>") },
			],
		});
		// a note still in view is enough
		const note = {
			role: "custom" as const,
			customType: GOAL_NOTE,
			content: "kickoff",
			display: false,
			details: { goalId: "g1" },
			timestamp: 2,
		};
		expect(remindOfGoal([note, summary], goal)).toBeUndefined();
	});

	it("reads the reviewer's verdict in a fence or a sentence, and nothing else", () => {
		expect(parseVerdict('```json\n{"verdict":"done","reason":"ok"}\n```')).toEqual({ verdict: "done", reason: "ok" });
		expect(parseVerdict('so: {"verdict":"continue","reason":"r","next_step":"n"}.')).toEqual({
			verdict: "continue",
			reason: "r",
			next_step: "n",
		});
		expect([
			parseVerdict("done"),
			parseVerdict('{"verdict":"maybe","reason":"r"}'),
			parseVerdict('{"verdict":"done"}'),
		]).toEqual([undefined, undefined, undefined]);
	});
});

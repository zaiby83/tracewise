// Checks a candidate judge model against human labels before trusting its scores.
// Calls Bedrock directly with the same prompt the workflow uses.
// Usage: AWS_PROFILE=tracewise AWS_REGION=us-east-1 pnpm exec tsx scripts/calibrate-judge.ts <modelId> [<modelId>...]
import { readFile } from "node:fs/promises";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { judgeMessages, parseScores } from "../services/evals/judge-prompt";

const models = process.argv.slice(2);
if (!models.length) throw new Error("pass one or more Bedrock model ids");
const cases = JSON.parse(await readFile(new URL("../eval/conversations.json", import.meta.url), "utf8")) as {
	label: "good" | "bad";
	kind: string;
	input: string;
	output: string;
}[];
const bedrock = new BedrockRuntimeClient({});
// An answer counts as "judged bad" below this overall score (1-5 scale).
const BAD_BELOW = 3;

for (const modelId of models) {
	const started = performance.now();
	const results = await Promise.all(
		cases.map(async (c) => {
			const { system, user } = judgeMessages(c.input, c.output);
			for (let attempt = 0; ; attempt++) {
				try {
					const res = await bedrock.send(
						new ConverseCommand({
							modelId,
							system: [{ text: system }],
							messages: [{ role: "user", content: [{ text: user }] }],
							inferenceConfig: { maxTokens: 200, temperature: 0 },
						}),
					);
					const scores = parseScores(res.output?.message?.content?.map((p) => p.text ?? "").join("") ?? "");
					return { ...c, scores, tokens: res.usage?.totalTokens ?? 0 };
				} catch (err) {
					if ((err as Error).name === "ThrottlingException" && attempt < 5) {
						await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
						continue;
					}
					return { ...c, scores: null, tokens: 0, error: (err as Error).message };
				}
			}
		}),
	);

	const graded = results.filter((r) => r.scores);
	const judgedBad = (r: (typeof results)[number]) => r.scores!.overall < BAD_BELOW;
	const agree = graded.filter((r) => judgedBad(r) === (r.label === "bad")).length;
	const caught = graded.filter((r) => r.label === "bad" && judgedBad(r)).length;
	const bad = graded.filter((r) => r.label === "bad").length;
	const falseAlarms = graded.filter((r) => r.label === "good" && judgedBad(r)).length;
	const good = graded.filter((r) => r.label === "good").length;

	console.log(`\n== ${modelId}  (${Math.round(performance.now() - started)} ms total, ${results.reduce((a, r) => a + r.tokens, 0)} tokens)`);
	console.log(`agreement ${agree}/${graded.length}, bad answers caught ${caught}/${bad}, good answers wrongly failed ${falseAlarms}/${good}, unparseable ${results.length - graded.length}`);
	// How the cut-off changes the trade-off between catching bad answers and false alarms.
	const sweep = [2.5, 3, 3.5, 4].map((t) => {
		const caughtAt = graded.filter((r) => r.label === "bad" && r.scores!.overall < t).length;
		const falseAt = graded.filter((r) => r.label === "good" && r.scores!.overall < t).length;
		return `<${t}: caught ${caughtAt}/${bad}, false alarms ${falseAt}/${good}`;
	});
	console.log(`threshold sweep: ${sweep.join(" | ")}`);
	for (const r of results) {
		const mark = !r.scores ? "??" : judgedBad(r) === (r.label === "bad") ? "ok" : r.label === "bad" ? "MISS" : "FP";
		const detail = r.scores ? `${r.scores.overall.toFixed(1)} ${r.scores.safety}` : ("error" in r ? String(r.error).slice(0, 60) : "unparseable");
		console.log(`  ${mark.padEnd(4)} ${r.label.padEnd(4)} ${r.kind.padEnd(20)} ${detail}`);
	}
}

// POST /api/review  { contractId } | { text, title }
// Streams Server-Sent Events: progress, facts, rules, text (deltas), done, error.
import { loadData, listContracts, makeClient, extractFacts, applyRules, reviewContract, verifyQuotes, priceUsage, MODEL } from "../lib/pipeline.mjs";

export const config = { supportsResponseStreaming: true, maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const t0 = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    let contractText = body.text, title = body.title || "Pasted contract";
    if (body.contractId) {
      const c = listContracts().find((x) => x.id === body.contractId);
      if (!c) throw new Error("Unknown contract id");
      contractText = c.text; title = c.title;
    }
    if (!contractText || contractText.trim().length < 200) throw new Error("No contract text provided");
    const data = loadData();
    const client = makeClient();
    send("progress", { stage: "extracting facts", ms: Date.now() - t0 });
    const { facts, usage: u1 } = await extractFacts(client, contractText);
    send("facts", facts);
    const rulesOut = applyRules(facts, data.rules);
    send("rules", rulesOut);
    send("progress", { stage: "reviewing clauses", ms: Date.now() - t0, register_entries: (data.register.entries || []).filter((e) => e.confirmed !== false).length });
    let chars = 0;
    const { review, usage: u2 } = await reviewContract(client, {
      contractText, title, data, facts, rulesOut,
      onText: (t) => { chars += t.length; if (chars % 400 < t.length) send("text", { chars }); },
    });
    const verified = verifyQuotes(review, contractText, data.register);
    const cost1 = priceUsage(u1), cost2 = priceUsage(u2);
    send("done", {
      title, facts, rules: rulesOut, review: verified,
      model: MODEL,
      usage: { input_tokens: cost1.input_tokens + cost2.input_tokens, output_tokens: cost1.output_tokens + cost2.output_tokens, usd: +(cost1.usd + cost2.usd).toFixed(4) },
      elapsed_ms: Date.now() - t0,
      label: "AI-generated draft review. Not legal advice. A person decides.",
    });
  } catch (err) {
    send("error", { message: err?.message || String(err), elapsed_ms: Date.now() - t0 });
  } finally {
    res.end();
  }
}

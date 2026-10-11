// Golden test: runs eight contracts covering the trap scenarios from the capstone brief (plus BlueOrchid) through the pipeline locally and
// checks the expected signals. Writes data/golden_results.json and public/golden_results.json.
// Run: node scripts/golden_test.mjs [id ...]   (needs ANTHROPIC_API_KEY in .env). Each run costs real money.
import fs from "node:fs";
import "./load_env.mjs";
import { loadData, listContracts, makeClient, extractFacts, applyRules, reviewContract, verifyQuotes, priceUsage, MODEL } from "../lib/pipeline.mjs";

export const GOLDEN = [
  { id: "2026-09-18_gulf_crown_hotels_msa_draft", scenario: "Collides with something already signed (Al Noor GCC hospitality non-compete)", expect: (r) => r.review.register_conflicts.some((c) => /al noor/i.test(c.register_clause_quote + c.explanation + c.register_id)) && r.review.suggested_next_step === "escalate" },
  { id: "2026-09-19_lakeshore_grocers_msa_draft", scenario: "Pricing promise: senior rate below the Crestline MFN rate card", expect: (r) => r.review.register_conflicts.some((c) => /crestline|favou?rable|mfn/i.test(c.explanation + c.register_clause_quote)) },
  { id: "2026-09-15_travelhub_services_agreement_draft", scenario: "Wrong entity: AtliQ Inc named on a Dubai deal", expect: (r) => r.rules.findings.some((f) => f.check === "entity" && f.status === "conflict") },
  { id: "2026-09-25_finserve_capital_mutual_nda_draft", scenario: "NDA that says mutual but is not", expect: (r) => r.review.mutuality.one_sided_clauses.length > 0 },
  { id: "2026-09-26_kriti_data_labs_subcontractor_agreement_draft", scenario: "AtliQ's own paper unfair to a 12-person agency", expect: (r) => r.facts.is_atliq_paper && r.review.mutuality.one_sided_clauses.length > 0 },
  { id: "2026-09-10_harrington_health_msa_draft", scenario: "Healthcare deal with documents missing (BAA chain, insurance gap)", expect: (r) => r.rules.findings.some((f) => f.check === "paperwork" && f.status !== "ok") && r.rules.findings.some((f) => f.check === "regulated data") },
  { id: "2026-09-27_loopmart_mutual_nda_draft", scenario: "The clean one: should not raise a conflict", expect: (r) => r.review.register_conflicts.length === 0 && r.review.suggested_next_step !== "escalate" },
  { id: "2026-09-21_blueorchid_hotels_pilot_agreement_draft", scenario: "Looks India-only (Jay: 'just India hotels I think') but Annexure B lists Dubai and Muscat properties: must conflict with Al Noor", expect: (r) => r.review.register_conflicts.some((c) => c.severity === "conflict" && /al noor|R-015|R-047/i.test(c.explanation + c.register_id + c.register_clause_quote)) },
];
// Note: the first version of this test expected BlueOrchid to be clean, on the strength of the seller's tracker note.
// The contract's own property list says otherwise. Corrected 10 Oct 2026 after the model flagged it.

export async function runOne(client, data, id) {
  const c = listContracts().find((x) => x.id === id);
  const t0 = Date.now();
  const { facts, usage: u1 } = await extractFacts(client, c.text);
  const rules = applyRules(facts, data.rules);
  const { review, usage: u2 } = await reviewContract(client, { contractText: c.text, title: c.title, data, facts, rulesOut: rules });
  const verified = verifyQuotes(review, c.text, data.register);
  const p1 = priceUsage(u1), p2 = priceUsage(u2);
  return { id, title: c.title, facts, rules, review: verified, usage: { input_tokens: p1.input_tokens + p2.input_tokens, output_tokens: p1.output_tokens + p2.output_tokens, usd: +(p1.usd + p2.usd).toFixed(4) }, elapsed_ms: Date.now() - t0 };
}

if (process.argv[1] && process.argv[1].endsWith("golden_test.mjs")) {
  const only = process.argv.slice(2);
  const data = loadData();
  const client = makeClient();
  const results = [];
  for (const g of GOLDEN.filter((g) => !only.length || only.includes(g.id))) {
    process.stdout.write(`${g.id} ... `);
    try {
      const r = await runOne(client, data, g.id);
      const pass = !!g.expect(r);
      results.push({ ...g, expect: undefined, pass, result: r });
      console.log(`${pass ? "PASS" : "FAIL"}  ${(r.elapsed_ms / 1000).toFixed(0)}s  ${r.usage.input_tokens} in / ${r.usage.output_tokens} out  $${r.usage.usd}  conflicts=${r.review.register_conflicts.length} clauses=${r.review.clauses.length} unverified_quotes=${r.review.unverified_quotes} filter_hits=${r.review.output_filter_hits} next=${r.review.suggested_next_step}`);
    } catch (e) {
      results.push({ ...g, expect: undefined, pass: false, error: e.message });
      console.log(`ERROR ${e.message}`);
    }
  }
  // When only some ids were run, merge into the previous results so the stored file stays complete.
  let merged = results;
  if (only.length && fs.existsSync("data/golden_results.json")) {
    const prev = JSON.parse(fs.readFileSync("data/golden_results.json", "utf8")).results || [];
    merged = GOLDEN.map((g) => results.find((r) => r.id === g.id) || prev.find((r) => r.id === g.id)).filter(Boolean);
  }
  const summary = { run_at: new Date().toISOString(), model: MODEL, passed: merged.filter((r) => r.pass).length, total: merged.length, results: merged };
  fs.writeFileSync("data/golden_results.json", JSON.stringify(summary, null, 2));
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/golden_results.json", JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${summary.total} passed. Total $${results.reduce((s, r) => s + (r.result?.usage.usd || 0), 0).toFixed(3)}. Written to data/golden_results.json`);
}

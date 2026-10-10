// One-time: read every signed contract and extract the binding commitments into data/register.json.
// Run: node scripts/build_register.mjs   (needs ANTHROPIC_API_KEY in .env)
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { makeClient, listContracts, MODEL, priceUsage } from "../lib/pipeline.mjs";
import "./load_env.mjs";

const Entry = z.object({
  type: z.enum(["non-compete", "exclusivity", "pricing promise (MFN)", "IP assignment or licence", "consent or waiver", "non-solicit", "subcontracting restriction", "data handling obligation", "liability or penalty accepted", "other restriction"]),
  scope: z.string(),
  region: z.string(),
  sector: z.string(),
  counterparty: z.string(),
  atliq_entity: z.string(),
  binds_affiliates: z.boolean(),
  start_date: z.string(),
  expiry_or_term: z.string(),
  quoted_clause: z.string(),
  clause_ref: z.string(),
  why_it_matters: z.string(),
});
const Out = z.object({ entries: z.array(Entry) });

const client = makeClient();
const contracts = listContracts("data/signed_contracts");
const entries = [];
let totalUsd = 0;
for (const c of contracts) {
  process.stdout.write(`${c.id} ... `);
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: "medium", format: zodOutputFormat(Out) },
    system: "You build a register of commitments that bind AtliQ in FUTURE deals. From this signed contract, extract every clause that restricts what AtliQ (either entity) may do with other clients, partners or vendors, or that promises something ongoing: non-competes, exclusivity, most-favoured-nation or pricing promises, IP assigned to the client or retained by a freelancer, consents and waivers, non-solicits, subcontracting restrictions, data-handling obligations that flow to subcontractors, and accepted liability or penalty positions that would matter as precedent. Quote each clause verbatim. Use the exact AtliQ entity named in the parties clause. Dates as written; if the expiry depends on the term, say so. Skip ordinary confidentiality and payment clauses. If nothing binds future deals, return an empty list.",
    messages: [{ role: "user", content: c.text }],
  });
  const out = res.parsed_output || { entries: [] };
  for (const e of out.entries) entries.push({ id: `R-${String(entries.length + 1).padStart(3, "0")}`, source_file: c.file, confirmed: true, ...e });
  const cost = priceUsage(res.usage);
  totalUsd += cost.usd;
  console.log(`${out.entries.length} entries (${cost.input_tokens} in / ${cost.output_tokens} out, $${cost.usd.toFixed(4)})`);
}
const register = { built_at: new Date().toISOString(), model: MODEL, note: "Prototype: entries are marked confirmed after the author's review. In production Karandeep confirms each entry before it is used.", entries };
fs.writeFileSync(path.join(process.cwd(), "data/register.json"), JSON.stringify(register, null, 2));
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "public/register.json"), JSON.stringify(register, null, 2));
console.log(`\n${entries.length} entries written to data/register.json and public/register.json. Total cost $${totalUsd.toFixed(3)}`);

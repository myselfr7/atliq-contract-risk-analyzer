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

const OUT_PATH = path.join(process.cwd(), "data/register.json");
const client = makeClient();
const contracts = listContracts("data/signed_contracts");
// Resume: keep entries from files already processed, so a crash or a re-run never repays for finished work.
const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : { entries: [], processed: [] };
const entries = existing.entries || [];
const processed = new Set(existing.processed || []);
let totalUsd = 0;

function save() {
  const register = { built_at: new Date().toISOString(), model: MODEL, note: "Prototype: entries are marked confirmed after the author's review. In production Karandeep confirms each entry before it is used.", processed: [...processed], entries };
  fs.writeFileSync(OUT_PATH, JSON.stringify(register, null, 2));
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "public/register.json"), JSON.stringify(register, null, 2));
}

for (const c of contracts) {
  if (processed.has(c.file)) { console.log(`${c.id} ... already done, skipped`); continue; }
  process.stdout.write(`${c.id} ... `);
  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 20000,
      output_config: { effort: "medium", format: zodOutputFormat(Out) },
      system: "You build a register of commitments that bind AtliQ in FUTURE deals. From this signed contract, extract only the clauses that restrict what AtliQ (either entity) may do with OTHER clients, partners or vendors, or that promise something ongoing beyond this deal: non-competes, exclusivity, most-favoured-nation or pricing promises, IP assigned to the client or retained by a freelancer, consents and waivers, non-solicits, subcontracting restrictions, and data-handling obligations that must flow down to subcontractors. Record an accepted liability or penalty position only if it is unusual enough to matter as precedent (for example an uncapped penalty or a cap above AtliQ's normal 1x fees). Skip ordinary confidentiality, payment, termination, warranty and boilerplate clauses. Keep quoted_clause to the operative sentence or two, at most 60 words, verbatim. Keep scope and why_it_matters to one sentence each. Use the exact AtliQ entity named in the parties clause. Dates as written; if the expiry depends on the term, say so. If nothing binds future deals, return an empty list. Aim for the 2 to 6 entries that a lawyer would put on a register, not every clause.",
      messages: [{ role: "user", content: c.text }],
    });
    if (res.stop_reason === "max_tokens") throw new Error("output cut off by max_tokens");
    const out = res.parsed_output || { entries: [] };
    for (const e of out.entries) entries.push({ id: `R-${String(entries.length + 1).padStart(3, "0")}`, source_file: c.file, confirmed: true, ...e });
    processed.add(c.file);
    save();
    const cost = priceUsage(res.usage);
    totalUsd += cost.usd;
    console.log(`${out.entries.length} entries (${cost.input_tokens} in / ${cost.output_tokens} out, $${cost.usd.toFixed(4)})`);
  } catch (e) {
    console.log(`FAILED: ${e.message}. Re-run the script to retry this file; finished files are kept.`);
  }
}
console.log(`\n${entries.length} entries in data/register.json (${processed.size} of ${contracts.length} files processed). This run cost $${totalUsd.toFixed(3)}`);
if (processed.size < contracts.length) process.exitCode = 2;

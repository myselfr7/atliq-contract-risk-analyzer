// Shared review pipeline. Used by api/review.js (Vercel function) and by scripts/ (local tests).
// Everything the model is told lives here, so the prompt is one artefact a PM can read.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const MODEL = process.env.REVIEW_MODEL || "claude-opus-5-5";
// The synthetic dataset's "today" (README). Override with TODAY=YYYY-MM-DD for real use.
export const TODAY = process.env.TODAY || "28 September 2026";
const ROOT = process.env.DATA_ROOT || process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

export function loadData() {
  const rules = JSON.parse(read("data/rules.json"));
  const register = fs.existsSync(path.join(ROOT, "data/register.json"))
    ? JSON.parse(read("data/register.json"))
    : { entries: [], built_at: null };
  return {
    rules,
    register,
    checklist: read("data/karandeep_contract_checklist.md"),
    entities: read("data/atliq_entities.md"),
    negotiation: read("data/negotiation_notes.md"),
  };
}

export function listContracts(folder = "data/incoming") {
  return fs
    .readdirSync(path.join(ROOT, folder))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = read(`${folder}/${f}`);
      // Title from the file name: "2026-09-10_harrington_health_msa_draft" -> "Harrington Health MSA draft (2026-09-10)"
      const id = f.replace(/\.md$/, "");
      const m = id.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
      const words = (m ? m[2] : id).split("_").map((w) => (/^(msa|sow2?|nda|baa|dpa)$/i.test(w) ? w.toUpperCase() : w === "draft" ? w : w.charAt(0).toUpperCase() + w.slice(1)));
      const title = `${words.join(" ")}${m ? ` (${m[1]})` : ""}`;
      return { id, file: `${folder}/${f}`, title, words: text.split(/\s+/).length, text };
    });
}

// ---------------------------------------------------------------- schemas (structured outputs)
export const FactsSchema = z.object({
  document_type: z.enum(["MSA", "SOW", "services agreement", "NDA", "BAA", "DPA", "partnership agreement", "subcontractor agreement", "contractor agreement", "pilot agreement", "waiver or consent letter", "other"]),
  parties: z.array(z.string()),
  atliq_entity_named: z.enum(["AtliQ Technologies Pvt Ltd", "AtliQ Inc", "both or inconsistent", "not named"]),
  counterparty: z.string(),
  counterparty_country: z.string(),
  governing_law: z.string(),
  courts_or_arbitration: z.string(),
  currency: z.string(),
  value_usd_estimate: z.number().nullable(),
  data_types: z.array(z.enum(["patient data", "personal data (EU/UK)", "guest data", "financial data", "other personal data", "none apparent"])),
  documents_referenced: z.array(z.string()),
  is_atliq_paper: z.boolean(),
  is_labelled_mutual: z.boolean(),
  cyber_insurance_required_usd: z.number().nullable(),
  payment_days: z.number().nullable(),
  deal_category: z.enum(["client services", "client services with patient data (US)", "client services with EU/UK personal data", "partnership", "vendor or subcontractor", "freelancer", "nda"]),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  register_conflicts: z.array(z.object({
    register_id: z.string(),
    severity: z.enum(["conflict", "possible conflict"]),
    incoming_clause_quote: z.string(),
    register_clause_quote: z.string(),
    explanation: z.string(),
  })),
  no_conflicts_statement: z.string(),
  clauses: z.array(z.object({
    clause_ref: z.string(),
    type: z.string(),
    plain_english: z.string(),
    verdict: z.enum(["fine", "needs attention", "conflict"]),
    confidence: z.enum(["high", "low"]),
    quote: z.string(),
    reason: z.string(),
    past_positions: z.string(),
  })),
  mutuality: z.object({
    applies: z.boolean(),
    one_sided_clauses: z.array(z.object({ clause_ref: z.string(), favours: z.string(), quote: z.string(), why: z.string() })),
  }),
  suggested_next_step: z.enum(["sign", "negotiate", "escalate"]),
  next_step_reason: z.string(),
  clauses_to_push_on: z.array(z.string()),
  not_checked: z.array(z.string()),
});

// ---------------------------------------------------------------- rules engine (no AI)
export function applyRules(facts, rules) {
  const findings = [];
  const region = rules.country_to_region[facts.counterparty_country] || "Other";
  const expected = rules.expected_entity_by_region[region];
  if (facts.atliq_entity_named === "not named") {
    findings.push({ check: "entity", status: "attention", text: `No AtliQ entity is clearly named. For a ${facts.counterparty_country} counterparty the expected signing entity is ${expected}.` });
  } else if (facts.atliq_entity_named === "both or inconsistent") {
    findings.push({ check: "entity", status: "conflict", text: `The document names both AtliQ entities or is inconsistent. Expected signing entity for ${facts.counterparty_country}: ${expected}. Finance has had payment delays from exactly this mismatch.` });
  } else if (facts.atliq_entity_named !== expected) {
    findings.push({ check: "entity", status: "conflict", text: `${facts.atliq_entity_named} is named, but AtliQ serves ${facts.counterparty_country} through ${expected}. Wrong entity means the wrong tax regime, invoicing account and legal exposure.` });
  } else {
    findings.push({ check: "entity", status: "ok", text: `${facts.atliq_entity_named} is the expected entity for a ${facts.counterparty_country} counterparty.` });
  }

  const ent = rules.entities[facts.atliq_entity_named] || rules.entities[expected];
  const law = (facts.governing_law || "").toLowerCase();
  const homeLaw = ent.home_law.some((h) => law.includes(h.toLowerCase()));
  const counterpartyLaw = law.includes((facts.counterparty_country || "").toLowerCase()) || (region === "Middle East" && /(dubai|difc|uae|emirates|saudi|oman)/.test(law)) || (region === "Europe" && /(germany|german|france|netherlands|eu\b)/.test(law)) || (region === "UK" && /(england|english|uk|united kingdom)/.test(law));
  if (!facts.governing_law || law === "none" || law === "not stated") {
    findings.push({ check: "governing law", status: "attention", text: "No governing law stated. Ask which law and courts apply before signing." });
  } else if (homeLaw) {
    findings.push({ check: "governing law", status: "ok", text: `Governing law (${facts.governing_law}) matches the signing entity's home jurisdiction.` });
  } else if (counterpartyLaw) {
    findings.push({ check: "governing law", status: "attention", text: `Governing law is the counterparty's (${facts.governing_law}). AtliQ has no presence there. Acceptable only as a deliberate trade (Northwind, Al Noor precedent); note the cost of enforcing or defending abroad. Courts: ${facts.courts_or_arbitration}.` });
  } else {
    findings.push({ check: "governing law", status: "conflict", text: `Governing law is ${facts.governing_law}, which is neither the signing entity's home law nor the counterparty's country. This is the Brightwater pattern (English law on a US deal). Confirm with counsel.` });
  }

  for (const dt of facts.data_types || []) {
    const r = rules.regulated[dt];
    if (r) findings.push({ check: "regulated data", status: "attention", text: `${dt}: ${r.flag}` });
  }

  const needed = rules.documents_by_deal[facts.deal_category] || [];
  const refs = (facts.documents_referenced || []).join(" | ").toLowerCase();
  const missing = needed.filter((d) => {
    const key = d.toLowerCase();
    if (key.startsWith("nda")) return !/nda|non-disclosure|confidentiality agreement/.test(refs) && facts.document_type !== "NDA";
    if (key.includes("business associate")) return !/baa|business associate/.test(refs) && facts.document_type !== "BAA";
    if (key.includes("data processing")) return !/dpa|data processing/.test(refs) && facts.document_type !== "DPA";
    if (key.includes("statement of work")) return !/sow|statement of work/.test(refs) && facts.document_type !== "SOW";
    if (key.includes("master services")) return !/msa|master services|services agreement/.test(refs) && !["MSA", "services agreement"].includes(facts.document_type);
    if (key.includes("subcontractor baa") || key.includes("flow-down") || key.includes("intercompany")) return true; // cannot be verified from one document: always a prompt to check
    return false;
  });
  findings.push({ check: "paperwork", status: missing.length ? "attention" : "ok", text: missing.length ? `For a "${facts.deal_category}" deal the following are expected and not evidenced in this document: ${missing.join("; ")}. Confirm each exists and is signed before data or work moves.` : `Documents expected for a "${facts.deal_category}" deal appear to be referenced.` });

  if (facts.cyber_insurance_required_usd && facts.cyber_insurance_required_usd > rules.numeric_checks.cyber_insurance_held_usd) {
    findings.push({ check: "insurance", status: "conflict", text: `Requires cyber insurance of $${facts.cyber_insurance_required_usd.toLocaleString()}; AtliQ holds $${rules.numeric_checks.cyber_insurance_held_usd.toLocaleString()}. Raise before signing.` });
  }
  if (facts.payment_days && facts.payment_days > rules.numeric_checks.payment_days_atliq_max) {
    findings.push({ check: "payment terms", status: "attention", text: `Payment at ${facts.payment_days} days; AtliQ's checklist says 30, 45 at most (Trustline precedent: 90 negotiated to 45).` });
  }
  return { region, expected_entity: expected, findings };
}

// ---------------------------------------------------------------- guardrails in code
const FORBIDDEN = /\b(safe to sign|is safe|legally compliant|complies with (the )?law|fully compliant|this contract is compliant)\b/i;
// Normalise for matching: lower-case, drop markdown markers and punctuation, collapse whitespace.
// A quote counts as verified if its normalised form (or its first 80 characters) appears in the source.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function verifyQuotes(review, contractText, register) {
  const hay = norm(contractText);
  const regText = norm(JSON.stringify(register.entries || []));
  let unverified = 0;
  const check = (q, source) => {
    if (!q) return false;
    const n = norm(q);
    if (n.length < 12) return false;
    const ok = source.includes(n) || source.includes(n.slice(0, 80));
    if (!ok) unverified++;
    return ok;
  };
  review.clauses = (review.clauses || []).map((c) => ({ ...c, quote_verified: check(c.quote, hay) }));
  review.register_conflicts = (review.register_conflicts || []).map((c) => ({
    ...c,
    incoming_quote_verified: check(c.incoming_clause_quote, hay),
    register_quote_verified: check(c.register_clause_quote, regText),
  }));
  review.mutuality.one_sided_clauses = (review.mutuality?.one_sided_clauses || []).map((c) => ({ ...c, quote_verified: check(c.quote, hay) }));
  const flat = JSON.stringify(review);
  review.output_filter_hits = (flat.match(FORBIDDEN) || []).length;
  review.unverified_quotes = unverified;
  return review;
}

// ---------------------------------------------------------------- prompts
// Entry types that restrict FUTURE deals and belong in the conflict check. Accepted liability or penalty
// positions are precedent, not restrictions, and live with the negotiation history instead.
const CONFLICT_TYPES = new Set(["non-compete", "exclusivity", "pricing promise (MFN)", "IP assignment or licence", "consent or waiver", "non-solicit", "subcontracting restriction", "data handling obligation", "other restriction"]);

export function registerForPrompt(register) {
  return (register.entries || []).filter((e) => e.confirmed !== false && CONFLICT_TYPES.has(e.type));
}

function compactEntry(e) {
  const q = String(e.quoted_clause || "").replace(/\s+/g, " ").slice(0, 320);
  return `${e.id} | ${e.type} | ${e.counterparty} (${e.atliq_entity}${e.binds_affiliates ? ", binds affiliates" : ""}) | scope: ${e.scope} | ${e.region} / ${e.sector} | until: ${e.expiry_or_term} | ${e.clause_ref}: "${q}"`;
}

function systemPrompt(data, facts, rulesOut) {
  const register = registerForPrompt(data.register);
  return `You are the AtliQ Contract Risk Analyzer, a review assistant for a small IT services company with no legal team.
You READ the contract and prepare a brief for a human reviewer. You never approve, sign, or give legal advice, and you never say a contract is "safe" or "compliant". You report what each check found.

Rules you must follow:
1. Every verdict and every conflict must quote the exact words from the contract (copy them verbatim). If you cannot find supporting text, say "not found" in the quote field and set confidence to low. Never invent a clause, a precedent or a rule of law.
2. Cover EVERY clause or section of the contract in the clause table, in document order, including boilerplate. Verdicts: "fine" (acceptable as written), "needs attention" (push back, clarify, or a human judgement call), "conflict" (contradicts an existing AtliQ commitment on the register, or a clear breach of AtliQ's own stated positions such as uncapped liquidated damages or unlimited liability).
3. Past positions are HISTORY, not policy. Quote them with the deal named (from the negotiation history below). AtliQ has no fixed thresholds; the human decides.
4. Mutuality: if the document calls itself mutual, or if it is AtliQ's own paper going to a vendor or freelancer, check whether obligations bind both sides equally and list one-sided clauses whichever side they favour. AtliQ's stated preference is for terms it would accept itself.
5. Register conflicts: compare the deal (counterparty, sector, region, services, pricing, IP, exclusivity) against every register entry. Report a conflict only with both quotes. If none applies, write the no_conflicts_statement as "No conflicts found against the N commitments on the register" with N = ${register.length}.
6. Suggested next step: "escalate" if any register conflict of severity "conflict" (not "possible conflict"), a regulated data type, or uncapped liability/penalty on a deal of USD ${data.rules.escalation.deal_value_usd.toLocaleString()} or more; else "negotiate" if any clause needs attention or any "possible conflict"; else "sign". It is a suggestion only. Use "possible conflict" when the overlap depends on facts not in this document (for example whether a rate is lower, or whether a tool is reused).
7. In not_checked, list anything you could not assess from this document alone (other documents in the bundle, insurance certificates, prior emails, phone calls).
9. Be brief inside the structure: plain_english at most 25 words, reason at most 45 words, past_positions at most 45 words, quote at most 60 words (the operative sentence), explanation at most 70 words, summary at most 120 words.
8. Today is ${TODAY}. A register entry whose "until" date has clearly passed is EXPIRED: mention it in the clause's reason if relevant, but never report it as a conflict. An entry whose expiry depends on a term that is still running is live.

=== AtliQ's own checklist (Karandeep, 2024) ===
${data.checklist}

=== AtliQ entities (finance fact sheet) ===
${data.entities}

=== Rules engine output for this document (deterministic, already computed; use it, do not contradict it) ===
Region: ${rulesOut.region}. Expected entity: ${rulesOut.expected_entity}.
${rulesOut.findings.map((f) => `- [${f.check}] ${f.status.toUpperCase()}: ${f.text}`).join("\n")}

=== Obligations register (${register.length} confirmed commitments AtliQ has already made; one per line) ===
${register.map(compactEntry).join("\n")}

=== Negotiation history (Jay's reconstruction, incomplete, unreviewed) ===
${data.negotiation}`;
}

export function makeClient() {
  return new Anthropic();
}

export async function extractFacts(client, contractText) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(FactsSchema) },
    system: "Extract facts from the contract exactly as written. Do not infer the AtliQ entity from context; use the parties clause and signature block. If a field is not stated, use 'not stated' for strings and null for numbers. value_usd_estimate: convert any stated fees to USD roughly if a currency is given, else null. is_atliq_paper: true if AtliQ is the drafting party (its own template to a vendor, freelancer or agency). deal_category: pick the closest.",
    messages: [{ role: "user", content: contractText }],
  });
  if (res.stop_reason === "refusal") throw new Error("Model declined the extraction request");
  if (!res.parsed_output) throw new Error("Fact extraction returned no parseable output");
  return { facts: res.parsed_output, usage: res.usage };
}

// Streams the review. onText receives text deltas; returns the final parsed review and usage.
export async function reviewContract(client, { contractText, title, data, facts, rulesOut, onText }) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 48000, // streaming; long contracts produce 40-50 clause rows plus reasoning
    output_config: { effort: "medium", format: zodOutputFormat(ReviewSchema) },
    system: systemPrompt(data, facts, rulesOut),
    messages: [{ role: "user", content: `Review this document: ${title}\n\nExtracted facts: ${JSON.stringify(facts)}\n\n=== CONTRACT TEXT ===\n${contractText}` }],
  });
  let buf = "";
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      buf += ev.delta.text;
      if (onText) onText(ev.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("Model declined the review request");
  if (final.stop_reason === "max_tokens") throw new Error("Review was cut off by the output limit; retry with a shorter document");
  const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = ReviewSchema.parse(JSON.parse(text));
  return { review: parsed, usage: final.usage };
}

export function priceUsage(usage, model = MODEL) {
  // List prices per 1M tokens, platform.claude.com/docs/en/about-claude/pricing, reference copy 25 Sep 2026.
  const price = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-4-5": [1, 5] }[model] || [4, 20];
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return { input_tokens: inTok, output_tokens: usage.output_tokens || 0, usd: (inTok * price[0] + (usage.output_tokens || 0) * price[1]) / 1e6 };
}

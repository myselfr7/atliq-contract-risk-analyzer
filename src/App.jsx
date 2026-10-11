import React, { useEffect, useMemo, useState } from "react";

const LABEL = "AI-generated draft review. Not legal advice. A person decides.";

export default function App() {
  // ?tab=review|register|golden|evals|about opens that tab directly (demo links and screenshots)
  const initialTab = new URLSearchParams(window.location.search).get("tab") || "review";
  const [tab, setTab] = useState(["review", "register", "golden", "evals", "about"].includes(initialTab) ? initialTab : "review");
  return (
    <>
      <header>
        <h1>AtliQ Contract Risk Analyzer</h1>
        <nav>
          {[["review", "Review"], ["register", "Obligations register"], ["golden", "Golden tests"], ["evals", "Evals vs PRD"], ["about", "How it works"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <span className="muted" style={{ color: "#cfe0f3" }}>Prototype on synthetic data. Codebasics AI PM capstone.</span>
      </header>
      <main>
        {tab === "review" && <Review />}
        {tab === "register" && <Register />}
        {tab === "golden" && <Golden />}
        {tab === "evals" && <Evals />}
        {tab === "about" && <About />}
      </main>
    </>
  );
}

// ------------------------------------------------------------------ shared: run a review via SSE
async function runReview(body, onEvent) {
  const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`Server error ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done = null;
  while (true) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
      const dataLine = (chunk.match(/^data: (.*)$/m) || [])[1];
      if (!ev || !dataLine) continue;
      const payload = JSON.parse(dataLine);
      onEvent(ev, payload);
      if (ev === "done") done = payload;
      if (ev === "error") throw new Error(payload.message);
    }
  }
  if (!done) throw new Error("The review ended without a result");
  return done;
}

// ------------------------------------------------------------------ Review tab
function Review() {
  const [contracts, setContracts] = useState([]);
  const [sel, setSel] = useState("");
  const [pasted, setPasted] = useState("");
  const [mode, setMode] = useState("pick");
  const [state, setState] = useState({ running: false, stage: "", chars: 0, facts: null, rules: null, result: null, error: null, started: 0 });
  const [override, setOverride] = useState({ step: "", reason: "" });
  // A ticking clock while a review runs, so the elapsed time on screen moves even when no event arrives.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.running]);

  useEffect(() => { fetch("/contracts.json").then((r) => r.json()).then((l) => { setContracts(l); if (l[0]) setSel(l[0].id); }).catch(() => {}); }, []);
  const current = useMemo(() => contracts.find((c) => c.id === sel), [contracts, sel]);

  // Replay mode: ?replay=<contract id> renders the saved golden-test result through the same page,
  // instantly and at no cost. Used for demos and screenshots. ?focus=brief|facts|conflicts|clauses|mutuality|notchecked|decision shows one card.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const focus = params.get("focus");
  useEffect(() => {
    const id = params.get("replay");
    if (!id) return;
    fetch("/golden_results.json").then((r) => r.json()).then((g) => {
      const hit = (g.results || []).find((x) => x.id === id && x.result);
      if (hit) { setSel(id); setState((s) => ({ ...s, result: { ...hit.result, label: LABEL, model: hit.result.model || g.model }, stage: "replayed from saved test run" })); }
    }).catch(() => {});
  }, [params]);
  useEffect(() => {
    if (!focus) return;
    const st = document.createElement("style");
    st.textContent = `.card[data-key]:not([data-key="${focus}"]) { display: none } .card[data-key="pick"] { display: none }`;
    document.head.appendChild(st);
    return () => st.remove();
  }, [focus]);

  async function go() {
    setState({ running: true, stage: "starting", chars: 0, facts: null, rules: null, result: null, error: null, started: Date.now() });
    setOverride({ step: "", reason: "" });
    try {
      const body = mode === "pick" ? { contractId: sel } : { text: pasted, title: "Pasted contract" };
      const result = await runReview(body, (ev, p) => {
        if (ev === "progress") setState((s) => ({ ...s, stage: p.stage }));
        if (ev === "facts") setState((s) => ({ ...s, facts: p }));
        if (ev === "rules") setState((s) => ({ ...s, rules: p }));
        if (ev === "text") setState((s) => ({ ...s, chars: p.chars }));
      });
      setState((s) => ({ ...s, running: false, stage: "done", result }));
      // The brief and the decision box sit at the top of the page; bring the reviewer there when the review lands.
      setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
    } catch (e) {
      setState((s) => ({ ...s, running: false, error: e.message }));
    }
  }

  function saveOverride() {
    const log = JSON.parse(localStorage.getItem("overrides") || "[]");
    log.push({ at: new Date().toISOString(), contract: state.result.title, suggested: state.result.review.suggested_next_step, decided: override.step, reason: override.reason });
    localStorage.setItem("overrides", JSON.stringify(log));
    alert(`Recorded: ${override.step} (suggested was ${state.result.review.suggested_next_step}). ${log.length} decision(s) in the local log.`);
  }

  const r = state.result;
  return (
    <>
      <div className="card" data-key="pick">
        <h2>1. Choose a contract</h2>
        <div className="row">
          <label><input type="radio" checked={mode === "pick"} onChange={() => setMode("pick")} /> From the incoming queue (15 synthetic drafts)</label>
          <label><input type="radio" checked={mode === "paste"} onChange={() => setMode("paste")} /> Paste contract text</label>
        </div>
        {mode === "pick" ? (
          <div className="row" style={{ marginTop: 8 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ minWidth: 420 }}>
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.words} words)</option>)}
            </select>
            {current && <span className="muted">{current.file}</span>}
          </div>
        ) : (
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the full contract text here (English)." />
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={state.running || (mode === "paste" && pasted.length < 200)} onClick={go}>{state.running ? "Reviewing..." : "Run review"}</button>
          {state.running && <span className="progress">{state.stage} · {Math.round((now - state.started) / 1000)} s</span>}
        </div>
        {state.error && <p className="err">Review failed: {state.error}. Nothing was decided. Try again or review manually.</p>}
      </div>

      {state.running && <WaitingCard stage={state.stage} facts={state.facts} rules={state.rules} chars={state.chars} seconds={Math.round((now - state.started) / 1000)} words={mode === "pick" ? current?.words : Math.round(pasted.split(/\s+/).length)} />}
      {state.facts && !r && <FactsCard facts={state.facts} rules={state.rules} />}

      {r && (
        <>
          <div className="card" data-key="brief">
            <div className="label">{r.label || LABEL}</div>
            <h2>Review brief: {r.title}</h2>
            <p><b>Suggested next step:</b> <span className={`pill ${r.review.suggested_next_step}`}>{r.review.suggested_next_step}</span> &nbsp; {r.review.next_step_reason}</p>
            {r.review.clauses_to_push_on?.length > 0 && <p><b>Clauses to push on:</b> {r.review.clauses_to_push_on.join("; ")}</p>}
            <p>{r.review.summary}</p>
            <p className="muted">Model {r.model} · {r.usage.input_tokens.toLocaleString()} tokens in, {r.usage.output_tokens.toLocaleString()} out · ${r.usage.usd} at list prices · {(r.elapsed_ms / 1000).toFixed(0)} s · quotes checked against the source text in code: {r.review.unverified_quotes} unverified · forbidden phrases filtered: {r.review.output_filter_hits}</p>
          </div>

          <div className="card decide" data-key="decision">
            <h2>Your decision (a person decides)</h2>
            <p className="muted">The assistant suggested <b>{r.review.suggested_next_step}</b>. Read the sections below, then confirm it or override it here. Overrides are recorded with a reason; nothing is signed or sent from here.</p>
            <div className="row">
              <select value={override.step} onChange={(e) => setOverride({ ...override, step: e.target.value })}>
                <option value="">Choose...</option><option value="sign">Sign</option><option value="negotiate">Negotiate</option><option value="escalate">Escalate to counsel</option><option value="reject">Reject</option>
              </select>
              <input style={{ minWidth: 380 }} placeholder="Reason (required if different from the suggestion)" value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
              <button className="primary" disabled={!override.step || (override.step !== r.review.suggested_next_step && !override.reason)} onClick={saveOverride}>Record decision</button>
            </div>
          </div>

          <FactsCard facts={r.facts} rules={r.rules} />

          <div className="card" data-key="conflicts">
            <h2>2. Existing commitments (register check)</h2>
            {r.review.register_conflicts.length === 0 ? (
              <p><span className="pill ok">no conflict found</span> &nbsp; {r.review.no_conflicts_statement}</p>
            ) : (
              <table><thead><tr><th>Severity</th><th>Register entry</th><th>Incoming clause</th><th>Existing clause</th><th>Why it collides</th></tr></thead><tbody>
                {r.review.register_conflicts.map((c, i) => (
                  <tr key={i} className={c.severity === "conflict" ? "v-conflict" : "v-attention"}>
                    <td><span className={`pill ${c.severity === "conflict" ? "conflict" : "attention"}`}>{c.severity}</span></td>
                    <td>{c.register_id}</td>
                    <td><Quote text={c.incoming_clause_quote} verified={c.incoming_quote_verified} where="this contract" /></td>
                    <td><Quote text={c.register_clause_quote} verified={c.register_quote_verified} where="the register" /></td>
                    <td>{c.explanation}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            {r.review.expired_restrictions_checked?.length > 0 && (
              <p className="muted"><b>Expired restrictions checked, no longer binding:</b> {r.review.expired_restrictions_checked.join("; ")}</p>
            )}
          </div>

          <div className="card" data-key="clauses">
            <h2>3. Clause by clause ({r.review.clauses.length} clauses)</h2>
            <table><thead><tr><th>Ref</th><th>Type</th><th>In plain English</th><th>Verdict</th><th>Quoted text</th><th>Reason and past positions</th></tr></thead><tbody>
              {r.review.clauses.map((c, i) => (
                <tr key={i} className={`v-${c.verdict.replace("needs ", "")}`}>
                  <td>{c.clause_ref}</td>
                  <td>{c.type}</td>
                  <td>{c.plain_english}</td>
                  <td><span className={`pill ${c.verdict.replace("needs ", "")}`}>{c.verdict}</span>{c.confidence === "low" && <> <span className="pill low">low confidence</span></>}</td>
                  <td><Quote text={c.quote} verified={c.quote_verified} where="this contract" /></td>
                  <td>{c.reason}{c.past_positions && c.past_positions !== "none" && <div className="muted"><b>History:</b> {c.past_positions}</div>}</td>
                </tr>
              ))}
            </tbody></table>
          </div>

          <div className="card" data-key="mutuality">
            <h2>4. Mutuality (both directions)</h2>
            {!r.review.mutuality.applies ? <p className="muted">Not applicable to this document type.</p> : r.review.mutuality.one_sided_clauses.length === 0 ? <p><span className="pill ok">balanced</span> No one-sided clauses found.</p> : (
              <table><thead><tr><th>Clause</th><th>Favours</th><th>Quoted text</th><th>Why one-sided</th></tr></thead><tbody>
                {r.review.mutuality.one_sided_clauses.map((c, i) => <tr key={i} className="v-attention"><td>{c.clause_ref}</td><td>{c.favours}</td><td><span className="quote">{c.quote}</span></td><td>{c.why}</td></tr>)}
              </tbody></table>
            )}
          </div>

          <div className="card" data-key="notchecked">
            <h2>5. What was not checked</h2>
            <ul>{r.review.not_checked.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>

        </>
      )}
      <TopButton />
    </>
  );
}

// A quoted clause. When the model could not find supporting text it writes "not found" in the quote field;
// show that as a plain statement instead of a code-font "not found" plus a checker warning.
function Quote({ text, verified, where }) {
  const t = String(text || "").trim();
  if (!t || /^not found\.?$/i.test(t)) return <span className="muted"><i>No matching clause in {where}; nothing to quote.</i></span>;
  return <><span className="quote">{t}</span>{!verified && <span className="muted"> (not matched word for word in {where})</span>}</>;
}

// A "back to top" button that appears once the reviewer has scrolled down the long clause table.
function TopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return <button className="totop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} title="Back to the brief and the decision box">&#8593; Top</button>;
}

// Shown while a review runs. The header facts and the rules table arrive in seconds; the clause-by-clause
// review takes one to three minutes, and without this card the page looked finished when it was not.
function WaitingCard({ stage, facts, rules, chars, seconds, words }) {
  // Golden set: 45 s for a 1,000-word NDA, 142 s for a 3,400-word MSA. Rough guide only.
  const expect = words ? Math.max(1, Math.round((45 + (words / 3400) * 100) / 30) * 0.5) : null;
  const steps = [
    { k: "facts", label: "Read the header facts (parties, entity, law, data types, documents)", done: !!facts, active: !facts },
    { k: "rules", label: "Apply the entity, country and paperwork rules (no AI)", done: !!rules, active: !!facts && !rules },
    { k: "review", label: "Review every clause against the register, the precedents and both sides' positions", done: false, active: stage === "reviewing clauses" },
    { k: "verify", label: "Match every quote back to the source text and filter forbidden phrases", done: false, active: false },
  ];
  return (
    <div className="card wait" data-key="wait">
      <h2>Review in progress: please wait for the AI summary and the clause table</h2>
      <ul className="steps">
        {steps.map((s) => (
          <li key={s.k} className={s.done ? "done" : s.active ? "active" : ""}>
            <span className="mark">{s.done ? "✓" : s.active ? "▶" : "○"}</span> {s.label}
            {s.k === "review" && s.active && <span className="muted"> · {chars > 0 ? `${chars.toLocaleString()} characters written so far` : "the model is reading the contract and the register; the first words usually arrive after 10 to 30 seconds"}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">
        {seconds} s elapsed{expect ? `, usually ${expect} to ${expect + 1} minutes for a ${words.toLocaleString()}-word document` : ""}. The facts and rules above are final; the brief, the conflicts and the clause table appear together when the review finishes. Nothing is decided until you record a decision at the bottom.
      </p>
    </div>
  );
}

function FactsCard({ facts, rules }) {
  return (
    <div className="card" data-key="facts">
      <h2>Header facts and rules check (no AI in the rules)</h2>
      <div className="grid2">
        <div>
          <table><tbody>
            {[["Document", facts.document_type], ["Counterparty", `${facts.counterparty} (${facts.counterparty_country})`], ["AtliQ entity named", facts.atliq_entity_named], ["Governing law", facts.governing_law], ["Courts / arbitration", facts.courts_or_arbitration], ["Currency / value", `${facts.currency} ${facts.value_usd_estimate ? "≈ $" + facts.value_usd_estimate.toLocaleString() : ""}`], ["Data types", (facts.data_types || []).join(", ")], ["Documents referenced", (facts.documents_referenced || []).join(", ") || "none"], ["AtliQ's own paper", facts.is_atliq_paper ? "yes" : "no"], ["Labelled mutual", facts.is_labelled_mutual ? "yes" : "no"], ["Deal category", facts.deal_category]].map(([k, v]) => <tr key={k}><th style={{ width: 160 }}>{k}</th><td>{v}</td></tr>)}
          </tbody></table>
        </div>
        <div>
          {rules ? (
            <table><thead><tr><th>Check</th><th>Status</th><th>Finding</th></tr></thead><tbody>
              {rules.findings.map((f, i) => <tr key={i} className={`v-${f.status === "ok" ? "fine" : f.status}`}><td>{f.check}</td><td><span className={`pill ${f.status}`}>{f.status}</span></td><td>{f.text}</td></tr>)}
            </tbody></table>
          ) : <p className="muted">Applying rules...</p>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Register tab
function Register() {
  const [reg, setReg] = useState(null);
  useEffect(() => { fetch("/register.json").then((r) => r.json()).then(setReg).catch(() => setReg({ entries: [] })); }, []);
  if (!reg) return <div className="card">Loading...</div>;
  return (
    <div className="card">
      <h2>Obligations register: what AtliQ has already promised ({reg.entries.length} entries)</h2>
      <p className="muted">Extracted once from the signed contracts by the assistant, then confirmed by a person. {reg.note} Built {reg.built_at ? new Date(reg.built_at).toLocaleString() : "not yet"}.</p>
      <table><thead><tr><th>ID</th><th>Type</th><th>Counterparty / entity</th><th>Scope</th><th>Region / sector</th><th>Expiry</th><th>Quoted clause</th><th>Source</th></tr></thead><tbody>
        {reg.entries.map((e) => (
          <tr key={e.id}><td>{e.id}</td><td>{e.type}</td><td>{e.counterparty}<div className="muted">{e.atliq_entity}{e.binds_affiliates ? ", binds affiliates" : ""}</div></td><td>{e.scope}</td><td>{e.region} / {e.sector}</td><td>{e.expiry_or_term}</td><td><span className="quote">{e.quoted_clause}</span><div className="muted">{e.clause_ref}</div></td><td className="muted">{e.source_file.replace("data/signed_contracts/", "")}</td></tr>
        ))}
      </tbody></table>
    </div>
  );
}

// ------------------------------------------------------------------ Golden tests tab
function Golden() {
  const [res, setRes] = useState(null);
  useEffect(() => { fetch("/golden_results.json").then((r) => r.json()).then(setRes).catch(() => setRes({ results: [] })); }, []);
  if (!res) return <div className="card">Loading...</div>;
  return (
    <div className="card">
      <h2>Golden test set: the seven trap scenarios from the brief</h2>
      <p className="muted">Last run {res.run_at ? new Date(res.run_at).toLocaleString() : "never"} on {res.model}: {res.passed} of {res.total} passed. Run with <code>npm run test:golden</code>; each run calls the model and costs real money, so results are stored rather than re-run on page load.</p>
      <table><thead><tr><th>Result</th><th>Contract</th><th>Scenario</th><th>Conflicts</th><th>Next step</th><th>Clauses</th><th>Unverified quotes</th><th>Cost</th><th>Time</th></tr></thead><tbody>
        {(res.results || []).map((g) => (
          <tr key={g.id} className={g.pass ? "v-fine" : "v-conflict"}>
            <td><span className={`pill ${g.pass ? "pass" : "fail"}`}>{g.pass ? "pass" : "fail"}</span></td>
            <td>{g.result?.title || g.id}</td><td>{g.scenario}</td>
            <td>{g.result ? g.result.review.register_conflicts.length : (g.error || "-")}</td>
            <td>{g.result && <span className={`pill ${g.result.review.suggested_next_step}`}>{g.result.review.suggested_next_step}</span>}</td>
            <td>{g.result?.review.clauses.length}</td><td>{g.result?.review.unverified_quotes}</td>
            <td>{g.result ? "$" + g.result.usage.usd : ""}</td><td>{g.result ? (g.result.elapsed_ms / 1000).toFixed(0) + " s" : ""}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

// ------------------------------------------------------------------ Evals vs PRD tab
// The ten eval dimensions from PRD section 11, each with its threshold, and what the stored golden run shows.
// Everything here is computed from golden_results.json in the browser: no model call, no cost.
// Dimensions the prototype cannot measure (they need Karandeep's ratings or seeded contracts) say so.
const EXPECT_CONFLICT = ["2026-09-18_gulf_crown_hotels_msa_draft", "2026-09-19_lakeshore_grocers_msa_draft", "2026-09-21_blueorchid_hotels_pilot_agreement_draft"];
const EXPECT_ONE_SIDED = ["2026-09-25_finserve_capital_mutual_nda_draft", "2026-09-26_kriti_data_labs_subcontractor_agreement_draft"];
const EXPECT_MUTUAL = "2026-09-27_loopmart_mutual_nda_draft";
const EXPECT_RULES = { "2026-09-15_travelhub_services_agreement_draft": "entity", "2026-09-10_harrington_health_msa_draft": "paperwork" };

function evalRows(res) {
  const ok = (res.results || []).filter((g) => g.result);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  // Groundedness: every quote the reviews produced vs the ones the in-code matcher could not find in the source.
  let quotes = 0, unverified = 0, filterHits = 0;
  for (const g of ok) {
    const v = g.result.review;
    quotes += v.clauses.length + 2 * v.register_conflicts.length + (v.mutuality?.one_sided_clauses?.length || 0);
    unverified += v.unverified_quotes || 0;
    filterHits += v.output_filter_hits || 0;
  }
  const conflictsFound = EXPECT_CONFLICT.filter((id) => ok.find((g) => g.id === id)?.pass).length;
  const oneSidedFound = EXPECT_ONE_SIDED.filter((id) => (ok.find((g) => g.id === id)?.result.review.mutuality.one_sided_clauses.length || 0) > 0).length;
  const mutualClean = (ok.find((g) => g.id === EXPECT_MUTUAL)?.result.review.mutuality.one_sided_clauses.length || 0) === 0;
  const rulesCaught = Object.entries(EXPECT_RULES).filter(([id, check]) => ok.find((g) => g.id === id)?.result.rules.findings.some((f) => f.check === check && f.status !== "ok")).length;
  const falseEntity = ok.filter((g) => !(g.id in EXPECT_RULES) && g.result.rules.findings.some((f) => f.check === "entity" && f.status === "conflict")).length;
  const times = ok.map((g) => g.result.elapsed_ms / 1000).sort((a, b) => a - b);
  const p95 = times.length ? times[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)] : 0;
  const under5 = times.filter((t) => t <= 300).length;

  return [
    { dim: "Conflict recall", threshold: "100% of known register conflicts in the golden set reported", blocker: true,
      status: conflictsFound === EXPECT_CONFLICT.length ? "met" : "not met",
      evidence: `${conflictsFound} of ${EXPECT_CONFLICT.length} known conflicts found (Gulf Crown and BlueOrchid vs Al Noor; Lakeshore vs the Crestline MFN).` },
    { dim: "Clause verdict agreement", threshold: "At least 85% agreement with Karandeep on 100 rated clauses; no conflict clause rated fine", blocker: true,
      status: "not measured", evidence: "Needs Karandeep's ratings on 100 clauses. Planned for the shadow pilot; the prototype has no human-rated clause set yet." },
    { dim: "False-alarm rate", threshold: "At most 20% of needs-attention or conflict clauses rated fine by Karandeep", blocker: false,
      status: "not measured", evidence: "Same 100 rated clauses as above." },
    { dim: "Groundedness", threshold: "100% of findings carry a quote matching the source text; 0 findings reference text in no document", blocker: true,
      status: unverified === 0 ? "met" : "partly met",
      evidence: unverified === 0
        ? `All ${quotes} quotes in the stored run matched the source word for word in code. A literal "not found" is not counted as a quote; a quote that does not match is shown as unverified in the brief for the reviewer to check.`
        : `${quotes - unverified} of ${quotes} quotes matched the source word for word in code (${pct(quotes - unverified, quotes)}%). ${unverified} did not and are shown as unverified in the brief for the reviewer to check. A literal "not found" is not counted as a quote.` },
    { dim: "Entity and rules accuracy", threshold: "Entity, law and courts check and required-documents list correct on all 32 contracts", blocker: true,
      status: rulesCaught === 2 && falseEntity === 0 ? "met on 8" : "not met",
      evidence: `${rulesCaught} of 2 rule traps caught (TravelHub wrong entity; Harrington missing BAA chain); ${falseEntity} false entity flags on the other ${ok.length - 2} golden contracts. The rules run with no AI. 24 of 32 contracts still need a hand-checked answer key.` },
    { dim: "Mutuality detection", threshold: "At least 90% of one-sided clauses found; the genuinely mutual NDA not flagged", blocker: false,
      status: oneSidedFound === EXPECT_ONE_SIDED.length && mutualClean ? "met on 3" : "not met",
      evidence: `${oneSidedFound} of ${EXPECT_ONE_SIDED.length} one-sided documents flagged (FinServe "mutual" NDA; AtliQ's own Kriti paper); LoopMart mutual NDA ${mutualClean ? "not flagged" : "wrongly flagged"}. Clause-level count needs the rated set.` },
    { dim: "Precedent usefulness", threshold: "Karandeep rates attached past positions relevant in at least 80% of 20 needs-attention clauses", blocker: false,
      status: "not measured", evidence: "Needs reviewer ratings. Past positions are shown as history, never policy, and the override log on the Review tab is where this will be collected." },
    { dim: "Safety and output filter", threshold: "0 briefs contain \"safe to sign\" or a legal-compliance assertion; 100% carry the label", blocker: true,
      status: filterHits === 0 ? "met" : "not met",
      evidence: `${filterHits} forbidden phrases across ${ok.length} reviews; the label is attached to every review in code, not written by the model.` },
    { dim: "Injection resistance", threshold: "0 of 10 contracts seeded with hidden instructions change schema or verdicts", blocker: true,
      status: "not measured", evidence: "Not yet run: the golden set has no seeded contracts. Structured output fixes the schema; verdict drift under injection is untested." },
    { dim: "Latency", threshold: "95% of 30-page reviews complete within 5 minutes", blocker: false,
      status: under5 === times.length ? "met" : "not met",
      evidence: `${under5} of ${times.length} reviews under 5 minutes; slowest ${Math.round(times[times.length - 1] || 0)} s, 95th percentile ${Math.round(p95)} s.` },
  ];
}

function Evals() {
  const [res, setRes] = useState(null);
  useEffect(() => { fetch("/golden_results.json").then((r) => r.json()).then(setRes).catch(() => setRes({ results: [] })); }, []);
  if (!res) return <div className="card">Loading...</div>;
  const rows = evalRows(res);
  const pill = (s) => (s.startsWith("met") ? "pass" : s === "not met" ? "fail" : "attention");
  const blockers = rows.filter((r) => r.blocker);
  const blockersMet = blockers.filter((r) => r.status.startsWith("met")).length;
  return (
    <div className="card">
      <h2>Eval criteria from the PRD, and where the prototype stands</h2>
      <p className="muted">PRD section 11 names ten eval dimensions; six are launch blockers. This page reads the stored golden run ({res.run_at ? new Date(res.run_at).toLocaleString() : "never"}, {res.model}) and reports each one. Launch blockers met on the golden set: {blockersMet} of {blockers.length}. "Not measured" is deliberate: those need Karandeep's ratings or seeded contracts, which is what the shadow pilot is for. No model call is made to show this page.</p>
      <table><thead><tr><th>Eval dimension</th><th>Threshold in the PRD</th><th>Launch blocker</th><th>Status</th><th>Evidence from the golden run</th></tr></thead><tbody>
        {rows.map((r) => (
          <tr key={r.dim}>
            <td><b>{r.dim}</b></td><td>{r.threshold}</td><td>{r.blocker ? "Yes" : "No"}</td>
            <td><span className={`pill ${pill(r.status)}`}>{r.status}</span></td><td>{r.evidence}</td>
          </tr>
        ))}
      </tbody></table>
      <p className="muted">Success metrics (reviewer time per contract from about 3 hours to under 30 minutes, days in queue, override rate) are measured after launch and are not on this page: the prototype has no production usage yet.</p>
    </div>
  );
}

// ------------------------------------------------------------------ About tab
function About() {
  return (
    <div className="card">
      <h2>How it works, and what it never does</h2>
      <ol>
        <li><b>Header facts</b> are extracted from the contract by the model into a fixed schema (parties, entity, country, law, data types, documents referenced).</li>
        <li><b>Rules, no AI:</b> a small table checks the entity against the country, the governing law against the entity's home law, the regulated data types, the documents the deal type needs, and numeric gaps such as insurance. Every regulatory point is a flag to confirm with counsel, never a statement of law.</li>
        <li><b>Register check:</b> the deal is compared with the confirmed register of commitments AtliQ has already signed. A conflict is reported only with both clauses quoted.</li>
        <li><b>Clause by clause:</b> every clause gets a type, a plain-English line, a verdict (fine, needs attention, conflict) and the quoted text. Past positions from the negotiation history are shown as history, never policy.</li>
        <li><b>Mutuality:</b> clauses labelled mutual, and AtliQ's own paper, are checked for one-sidedness in both directions.</li>
        <li><b>Guardrails in code:</b> every quote is matched back to the source text and unmatched quotes are counted; phrases like "safe to sign" are filtered; the brief always carries the label; the suggested next step is a field, never an action. The app has no ability to send, sign or change a document.</li>
      </ol>
      <p><b>Never:</b> sign, approve, send, give legal advice, call a contract safe, or set negotiation thresholds. A person decides every contract.</p>
      <p className="muted">Synthetic dataset from the Codebasics AI PM capstone. No real client, contract or legal advice. Names, rates and identifiers would be masked before any model call on real contracts; the prototype skips masking because the data is synthetic.</p>
    </div>
  );
}

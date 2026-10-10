import React, { useEffect, useMemo, useState } from "react";

const LABEL = "AI-generated draft review. Not legal advice. A person decides.";

export default function App() {
  const [tab, setTab] = useState("review");
  return (
    <>
      <header>
        <h1>AtliQ Contract Risk Analyzer</h1>
        <nav>
          {[["review", "Review"], ["register", "Obligations register"], ["golden", "Golden tests"], ["about", "How it works"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <span className="muted" style={{ color: "#cfe0f3" }}>Prototype on synthetic data. Capstone 2, Codebasics AI PM Cohort.</span>
      </header>
      <main>
        {tab === "review" && <Review />}
        {tab === "register" && <Register />}
        {tab === "golden" && <Golden />}
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

  useEffect(() => { fetch("/contracts.json").then((r) => r.json()).then((l) => { setContracts(l); if (l[0]) setSel(l[0].id); }).catch(() => {}); }, []);
  const current = useMemo(() => contracts.find((c) => c.id === sel), [contracts, sel]);

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
      <div className="card">
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
          {state.running && <span className="progress">{state.stage} · {state.chars.toLocaleString()} characters written · {Math.round((Date.now() - state.started) / 1000)}s</span>}
        </div>
        {state.error && <p className="err">Review failed: {state.error}. Nothing was decided. Try again or review manually.</p>}
      </div>

      {state.facts && !r && <FactsCard facts={state.facts} rules={state.rules} />}

      {r && (
        <>
          <div className="card">
            <div className="label">{r.label || LABEL}</div>
            <h2>Review brief: {r.title}</h2>
            <p><b>Suggested next step:</b> <span className={`pill ${r.review.suggested_next_step}`}>{r.review.suggested_next_step}</span> &nbsp; {r.review.next_step_reason}</p>
            {r.review.clauses_to_push_on?.length > 0 && <p><b>Clauses to push on:</b> {r.review.clauses_to_push_on.join("; ")}</p>}
            <p>{r.review.summary}</p>
            <p className="muted">Model {r.model} · {r.usage.input_tokens.toLocaleString()} tokens in, {r.usage.output_tokens.toLocaleString()} out · ${r.usage.usd} at list prices · {(r.elapsed_ms / 1000).toFixed(0)} s · quotes checked against the source text in code: {r.review.unverified_quotes} unverified · forbidden phrases filtered: {r.review.output_filter_hits}</p>
          </div>

          <FactsCard facts={r.facts} rules={r.rules} />

          <div className="card">
            <h2>2. Existing commitments (register check)</h2>
            {r.review.register_conflicts.length === 0 ? (
              <p><span className="pill ok">no conflict found</span> &nbsp; {r.review.no_conflicts_statement}</p>
            ) : (
              <table><thead><tr><th>Severity</th><th>Register entry</th><th>Incoming clause</th><th>Existing clause</th><th>Why it collides</th></tr></thead><tbody>
                {r.review.register_conflicts.map((c, i) => (
                  <tr key={i} className={c.severity === "conflict" ? "v-conflict" : "v-attention"}>
                    <td><span className={`pill ${c.severity === "conflict" ? "conflict" : "attention"}`}>{c.severity}</span></td>
                    <td>{c.register_id}</td>
                    <td><span className="quote">{c.incoming_clause_quote}</span>{!c.incoming_quote_verified && <span className="muted"> (quote not matched in source)</span>}</td>
                    <td><span className="quote">{c.register_clause_quote}</span>{!c.register_quote_verified && <span className="muted"> (quote not matched in register)</span>}</td>
                    <td>{c.explanation}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>

          <div className="card">
            <h2>3. Clause by clause ({r.review.clauses.length} clauses)</h2>
            <table><thead><tr><th>Ref</th><th>Type</th><th>In plain English</th><th>Verdict</th><th>Quoted text</th><th>Reason and past positions</th></tr></thead><tbody>
              {r.review.clauses.map((c, i) => (
                <tr key={i} className={`v-${c.verdict.replace("needs ", "")}`}>
                  <td>{c.clause_ref}</td>
                  <td>{c.type}</td>
                  <td>{c.plain_english}</td>
                  <td><span className={`pill ${c.verdict.replace("needs ", "")}`}>{c.verdict}</span>{c.confidence === "low" && <> <span className="pill low">low confidence</span></>}</td>
                  <td><span className="quote">{c.quote}</span>{!c.quote_verified && <span className="muted">not matched in source text</span>}</td>
                  <td>{c.reason}{c.past_positions && c.past_positions !== "none" && <div className="muted"><b>History:</b> {c.past_positions}</div>}</td>
                </tr>
              ))}
            </tbody></table>
          </div>

          <div className="card">
            <h2>4. Mutuality (both directions)</h2>
            {!r.review.mutuality.applies ? <p className="muted">Not applicable to this document type.</p> : r.review.mutuality.one_sided_clauses.length === 0 ? <p><span className="pill ok">balanced</span> No one-sided clauses found.</p> : (
              <table><thead><tr><th>Clause</th><th>Favours</th><th>Quoted text</th><th>Why one-sided</th></tr></thead><tbody>
                {r.review.mutuality.one_sided_clauses.map((c, i) => <tr key={i} className="v-attention"><td>{c.clause_ref}</td><td>{c.favours}</td><td><span className="quote">{c.quote}</span></td><td>{c.why}</td></tr>)}
              </tbody></table>
            )}
          </div>

          <div className="card">
            <h2>5. What was not checked</h2>
            <ul>{r.review.not_checked.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>

          <div className="card">
            <h2>6. Your decision (human in the loop)</h2>
            <p className="muted">The assistant suggested <b>{r.review.suggested_next_step}</b>. Confirm it or override it. Overrides are recorded with a reason; nothing is signed or sent from here.</p>
            <div className="row">
              <select value={override.step} onChange={(e) => setOverride({ ...override, step: e.target.value })}>
                <option value="">Choose...</option><option value="sign">Sign</option><option value="negotiate">Negotiate</option><option value="escalate">Escalate to counsel</option><option value="reject">Reject</option>
              </select>
              <input style={{ minWidth: 380 }} placeholder="Reason (required if different from the suggestion)" value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
              <button className="primary" disabled={!override.step || (override.step !== r.review.suggested_next_step && !override.reason)} onClick={saveOverride}>Record decision</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function FactsCard({ facts, rules }) {
  return (
    <div className="card">
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
      <p className="muted">Synthetic dataset from the Codebasics AI PM Cohort capstone. No real client, contract or legal advice. Names, rates and identifiers would be masked before any model call on real contracts; the prototype skips masking because the data is synthetic.</p>
    </div>
  );
}

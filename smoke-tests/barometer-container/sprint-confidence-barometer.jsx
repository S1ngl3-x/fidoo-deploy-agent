import { useState, useEffect } from "react";

// Replace with your deployed container URL, e.g. https://barometer-api.api.env.fidoo.cloud
const API_URL = "REPLACE_WITH_API_URL";

const TEAM_MEMBERS = ["Alina", "Gabriela", "Zdeněk", "Peter", "Petr", "Vladimír", "Barbora K.", "Alexandr", "Barbora N.", "David", "Iva", "Tomáš", "Pavla", "Daniel", "Zuzana", "Mario"];

const CONFIDENCE_LABELS = {
  1: "No chance 💀",
  2: "Very unlikely 😬",
  3: "Doubtful 😟",
  4: "Below average 😕",
  5: "Unsure 😐",
  6: "Leaning yes 🙂",
  7: "Fairly confident 😊",
  8: "Confident 💪",
  9: "Very confident 🔥",
  10: "Absolutely! 🚀",
};

const COLOR_MAP = {
  1: "#ef4444",
  2: "#f97316",
  3: "#fb923c",
  4: "#fbbf24",
  5: "#facc15",
  6: "#a3e635",
  7: "#4ade80",
  8: "#34d399",
  9: "#2dd4bf",
  10: "#22d3ee",
};

function getColor(val) {
  if (!val) return "#334155";
  return COLOR_MAP[Math.round(val)] || "#334155";
}

function CircleGauge({ value, size = 120, label, animate = true }) {
  const r = 45;
  const circ = 2 * Math.PI * r;
  const pct = value ? value / 10 : 0;
  const dash = pct * circ;
  const color = getColor(value);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle
          cx="50" cy="50" r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          strokeDashoffset={circ / 4}
          style={{ transition: animate ? "stroke-dasharray 0.8s cubic-bezier(.4,2,.6,1), stroke 0.5s" : "none" }}
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central"
          style={{ fontFamily: "'DM Mono', monospace", fontSize: value ? 22 : 14, fill: value ? color : "#475569", fontWeight: 700 }}>
          {value ? value.toFixed(1) : "–"}
        </text>
      </svg>
      {label && <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "'DM Mono', monospace", textAlign: "center", maxWidth: 90 }}>{label}</span>}
    </div>
  );
}

function BarSlider({ value, onChange }) {
  return (
    <div style={{ position: "relative", width: "100%", padding: "12px 0" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", marginBottom: 8
      }}>
        {[1,2,3,4,5,6,7,8,9,10].map(n => (
          <button
            key={n}
            onClick={() => onChange(n)}
            style={{
              width: 38, height: 38, borderRadius: "50%", border: "none",
              background: value === n ? getColor(n) : "#1e293b",
              color: value === n ? "#0f172a" : "#64748b",
              fontFamily: "'DM Mono', monospace",
              fontWeight: 700, fontSize: 13,
              cursor: "pointer",
              boxShadow: value === n ? `0 0 16px ${getColor(n)}88` : "none",
              transform: value === n ? "scale(1.18)" : "scale(1)",
              transition: "all 0.2s cubic-bezier(.4,2,.6,1)",
            }}
          >{n}</button>
        ))}
      </div>
      {value && (
        <div style={{ textAlign: "center", color: getColor(value), fontFamily: "'DM Mono', monospace", fontSize: 13, marginTop: 4 }}>
          {CONFIDENCE_LABELS[value]}
        </div>
      )}
    </div>
  );
}

function HistoryBar({ history }) {
  if (!history || history.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 40 }}>
      {history.map((d, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{
            width: 14, height: (d.pool / 10) * 34,
            background: getColor(d.pool),
            borderRadius: 3,
            opacity: 0.7 + (i / history.length) * 0.3,
          }} title={`Day ${d.day}: ${d.pool.toFixed(1)}`} />
          <span style={{ fontSize: 8, color: "#475569", fontFamily: "'DM Mono', monospace" }}>D{d.day}</span>
        </div>
      ))}
    </div>
  );
}

export default function SprintBarometer() {
  const [sprintGoal, setSprintGoal] = useState("Ship the onboarding redesign");
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState("Ship the onboarding redesign");
  const [day, setDay] = useState(1);
  const [member, setMember] = useState(TEAM_MEMBERS[0]);
  const [scores, setScores] = useState({});
  const [pending, setPending] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [history, setHistory] = useState([]);
  const [activeTab, setActiveTab] = useState("vote");
  const [trendView, setTrendView] = useState("team");
  const [highlightMember, setHighlightMember] = useState(null);
  const [completedSprints, setCompletedSprints] = useState([]);
  const [showEndModal, setShowEndModal] = useState(false);
  const [nextGoal, setNextGoal] = useState("");
  const [sprintNumber, setSprintNumber] = useState(1);
  const [storageReady, setStorageReady] = useState(false);

  // ── Hydrate from storage on mount ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/api/state`).then(res => res.json());
        if (r?.value) {
          const s = JSON.parse(r.value);
          if (s.sprintGoal)      { setSprintGoal(s.sprintGoal); setGoalInput(s.sprintGoal); }
          if (s.day)             setDay(s.day);
          if (s.scores)          setScores(s.scores);
          if (s.history)         setHistory(s.history);
          if (s.sprintNumber)    setSprintNumber(s.sprintNumber);
          if (s.completedSprints) setCompletedSprints(s.completedSprints);
        }
      } catch (_) { /* first run — no key yet */ }
      setStorageReady(true);
    })();
  }, []);

  // ── Persist to storage on every meaningful change ─────────────────────────
  useEffect(() => {
    if (!storageReady) return;
    const payload = JSON.stringify({ sprintGoal, day, scores, history, sprintNumber, completedSprints });
    fetch(`${API_URL}/api/state`, { method: "POST", body: payload }).catch(() => {});
  }, [sprintGoal, day, scores, history, sprintNumber, completedSprints, storageReady]);

  const todayKey = (m) => `${day}-${m}`;

  const myScore = scores[todayKey(member)];

  const todayStats = (() => {
    const vals = TEAM_MEMBERS.map(m => scores[todayKey(m)]).filter(Boolean);
    if (!vals.length) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return { avg, median, min: sorted[0], max: sorted[sorted.length - 1] };
  })();
  const pooledToday = todayStats ? todayStats.avg : null;

  const submittedToday = TEAM_MEMBERS.filter(m => scores[todayKey(m)]);
  const pendingToday = TEAM_MEMBERS.filter(m => !scores[todayKey(m)]);

  function handleSubmit() {
    if (!pending) return;
    setScores(prev => ({ ...prev, [todayKey(member)]: pending }));
    setSubmitted(true);
  }

  function advanceDay() {
    if (todayStats !== null) {
      const memberScores = Object.fromEntries(TEAM_MEMBERS.map(m => [m, scores[`${day}-${m}`] || null]));
      setHistory(prev => [...prev.filter(h => h.day !== day), { day, ...todayStats, memberScores }]);
    }
    setDay(d => d + 1);
    setSubmitted(false);
    setPending(null);
    setActiveTab("vote");
  }

  // Scoring: points = 10 - |member_avg - outcome_target|, clamped [0,10]
  // outcome YES → target=10 (optimists rewarded), NO → target=1 (skeptics rewarded)
  function calcPoints(memberAvg, achieved) {
    const target = achieved ? 10 : 1;
    return Math.max(0, Math.round(10 - Math.abs(memberAvg - target)));
  }

  function endSprint(achieved) {
    // Lock today first if there are votes
    const allHistory = [...history];
    if (todayStats !== null) {
      const memberScores = Object.fromEntries(TEAM_MEMBERS.map(m => [m, scores[`${day}-${m}`] || null]));
      const existing = allHistory.findIndex(h => h.day === day);
      const entry = { day, ...todayStats, memberScores };
      if (existing >= 0) allHistory[existing] = entry; else allHistory.push(entry);
    }

    // Compute per-member sprint averages across all locked days
    const memberAvgs = {};
    const memberPoints = {};
    TEAM_MEMBERS.forEach(m => {
      const vals = allHistory.map(h => h.memberScores?.[m]).filter(v => v != null);
      if (vals.length > 0) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        memberAvgs[m] = avg;
        memberPoints[m] = calcPoints(avg, achieved);
      }
    });

    setCompletedSprints(prev => [...prev, {
      number: sprintNumber,
      goal: sprintGoal,
      outcome: achieved,
      days: allHistory.length,
      memberAvgs,
      memberPoints,
    }]);

    // Reset for new sprint
    setSprintNumber(n => n + 1);
    setHistory([]);
    setScores({});
    setDay(1);
    setPending(null);
    setSubmitted(false);
    const ng = nextGoal.trim() || "New sprint goal...";
    setSprintGoal(ng);
    setGoalInput(ng);
    setNextGoal("");
    setShowEndModal(false);
    setActiveTab("vote");
  }

  const tabs = [
    { id: "vote", label: "Vote" },
    { id: "results", label: "Results" },
    { id: "history", label: "Trend" },
    { id: "scores", label: "Scores" },
  ];

  if (!storageReady) return (
    <div style={{ minHeight: "100vh", background: "#050d1a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", color: "#475569", fontSize: 13 }}>
      Loading...
    </div>
  );

  return (
    <div style={{
      minHeight: "100vh",
      background: "#050d1a",
      color: "#e2e8f0",
      fontFamily: "'DM Mono', monospace",
      padding: "0 0 40px",
      backgroundImage: "radial-gradient(ellipse at 20% 10%, #0c2444 0%, transparent 60%), radial-gradient(ellipse at 80% 80%, #0d1f33 0%, transparent 60%)",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;700&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        background: "linear-gradient(180deg, #0f2540 0%, transparent 100%)",
        borderBottom: "1px solid #1e3a5f",
        padding: "28px 32px 20px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 11, color: "#3b82f6", letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>
              Sprint Confidence Barometer
            </div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, color: "#f1f5f9" }}>
              Day {day} · Sprint Check-in
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#475569", marginBottom: 4 }}>TEAM SUBMITTED</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#3b82f6" }}>
                {submittedToday.length}/{TEAM_MEMBERS.length}
              </div>
            </div>
            <button onClick={async () => {
              if (!confirm("Wipe ALL data and start fresh?")) return;
              await fetch(`${API_URL}/api/state`, { method: "DELETE" }).catch(() => {});
              setSprintGoal("New sprint goal..."); setGoalInput("New sprint goal...");
              setDay(1); setScores({}); setHistory([]); setSprintNumber(1);
              setCompletedSprints([]); setPending(null); setSubmitted(false);
            }} style={{
              background: "none", border: "1px solid #1e3a5f", borderRadius: 6,
              color: "#334155", fontFamily: "'DM Mono', monospace", fontSize: 9,
              padding: "3px 8px", cursor: "pointer", letterSpacing: 1,
            }}>RESET ALL</button>
          </div>
        </div>

        {/* Sprint goal */}
        {editingGoal ? (
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input
              value={goalInput}
              onChange={e => setGoalInput(e.target.value)}
              style={{
                flex: 1, background: "#0f2540", border: "1px solid #3b82f6", borderRadius: 6,
                color: "#e2e8f0", fontFamily: "'DM Mono', monospace", fontSize: 13, padding: "6px 10px"
              }}
              autoFocus
            />
            <button onClick={() => { setSprintGoal(goalInput); setEditingGoal(false); }}
              style={{ background: "#3b82f6", border: "none", borderRadius: 6, color: "#fff", padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>
              Save
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => { setGoalInput(sprintGoal); setEditingGoal(true); }}>
            <span style={{ fontSize: 10, color: "#475569" }}>GOAL:</span>
            <span style={{ fontSize: 13, color: "#94a3b8", borderBottom: "1px dashed #334155" }}>{sprintGoal}</span>
            <span style={{ fontSize: 10, color: "#334155" }}>✎</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #1e3a5f", padding: "0 32px" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background: "none", border: "none", borderBottom: activeTab === t.id ? "2px solid #3b82f6" : "2px solid transparent",
            color: activeTab === t.id ? "#3b82f6" : "#475569",
            fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700,
            padding: "12px 20px", cursor: "pointer", letterSpacing: 1, textTransform: "uppercase",
            transition: "color 0.2s",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: "28px 32px", maxWidth: 560, margin: "0 auto" }}>

        {/* VOTE TAB */}
        {activeTab === "vote" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {/* Member selector */}
            <div>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 10 }}>WHO ARE YOU?</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {TEAM_MEMBERS.map(m => {
                  const voted = !!scores[todayKey(m)];
                  return (
                    <button key={m} onClick={() => { setMember(m); setSubmitted(!!scores[todayKey(m)]); setPending(scores[todayKey(m)] || null); }}
                      style={{
                        padding: "7px 16px", borderRadius: 20,
                        border: member === m ? "2px solid #3b82f6" : "2px solid #1e3a5f",
                        background: member === m ? "#0f2540" : "transparent",
                        color: member === m ? "#3b82f6" : "#64748b",
                        fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700,
                        cursor: "pointer", position: "relative",
                        transition: "all 0.2s",
                      }}>
                      {m}
                      {voted && <span style={{ position: "absolute", top: -4, right: -4, width: 10, height: 10, background: "#22c55e", borderRadius: "50%", border: "2px solid #050d1a" }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Slider */}
            <div style={{ background: "#0a1929", borderRadius: 12, padding: "20px 16px", border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 12 }}>
                {submitted ? "YOUR CONFIDENCE TODAY" : "HOW CONFIDENT ARE YOU?"}
              </div>
              {submitted ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0" }}>
                  <CircleGauge value={myScore} size={110} />
                  <div style={{ color: getColor(myScore), fontSize: 14, fontWeight: 700 }}>{CONFIDENCE_LABELS[myScore]}</div>
                  <button onClick={() => { setSubmitted(false); setPending(myScore); }}
                    style={{ background: "none", border: "1px solid #334155", borderRadius: 6, color: "#64748b", fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 14px", cursor: "pointer", marginTop: 4 }}>
                    Change my vote
                  </button>
                </div>
              ) : (
                <>
                  <BarSlider value={pending} onChange={setPending} />
                  <button
                    disabled={!pending}
                    onClick={handleSubmit}
                    style={{
                      marginTop: 16, width: "100%", padding: "12px", borderRadius: 8,
                      background: pending ? getColor(pending) : "#1e293b",
                      border: "none", color: pending ? "#0f172a" : "#475569",
                      fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 13,
                      cursor: pending ? "pointer" : "not-allowed",
                      boxShadow: pending ? `0 0 24px ${getColor(pending)}44` : "none",
                      transition: "all 0.3s",
                    }}>
                    {pending ? `Submit ${pending}/10` : "Select your confidence"}
                  </button>
                </>
              )}
            </div>

            {/* Pending members */}
            {pendingToday.length > 0 && (
              <div style={{ fontSize: 11, color: "#475569" }}>
                ⏳ Waiting for: {pendingToday.join(", ")}
              </div>
            )}
          </div>
        )}

        {/* RESULTS TAB */}
        {activeTab === "results" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Pooled gauge */}
            <div style={{ background: "#0a1929", borderRadius: 12, padding: 24, border: "1px solid #1e3a5f", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2 }}>TEAM CONFIDENCE — DAY {day}</div>
              <CircleGauge value={pooledToday} size={140} />
              <div style={{ color: pooledToday ? getColor(pooledToday) : "#334155", fontSize: 16, fontWeight: 700 }}>
                {pooledToday ? CONFIDENCE_LABELS[Math.round(pooledToday)] : "No votes yet"}
              </div>
            </div>

            {/* Individual breakdown */}
            <div>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 12 }}>INDIVIDUAL SCORES</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {TEAM_MEMBERS.map(m => {
                  const s = scores[todayKey(m)];
                  return (
                    <div key={m} style={{
                      display: "flex", alignItems: "center", gap: 12,
                      background: "#0a1929", borderRadius: 8, padding: "10px 14px",
                      border: `1px solid ${s ? getColor(s) + "44" : "#1e3a5f"}`,
                    }}>
                      <div style={{ width: 70, fontSize: 12, color: "#94a3b8", fontWeight: 700 }}>{m}</div>
                      <div style={{ flex: 1 }}>
                        {s ? (
                          <div style={{ height: 6, borderRadius: 3, background: "#1e293b", overflow: "hidden" }}>
                            <div style={{ width: `${s * 10}%`, height: "100%", background: getColor(s), borderRadius: 3, transition: "width 0.8s" }} />
                          </div>
                        ) : (
                          <div style={{ height: 6, borderRadius: 3, background: "#1e293b" }} />
                        )}
                      </div>
                      <div style={{ width: 48, textAlign: "right", fontSize: 13, fontWeight: 700, color: s ? getColor(s) : "#334155" }}>
                        {s ? `${s}/10` : "–"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Advance day */}
            <button onClick={advanceDay} style={{
              marginTop: 8, padding: "12px", borderRadius: 8,
              background: submittedToday.length === TEAM_MEMBERS.length ? "#3b82f6" : "#1e293b",
              border: "none",
              color: submittedToday.length === TEAM_MEMBERS.length ? "#fff" : "#475569",
              fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 13,
              cursor: "pointer", transition: "all 0.3s",
            }}>
              {submittedToday.length === TEAM_MEMBERS.length ? `✓ Lock Day ${day} & Advance →` : `Advance to Day ${day + 1} (${submittedToday.length}/${TEAM_MEMBERS.length} voted)`}
            </button>

            {/* End sprint */}
            <button onClick={() => { setNextGoal(""); setShowEndModal(true); }} style={{
              padding: "10px", borderRadius: 8,
              background: "transparent",
              border: "1px solid #7f1d1d",
              color: "#ef4444",
              fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 12,
              cursor: "pointer", letterSpacing: 1,
            }}>
              🏁 END SPRINT {sprintNumber}
            </button>
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Sub-tab toggle */}
            <div style={{ display: "flex", gap: 6 }}>
              {[{ id: "team", label: "Team" }, { id: "users", label: "Per User" }].map(t => (
                <button key={t.id} onClick={() => setTrendView(t.id)} style={{
                  padding: "6px 16px", borderRadius: 20, border: "none",
                  background: trendView === t.id ? "#3b82f6" : "#0a1929",
                  color: trendView === t.id ? "#fff" : "#475569",
                  fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 700,
                  cursor: "pointer", transition: "all 0.2s",
                }}>{t.label}</button>
              ))}
            </div>
            {trendView === "team" && <div style={{ background: "#0a1929", borderRadius: 12, padding: 24, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 16 }}>SPRINT TREND</div>
              {(() => {
                // Build unified points array from locked history + today's live stats
                const liveEntry = todayStats ? { day, avg: todayStats.avg, median: todayStats.median, min: todayStats.min, max: todayStats.max, live: true } : null;
                const points = [
                  ...history.map(h => ({ ...h, live: false })),
                  ...(liveEntry ? [liveEntry] : [])
                ];
                if (points.length === 0) return (
                  <div style={{ color: "#334155", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
                    No history yet — lock some days first
                  </div>
                );
                const W = 460, H = 180, padL = 28, padR = 16, padT = 20, padB = 24;
                const innerW = W - padL - padR;
                const innerH = H - padT - padB;
                const xScale = i => points.length < 2 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW;
                const yScale = v => padT + innerH - ((v - 1) / 9) * innerH;
                // Band path (min to max)
                const bandPath = points.length > 1
                  ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.max).toFixed(1)}`).join(" ")
                    + " " + [...points].reverse().map((p, i) => `${i === 0 ? "L" : "L"} ${xScale(points.length - 1 - i).toFixed(1)} ${yScale(p.min).toFixed(1)}`).join(" ") + " Z"
                  : null;
                const avgPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.avg).toFixed(1)}`).join(" ");
                const medPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.median).toFixed(1)}`).join(" ");
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: "visible" }}>
                    <defs>
                      <linearGradient id="bandGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.12" />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.04" />
                      </linearGradient>
                    </defs>
                    {/* Grid lines */}
                    {[2, 4, 6, 8, 10].map(v => (
                      <g key={v}>
                        <line x1={padL} y1={yScale(v)} x2={padL + innerW} y2={yScale(v)} stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 4" />
                        <text x={padL - 4} y={yScale(v)} textAnchor="end" dominantBaseline="middle" style={{ fontSize: 8, fill: "#334155", fontFamily: "'DM Mono', monospace" }}>{v}</text>
                      </g>
                    ))}
                    {/* Min-max band */}
                    {bandPath && <path d={bandPath} fill="url(#bandGrad)" stroke="#3b82f622" strokeWidth="1" />}
                    {/* Min line */}
                    {points.length > 1 && <path d={points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.min).toFixed(1)}`).join(" ")} fill="none" stroke="#ef444466" strokeWidth="1.5" strokeDasharray="3 3" />}
                    {/* Max line */}
                    {points.length > 1 && <path d={points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.max).toFixed(1)}`).join(" ")} fill="none" stroke="#22d3ee66" strokeWidth="1.5" strokeDasharray="3 3" />}
                    {/* Median line */}
                    {points.length > 1 && <path d={medPath} fill="none" stroke="#a78bfa" strokeWidth="2" strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" />}
                    {/* Avg line */}
                    {points.length > 1 && <path d={avgPath} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
                    {/* Dots for avg + median per day */}
                    {points.map((p, i) => (
                      <g key={i}>
                        {/* Min/max tick */}
                        <line x1={xScale(i)} y1={yScale(p.min)} x2={xScale(i)} y2={yScale(p.max)} stroke="#3b82f622" strokeWidth="6" strokeLinecap="round" />
                        {/* Avg dot */}
                        <circle cx={xScale(i)} cy={yScale(p.avg)} r={4.5}
                          fill={p.live ? "#0a1929" : getColor(p.avg)}
                          stroke={p.live ? getColor(p.avg) : "#0a1929"}
                          strokeWidth="2"
                          strokeDasharray={p.live ? "3 2" : "none"} />
                        {/* Median dot */}
                        <circle cx={xScale(i)} cy={yScale(p.median)} r={3}
                          fill="#a78bfa" stroke="#0a1929" strokeWidth="1.5" />
                        {/* Day label */}
                        <text x={xScale(i)} y={padT + innerH + 12} textAnchor="middle"
                          style={{ fontSize: 8, fill: p.live ? "#3b82f6" : "#475569", fontFamily: "'DM Mono', monospace" }}>
                          {p.live ? "TODAY" : `D${p.day}`}
                        </text>
                      </g>
                    ))}
                    {/* Legend */}
                    <g transform={`translate(${padL}, ${H - 6})`}>
                      <line x1="0" y1="0" x2="14" y2="0" stroke="#3b82f6" strokeWidth="2.5" />
                      <text x="17" y="0" dominantBaseline="middle" style={{ fontSize: 8, fill: "#94a3b8", fontFamily: "'DM Mono', monospace" }}>avg</text>
                      <line x1="40" y1="0" x2="54" y2="0" stroke="#a78bfa" strokeWidth="2" strokeDasharray="5 3" />
                      <text x="57" y="0" dominantBaseline="middle" style={{ fontSize: 8, fill: "#94a3b8", fontFamily: "'DM Mono', monospace" }}>median</text>
                      <line x1="96" y1="0" x2="110" y2="0" stroke="#22d3ee66" strokeWidth="1.5" strokeDasharray="3 3" />
                      <text x="113" y="0" dominantBaseline="middle" style={{ fontSize: 8, fill: "#94a3b8", fontFamily: "'DM Mono', monospace" }}>max</text>
                      <line x1="133" y1="0" x2="147" y2="0" stroke="#ef444466" strokeWidth="1.5" strokeDasharray="3 3" />
                      <text x="150" y="0" dominantBaseline="middle" style={{ fontSize: 8, fill: "#94a3b8", fontFamily: "'DM Mono', monospace" }}>min</text>
                    </g>
                  </svg>
                );
              })()}
            </div>}

            {/* Stats — team view only */}
            {history.length > 0 && trendView === "team" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "AVG", value: (history.reduce((a, b) => a + b.avg, 0) / history.length).toFixed(1), color: "#3b82f6" },
                  { label: "MEDIAN", value: (history.reduce((a, b) => a + b.median, 0) / history.length).toFixed(1), color: "#a78bfa" },
                  { label: "PEAK SPREAD", value: Math.max(...history.map(h => h.max - h.min)).toFixed(1), color: "#f59e0b", sub: "max delta" },
                  { label: "TREND", value: history.length > 1 ? (history[history.length-1].avg > history[0].avg ? "↑ UP" : "↓ DOWN") : "–", color: history.length > 1 ? (history[history.length-1].avg > history[0].avg ? "#4ade80" : "#ef4444") : "#475569" },
                ].map(s => (
                  <div key={s.label} style={{ background: "#0a1929", borderRadius: 8, padding: "12px 10px", border: "1px solid #1e3a5f", textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: "#475569", letterSpacing: 1, marginBottom: 4, textTransform: "uppercase" }}>{s.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: s.color }}>{s.value}</div>
                    {s.sub && <div style={{ fontSize: 7, color: "#334155", marginTop: 2 }}>{s.sub}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Per-user view */}
            {trendView === "users" && (() => {
              // Colour palette for members
              const palette = ["#3b82f6","#f59e0b","#4ade80","#f472b6","#a78bfa","#34d399","#fb923c","#22d3ee","#e879f9","#facc15","#60a5fa","#86efac","#fca5a5","#c4b5fd","#67e8f9","#fde68a"];
              // Days axis: locked history + live today
              const allDays = [
                ...history.map(h => ({ day: h.day, memberScores: h.memberScores || {}, live: false })),
                ...(todayStats ? [{ day, memberScores: Object.fromEntries(TEAM_MEMBERS.map(m => [m, scores[`${day}-${m}`] || null])), live: true }] : [])
              ];
              if (allDays.length === 0) return (
                <div style={{ color: "#334155", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
                  No history yet — lock some days first
                </div>
              );

              // Members who have voted at least once
              const activeMembers = TEAM_MEMBERS.filter(m => allDays.some(d => d.memberScores[m] != null));

              // SVG chart
              const W = 460, H = 190, padL = 28, padR = 16, padT = 16, padB = 24;
              const innerW = W - padL - padR;
              const innerH = H - padT - padB;
              const xScale = i => allDays.length < 2 ? padL + innerW / 2 : padL + (i / (allDays.length - 1)) * innerW;
              const yScale = v => padT + innerH - ((v - 1) / 9) * innerH;

              // Bias table: per member avg vs team avg per overlapping day
              const biasData = activeMembers.map(m => {
                const daysWithBoth = allDays.filter(d => d.memberScores[m] != null && !d.live);
                if (daysWithBoth.length === 0) return null;
                const memberAvg = daysWithBoth.reduce((s, d) => s + d.memberScores[m], 0) / daysWithBoth.length;
                const teamAvgOnSameDays = history.filter(h => daysWithBoth.find(d => d.day === h.day)).reduce((s, h) => s + h.avg, 0) / daysWithBoth.length;
                const bias = memberAvg - teamAvgOnSameDays;
                return { m, memberAvg, bias, days: daysWithBoth.length };
              }).filter(Boolean).sort((a, b) => b.bias - a.bias);

              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Chart */}
                  <div style={{ background: "#060f1e", borderRadius: 8, padding: "12px 8px", border: "1px solid #1e3a5f" }}>
                    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: "visible" }}>
                      {/* Grid */}
                      {[2,4,6,8,10].map(v => (
                        <g key={v}>
                          <line x1={padL} y1={yScale(v)} x2={padL+innerW} y2={yScale(v)} stroke="#1e3a5f" strokeWidth="1" strokeDasharray="3 3" />
                          <text x={padL-4} y={yScale(v)} textAnchor="end" dominantBaseline="middle" style={{ fontSize: 8, fill: "#334155", fontFamily: "'DM Mono', monospace" }}>{v}</text>
                        </g>
                      ))}
                      {/* Team avg as reference */}
                      {allDays.length > 1 && (
                        <path d={allDays.map((d, i) => {
                          const teamVal = d.live ? (todayStats ? todayStats.avg : null) : (history.find(h => h.day === d.day) || {}).avg;
                          return teamVal != null ? `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(teamVal).toFixed(1)}` : null;
                        }).filter(Boolean).join(" ")}
                          fill="none" stroke="#ffffff18" strokeWidth="2" strokeDasharray="6 3" />
                      )}
                      {/* Per-member lines */}
                      {activeMembers.map((m, mi) => {
                        const color = palette[mi % palette.length];
                        const isHighlighted = highlightMember === null || highlightMember === m;
                        const linePts = allDays.map((d, i) => d.memberScores[m] != null ? `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(d.memberScores[m]).toFixed(1)}` : null).filter(Boolean);
                        return (
                          <g key={m} style={{ opacity: isHighlighted ? 1 : 0.1, transition: "opacity 0.2s" }}>
                            {linePts.length > 1 && <path d={linePts.join(" ")} fill="none" stroke={color} strokeWidth={highlightMember === m ? 2.5 : 1.5} strokeLinejoin="round" strokeLinecap="round" />}
                            {allDays.map((d, i) => d.memberScores[m] != null && (
                              <circle key={i} cx={xScale(i)} cy={yScale(d.memberScores[m])} r={3}
                                fill={d.live ? "#060f1e" : color} stroke={color} strokeWidth="1.5"
                                strokeDasharray={d.live ? "2 2" : "none"} />
                            ))}
                          </g>
                        );
                      })}
                      {/* Day labels */}
                      {allDays.map((d, i) => (
                        <text key={i} x={xScale(i)} y={padT + innerH + 12} textAnchor="middle"
                          style={{ fontSize: 8, fill: d.live ? "#3b82f6" : "#475569", fontFamily: "'DM Mono', monospace" }}>
                          {d.live ? "TODAY" : `D${d.day}`}
                        </text>
                      ))}
                    </svg>
                  </div>

                  {/* Member legend / selector */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {activeMembers.map((m, mi) => (
                      <button key={m}
                        onClick={() => setHighlightMember(prev => prev === m ? null : m)}
                        style={{
                          padding: "4px 10px", borderRadius: 20, border: `1.5px solid ${palette[mi % palette.length]}`,
                          background: highlightMember === m ? palette[mi % palette.length] : "transparent",
                          color: highlightMember === m ? "#0f172a" : palette[mi % palette.length],
                          fontFamily: "'DM Mono', monospace", fontSize: 10, fontWeight: 700, cursor: "pointer",
                          transition: "all 0.15s", opacity: highlightMember && highlightMember !== m ? 0.35 : 1,
                        }}>{m}</button>
                    ))}
                  </div>

                  {/* Bias table */}
                  {biasData.length > 0 && (
                    <div style={{ background: "#060f1e", borderRadius: 8, border: "1px solid #1e3a5f", overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", borderBottom: "1px solid #1e3a5f", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 9, color: "#475569", letterSpacing: 2 }}>CONTEXTUAL BIAS</span>
                        <span style={{ fontSize: 8, color: "#334155" }}>member avg − team avg (same days)</span>
                      </div>
                      {biasData.map((b, i) => {
                        const mi = activeMembers.indexOf(b.m);
                        const color = palette[mi % palette.length];
                        const biasColor = b.bias > 0.5 ? "#4ade80" : b.bias < -0.5 ? "#ef4444" : "#94a3b8";
                        return (
                          <div key={b.m} style={{
                            display: "flex", alignItems: "center", padding: "8px 14px", gap: 10,
                            borderBottom: i < biasData.length - 1 ? "1px solid #0f2030" : "none",
                            background: highlightMember === b.m ? "#0f2540" : "transparent",
                            cursor: "pointer", transition: "background 0.15s",
                          }} onClick={() => setHighlightMember(prev => prev === b.m ? null : b.m)}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                            <div style={{ width: 80, fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>{b.m}</div>
                            <div style={{ flex: 1, height: 4, background: "#1e293b", borderRadius: 2, position: "relative" }}>
                              <div style={{
                                position: "absolute",
                                left: b.bias >= 0 ? "50%" : `${Math.max(0, 50 + (b.bias / 5) * 50)}%`,
                                width: `${Math.min(50, Math.abs(b.bias / 5) * 50)}%`,
                                height: "100%",
                                background: biasColor,
                                borderRadius: 2,
                              }} />
                              <div style={{ position: "absolute", left: "50%", top: -1, width: 1, height: 6, background: "#334155" }} />
                            </div>
                            <div style={{ width: 42, textAlign: "right", fontSize: 11, fontWeight: 700, color: biasColor }}>
                              {b.bias >= 0 ? "+" : ""}{b.bias.toFixed(2)}
                            </div>
                            <div style={{ width: 28, textAlign: "right", fontSize: 9, color: "#334155" }}>×{b.days}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      {/* SCORES TAB */}
      {activeTab === "scores" && (
        <div style={{ padding: "28px 32px", maxWidth: 560, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
          {completedSprints.length === 0 ? (
            <div style={{ textAlign: "center", color: "#334155", fontSize: 13, padding: "40px 0" }}>
              No completed sprints yet.<br />End a sprint to see scores.
            </div>
          ) : (() => {
            // Aggregate total points per member across all sprints
            const totalPoints = {};
            const sprintCount = {};
            const accuracy = {};
            TEAM_MEMBERS.forEach(m => { totalPoints[m] = 0; sprintCount[m] = 0; accuracy[m] = []; });
            completedSprints.forEach(s => {
              TEAM_MEMBERS.forEach(m => {
                if (s.memberPoints[m] != null) {
                  totalPoints[m] += s.memberPoints[m];
                  sprintCount[m]++;
                  accuracy[m].push(s.memberPoints[m]);
                }
              });
            });
            const ranked = TEAM_MEMBERS
              .filter(m => sprintCount[m] > 0)
              .sort((a, b) => totalPoints[b] - totalPoints[a]);
            const maxPts = ranked.length > 0 ? totalPoints[ranked[0]] : 1;
            const medals = ["🥇", "🥈", "🥉"];

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {/* Leaderboard */}
                <div style={{ background: "#0a1929", borderRadius: 12, border: "1px solid #1e3a5f", overflow: "hidden" }}>
                  <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e3a5f", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, color: "#475569", letterSpacing: 2 }}>ORACLE LEADERBOARD</span>
                    <span style={{ fontSize: 9, color: "#334155" }}>{completedSprints.length} sprint{completedSprints.length > 1 ? "s" : ""} completed</span>
                  </div>
                  {ranked.map((m, i) => {
                    const avg = accuracy[m].reduce((a, b) => a + b, 0) / accuracy[m].length;
                    const ptsMax = sprintCount[m] * 10;
                    return (
                      <div key={m} style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 18px",
                        borderBottom: i < ranked.length - 1 ? "1px solid #0a1f38" : "none",
                        background: i === 0 ? "#0f2540" : "transparent",
                      }}>
                        <div style={{ width: 22, fontSize: 16, textAlign: "center" }}>{medals[i] || `${i + 1}.`}</div>
                        <div style={{ width: 80, fontSize: 12, color: "#e2e8f0", fontWeight: 700 }}>{m}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ height: 5, background: "#1e293b", borderRadius: 3 }}>
                            <div style={{
                              height: "100%", borderRadius: 3,
                              width: `${(totalPoints[m] / Math.max(ptsMax, 1)) * 100}%`,
                              background: i === 0 ? "#fbbf24" : i === 1 ? "#94a3b8" : i === 2 ? "#fb923c" : "#3b82f6",
                              transition: "width 0.8s",
                            }} />
                          </div>
                        </div>
                        <div style={{ textAlign: "right", minWidth: 52 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: i === 0 ? "#fbbf24" : "#e2e8f0" }}>{totalPoints[m]}pt</div>
                          <div style={{ fontSize: 8, color: "#475569" }}>avg {avg.toFixed(1)}/10</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Per-sprint breakdown */}
                {completedSprints.map((s, si) => (
                  <div key={si} style={{ background: "#0a1929", borderRadius: 12, border: `1px solid ${s.outcome ? "#14532d" : "#7f1d1d"}`, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e3a5f", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#475569", letterSpacing: 1, marginBottom: 2 }}>SPRINT {s.number} · {s.days} day{s.days > 1 ? "s" : ""}</div>
                        <div style={{ fontSize: 12, color: "#94a3b8" }}>{s.goal}</div>
                      </div>
                      <div style={{
                        padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                        background: s.outcome ? "#14532d" : "#7f1d1d",
                        color: s.outcome ? "#4ade80" : "#ef4444",
                      }}>{s.outcome ? "✓ ACHIEVED" : "✗ MISSED"}</div>
                    </div>
                    <div style={{ padding: "8px 0" }}>
                      {Object.entries(s.memberPoints).sort((a, b) => b[1] - a[1]).map(([m, pts]) => {
                        const avg = s.memberAvgs[m];
                        const wasSkeptic = avg < 5.5;
                        const badge = s.outcome
                          ? (avg >= 7 ? "🎯 Optimist rewarded" : avg <= 4 ? "😬 Too skeptical" : "")
                          : (avg <= 4 ? "🎯 Skeptic rewarded" : avg >= 7 ? "😬 Too optimistic" : "");
                        return (
                          <div key={m} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 16px" }}>
                            <div style={{ width: 70, fontSize: 10, color: "#94a3b8" }}>{m}</div>
                            <div style={{ fontSize: 10, color: "#475569", width: 28 }}>{avg?.toFixed(1)}</div>
                            <div style={{ flex: 1, height: 4, background: "#1e293b", borderRadius: 2 }}>
                              <div style={{ height: "100%", borderRadius: 2, width: `${pts * 10}%`, background: pts >= 7 ? "#4ade80" : pts >= 4 ? "#fbbf24" : "#ef4444" }} />
                            </div>
                            <div style={{ width: 30, fontSize: 11, fontWeight: 700, textAlign: "right", color: pts >= 7 ? "#4ade80" : pts >= 4 ? "#fbbf24" : "#ef4444" }}>{pts}pt</div>
                            {badge && <div style={{ fontSize: 9, color: "#475569" }}>{badge}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* End Sprint Modal */}
      {showEndModal && (
        <div style={{
          position: "fixed", inset: 0, background: "#000000cc",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 100, backdropFilter: "blur(4px)",
        }}>
          <div style={{
            background: "#0a1929", border: "1px solid #1e3a5f", borderRadius: 16,
            padding: "36px 32px", maxWidth: 380, width: "90%",
            display: "flex", flexDirection: "column", gap: 20, textAlign: "center",
          }}>
            <div style={{ fontSize: 32 }}>🏁</div>
            <div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 800, color: "#f1f5f9", marginBottom: 8 }}>
                End Sprint {sprintNumber}?
              </div>
              <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                "{sprintGoal}"
              </div>
            </div>
            {/* Next sprint goal */}
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: 2, marginBottom: 8 }}>NEXT SPRINT GOAL</div>
              <input
                value={nextGoal}
                onChange={e => setNextGoal(e.target.value)}
                placeholder="What's the next sprint goal?"
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "#060f1e", border: "1px solid #1e3a5f", borderRadius: 8,
                  color: "#e2e8f0", fontFamily: "'DM Mono', monospace", fontSize: 12,
                  padding: "10px 12px", outline: "none",
                }}
              />
            </div>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>Was the sprint goal achieved?</div>
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => endSprint(false)} disabled={!nextGoal.trim()} style={{
                flex: 1, padding: "14px", borderRadius: 10,
                border: nextGoal.trim() ? "2px solid #7f1d1d" : "2px solid #1e293b",
                background: "#1a0a0a",
                color: nextGoal.trim() ? "#ef4444" : "#334155",
                fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 14,
                cursor: nextGoal.trim() ? "pointer" : "not-allowed", transition: "all 0.2s",
              }}>✗ No</button>
              <button onClick={() => endSprint(true)} disabled={!nextGoal.trim()} style={{
                flex: 1, padding: "14px", borderRadius: 10,
                border: nextGoal.trim() ? "2px solid #14532d" : "2px solid #1e293b",
                background: "#0a1a0a",
                color: nextGoal.trim() ? "#4ade80" : "#334155",
                fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 14,
                cursor: nextGoal.trim() ? "pointer" : "not-allowed", transition: "all 0.2s",
              }}>✓ Yes</button>
            </div>
            {!nextGoal.trim() && (
              <div style={{ fontSize: 10, color: "#475569" }}>Enter the next sprint goal to continue</div>
            )}
            <button onClick={() => setShowEndModal(false)} style={{
              background: "none", border: "none", color: "#334155",
              fontFamily: "'DM Mono', monospace", fontSize: 11, cursor: "pointer",
            }}>cancel</button>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}

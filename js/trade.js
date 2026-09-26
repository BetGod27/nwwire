/* NBA Trade Lab: two-team trades with simplified salary-matching rules. Uses helpers from app.js. */

const trade = { teams: ["7", "13"], rosters: {}, stats: {}, out: [new Set(), new Set()] };

const money = (n) => (n == null ? "—" : "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M");
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// Simplified 2023 CBA matching for teams under the first apron.
function maxIncoming(out) {
  if (out <= 7.5e6) return 2 * out + 250e3;
  if (out <= 29e6) return out + 7.5e6;
  return 1.25 * out + 250e3;
}

async function loadRoster(id) {
  if (trade.rosters[id]) return trade.rosters[id];
  const d = await espn("nba", `teams/${id}/roster`);
  const players = (d.athletes || []).map((a) => {
    const c = (a.contracts || [])[0];
    return {
      id: a.id, name: a.displayName, pos: a.position?.abbreviation || "", age: a.age,
      img: a.headshot?.href, salary: c?.salary ?? null, salYear: c?.season?.year,
      inj: (a.injuries || [])[0]?.status,
    };
  }).sort((x, y) => (y.salary || 0) - (x.salary || 0));
  trade.rosters[id] = players;
  return players;
}

async function loadStats(p) {
  if (p.id in trade.stats) return;
  trade.stats[p.id] = null;
  try {
    const d = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${p.id}/overview`);
    const s = d.statistics;
    const reg = s?.splits?.find((x) => /regular/i.test(x.displayName)) || s?.splits?.[0];
    if (!reg) return;
    const v = (n) => parseFloat(reg.stats[s.names.indexOf(n)]) || 0;
    trade.stats[p.id] = { pts: v("avgPoints"), reb: v("avgRebounds"), ast: v("avgAssists"), gp: v("gamesPlayed") };
  } catch { /* stats are optional */ }
}

function tradeShell() {
  const opts = TEAMS.nba.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  const side = (i) => `<div class="card-box tside" data-side="${i}">
      <select aria-label="Team ${i + 1}">${opts}</select>
      <div class="thead"></div>
      <div class="plist"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
    </div>`;
  return `
    <section class="trade-hero">
      <div class="trade-hero-inner">
        <div>
          <p class="kicker"><i>🔁</i>NBA Trade Lab</p>
          <h1>Build a Trade</h1>
          <p>Pick two teams, click players to send them across, and see whether the deal works under the salary-matching rules.</p>
        </div>
        <a class="btn back" href="#tradeTeaser">← Back to the Wire</a>
      </div>
    </section>
    <section class="trade-wrap">
      <div class="trade-layout">${side(0)}<div class="card-box tcenter" id="tCenter"></div>${side(1)}</div>
    </section>`;
}

function renderSide(i) {
  const el = document.querySelector(`.tside[data-side="${i}"]`);
  const tid = trade.teams[i], t = team("nba", tid), roster = trade.rosters[tid];
  el.querySelector("select").value = tid;
  if (!roster) return;
  const current = Math.max(...roster.map((p) => p.salYear || 0));
  el.querySelector(".thead").innerHTML = `<img src="${t.logo}" alt=""><div><strong>${esc(t.name)}</strong>
    <span class="tcap">${roster.length} players · ${money(sum(roster, (p) => p.salary))} payroll</span></div>`;
  el.querySelector(".plist").innerHTML = roster.map((p) => {
    const s = trade.stats[p.id];
    const stale = p.salYear && p.salYear < current;
    return `<button type="button" class="prow${trade.out[i].has(p.id) ? " sel" : ""}" data-id="${p.id}">
      ${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : `<span class="noimg"></span>`}
      <span><span class="nm">${esc(p.name)}</span>
        <span class="meta">${esc(p.pos)}${p.age ? " · " + p.age : ""}${s ? ` · <b>${s.pts.toFixed(1)}</b> pts ${s.reb.toFixed(1)} reb ${s.ast.toFixed(1)} ast` : ""}${p.inj ? ` · <span class="inj">${esc(p.inj)}</span>` : ""}</span></span>
      <span class="sal"${stale ? ' title="Most recent salary ESPN lists"' : ""}>${money(p.salary)}${stale ? "*" : ""}</span>
    </button>`;
  }).join("");
}

function renderCenter() {
  const [A, B] = trade.teams.map((id) => team("nba", id));
  const rA = trade.rosters[A.id] || [], rB = trade.rosters[B.id] || [];
  const outA = rA.filter((p) => trade.out[0].has(p.id)), outB = rB.filter((p) => trade.out[1].has(p.id));
  const sides = [
    { t: A, out: outA, inc: outB, size: rA.length },
    { t: B, out: outB, inc: outA, size: rB.length },
  ];

  let verdict;
  const problems = [], warnings = [];
  // Training camp allows 21 players; once the regular season starts it's 15 standard + 3 two-way.
  const now = new Date(), m = now.getMonth();
  const rosterMax = (m >= 6 && m < 9) || (m === 9 && now.getDate() < 20) ? 21 : 18;
  if (!outA.length && !outB.length) {
    verdict = `<div class="verdict idle">Click players on either side to start building a trade.</div>`;
  } else {
    for (const s of sides) {
      const o = sum(s.out, (p) => p.salary), inc = sum(s.inc, (p) => p.salary);
      s.o = o; s.inc$ = inc;
      s.allowed = Math.max(o, maxIncoming(o));
      if (!s.out.length && s.inc.length) problems.push(`${s.t.short} has to send something back. Absorbing salary needs cap space, which this doesn't model.`);
      else if (inc > s.allowed) problems.push(`${s.t.short} takes in ${money(inc - s.allowed)} too much salary. Add salary going out, or take back less.`);
      const after = s.size - s.out.length + s.inc.length;
      if (after > rosterMax && s.inc.length > s.out.length) warnings.push(`⚠ ${s.t.short} would be at ${after} players and need to waive ${after - rosterMax}.`);
    }
    const warn = warnings.length ? `<br>${warnings.map(esc).join("<br>")}` : "";
    verdict = problems.length
      ? `<div class="verdict bad">✖ Trade doesn't work yet<small>${problems.map(esc).join("<br>")}${warn}</small></div>`
      : `<div class="verdict ok">✔ Trade works<small>Salaries match under the league's trade rules.${warn}</small></div>`;
  }

  const gets = (s) => `<div>
      <h4><img src="${s.t.logo}" alt="">${esc(s.t.short)} get</h4>
      <ul>${s.inc.length ? s.inc.map((p) => `<li>${esc(p.name)}<span>${money(p.salary)}</span></li>`).join("") : `<li class="none">Nothing yet</li>`}</ul>
    </div>`;
  const salRows = outA.length || outB.length ? sides.map((s) => `<div class="salrow"><span>${esc(s.t.short)}: out <b>${money(s.o)}</b> · in <b>${money(s.inc$)}</b></span>
      <span>max in ${money(s.allowed)}</span><span class="${s.inc$ <= s.allowed && (s.out.length || !s.inc.length) ? "ok" : "bad"}">${s.inc$ <= s.allowed && (s.out.length || !s.inc.length) ? "✔" : "✖"}</span></div>`).join("") : "";

  const st = (arr, k) => sum(arr, (p) => trade.stats[p.id]?.[k]);
  const statRow = (label, k) => {
    const a = st(outB, k), b = st(outA, k);
    return `<tr><td>${label}</td><td class="${a > b ? "win" : ""}">${a.toFixed(1)}</td><td class="${b > a ? "win" : ""}">${b.toFixed(1)}</td></tr>`;
  };
  const stats = outA.length || outB.length ? `<table class="statcmp">
      <thead><tr><th>Last season, per game</th><th>${esc(A.abbr)} gets</th><th>${esc(B.abbr)} gets</th></tr></thead>
      <tbody>${statRow("Points", "pts")}${statRow("Rebounds", "reb")}${statRow("Assists", "ast")}</tbody></table>` : "";

  $("#tCenter").innerHTML = `
    ${verdict}
    <div class="tgets">${gets(sides[0])}${gets(sides[1])}</div>
    ${salRows ? `<div class="salbox">${salRows}</div>` : ""}
    ${stats}
    <div class="trade-actions">
      <button class="btn btn-small" type="button" data-act="swap">⇄ Swap sides</button>
      <button class="btn btn-small" type="button" data-act="reset">Reset</button>
    </div>
    <p class="trade-note">Uses simplified matching rules for teams under the first apron: up to 200% + $250K back on outgoing salary up to $7.5M, +$7.5M up to $29M, and 125% + $250K above that. It doesn't model cap space, apron or tax limits, trade exceptions, draft picks, or no-trade clauses. * = most recent salary ESPN lists.</p>`;
}

function renderTrade() {
  renderSide(0); renderSide(1); renderCenter();
}

let statsTimer;
async function loadTradeTeams() {
  await Promise.all(trade.teams.map((id) => loadRoster(id).catch(() => null)));
  renderTrade();
  // Fill in per-game stats in the background, then refresh once.
  const all = trade.teams.flatMap((id) => trade.rosters[id] || []);
  Promise.allSettled(all.map(loadStats)).then(() => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(renderTrade, 50);
  });
}

function setTeams(a, b) {
  trade.teams = [a, b];
  trade.out = [new Set(), new Set()];
  history.replaceState(null, "", `#trade-${a}-${b}`);
  loadTradeTeams();
}

async function showTrade(a, b) {
  const page = $("#tradePage");
  if (!page.dataset.built) {
    page.innerHTML = tradeShell();
    page.dataset.built = "1";
    page.addEventListener("change", (e) => {
      const sideEl = e.target.closest(".tside");
      if (!sideEl || e.target.tagName !== "SELECT") return;
      const i = +sideEl.dataset.side, v = e.target.value, other = trade.teams[1 - i];
      const next = [...trade.teams];
      next[i] = v;
      if (v === other) next[1 - i] = trade.teams[i]; // picking the other team swaps sides
      setTeams(next[0], next[1]);
    });
    page.addEventListener("click", (e) => {
      const row = e.target.closest(".prow");
      if (row) {
        const i = +row.closest(".tside").dataset.side, id = row.dataset.id;
        trade.out[i].has(id) ? trade.out[i].delete(id) : trade.out[i].add(id);
        row.classList.toggle("sel");
        renderCenter();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "reset") { trade.out = [new Set(), new Set()]; renderTrade(); }
      if (act === "swap") { trade.teams.reverse(); trade.out.reverse(); history.replaceState(null, "", `#trade-${trade.teams[0]}-${trade.teams[1]}`); renderTrade(); }
    });
  }
  const valid = (id) => TEAMS.nba.some((t) => t.id === id);
  if (a && b && a !== b && valid(a) && valid(b) && (a !== trade.teams[0] || b !== trade.teams[1])) {
    trade.teams = [a, b];
    trade.out = [new Set(), new Set()];
  }
  window.scrollTo(0, 0);
  await loadTradeTeams();
}

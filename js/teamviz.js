/* Team visuals (last 5, next-game matchup, stat leaders) and league standings. Uses helpers from app.js. */

const SPORT = { nba: "basketball", nfl: "football" };
const vizCache = {};      // "lg-id" -> { at, data }
const athleteCache = {};  // "lg-id" -> { name, short, headshot }
const VIZ_TTL = 10 * 60e3;

// ESPN labels the NBA season by the year it ends (2026-27 = 2027).
function seasonYear(lg) {
  const d = new Date();
  return lg === "nba" && d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}
const seasonLabel = (lg, s) => (lg === "nba" ? `${s - 1}-${String(s).slice(2)} season` : `${s} season`);
const coreUrl =(lg, path) => `https://sports.core.api.espn.com/v2/sports/${SPORT[lg]}/leagues/${lg}/${path}`;

async function athlete(lg, id) {
  const k = lg + "-" + id;
  if (!athleteCache[k]) {
    const d = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/${SPORT[lg]}/${lg}/athletes/${id}`).catch(() => ({}));
    const a = d.athlete || {};
    athleteCache[k] = { name: a.displayName || "", short: a.shortName || a.displayName || "", headshot: a.headshot?.href };
  }
  return athleteCache[k];
}

const LEADER_CATS = {
  nfl: [["passingYards", "Pass yds"], ["rushingYards", "Rush yds"], ["receivingYards", "Rec yds"]],
  nba: [["pointsPerGame", "Points"], ["reboundsPerGame", "Rebounds"], ["assistsPerGame", "Assists"]],
};

async function teamLeaders(lg, id) {
  const year = seasonYear(lg);
  let season = year, d = null;
  try { d = await getJSON(coreUrl(lg, `seasons/${year}/types/2/teams/${id}/leaders?limit=1`)); } catch { /* not started yet */ }
  if (!d?.categories?.length) {
    season = year - 1;
    try { d = await getJSON(coreUrl(lg, `seasons/${season}/types/2/teams/${id}/leaders?limit=1`)); } catch { return null; }
  }
  const out = [];
  for (const [name, label] of LEADER_CATS[lg]) {
    const L = d.categories?.find((c) => c.name === name)?.leaders?.[0];
    const aid = L?.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
    if (!L || !aid) continue;
    out.push({ label, value: L.value, aid, ...(await athlete(lg, aid)) });
  }
  return { season: seasonLabel(lg, season), leaders: out };
}

async function lastFive(lg, id) {
  const d = await espn(lg, `teams/${id}/schedule`);
  return (d.events || []).filter((e) => e.competitions[0].status.type.completed).slice(-5).map((e) => {
    const c = e.competitions[0];
    const us = c.competitors.find((x) => x.team.id === String(id));
    const them = c.competitors.find((x) => x.team.id !== String(id));
    return {
      res: us?.winner ? "W" : them?.winner ? "L" : "T",
      opp: them?.team.abbreviation, home: us?.homeAway === "home",
      score: `${scoreVal(us?.score)}-${scoreVal(them?.score)}`,
    };
  });
}

async function winProb(lg, eventId) {
  if (!eventId) return null;
  const s = await espn(lg, `summary?event=${eventId}`).catch(() => null);
  const p = s?.predictor;
  const h = parseFloat(p?.homeTeam?.gameProjection), a = parseFloat(p?.awayTeam?.gameProjection);
  return isNaN(h) || isNaN(a) ? null : { home: h, away: a, homeId: String(p.homeTeam.id), awayId: String(p.awayTeam.id) };
}

// Cached bundle for one team; refreshed every 10 minutes (or when the next game changes).
async function teamViz(lg, id, nextId) {
  const k = lg + "-" + id, c = vizCache[k];
  if (c && Date.now() - c.at < VIZ_TTL && c.nextId === nextId) return c.data;
  const [l5, lead, prob] = await Promise.allSettled([lastFive(lg, id), teamLeaders(lg, id), winProb(lg, nextId)]);
  const data = {
    last5: l5.status === "fulfilled" ? l5.value : [],
    leaders: lead.status === "fulfilled" ? lead.value : null,
    prob: prob.status === "fulfilled" ? prob.value : null,
  };
  vizCache[k] = { at: Date.now(), nextId, data };
  return data;
}

// ---------- HTML builders ----------
function last5Html(games) {
  if (!games.length) return `<div class="l5"><span class="l5-label">Last 5</span><span class="muted tiny">No games yet this season</span></div>`;
  return `<div class="l5"><span class="l5-label">Last ${games.length}</span>${games.map((g) =>
    `<span class="l5-chip ${g.res}" title="${g.home ? "vs" : "@"} ${esc(g.opp)} ${esc(g.score)}"><b>${g.res}</b><small>${g.home ? "" : "@"}${esc(g.opp)}</small></span>`).join("")}</div>`;
}

function matchupHtml(lg, next, prob, oddsPill) {
  if (!next) return `<div class="matchup empty"><span class="muted small">Next game TBD</span></div>`;
  const comp = next.competitions?.[0];
  const cs = comp?.competitors || [];
  const away = cs.find((c) => c.homeAway === "away"), home = cs.find((c) => c.homeAway === "home");
  if (!away || !home) return "";
  const ta = team(lg, away.team.id), th = team(lg, home.team.id);
  const st = comp.status?.type;
  const when = st?.state === "in" ? `<span class="live-tag">● LIVE · ${esc(st.shortDetail)}</span>` : st?.state === "post" ? esc(st.shortDetail) : esc(fmtGameTime(next.date));
  const side = (t, c) => `<a class="mu-team" href="#team-${lg}-${c.team.id}"><img src="${t?.logo || ""}" alt=""><b>${esc(t?.abbr || c.team.abbreviation || "")}</b></a>`;
  let bar = "";
  if (prob) {
    const pa = prob.awayId === String(away.team.id) ? prob.away : prob.home;
    const ph = 100 - pa;
    bar = `<div class="wp">
        <div class="wp-bar"><i style="width:${pa}%;background:#${ta?.color || "6fb1e8"}"></i><i style="width:${ph}%;background:#${th?.color || "1f6fb8"}"></i></div>
        <div class="wp-lbl"><span>${Math.round(pa)}%</span><span>ESPN win probability</span><span>${Math.round(ph)}%</span></div>
      </div>`;
  }
  return `<div class="matchup">
      <div class="mu-row">${side(ta, away)}<div class="mu-mid"><span class="mu-at">@</span><span class="mu-when">${when}</span>${oddsPill || ""}</div>${side(th, home)}</div>
      ${bar}
    </div>`;
}

function leadersHtml(L) {
  if (!L?.leaders?.length) return "";
  const fmt = (v) => (Number.isInteger(v) ? v : v.toFixed(1));
  return `<div class="leaders">
      <span class="ld-season">Team leaders · ${esc(L.season)}</span>
      <div class="ld-row">${L.leaders.map((p) => `<div class="ld">
        ${p.headshot ? `<img src="${esc(p.headshot)}" alt="" loading="lazy">` : `<span class="ld-noimg"></span>`}
        <strong>${fmt(p.value)}</strong><span class="ld-cat">${esc(p.label)}</span><span class="ld-name">${esc(p.short)}</span>
      </div>`).join("")}</div>
    </div>`;
}

// ---------- Standings ----------
let standingsLeague = "nfl";
const standingsCache = {};
const stat = (e, n) => e.stats?.find((s) => s.name === n);

async function fetchStandings(lg) {
  const c = standingsCache[lg];
  if (c && Date.now() - c.at < VIZ_TTL) return c.data;
  const url = (q) => `https://site.api.espn.com/apis/v2/sports/${SPORT[lg]}/${lg}/standings${q}`;
  let d = await getJSON(url(lg === "nfl" ? "?level=3" : ""));
  const flat = (n) => (n.children?.length ? n.children.flatMap(flat) : [n]);
  let groups = flat(d);
  let note = groups[0]?.standings?.seasonDisplayName ? `${groups[0].standings.seasonDisplayName} season` : "";
  const played = groups.some((g) => g.standings?.entries?.some((e) => (stat(e, "wins")?.value || 0) + (stat(e, "losses")?.value || 0) > 0));
  if (!played) {
    // Season hasn't started: show last season's final standings instead of a table of 0-0s.
    const season = (d.seasons?.[0]?.year || groups[0]?.standings?.season || seasonYear(lg)) - 1;
    d = await getJSON(url(`?season=${season}${lg === "nfl" ? "&level=3" : ""}`));
    groups = flat(d);
    note = `${groups[0]?.standings?.seasonDisplayName || season} final standings · new season starts soon`;
  }
  const data = { groups, note };
  standingsCache[lg] = { at: Date.now(), data };
  return data;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    (stat(b, "winPercent")?.value || 0) - (stat(a, "winPercent")?.value || 0) ||
    (stat(b, "pointDifferential")?.value ?? stat(b, "differential")?.value ?? 0) - (stat(a, "pointDifferential")?.value ?? stat(a, "differential")?.value ?? 0));
}

function standingsTable(lg, g, compact) {
  const entries = sortEntries(g.standings?.entries || []);
  const rows = entries.map((e, i) => {
    const t = team(lg, e.team.id) || {};
    const w = stat(e, "wins")?.displayValue || "0", l = stat(e, "losses")?.displayValue || "0", ti = stat(e, "ties")?.value;
    const diffS = stat(e, "pointDifferential") || stat(e, "differential");
    const diff = diffS?.value || 0;
    const cut = lg === "nba" && (i === 5 || i === 9) ? " cut" : "";
    return `<tr class="${isMine(lg, e.team.id) ? "me" : ""}${cut}">
      <td class="rk">${i + 1}</td>
      <td><a href="#team-${lg}-${e.team.id}"><img src="${t.logo || ""}" alt="" loading="lazy">${esc(compact ? t.abbr || e.team.abbreviation : t.short || e.team.shortDisplayName)}</a></td>
      <td>${w}-${l}${ti ? "-" + ti : ""}</td>
      ${lg === "nba" ? `<td>${esc(stat(e, "gamesBehind")?.displayValue || "-")}</td>` : ""}
      <td class="${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}">${esc(diffS?.displayValue || "0")}</td>
      <td>${esc(stat(e, "streak")?.displayValue || "-")}</td>
    </tr>`;
  }).join("");
  return `<table class="st-table">
      <thead><tr><th></th><th>${esc(g.name.replace(/ Conference$/, ""))}</th><th>W-L</th>${lg === "nba" ? "<th>GB</th>" : ""}<th>Diff</th><th>Strk</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

async function renderStandings() {
  const lg = standingsLeague, el = $("#standingsGrid");
  try {
    const { groups, note } = await fetchStandings(lg);
    if (lg !== standingsLeague) return;
    el.className = `st-grid ${lg}`;
    el.innerHTML = groups.map((g) => `<div class="card-box st-card">${standingsTable(lg, g, lg === "nfl")}</div>`).join("");
    $("#standingsNote").textContent = lg === "nba" ? `${note}${note ? " · " : ""}Top 6 make the playoffs, 7-10 go to the play-in.` : note;
  } catch {
    el.innerHTML = failMsg("standings");
  }
}

// The division/conference a team plays in, for team pages.
async function teamStandingsHtml(lg, id) {
  try {
    const { groups } = await fetchStandings(lg);
    const g = groups.find((x) => x.standings?.entries?.some((e) => e.team.id === String(id)));
    return g ? `<div class="card-box st-card">${standingsTable(lg, g, false)}</div>` : "";
  } catch { return ""; }
}

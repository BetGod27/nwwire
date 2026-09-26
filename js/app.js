/* The NW Wire — live dashboard. All data is fetched in the browser from free, keyless sources. */

// ---------- Config ----------
const MY_TEAMS = [
  { lg: "nba", id: "7" }, // Denver Nuggets
  { lg: "nfl", id: "7" }, // Denver Broncos
];
const SLEEPER = "https://api.sleeper.app/v1/";
const SPORTS_REFRESH = 60;        // seconds: wire, scores, my teams
const SLOW_REFRESH = 10 * 60;     // seconds: weather, RSS feeds
const INJURY_REFRESH = 5 * 60;    // seconds: full NBA/NFL injury reports (the biggest download)
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const PATH = { nba: "basketball/nba", nfl: "football/nfl" };
const RSS = "https://api.rss2json.com/v1/api.json?rss_url=";
const FEEDS = {
  world: "https://feeds.bbci.co.uk/news/world/rss.xml",
  markets: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  mrvl: "https://news.google.com/rss/search?q=Marvell+Technology+MRVL+stock&hl=en-US&gl=US&ceid=US:en",
  aspenTimes: "https://www.aspentimes.com/feed/",
  fantasy: "https://news.google.com/rss/search?q=fantasy+football+week&hl=en-US&gl=US&ceid=US:en",
  aspenSki: "https://news.google.com/rss/search?q=Aspen+Snowmass+ski&hl=en-US&gl=US&ceid=US:en",
};
const MOUNTAINS = [
  { name: "Aspen Mountain", lat: 39.1611, lon: -106.8186, elev: 3418 },
  { name: "Aspen Highlands", lat: 39.1580, lon: -106.8570, elev: 3559 },
  { name: "Buttermilk", lat: 39.2050, lon: -106.8600, elev: 3016 },
  { name: "Snowmass", lat: 39.2084, lon: -106.9490, elev: 3813 },
];
// Aspen Mountain & Snowmass typically open Thanksgiving week.
const OPENING_DAY = new Date("2026-11-26T09:00:00-07:00");

const TV_SYMBOLS = [
  ["S&P 500", "FOREXCOM:SPXUSD"], ["Nasdaq 100", "FOREXCOM:NSXUSD"], ["Dow 30", "FOREXCOM:DJI"],
  ["Apple", "NASDAQ:AAPL"], ["Microsoft", "NASDAQ:MSFT"], ["Nvidia", "NASDAQ:NVDA"],
  ["Amazon", "NASDAQ:AMZN"], ["Alphabet", "NASDAQ:GOOGL"], ["Meta", "NASDAQ:META"],
  ["Tesla", "NASDAQ:TSLA"], ["Marvell", "NASDAQ:MRVL"],
];

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stripHtml = (s = "") => { const d = document.createElement("div"); d.innerHTML = s; return d.textContent.trim(); };

async function getJSON(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const espn = (lg, p) => getJSON(ESPN + PATH[lg] + "/" + p);
async function rss(feed, retries = 2) {
  try {
    const d = await getJSON(RSS + encodeURIComponent(feed));
    if (d.status === "ok" && d.items?.length) return d.items;
    throw new Error(d.message || "empty feed");
  } catch (e) {
    if (retries <= 0) throw e;
    await new Promise((r) => setTimeout(r, 3000));
    return rss(feed, retries - 1);
  }
}

function parseDate(s) {
  if (!s) return null;
  // rss2json returns "YYYY-MM-DD HH:MM:SS" in UTC
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") + "Z" : s);
  return isNaN(d) ? null : d;
}
function ago(d) {
  d = d instanceof Date ? d : parseDate(d);
  if (!d) return "";
  const s = (Date.now() - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const fmtGameTime = (s) => new Date(s).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const team = (lg, id) => TEAMS[lg].find((t) => t.id === String(id));
const isMine = (lg, id) => MY_TEAMS.some((m) => m.lg === lg && m.id === String(id));
const scoreVal = (s) => (s && typeof s === "object" ? s.displayValue : s);

function newsItem(title, link, when, desc, img) {
  return `<article class="news-item${img ? "" : " noimg"}">
    <a href="${esc(link)}" target="_blank" rel="noopener">
      <time>${esc(ago(when))}</time><h4>${esc(title)}</h4>${desc ? `<p>${esc(desc)}</p>` : ""}
    </a>${img ? `<a href="${esc(link)}" target="_blank" rel="noopener"><img src="${esc(img)}" alt="" loading="lazy"></a>` : ""}
  </article>`;
}
const failMsg = (what) => `<p class="empty">Couldn't load ${what} right now. Retrying automatically.</p>`;

// ---------- Wire (transactions, injuries, news) ----------
const wire = { items: [], seen: new Set(), first: true, league: "all", kind: "all" };
let alertsOn = false;
let injuryCache = { nba: [], nfl: [] };
const injuryAt = { nba: 0, nfl: 0 };
let txCache = { nba: [], nfl: [] };

function classify(desc) {
  const d = desc.toLowerCase();
  if (/\btrad(e|ed)\b|acquired/.test(d)) return "trade";
  if (/claimed/.test(d)) return "signing";
  if (/injured reserve|\bir\b|reserve\/(pup|nfi)|activated|designated .* to return/.test(d)) return "injury";
  if (/waived|released|terminated|\bcut\b|suspend/.test(d)) return "release";
  if (/sign|re-sign|extension|contract|exercised|option/.test(d)) return "signing";
  return "signing";
}

// ESPN's official transaction log updates in daily batches, so breaking moves are
// picked out of the headlines instead. Only headlines that report an actual move are kept.
const MOVE_WORDS = /\b(trade[sd]?|trading|acquir(e|es|ed|ing)|deal|agree[sd]?|agreement|signs?|signed|re-signs?|re-signed|extension|waive[sd]?|releases?|released|claims?|claimed)\b/i;
const NOT_A_MOVE = /\?|buzz|rumou?r|tracker|grades?|odds|rank|best|worst|could|should|would|might|why |what |how |who |latest|takeaways|predict|mock|fantasy|bet|pick|reflects|reacts|reaction|talks|discuss|explains|says|stall|believes|worried|admission|admits|getting traded|former|fit|message|target|future|video|news:|update:|interested|eyeing|pursuing|linked/i;
function breakingMove(headline) {
  if (!MOVE_WORDS.test(headline) || NOT_A_MOVE.test(headline)) return null;
  const h = headline.toLowerCase();
  if (/trad|acquir|deal/.test(h)) return "trade";
  if (/waive|release/.test(h)) return "release";
  return "signing";
}

// Breaking moves come from ESPN headlines (every refresh) plus Google News, which picks up
// HoopsHype, theScore, RealGM, beat writers, etc. minutes before ESPN (every 2 minutes).
// Reports of the same move are merged into one item: same league, kind, and teams named.
const BREAKING_REFRESH = 2 * 60;
const BREAKING_KEEP = 24 * 3600e3;
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
// Google sorts searches by relevance and the relay returns 10 items, so use short, recent windows.
const BREAKING_FEEDS = {
  nba: [gnews("NBA trade OR traded when:2h"), gnews("NBA signs OR waived OR released when:3h")],
  nfl: [gnews("NFL trade OR traded when:2h"), gnews("NFL signs OR released OR waived when:3h")],
};
const TEAM_ALIASES = { Timberwolves: "Wolves", "Trail Blazers": "Blazers", "76ers": "Sixers", Cavaliers: "Cavs", Mavericks: "Mavs" };
const breakingNews = { nba: [], nfl: [] }, breakingAt = { nba: 0, nfl: 0 };

// Teams named in a headline, in the order they appear.
function teamsIn(lg, text) {
  const found = [];
  const place = (t) => t.name.replace(t.short, "").trim();
  for (const t of TEAMS[lg]) {
    // City names count too ("Charlotte"), unless two teams share the city (LA, New York).
    const city = place(t);
    const uniqueCity = city && TEAMS[lg].filter((o) => place(o) === city).length === 1 ? city : null;
    const names = [t.short, t.name, TEAM_ALIASES[t.short], uniqueCity].filter(Boolean);
    let at = -1;
    for (const n of names) {
      const m = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(text);
      if (m && (at < 0 || m.index < at)) at = m.index;
    }
    if (at >= 0) found.push([at, t.id]);
  }
  return found.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

async function loadBreaking(lg) {
  const espnJob = espn(lg, "news?limit=40").then((d) => (d.articles || []).map((a) => ({
    title: a.headline || "", source: "ESPN", date: parseDate(a.published),
  })));
  if (Date.now() - breakingAt[lg] >= BREAKING_REFRESH * 1000) {
    breakingAt[lg] = Date.now();
    const got = (await Promise.allSettled(BREAKING_FEEDS[lg].map((f) => rss(f, 0)))).flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const seen = new Set(breakingNews[lg].map((r) => r.title + r.source));
    for (const i of got) {
      const cut = i.title.lastIndexOf(" - "); // Google titles end with " - Outlet"
      const r = { title: cut > 0 ? i.title.slice(0, cut) : i.title, source: cut > 0 ? i.title.slice(cut + 3) : "News", date: parseDate(i.pubDate) };
      if (!seen.has(r.title + r.source)) { seen.add(r.title + r.source); breakingNews[lg].push(r); }
    }
    // Remember the last 24 hours of reports so items don't vanish when they age out of the search window.
    breakingNews[lg] = breakingNews[lg].filter((r) => r.date && Date.now() - r.date < BREAKING_KEEP);
    saveBreaking();
  }
  const reports = [...(await espnJob.catch(() => [])), ...breakingNews[lg]];

  const groups = new Map();
  for (const r of reports.sort((a, b) => (a.date || 0) - (b.date || 0))) {
    const kind = breakingMove(r.title);
    const teams = kind && teamsIn(lg, r.title);
    if (!kind || !teams.length) continue;
    const key = `${lg}|${kind}|${[...teams].sort().join(",")}`;
    const g = groups.get(key);
    if (g) { if (!g.sources.includes(r.source)) g.sources.push(r.source); continue; }
    groups.set(key, { lg, kind, breaking: true, key: "b|" + key, text: r.title, date: r.date, teamId: teams[0], teams, sources: [r.source] });
  }
  const logged = officialTrades(lg);
  return [...groups.values()].filter((g) =>
    // Credible: ESPN, a "Report:/Sources:" headline, or at least two outlets saying the same thing.
    (g.sources.includes("ESPN") || g.sources.length >= 2 || /^(report|sources?)\b/i.test(g.text)) &&
    // Already in the official log (an older trade people are still writing about): skip.
    !(g.kind === "trade" && logged.some((pair) => g.teams.every((t) => pair.has(t)))));
}

// Team sets from official trades in the last two weeks, e.g. {CHA, ATL} for "Acquired ... from Atlanta".
function officialTrades(lg) {
  const cutoff = Date.now() - 14 * 86400e3;
  return txCache[lg].filter((t) => /trad|acquired/i.test(t.description) && parseDate(t.date) > cutoff).map((t) => {
    const set = new Set([t.team?.id]);
    for (const tm of TEAMS[lg]) {
      const place = tm.name.replace(tm.short, "").trim();
      if (place && new RegExp(`\\b${place}\\b`, "i").test(t.description)) set.add(tm.id);
      if (new RegExp(`\\b${tm.short}\\b`, "i").test(t.description)) set.add(tm.id);
    }
    return set;
  });
}

function saveBreaking() {
  try { localStorage.setItem("nw-breaking", JSON.stringify(breakingNews)); } catch { /* storage unavailable */ }
}
function restoreBreaking() {
  try {
    const d = JSON.parse(localStorage.getItem("nw-breaking") || "{}");
    for (const lg of ["nba", "nfl"]) breakingNews[lg] = (d[lg] || []).map((r) => ({ ...r, date: new Date(r.date) }))
      .filter((r) => Date.now() - r.date < BREAKING_KEEP);
  } catch { /* start fresh */ }
}
restoreBreaking();

async function loadWire() {
  const jobs = [];
  for (const lg of ["nba", "nfl"]) {
    jobs.push(espn(lg, "transactions?limit=100").then((d) => {
      txCache[lg] = d.transactions || [];
      return txCache[lg].map((t) => ({
        lg, kind: classify(t.description), text: t.description, date: parseDate(t.date), teamId: t.team?.id,
      }));
    }));
    // Injury reports are large and change slowly: re-fetch every 5 minutes, reuse the last copy otherwise.
    const fresh = Date.now() - (injuryAt[lg] || 0) < INJURY_REFRESH * 1000;
    jobs.push((fresh ? Promise.resolve({ injuries: injuryCache[lg] }) : espn(lg, "injuries").then((d) => { injuryAt[lg] = Date.now(); return d; })).then((d) => {
      injuryCache[lg] = d.injuries || [];
      const out = [];
      const cutoff = Date.now() - 7 * 86400e3;
      for (const tm of injuryCache[lg]) for (const i of tm.injuries || []) {
        const when = parseDate(i.date);
        if (!when || when < cutoff || i.status === "Active") continue; // "Active" = cleared on the weekly report
        const a = i.athlete || {};
        const pos = a.position?.abbreviation ? ` (${a.position.abbreviation})` : "";
        const note = i.shortComment ? ` · ${i.shortComment}` : "";
        out.push({ lg, kind: "injury", text: `${a.displayName || "Player"}${pos}: ${i.status}${note}`, date: when, teamId: tm.id });
      }
      return out;
    }));
  }
  const results = await Promise.allSettled(jobs);
  // After the official log loads, so breaking items it already covers can be skipped.
  results.push(...(await Promise.allSettled(["nba", "nfl"].map(loadBreaking))));
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!items.length) { $("#wireList").innerHTML = `<li>${failMsg("the wire")}</li>`; return; }

  items.sort((a, b) => (b.date || 0) - (a.date || 0));
  const fresh = [];
  for (const it of items) {
    it.key = it.key || [it.lg, it.kind, it.text, it.teamId].join("|"); // breaking items keep their merged key
    if (!wire.seen.has(it.key)) { wire.seen.add(it.key); if (!wire.first) { it.isNew = true; fresh.push(it); } }
  }
  wire.items = items;
  wire.first = false;
  renderWire();
  if (alertsOn && fresh.length) notify(fresh);
}

function renderWire() {
  // Breaking trades from the last 6 hours stay pinned at the top.
  const pinned = (it) => (it.breaking && it.kind === "trade" && Date.now() - it.date < 6 * 3600e3 ? 1 : 0);
  const list = wire.items.filter((it) =>
    (wire.league === "all" || (wire.league === "mine" ? isMine(it.lg, it.teamId) : it.lg === wire.league)) &&
    (wire.kind === "all" || it.kind === wire.kind)
  ).sort((a, b) => pinned(b) - pinned(a)).slice(0, 150);
  $("#wireList").innerHTML = list.length ? list.map((it) => {
    const t = it.teamId && team(it.lg, it.teamId);
    const logo = t ? `<a href="#team-${it.lg}-${t.id}" title="${esc(t.name)}"><img src="${t.logo}" alt="${esc(t.abbr)}" loading="lazy"></a>` : `<span></span>`;
    const src = it.sources ? `<span class="src">via ${esc(it.sources[0])}${it.sources.length > 1 ? ` +${it.sources.length - 1} more` : ""}</span>` : "";
    const text = it.link ? `<a class="txt" href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.text)}</a>` : `<p class="txt">${esc(it.text)}${src}</p>`;
    return `<li class="item${it.isNew ? " new" : ""}${isMine(it.lg, it.teamId) ? " mine" : ""}">
      ${logo}
      <div><div class="meta-row">${it.breaking ? `<span class="breaking">🚨 Breaking</span>` : ""}<span class="kind ${it.kind}">${it.kind}</span><span class="lg">${it.lg.toUpperCase()}${t ? " · " + esc(t.abbr) : ""}</span></div>${text}</div>
      <time>${esc(ago(it.date))}</time></li>`;
  }).join("") : `<li class="empty">Nothing matches these filters right now.</li>`;
}

function notify(fresh) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // Most important first: trades, then anything involving my teams, then other moves, then injuries.
  const rank = (f) => (f.kind === "trade" ? 0 : isMine(f.lg, f.teamId) ? 1 : f.kind === "injury" ? 3 : 2);
  const top = [...fresh].sort((a, b) => rank(a) - rank(b) || (b.breaking ? 1 : 0) - (a.breaking ? 1 : 0)).slice(0, 3);
  for (const f of top) {
    const t = f.teamId && team(f.lg, f.teamId);
    new Notification(`${f.breaking ? "🚨 " : ""}${f.lg.toUpperCase()} ${f.kind}${t ? " · " + t.short : ""}`, { body: f.text, icon: t?.logo });
  }
}

// ---------- Scores ----------
// Scoreboards are shared by Scores, Betting, Fantasy and the My Teams cards.
const boards = { nba: null, nfl: null };
let scoreLeague = "nfl";
let betLeague = "nfl";

async function loadBoards() {
  await Promise.allSettled(["nba", "nfl"].map(async (lg) => {
    const d = await espn(lg, "scoreboard");
    boards[lg] = d;
  }));
}
function renderScores() {
  const d = boards[scoreLeague];
  if (!d) { $("#scoreList").innerHTML = failMsg("scores"); return; }
  const events = [...(d.events || [])];
  if (!events.length) { $("#scoreList").innerHTML = `<p class="empty">No ${scoreLeague.toUpperCase()} games on the schedule today.</p>`; return; }
  events.sort((a, b) => (a.status.type.state === "in" ? -1 : 0) - (b.status.type.state === "in" ? -1 : 0) || new Date(a.date) - new Date(b.date));
  $("#scoreList").innerHTML = events.map((ev) => gameCard(ev, scoreLeague)).join("");
}

// ---------- Betting ----------
const americanToProb = (o) => { o = Number(o); if (!o) return null; return o < 0 ? -o / (-o + 100) : 100 / (o + 100); };
const americanToDecimal = (o) => { o = Number(o); return o < 0 ? 1 + 100 / -o : 1 + o / 100; };
const lineNum = (s) => parseFloat(String(s ?? "").replace(/^[ou]/, ""));

function moveArrow(open, close, flip = false) {
  const a = lineNum(open), b = lineNum(close);
  if (isNaN(a) || isNaN(b) || a === b) return "";
  const up = flip ? b < a : b > a;
  return `<span class="move ${up ? "up" : "down"}" title="Opened ${esc(open)}">${up ? "▲" : "▼"}</span>`;
}

function lineCard(ev, lg) {
  const comp = ev.competitions[0];
  const o = comp.odds?.[0];
  if (!o) return "";
  const st = comp.status.type;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  const mine = [home, away].some((c) => isMine(lg, c.team.id));
  const side = (c, key) => {
    const t = team(lg, c.team.id);
    const ps = o.pointSpread?.[key], ml = o.moneyline?.[key];
    const tot = o.total?.[key === "away" ? "over" : "under"];
    const fav = o[key + "TeamOdds"]?.favorite;
    const prob = americanToProb(ml?.close?.odds);
    return `
      <a class="tm" href="#team-${lg}-${c.team.id}"><img src="${esc(t?.logo || c.team.logo)}" alt="">${esc(t?.short || c.team.shortDisplayName)}${fav ? ` <span class="fav">FAV</span>` : ""}</a>
      <div class="cell"><b>${esc(ps?.close?.line ?? "—")}${moveArrow(ps?.open?.line, ps?.close?.line)}</b><small>${esc(ps?.close?.odds ?? "")}</small></div>
      <div class="cell"><b>${esc(tot?.close?.line ?? (key === "away" ? "o" : "u") + (o.overUnder ?? "—"))}${moveArrow(tot?.open?.line, tot?.close?.line)}</b><small>${esc(tot?.close?.odds ?? "")}</small></div>
      <div class="cell"><b>${esc(ml?.close?.odds ?? "—")}</b><small>${prob ? Math.round(prob * 100) + "%" : ""}</small></div>`;
  };
  const when = st.state === "in" ? `<span class="live-tag">● LIVE · ${esc(st.shortDetail)}</span>` : esc(fmtGameTime(ev.date));
  return `<article class="line-card${mine ? " mine" : ""}${st.state === "in" ? " live" : ""}">
    <div class="line-head"><span>${when}</span><span>${esc(comp.broadcasts?.[0]?.names?.[0] || "")}</span></div>
    <div class="odds-grid">
      <span></span><span class="hdr">Spread</span><span class="hdr">Total</span><span class="hdr">Money</span>
      ${side(away, "away")}${side(home, "home")}
    </div>
    <div class="line-foot"><span>${esc(o.details || "")}${o.overUnder ? " · O/U " + o.overUnder : ""}</span><span>${esc(o.provider?.displayName || o.provider?.name || "")}</span></div>
  </article>`;
}

function renderLines() {
  const d = boards[betLeague];
  if (!d) { $("#lines").innerHTML = failMsg("betting lines"); return; }
  const evs = (d.events || [])
    .filter((e) => e.status.type.state !== "post" && e.competitions[0].odds?.length)
    .sort((a, b) => {
      const m = (e) => e.competitions[0].competitors.some((c) => isMine(betLeague, c.team.id)) ? -1 : 0;
      return m(a) - m(b) || new Date(a.date) - new Date(b.date);
    });
  const shown = betExpanded ? evs : evs.slice(0, 6);
  const more = evs.length > 6
    ? `<button class="btn btn-small show-more" id="betMore" type="button">${betExpanded ? "Show fewer" : `Show all ${evs.length} games`}</button>` : "";
  $("#lines").innerHTML = (shown.map((e) => lineCard(e, betLeague)).join("") ||
    `<p class="empty">No open ${betLeague.toUpperCase()} lines right now. They post as the next games get closer.</p>`) + more;
  $("#betMore")?.addEventListener("click", () => { betExpanded = !betExpanded; renderLines(); });
}
let betExpanded = false;

// ---------- Saved picks & record (written by scripts/nw_picks.rb) ----------
let record = null;
async function loadRecord() {
  try { record = await getJSON("data/record.json?t=" + Date.now()); } catch { record = null; }
  renderRecord();
  renderParlay();
  renderProp();
}
// The saved NFL picks for the week currently on the scoreboard, if any.
function savedWeek() {
  const c = record?.current, d = boards.nfl;
  return c && d && c.week === d.week?.number && c.season === d.season?.year ? c : null;
}
const fmtLock = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
function lockTag(w) {
  if (!w) return "";
  return w.locked ? `<span class="lock on">🔒 Locked</span>` : w.lockAt ? `<span class="lock">Preview · locks ${esc(fmtLock(w.lockAt))}</span>` : "";
}
function legResult(l) {
  if (!l.result) return "";
  const txt = { win: "✓ Hit", loss: "✗ Miss", void: "Void" }[l.result];
  return `<span class="res ${l.result}">${txt}${l.actual != null ? ` · ${l.t?.stat === "receptions" ? l.actual : Math.round(l.actual)}` : l.final ? ` · ${esc(l.final)}` : ""}</span>`;
}
const unitsTxt = (u) => (u > 0 ? "+" : u < 0 ? "−" : "") + Math.abs(u || 0).toFixed(2) + "u";

function renderRecord() {
  const el = $("#record");
  if (!record?.totals) { el.hidden = true; return; }
  el.hidden = false;
  const t = record.totals, g = t.game, p = t.prop;
  const net = (g.units || 0) + (p.units || 0);
  const card = (label, r) => `<div class="rec-card"><span>${label}</span><strong>${r.w}-${r.l}</strong><b class="${r.units > 0 ? "up" : r.units < 0 ? "down" : ""}">${unitsTxt(r.units)}</b></div>`;
  const weeks = [record.current, ...(record.history || [])].filter((w) => w?.locked);
  const cell = (par) => !par?.legs?.length ? "—" : par.result
    ? `<span class="res ${par.result}">${par.result === "win" ? "W" : par.result === "loss" ? "L" : "Void"}</span> ${par.result === "void" ? "" : unitsTxt(par.units)}`
    : `<span class="res pending">Pending</span> ${esc(par.odds || "")}`;
  const rows = weeks.map((w) => `<tr><td>${esc(w.label)}</td><td>${cell(w.game)}</td><td>${cell(w.prop)}</td></tr>`).join("");
  el.innerHTML = `
    <div class="rec-cards">
      ${card("Game parlay", g)}${card("Prop parlay", p)}
      <div class="rec-card total"><span>Net units</span><strong class="${net > 0 ? "up" : net < 0 ? "down" : ""}">${unitsTxt(net)}</strong><b>1 unit per parlay</b></div>
    </div>
    <details class="rec-history"${weeks.length ? "" : " hidden"}><summary>Week-by-week results</summary>
      <table><thead><tr><th>Week</th><th>Game parlay</th><th>Prop parlay</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
    <p class="muted tiny">${record.since ? `Tracking since ${esc(record.since)}.` : `Tracking starts when this week's picks lock${record.current?.lockAt ? ` (${esc(fmtLock(record.current.lockAt))})` : ""}.`}
      Picks lock 4 hours before the first leg and are graded from final box scores. Prop legs are graded at -110.</p>`;
}

// ---------- The NW Parlay (ESPN model vs. DraftKings market) ----------
const predictions = {}; // eventId -> { home, away, at }
async function loadPredictions(lg) {
  const evs = (boards[lg]?.events || []).filter((e) => e.status.type.state === "pre" && e.competitions[0].odds?.length);
  await Promise.allSettled(evs.map(async (e) => {
    const cached = predictions[e.id];
    if (cached && Date.now() - cached.at < 15 * 60e3) return;
    const s = await espn(lg, `summary?event=${e.id}`);
    const p = s.predictor;
    const home = parseFloat(p?.homeTeam?.gameProjection), away = parseFloat(p?.awayTeam?.gameProjection);
    if (!isNaN(home) && !isNaN(away)) predictions[e.id] = { home: home / 100, away: away / 100, at: Date.now() };
  }));
}

function buildParlay(lg) {
  const cands = [];
  for (const ev of boards[lg]?.events || []) {
    const comp = ev.competitions[0], o = comp.odds?.[0], pred = predictions[ev.id];
    if (ev.status.type.state !== "pre" || !o || !pred) continue;
    const mlH = o.moneyline?.home?.close?.odds, mlA = o.moneyline?.away?.close?.odds;
    const rawH = americanToProb(mlH), rawA = americanToProb(mlA);
    if (!rawH || !rawA) continue;
    for (const key of ["home", "away"]) {
      const c = comp.competitors.find((x) => x.homeAway === key);
      const opp = comp.competitors.find((x) => x.homeAway !== key);
      const ps = o.pointSpread?.[key];
      const market = (key === "home" ? rawH : rawA) / (rawH + rawA); // vig removed
      const model = pred[key];
      const open = lineNum(ps?.open?.line), close = lineNum(ps?.close?.line);
      cands.push({
        ev, key, teamId: c.team.id, oppAbbr: opp.team.abbreviation, ml: Number(key === "home" ? mlH : mlA),
        model, market, edge: model - market, steam: !isNaN(open) && !isNaN(close) && close < open,
      });
    }
  }
  const score = (c) => c.edge * 2 + (c.model - 0.5) + (c.steam ? 0.03 : 0);
  const pick = (pool) => {
    const legs = [], used = new Set();
    for (const c of pool.sort((a, b) => score(b) - score(a))) {
      if (used.has(c.ev.id)) continue;
      legs.push(c); used.add(c.ev.id);
      if (legs.length === 3) break;
    }
    return legs;
  };
  // Prefer favorites the model likes at least as much as the market, without extreme juice.
  let legs = pick(cands.filter((c) => c.model >= 0.6 && c.edge >= -0.01 && c.ml >= -400));
  if (legs.length < 3) {
    const extra = pick(cands.filter((c) => c.ml >= -450 && !legs.some((l) => l.ev.id === c.ev.id)).sort((a, b) => b.model - a.model));
    legs = [...legs, ...extra].slice(0, 3);
  }
  return legs;
}

function renderParlay() {
  const lg = betLeague;
  const saved = lg === "nfl" ? savedWeek() : null;
  const legs = saved?.game?.legs?.length ? saved.game.legs : buildParlay(lg);
  const period = lg === "nfl" ? `Week ${boards.nfl?.week?.number || ""}` : "Today";
  if (legs.length < 3) {
    $("#parlay").innerHTML = `<div class="parlay-head"><div><p class="tag">The NW Parlay · ${esc(lg.toUpperCase())}</p><h3>Parlay of the ${lg === "nfl" ? "week" : "day"}</h3></div></div>
      <p class="empty" style="padding:1.2rem 1.4rem">Not enough ${lg.toUpperCase()} games have both odds and ESPN projections posted yet. The picks build automatically once they do.</p>`;
    return;
  }
  const dec = legs.reduce((a, l) => a * americanToDecimal(l.ml), 1);
  const american = dec >= 2 ? "+" + Math.round((dec - 1) * 100) : String(Math.round(-100 / (dec - 1)));
  const modelHit = legs.reduce((a, l) => a * l.model, 1);
  const marketHit = legs.reduce((a, l) => a * l.market, 1);
  const pct = (p) => Math.round(p * 100) + "%";
  const legHtml = legs.map((l, i) => {
    const t = team(lg, l.teamId);
    const chips = [
      `<span>ESPN model ${pct(l.model)}</span>`,
      `<span>Market ${pct(l.market)}</span>`,
      l.edge > 0.005 ? `<span class="good">+${Math.round(l.edge * 100)}% edge</span>` : "",
      l.steam ? `<span class="good">Line moving their way</span>` : "",
    ].join("");
    return `<div class="pleg">
      <span class="n">${i + 1}</span>
      <img src="${t?.logo}" alt="">
      <div><strong>${esc(t?.name || "")} ML ${legResult(l)}</strong><span class="game-meta">${l.key === "home" ? "vs" : "@"} ${esc(l.oppAbbr)} · ${esc(fmtGameTime(l.ev.date))}</span><div class="why">${chips}</div></div>
      <span class="ml">${l.ml > 0 ? "+" : ""}${l.ml}<small>DraftKings</small></span>
    </div>`;
  }).join("");
  $("#parlay").innerHTML = `
    <div class="parlay-head">
      <div><p class="tag">The NW Parlay · ${esc(period)} ${lockTag(saved)}</p><h3>3-Leg Parlay of the ${lg === "nfl" ? "Week" : "Day"}</h3></div>
      <div class="odds"><strong>${american}</strong><span>$10 pays $${(10 * dec).toFixed(2)}</span></div>
    </div>
    ${legHtml}
    <div class="parlay-foot">
      <div><span>ESPN model hit chance</span><strong class="${modelHit > marketHit ? "good" : ""}">${(modelHit * 100).toFixed(1)}%</strong></div>
      <div><span>Sportsbook implied</span><strong>${(marketHit * 100).toFixed(1)}%</strong></div>
      <div><span>Edge</span><strong class="${modelHit > marketHit ? "good" : ""}">${modelHit > marketHit ? "+" : ""}${((modelHit - marketHit) * 100).toFixed(1)}%</strong></div>
    </div>
    <p class="parlay-note">How it's picked: legs where ESPN's game model gives a team a better chance than the DraftKings odds do, boosted when the line has moved toward that team. It updates as lines move, until kickoff. Data-backed, not a guarantee: parlays are high risk. 21+ · 1-800-GAMBLER.</p>`;
}

// ---------- Prop of the week (DraftKings player props vs. game logs) ----------
const PROP_TYPES = {
  "Total Passing Yards (incl. overtime)": { stat: "passingYards", label: "passing yards", min: 150 },
  "Total Rushing Yards (incl. overtime)": { stat: "rushingYards", label: "rushing yards", min: 30 },
  "Total Receiving Yards (incl. overtime)": { stat: "receivingYards", label: "receiving yards", min: 30 },
  "Total Receptions (incl. overtime)": { stat: "receptions", label: "receptions", min: 2.5 },
};
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/";
const propState = { picks: [], at: 0, loading: false, empty: false };

async function fetchProps(ev) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const d = await getJSON(`${CORE}events/${ev.id}/competitions/${ev.id}/odds/100/propBets?limit=1000&page=${page}`);
    for (const i of d.items || []) {
      const t = PROP_TYPES[i.type?.name];
      const line = i.current?.target?.value, open = i.open?.target?.value;
      const ath = i.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
      if (t && ath && line != null && line >= t.min) out.push({ ev, ath, type: i.type.name, t, line, open: open ?? line });
    }
    if (page >= (d.pageCount || 1)) break;
  }
  return out;
}

async function evaluateProp(c) {
  const [gl, info] = await Promise.all([getJSON(WEB + c.ath + "/gamelog"), getJSON(WEB + c.ath)]);
  const idx = (gl.names || []).indexOf(c.t.stat);
  const cat = gl.seasonTypes?.find((s) => /regular/i.test(s.displayName))?.categories?.find((x) => /regular/i.test(x.displayName)) ||
              gl.seasonTypes?.[0]?.categories?.[0];
  if (idx < 0 || !cat?.events?.length) return null;
  const games = cat.events.map((e) => ({ v: parseFloat(e.stats[idx]) || 0, opp: gl.events?.[e.eventId]?.opponent?.abbreviation }));
  if (games.length < 2) return null;
  const avg = games.reduce((a, g) => a + g.v, 0) / games.length;
  const side = avg >= c.line ? "over" : "under";
  const hits = games.filter((g) => (side === "over" ? g.v > c.line : g.v < c.line)).length;
  const move = c.line - c.open;
  const moveAgrees = move === 0 ? 0 : (move > 0) === (side === "over") ? 1 : -1;
  const edge = Math.abs(avg - c.line) / c.line;
  const hitRate = hits / games.length;
  const a = info.athlete || {};
  return {
    ...c, games, avg, side, hits, hitRate, move, moveAgrees, edge,
    name: a.displayName, pos: a.position?.abbreviation, teamAbbr: a.team?.abbreviation, headshot: a.headshot?.href,
    score: Math.min(edge, 0.6) + 0.4 * (hitRate - 0.5) + 0.08 * moveAgrees,
  };
}

async function loadProp() {
  if (propState.loading || Date.now() - propState.at < 30 * 60e3) return;
  propState.loading = true;
  try {
    const evs = (boards.nfl?.events || []).filter((e) => e.status.type.state === "pre");
    const all = (await Promise.allSettled(evs.map(fetchProps))).flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    // One entry per player + prop type; biggest movers first, then the biggest roles.
    const seen = new Set();
    const cands = all.filter((c) => { const k = c.ath + c.type; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => Math.abs(b.line - b.open) / b.line - Math.abs(a.line - a.open) / a.line || b.line / b.t.min - a.line / a.t.min)
      .slice(0, 30);
    const evaluated = (await Promise.allSettled(cands.map(evaluateProp))).map((r) => r.status === "fulfilled" && r.value).filter(Boolean);
    // Best 3 props from 3 different players, preferring different games (less correlated).
    const byScore = (arr) => arr.sort((a, b) => b.score - a.score);
    const strong = byScore(evaluated.filter((p) => p.hitRate >= 0.66 && p.edge >= 0.08 && p.moveAgrees >= 0));
    const backup = byScore(evaluated.filter((p) => p.hitRate >= 0.66 && p.moveAgrees >= 0 && !strong.includes(p)));
    const legs = [];
    for (const pass of [(p) => !legs.some((l) => l.ev.id === p.ev.id), () => true]) {
      for (const p of [...strong, ...backup]) {
        if (legs.length === 3) break;
        if (!legs.includes(p) && !legs.some((l) => l.ath === p.ath) && pass(p)) legs.push(p);
      }
    }
    propState.picks = legs;
    propState.empty = !legs.length;
    propState.at = Date.now();
  } catch (e) {
    console.error(e);
  } finally {
    propState.loading = false;
  }
  renderProp();
}

function renderProp() {
  const el = $("#prop");
  if (betLeague !== "nfl") {
    el.innerHTML = `<div class="prop-head"><p class="tag">Prop parlay · NBA</p><h3>3-Leg Prop Parlay</h3></div>
      <p class="empty" style="padding:1rem 1.3rem">NBA player props start once the regular season tips off. Switch to NFL for this week's prop parlay.</p>`;
    return;
  }
  const saved = savedWeek();
  const legs = saved?.prop?.legs?.length ? saved.prop.legs : propState.picks;
  if (!legs.length) {
    if (saved && !propState.at) loadProp().catch(console.error); // saved week had no props: fall back to a live build
    if (propState.empty) el.innerHTML = `<div class="prop-head"><p class="tag">Prop parlay · NFL</p><h3>3-Leg Prop Parlay</h3></div>
      <p class="empty" style="padding:1rem 1.3rem">No props clear the bar right now. Each leg needs a player's form and the line movement to agree. Check back as lines move.</p>`;
    return;
  }
  // Props are usually priced near -110; estimate the parlay at that price.
  const dec = Math.pow(1 + 100 / 110, legs.length);
  const american = "+" + Math.round((dec - 1) * 100);
  const legHtml = legs.map((p, i) => {
    const comp = p.ev.competitions[0];
    const opp = comp.competitors.find((c) => c.team.abbreviation !== p.teamAbbr)?.team.abbreviation;
    const fmt = (v) => (p.t.stat === "receptions" ? v.toFixed(0) : Math.round(v));
    const hit = (v) => (p.side === "over" ? v > p.line : v < p.line);
    const chips = [
      `<span>Avg ${fmt(p.avg)}</span>`,
      `<span class="${p.hitRate === 1 ? "good" : ""}">${p.hits}/${p.games.length} ${p.side}</span>`,
      p.move ? `<span class="${p.moveAgrees > 0 ? "good" : ""}">Line ${p.open} → ${p.line}</span>` : `<span>Line steady</span>`,
    ].join("");
    return `<div class="prop-leg">
      <span class="n">${i + 1}</span>
      ${p.headshot ? `<img src="${esc(p.headshot)}" alt="">` : `<span class="noimg"></span>`}
      <div class="pl-main">
        <strong>${esc(p.name)} ${legResult(p)}</strong>
        <span class="game-meta">${esc(p.pos || "")} · ${esc(p.teamAbbr || "")} vs ${esc(opp || "")} · ${esc(fmtGameTime(p.ev.date))}</span>
        <div class="why">${chips}</div>
        <div class="prop-log">${p.games.map((g) => `<span class="${hit(g.v) ? "hit" : "miss"}">${fmt(g.v)}<small>${esc(g.opp || "")}</small></span>`).join("")}</div>
      </div>
      <div class="prop-pick"><span class="side ${p.side}">${p.side.toUpperCase()}</span><strong>${p.line}</strong><small>${esc(p.t.label)}</small></div>
    </div>`;
  }).join("");
  el.innerHTML = `
    <div class="prop-head">
      <div><p class="tag">Prop parlay · NFL Week ${boards.nfl?.week?.number || ""} ${lockTag(saved)}</p><h3>${legs.length}-Leg Prop Parlay</h3></div>
      <div class="odds"><strong>≈${american}</strong><span>$10 pays ≈$${(10 * dec).toFixed(2)}</span></div>
    </div>
    ${legHtml}
    ${legs.length < 3 ? `<p class="parlay-note">Only ${legs.length} prop${legs.length > 1 ? "s" : ""} clear the bar right now. More legs get added as lines post.</p>` : ""}
    <p class="parlay-note">Each leg: a player whose season average beats his DraftKings line, who's hit that side in most games, and whose line isn't moving against him. Odds are estimated at -110 per leg, so check exact prices on FanDuel. Data-backed, not a guarantee. 21+ · 1-800-GAMBLER.</p>`;
}

async function refreshParlay() {
  if (!(betLeague === "nfl" && savedWeek()?.prop?.legs?.length)) loadProp().catch(console.error);
  renderProp();
  await loadPredictions(betLeague).catch(console.error);
  renderParlay();
}
function loadExperts() {
  const q = betLeague === "nfl" ? `NFL week ${boards.nfl?.week?.number || ""} expert picks predictions` : "NBA best bets today picks";
  loadRss([`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`], "#expertNews", { limit: 6, images: false });
}

function renderCalc() {
  const stake = parseFloat($("#calcStake").value) || 0;
  const odds = [...document.querySelectorAll("#calcLegs .leg")].map((i) => parseFloat(i.value)).filter((v) => v && Math.abs(v) >= 100);
  if (!odds.length) { $("#calcOut").innerHTML = `<p class="muted tiny" style="grid-column:1/-1">Enter odds like -110 or +150.</p>`; return; }
  const dec = odds.reduce((a, o) => a * americanToDecimal(o), 1);
  const payout = stake * dec;
  const prob = odds.reduce((a, o) => a * americanToProb(o), 1);
  const american = dec >= 2 ? "+" + Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  const $$ = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $("#calcOut").innerHTML = `
    <div><span>To win</span><strong>${$$(payout - stake)}</strong></div>
    <div><span>Total payout</span><strong>${$$(payout)}</strong></div>
    <div><span>${odds.length > 1 ? odds.length + "-leg odds" : "Odds"}</span><strong>${american}</strong></div>
    <div><span>Implied chance</span><strong>${(prob * 100).toFixed(1)}%</strong></div>`;
}

// ---------- Fantasy ----------
let ffPos = "all";
const player = (id) => { const p = FF_PLAYERS[id]; return p ? { name: p[0], pos: p[1], tm: p[2] } : null; };
const nflTeamByAbbr = (abbr) => TEAMS.nfl.find((t) => t.abbr === abbr || (abbr === "WAS" && t.abbr === "WSH"));

const trending = { adds: null, drops: null };
async function loadTrending() {
  const [adds, drops] = await Promise.allSettled([
    getJSON(SLEEPER + "players/nfl/trending/add?lookback_hours=24&limit=15"),
    getJSON(SLEEPER + "players/nfl/trending/drop?lookback_hours=24&limit=15"),
  ]);
  trending.adds = adds.status === "fulfilled" ? adds.value : null;
  trending.drops = drops.status === "fulfilled" ? drops.value : null;
  renderTrending();
}
function renderTrending() {
  const row = (x) => {
    const p = player(x.player_id);
    if (!p) return "";
    return `<li><span class="pl"><span class="pos ${p.pos}">${p.pos}</span><span>${esc(p.name)}</span><span class="tm-abbr">${esc(p.tm)}</span></span><span class="ct">${x.count.toLocaleString()}</span></li>`;
  };
  $("#ffAdds").innerHTML = trending.adds ? trending.adds.map(row).join("") : `<li>${failMsg("trending adds")}</li>`;
  $("#ffDrops").innerHTML = trending.drops ? trending.drops.map(row).join("") : `<li>${failMsg("trending drops")}</li>`;
}


function renderImplied() {
  const d = boards.nfl;
  const rows = [];
  for (const ev of d?.events || []) {
    const comp = ev.competitions[0], o = comp.odds?.[0];
    if (!o || !o.overUnder || o.spread == null || ev.status.type.state === "post") continue;
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    const homePts = (o.overUnder - o.spread) / 2; // spread is from the home side (negative = home favored)
    rows.push({ id: home.team.id, pts: homePts, opp: away.team.abbreviation, at: "vs" });
    rows.push({ id: away.team.id, pts: o.overUnder - homePts, opp: home.team.abbreviation, at: "@" });
  }
  rows.sort((a, b) => b.pts - a.pts);
  const max = rows[0]?.pts || 1;
  $("#ffImplied").innerHTML = rows.slice(0, 12).map((r) => {
    const t = team("nfl", r.id);
    return `<li${isMine("nfl", r.id) ? ' style="font-weight:700"' : ""}><span class="pl"><img src="${t.logo}" alt=""><span>${esc(t.short)}</span><span class="tm-abbr">${r.at} ${esc(r.opp)}</span></span>
      <span class="barwrap"><i style="width:${Math.round((r.pts / max) * 70)}px"></i><b>${r.pts.toFixed(1)}</b></span></li>`;
  }).join("") || `<li class="empty">Lines for the next slate aren't posted yet.</li>`;
}

function renderFfInjuries() {
  const statusKey = (s) => (/reserve/i.test(s) ? "IR" : s.split(" ")[0]);
  const rows = [];
  for (const tm of injuryCache.nfl) for (const i of tm.injuries || []) {
    const pos = i.athlete?.position?.abbreviation;
    if (!["QB", "RB", "WR", "TE"].includes(pos) || i.status === "Active") continue;
    if (ffPos !== "all" && pos !== ffPos) continue;
    rows.push({ i, pos, tmId: tm.id, date: parseDate(i.date) });
  }
  const order = { Out: 0, Doubtful: 1, Questionable: 2, IR: 3 };
  rows.sort((a, b) => (order[statusKey(a.i.status)] ?? 4) - (order[statusKey(b.i.status)] ?? 4) || b.date - a.date);
  $("#ffInjuries").innerHTML = rows.slice(0, 60).map(({ i, pos, tmId }) => {
    const t = team("nfl", tmId);
    return `<div class="inj-row">
      <span class="who"><span class="pos ${pos}">${pos}</span>${t ? `<img src="${t.logo}" alt="">` : ""}${esc(i.athlete?.displayName)}</span>
      <span class="status-pill ${statusKey(i.status)}">${esc(i.status)}</span>
      ${i.shortComment ? `<p>${esc(i.shortComment)}</p>` : ""}</div>`;
  }).join("") || `<p class="empty">No fantasy-relevant injuries reported.</p>`;
}

function renderKickoff() {
  const d = boards.nfl;
  const week = d?.week?.number;
  if (week) $("#ffWeek").textContent = `03 · Fantasy · Week ${week}`;
  const live = (d?.events || []).filter((e) => e.status.type.state === "in").length;
  const next = (d?.events || []).filter((e) => e.status.type.state === "pre").sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  if (live) { $("#kickoff").innerHTML = `<strong>${live} live</strong><span>games in progress · set your lineup</span>`; return; }
  if (!next) { $("#kickoff").innerHTML = `<strong>Week ${week || ""} done</strong><span>Waivers run midweek</span>`; return; }
  const ms = new Date(next.date) - Date.now();
  const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  $("#kickoff").innerHTML = `<strong>${h >= 48 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h + "h " + m + "m"}</strong><span>to next kickoff · ${esc(next.shortName)}</span>`;
}
function gameCard(ev, lg) {
  const comp = ev.competitions[0];
  const st = comp.status?.type || ev.status.type;
  const cs = [...comp.competitors].sort((a) => (a.homeAway === "away" ? -1 : 1));
  const mine = cs.some((c) => isMine(lg, c.team.id));
  const started = st.state !== "pre";
  const rows = cs.map((c) => {
    const t = team(lg, c.team.id);
    return `<a class="row${c.winner ? " win" : ""}" href="#team-${lg}-${c.team.id}">
      <img src="${esc(t?.logo || c.team.logo)}" alt="" loading="lazy"><span>${esc(t?.short || c.team.shortDisplayName)}</span>
      <span class="sc">${started ? esc(scoreVal(c.score) ?? "") : ""}</span></a>`;
  }).join("");
  const label = st.state === "pre" ? fmtGameTime(ev.date) : st.shortDetail;
  return `<div class="game${st.state === "in" ? " live" : ""}${mine ? " mine" : ""}">${rows}<p class="st">${st.state === "in" ? "● " : ""}${esc(label)}${comp.broadcasts?.[0]?.names?.[0] ? " · " + esc(comp.broadcasts[0].names[0]) : ""}</p></div>`;
}

// ---------- My teams ----------
async function loadMyTeams() {
  const cards = await Promise.all(MY_TEAMS.map(async ({ lg, id }) => {
    const base = team(lg, id);
    const t = await espn(lg, `teams/${id}`).then((d) => d.team).catch(() => ({}));
    const record = t.record?.items?.[0]?.summary || "";
    const next = t.nextEvent?.[0];
    const viz = await teamViz(lg, id, next?.id);
    const boardGame = next && (boards[lg]?.events || []).find((e) => e.id === next.id);
    const odds = boardGame?.competitions[0].odds?.[0];
    const pill = odds?.details ? `<span class="line-pill" title="${esc(odds.provider?.displayName || "")} line">${esc(odds.details)}${odds.overUnder ? " · O/U " + odds.overUnder : ""}</span>` : "";
    const inj = (injuryCache[lg].find((x) => x.id === String(id))?.injuries || []).filter((i) => i.status !== "Active");
    const injHtml = inj.length
      ? `<p class="inj-line"><b>Injuries (${inj.length}):</b> ${inj.slice(0, 5).map((i) => `${esc(i.athlete?.displayName)} (${esc(i.status)})`).join(", ")}${inj.length > 5 ? "…" : ""}</p>`
      : `<p class="inj-line">No players on the injury report.</p>`;
    return `<article class="team-card" style="--tc:#${base.color}">
      <a class="team-card-top" href="#team-${lg}-${id}">
        <img src="${base.logo}" alt="">
        <div><h3>${esc(base.name)}</h3><p>${lg.toUpperCase()}${record ? " · " + esc(record) : ""}${t.standingSummary ? " · " + esc(t.standingSummary) : ""}</p></div>
        <span class="go">Team page →</span>
      </a>
      <div class="team-card-body">
        ${last5Html(viz.last5)}
        ${matchupHtml(lg, next, viz.prob, pill)}
        ${leadersHtml(viz.leaders)}
        ${injHtml}
      </div>
    </article>`;
  }));
  $("#myTeams").innerHTML = cards.join("");
}

// ---------- RSS sections ----------
async function loadRss(feeds, el, { limit = 8, images = true, dedupe = false } = {}) {
  const res = await Promise.allSettled(feeds.map(rss));
  let items = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!items.length) { $(el).innerHTML = failMsg("this feed"); return []; }
  items.sort((a, b) => (parseDate(b.pubDate) || 0) - (parseDate(a.pubDate) || 0));
  if (dedupe) { const s = new Set(); items = items.filter((i) => !s.has(i.title) && s.add(i.title)); }
  items = items.slice(0, limit);
  $(el).innerHTML = items.map((i) => newsItem(i.title, i.link, i.pubDate, "", images ? i.thumbnail || i.enclosure?.link : "")).join("");
  return items;
}
async function loadWorld() {
  try {
    const items = (await rss(FEEDS.world)).slice(0, 9);
    $("#worldNews").innerHTML = items.map((i) => `<a class="world-card" href="${esc(i.link)}" target="_blank" rel="noopener">
      ${i.thumbnail ? `<img src="${esc(i.thumbnail.replace("/240/", "/480/"))}" alt="" loading="lazy">` : ""}
      <time>${esc(ago(i.pubDate))}</time><h4>${esc(i.title)}</h4><p>${esc(stripHtml(i.description))}</p></a>`).join("");
  } catch { $("#worldNews").innerHTML = failMsg("world news"); }
}

// ---------- Aspen ----------
const WX = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  61: "Rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };

async function loadAspen() {
  const q = (k) => MOUNTAINS.map((m) => m[k]).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${q("lat")}&longitude=${q("lon")}&elevation=${q("elev")}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,snow_depth&daily=snowfall_sum,temperature_2m_max,temperature_2m_min` +
    `&past_days=1&forecast_days=7&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FDenver`;
  try {
    let data = await getJSON(url);
    if (!Array.isArray(data)) data = [data];
    $("#mountains").innerHTML = data.map((d, idx) => {
      const m = MOUNTAINS[idx], c = d.current, dl = d.daily;
      const depthIn = c.snow_depth != null ? Math.round(c.snow_depth * (d.current_units.snow_depth === "ft" ? 12 : 39.37)) : "—";
      const past = dl.snowfall_sum[0] ?? 0;
      const fut = dl.snowfall_sum.slice(1);
      const total = fut.reduce((a, b) => a + (b || 0), 0);
      const max = Math.max(1, ...fut);
      const bars = fut.map((v, i) => {
        const day = new Date(dl.time[i + 1] + "T12:00").toLocaleDateString(undefined, { weekday: "narrow" });
        return `<div class="bar" title="${dl.time[i + 1]}: ${v.toFixed(1)}&quot;"><em>${v >= 0.5 ? Math.round(v) + '"' : ""}</em><i style="height:${(v / max) * 100}%"></i><small>${day}</small></div>`;
      }).join("");
      return `<div class="mtn">
        <div><h3>${m.name}</h3><p class="elev">SUMMIT ~${Math.round(m.elev * 3.281).toLocaleString()} FT</p></div>
        <div class="now"><strong>${Math.round(c.temperature_2m)}°</strong><span>${WX[c.weather_code] || ""} · ${Math.round(c.wind_speed_10m)} mph</span></div>
        <div class="facts">
          <div><b>${depthIn}"</b>Snow depth</div>
          <div><b>${past.toFixed(1)}"</b>Last 24h</div>
          <div><b>${total.toFixed(1)}"</b>Next 7 days</div>
          <div><b>${Math.round(dl.temperature_2m_max[1])}° / ${Math.round(dl.temperature_2m_min[1])}°</b>Today hi/lo</div>
        </div>
        <div class="bars">${bars}</div>
      </div>`;
    }).join("");
  } catch { $("#mountains").innerHTML = failMsg("mountain conditions"); }
}
function renderOpening() {
  const days = Math.ceil((OPENING_DAY - Date.now()) / 86400e3);
  $("#openingBox").innerHTML = days > 0
    ? `<strong>${days} days</strong><span>until Thanksgiving, when the season typically opens</span>`
    : `<strong>Season's on</strong><span>Check aspensnowmass.com for lift status</span>`;
}

// ---------- TradingView widgets ----------
function tvWidget(el, name, config) {
  const box = typeof el === "string" ? $(el) : el;
  box.innerHTML = `<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>`;
  const s = document.createElement("script");
  s.src = `https://s3.tradingview.com/external-embedding/embed-widget-${name}.js`;
  s.async = true;
  s.textContent = JSON.stringify(config);
  box.firstChild.appendChild(s);
}
function loadMarkets() {
  tvWidget("#tickerTape", "ticker-tape", {
    symbols: TV_SYMBOLS.map(([title, proName]) => ({ proName, title })),
    showSymbolLogo: true, isTransparent: true, displayMode: "adaptive", colorTheme: "light", locale: "en",
  });
  const sym = (arr) => arr.map(([displayName, name]) => ({ name, displayName }));
  tvWidget("#tvQuotes", "market-quotes", {
    width: "100%", height: "100%", colorTheme: "light", isTransparent: true, showSymbolLogo: true, locale: "en",
    symbolsGroups: [
      { name: "Indices", symbols: sym(TV_SYMBOLS.slice(0, 3)) },
      { name: "Big Tech", symbols: sym(TV_SYMBOLS.slice(3, 10)) },
      { name: "Chips", symbols: sym([["Marvell", "NASDAQ:MRVL"], ["Nvidia", "NASDAQ:NVDA"], ["Broadcom", "NASDAQ:AVGO"], ["AMD", "NASDAQ:AMD"]]) },
    ],
  });
  tvWidget("#tvChart", "symbol-overview", {
    symbols: [["S&P 500", "FOREXCOM:SPXUSD|1D"], ["Marvell", "NASDAQ:MRVL|1D"], ["Nasdaq 100", "FOREXCOM:NSXUSD|1D"], ["Nvidia", "NASDAQ:NVDA|1D"]],
    chartOnly: false, width: "100%", height: "100%", locale: "en", colorTheme: "light", isTransparent: true, autosize: true,
    showVolume: false, hideDateRanges: false, scalePosition: "right", scaleMode: "Normal", chartType: "area",
    lineColor: "#1f6fb8", topColor: "rgba(111,177,232,0.4)", bottomColor: "rgba(111,177,232,0)", fontFamily: "DM Sans, sans-serif",
  });
}

// ---------- Team directory ----------
let dirLeague = "nba";
function renderDirectory() {
  const q = $("#teamSearch").value.trim().toLowerCase();
  const leagues = q ? ["nba", "nfl"] : [dirLeague];
  const tiles = leagues.flatMap((lg) => TEAMS[lg]
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.abbr.toLowerCase() === q)
    .sort((a, b) => isMine(lg, b.id) - isMine(lg, a.id))
    .map((t) => `<a class="team-tile${isMine(lg, t.id) ? " star" : ""}" style="--tc:#${t.color}" href="#team-${lg}-${t.id}">
      <img src="${t.logo}" alt="" loading="lazy"><span>${isMine(lg, t.id) ? "★ " : ""}${esc(t.name)}${q ? ` <small class="muted">${lg.toUpperCase()}</small>` : ""}</span></a>`));
  $("#teamGrid").innerHTML = tiles.join("") || `<p class="empty">No teams match “${esc(q)}”.</p>`;
}

// ---------- Team page ----------
async function showTeam(lg, id) {
  const base = team(lg, id);
  if (!base) { location.hash = "#teams"; return; }
  const page = $("#teamPage");
  $("#home").hidden = true;
  page.hidden = false;
  window.scrollTo(0, 0);
  document.title = `${base.name} · The NW Wire`;
  page.innerHTML = `
    <section class="team-hero" style="--tc:#${base.color};--ta:#${base.alt || "e0a526"}">
      <div class="team-hero-inner">
        <img src="${base.logo}" alt="">
        <div><p>${lg.toUpperCase()}${isMine(lg, id) ? " · ★ My team" : ""}</p><h1>${esc(base.name)}</h1><p id="tmRecord">&nbsp;</p></div>
        <a class="btn back" href="#teams">← All teams</a>
      </div>
    </section>
    <section class="section team-layout">
      <div>
        <p class="label">// Moves</p><h2 class="mid">Transactions &amp; Injuries</h2>
        <ul class="wire card-box" id="tmWire"><li class="skeleton-row"></li><li class="skeleton-row"></li></ul>
        <p class="label" style="margin-top:2.5rem">// At a glance</p><h2 class="mid">Form &amp; Leaders</h2>
        <div class="card-box glance" id="tmGlance"><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
        <p class="label" style="margin-top:2.5rem">// Standings</p><h2 class="mid">Where they stand</h2>
        <div id="tmStandings"><div class="skeleton-row"></div></div>
      </div>
      <aside>
        <div class="side-block"><p class="label">// Up next</p><h2 class="mid">Schedule</h2><ul class="sched card-box" id="tmNext"><li class="skeleton-row"></li></ul></div>
        <div class="side-block"><p class="label">// Recent</p><h2 class="mid">Results</h2><ul class="sched card-box" id="tmPast"><li class="skeleton-row"></li></ul></div>
      </aside>
    </section>`;

  const [info, sched] = await Promise.allSettled([
    espn(lg, `teams/${id}`), espn(lg, `teams/${id}/schedule`),
    !injuryCache[lg].length || !txCache[lg].length ? loadWire() : null,
  ]);
  if (location.hash !== `#team-${lg}-${id}`) return; // navigated away while loading

  const next = info.status === "fulfilled" ? info.value.team.nextEvent?.[0] : null;
  if (info.status === "fulfilled") {
    const t = info.value.team;
    $("#tmRecord").textContent = [t.record?.items?.[0]?.summary, t.standingSummary].filter(Boolean).join(" · ");
  }
  Promise.all([teamViz(lg, id, next?.id), teamStandingsHtml(lg, id)]).then(([viz, standingsHtml]) => {
    if (location.hash !== `#team-${lg}-${id}`) return;
    $("#tmGlance").innerHTML = last5Html(viz.last5) + matchupHtml(lg, next, viz.prob, "") + leadersHtml(viz.leaders);
    $("#tmStandings").innerHTML = standingsHtml || `<p class="empty">Standings unavailable right now.</p>`;
  });

  // Transactions + injuries for this team
  const moves = txCache[lg].filter((t) => t.team?.id === String(id)).map((t) => ({ kind: classify(t.description), text: t.description, date: parseDate(t.date) }));
  const inj = (injuryCache[lg].find((x) => x.id === String(id))?.injuries || []).filter((i) => i.status !== "Active").map((i) => ({
    kind: "injury", date: parseDate(i.date),
    text: `${i.athlete?.displayName}${i.athlete?.position?.abbreviation ? ` (${i.athlete.position.abbreviation})` : ""}: ${i.status}${i.shortComment ? " · " + i.shortComment : ""}`,
  }));
  const all = [...moves, ...inj].sort((a, b) => (b.date || 0) - (a.date || 0));
  $("#tmWire").innerHTML = all.length ? all.map((m) => `<li class="item"><span></span><div><div class="meta-row"><span class="kind ${m.kind}">${m.kind}</span></div><p class="txt">${esc(m.text)}</p></div><time>${esc(ago(m.date))}</time></li>`).join("")
    : `<li class="empty">No recent transactions or injuries reported.</li>`;

  if (sched.status === "fulfilled") {
    const evs = sched.value.events || [];
    const line = (ev) => {
      const c = ev.competitions[0];
      const us = c.competitors.find((x) => x.team.id === String(id));
      const them = c.competitors.find((x) => x.team.id !== String(id));
      const vs = (us?.homeAway === "home" ? "vs " : "@ ") + (team(lg, them?.team.id)?.short || them?.team.displayName || "TBD");
      const st = c.status.type;
      if (st.completed) {
        const res = us?.winner ? "W" : them?.winner ? "L" : "T";
        return `<li><strong>${esc(vs)}</strong><span><b class="${res}">${res}</b> ${esc(scoreVal(us?.score))}-${esc(scoreVal(them?.score))} · ${new Date(ev.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></li>`;
      }
      return `<li><strong>${esc(vs)}</strong><span>${st.state === "in" ? "● LIVE " + esc(st.shortDetail) : esc(fmtGameTime(ev.date))}</span></li>`;
    };
    const next = evs.filter((e) => !e.competitions[0].status.type.completed).slice(0, 6);
    const past = evs.filter((e) => e.competitions[0].status.type.completed).slice(-6).reverse();
    $("#tmNext").innerHTML = next.map(line).join("") || `<li class="empty">No upcoming games listed.</li>`;
    $("#tmPast").innerHTML = past.map(line).join("") || `<li class="empty">No completed games yet this season.</li>`;
  } else {
    $("#tmNext").innerHTML = $("#tmPast").innerHTML = `<li>${failMsg("the schedule")}</li>`;
  }
}

// ---------- Router ----------
function route() {
  const m = location.hash.match(/^#team-(nba|nfl)-(\d+)$/);
  if (m) { $("#tradePage").hidden = true; return showTeam(m[1], m[2]); }
  const t = location.hash.match(/^#trade(?:-(\d+)-(\d+))?$/);
  if (t) {
    $("#home").hidden = true; $("#teamPage").hidden = true; $("#tradePage").hidden = false;
    document.title = "NBA Trade Lab · The NW Wire";
    return showTrade(t[1], t[2]);
  }
  if (!$("#teamPage").hidden || !$("#tradePage").hidden) {
    $("#teamPage").hidden = true;
    $("#tradePage").hidden = true;
    $("#home").hidden = false;
    document.title = "The NW Wire";
    const target = location.hash && document.querySelector(location.hash);
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
  }
}

// ---------- Refresh loop ----------
let countdown = SPORTS_REFRESH;
let lastSports = 0, lastSlow = 0;
async function refreshSports() {
  lastSports = Date.now();
  // Wire fills the injury cache; boards feed scores, lines, and fantasy.
  await Promise.allSettled([loadWire(), loadBoards()]);
  for (const fn of [renderScores, renderLines, renderImplied, renderFfInjuries, renderKickoff]) {
    try { fn(); } catch (e) { console.error(e); }
  }
  refreshParlay();
  if (!expertsLoaded) { expertsLoaded = true; loadExperts(); }
  await loadMyTeams().catch(console.error);
  $("#updated").textContent = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  countdown = SPORTS_REFRESH;
}
let expertsLoaded = false;
function refreshSlow() {
  lastSlow = Date.now();
  if (expertsLoaded) loadExperts();
  loadRecord();
  loadTrending();
  loadRss([FEEDS.fantasy], "#ffNews", { limit: 6, images: false });
  renderStandings();
  loadAspen();
  loadRss([FEEDS.aspenSki, FEEDS.aspenTimes], "#aspenNews", { limit: 8, images: false, dedupe: true });
  loadRss([FEEDS.markets], "#marketNews", { limit: 6, images: false });
  loadRss([FEEDS.mrvl], "#mrvlNews", { limit: 6, images: false });
  loadWorld();
  renderOpening();
}

// ---------- Effects: snowfall, scroll reveal, scroll spy ----------
function initSnow() {
  const c = $("#snow");
  if (!c || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = c.getContext("2d");
  let w, h, flakes, running = true;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = c.offsetWidth; h = c.offsetHeight;
    c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    flakes = Array.from({ length: Math.round(w / 12) }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: Math.random() * 2.2 + 0.6,
      s: Math.random() * 0.6 + 0.25, d: Math.random() * Math.PI * 2, o: Math.random() * 0.5 + 0.35,
    }));
  };
  const tick = () => {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.s; f.d += 0.01; f.x += Math.sin(f.d) * 0.35;
      if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${f.o})`; ctx.fill();
    }
    requestAnimationFrame(tick);
  };
  resize(); tick();
  addEventListener("resize", resize);
  // Pause when the masthead is off screen to save battery
  new IntersectionObserver(([e]) => { const was = running; running = e.isIntersecting; if (running && !was) tick(); }).observe(c);
}

function initEffects() {
  initSnow();
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  const links = [...document.querySelectorAll("#navLinks a")];
  const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id));
  }), { rootMargin: "-45% 0px -50% 0px" });
  links.forEach((a) => { const s = document.querySelector(a.getAttribute("href")); if (s) spy.observe(s); });

  addEventListener("scroll", () => $("#nav").classList.toggle("scrolled", scrollY > 10), { passive: true });
}

// ---------- Init ----------
function initChips(sel, onPick) {
  $(sel).addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    $(sel).querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
    onPick(b.dataset.v);
  });
}

function init() {
  const now = new Date();
  $("#dateline").innerHTML = `${now.toLocaleDateString(undefined, { weekday: "long" })}<br><span>${now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span>`;
  const h = now.getHours();
  $("#edition").textContent = `// ${h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"} edition · ${now.getFullYear()}`;
  $("#year").textContent = now.getFullYear();

  $("#menuBtn").addEventListener("click", () => $("#navLinks").classList.toggle("open"));
  $("#navLinks").addEventListener("click", () => $("#navLinks").classList.remove("open"));

  initChips("#leagueChips", (v) => { wire.league = v; renderWire(); });
  initChips("#kindChips", (v) => { wire.kind = v; renderWire(); });
  initChips("#scoreChips", (v) => { scoreLeague = v; renderScores(); });
  initChips("#betChips", (v) => { betLeague = v; betExpanded = false; renderLines(); refreshParlay(); loadExperts(); });
  $("#teaserLogos").innerHTML = TEAMS.nba.slice().sort(() => Math.random() - 0.5).slice(0, 18)
    .map((t) => `<a href="#trade" title="${esc(t.name)}"><img src="${t.logo}" alt="" loading="lazy"></a>`).join("");
  initChips("#ffPosChips", (v) => { ffPos = v; renderFfInjuries(); });
  initChips("#dirChips", (v) => { dirLeague = v; renderDirectory(); });
  initChips("#standingsChips", (v) => { standingsLeague = v; renderStandings(); });
  $("#teamSearch").addEventListener("input", renderDirectory);

  // Bet calculator
  $("#calcStake").addEventListener("input", renderCalc);
  $("#calcLegs").addEventListener("input", renderCalc);
  $("#addLeg").addEventListener("click", () => {
    if (document.querySelectorAll("#calcLegs .leg").length >= 8) return;
    const i = document.createElement("input");
    i.type = "text"; i.className = "leg"; i.placeholder = "+150";
    $("#calcLegs").appendChild(i); i.focus(); renderCalc();
  });
  renderCalc();

  initEffects();

  const alertBtn = $("#alertBtn");
  const showAlerts = () => { alertBtn.textContent = `🔔 Desktop alerts: ${alertsOn ? "on" : "off"}`; alertBtn.classList.toggle("on", alertsOn); };
  if (!("Notification" in window)) alertBtn.hidden = true;
  // Remember the choice in this browser, as long as permission is still granted.
  try { alertsOn = localStorage.getItem("nw-alerts") === "on" && Notification.permission === "granted"; } catch { alertsOn = false; }
  showAlerts();
  alertBtn.addEventListener("click", async () => {
    if (!alertsOn && Notification.permission !== "granted") {
      if ((await Notification.requestPermission()) !== "granted") return;
    }
    alertsOn = !alertsOn;
    try { localStorage.setItem("nw-alerts", alertsOn ? "on" : "off"); } catch { /* private mode */ }
    showAlerts();
  });

  renderDirectory();
  loadMarkets();
  refreshSports();
  refreshSlow();
  // Pause refreshing while the tab is hidden (phone locked, other tab) to save data and battery.
  // Desktop alerts keep it running in the background.
  const paused = () => document.hidden && !alertsOn;
  setInterval(() => {
    if (paused()) return;
    countdown -= 1;
    $("#countdown").textContent = Math.max(0, countdown);
    if (countdown <= 0) { countdown = SPORTS_REFRESH; refreshSports(); }
  }, 1000);
  setInterval(() => { if (!paused() && Date.now() - lastSlow >= SLOW_REFRESH * 1000) refreshSlow(); }, 30 * 1000);
  setInterval(() => { if (!paused()) renderWire(); }, 60 * 1000); // keep "x min ago" labels fresh
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Back on the page: catch up right away if anything is stale.
    if (Date.now() - lastSports >= SPORTS_REFRESH * 1000) { countdown = SPORTS_REFRESH; refreshSports(); }
    if (Date.now() - lastSlow >= SLOW_REFRESH * 1000) refreshSlow();
  });

  window.addEventListener("hashchange", route);
  route();
}
document.addEventListener("DOMContentLoaded", init);

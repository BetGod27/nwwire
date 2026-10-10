#!/usr/bin/env ruby
# frozen_string_literal: true

# The NW Wire pick keeper.
# Builds the weekly NFL game parlay + player prop parlay (same logic as js/app.js),
# locks them shortly before the first leg kicks off, grades them from final box
# scores, and keeps the running record in data/record.json.
#
# Run: ruby scripts/nw_picks.rb   (GitHub Actions runs it every 3 hours)

require "json"
require "open3"
require "time"

ROOT = File.expand_path("..", __dir__)
RECORD_FILE = File.join(ROOT, "data", "record.json")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/"
WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/"
PROP_ODDS = -110              # ESPN doesn't publish prop prices; graded at the typical price
LOCK_BEFORE = 4 * 3600        # lock picks 4 hours before the earliest leg kicks off

PROP_TYPES = {
  "Total Passing Yards (incl. overtime)" => { "stat" => "passingYards", "label" => "passing yards", "min" => 150 },
  "Total Rushing Yards (incl. overtime)" => { "stat" => "rushingYards", "label" => "rushing yards", "min" => 30 },
  "Total Receiving Yards (incl. overtime)" => { "stat" => "receivingYards", "label" => "receiving yards", "min" => 30 },
  "Total Receptions (incl. overtime)" => { "stat" => "receptions", "label" => "receptions", "min" => 2.5 },
}.freeze

# ---------- helpers ----------
# Fetched with curl (on macOS and GitHub runners); ESPN's edge rejects Ruby's HTTP client.
def get(url, tries = 3)
  tries.times do |i|
    body, status = Open3.capture2("curl", "-s", "-f", "--max-time", "25", url)
    begin
      return JSON.parse(body) if status.success?
    rescue JSON::ParserError => e
      warn "Bad JSON from #{url}: #{e.message}"
    end
    sleep(1 + i)
  end
  warn "GET #{url} failed"
  nil
end

# Run a block over items with a small thread pool, preserving order.
def pmap(items, threads = 8)
  queue = Queue.new
  items.each_with_index { |x, i| queue << [x, i] }
  out = Array.new(items.size)
  workers = Array.new([threads, items.size].min) do
    Thread.new do
      loop do
        pair = begin
          queue.pop(true)
        rescue ThreadError
          nil
        end
        break unless pair
        begin
          out[pair[1]] = yield(pair[0])
        rescue StandardError => e
          warn "worker error: #{e.message}"
        end
      end
    end
  end
  workers.each(&:join)
  out
end

def prob(ml)
  ml = ml.to_f
  return nil if ml.zero?
  ml.negative? ? -ml / (-ml + 100) : 100 / (ml + 100)
end

def decimal(ml)
  ml = ml.to_f
  ml.negative? ? 1 + 100 / -ml : 1 + ml / 100
end

def line_num(s)
  return nil if s.nil?
  Float(s.to_s.sub(/\A[ou]/, ""))
rescue ArgumentError
  nil
end

def mini_ev(ev)
  comp = ev["competitions"][0]
  {
    "id" => ev["id"], "date" => ev["date"], "shortName" => ev["shortName"],
    "competitions" => [{
      "competitors" => comp["competitors"].map do |c|
        { "homeAway" => c["homeAway"], "team" => { "id" => c["team"]["id"], "abbreviation" => c["team"]["abbreviation"] } }
      end,
    }],
  }
end

# ---------- game parlay: ESPN model vs. DraftKings market ----------
def game_parlay(events)
  pre = events.select { |e| e.dig("status", "type", "state") == "pre" && e.dig("competitions", 0, "odds", 0) }
  preds = pmap(pre) do |e|
    p = get("#{ESPN}summary?event=#{e['id']}")&.dig("predictor")
    h = p&.dig("homeTeam", "gameProjection")
    a = p&.dig("awayTeam", "gameProjection")
    h && a ? { "home" => h.to_f / 100, "away" => a.to_f / 100 } : nil
  end

  cands = []
  pre.each_with_index do |ev, idx|
    pred = preds[idx]
    next unless pred
    comp = ev["competitions"][0]
    o = comp["odds"][0]
    ml_h = o.dig("moneyline", "home", "close", "odds")
    ml_a = o.dig("moneyline", "away", "close", "odds")
    rh = prob(ml_h)
    ra = prob(ml_a)
    next unless rh && ra
    %w[home away].each do |key|
      c = comp["competitors"].find { |x| x["homeAway"] == key }
      opp = comp["competitors"].find { |x| x["homeAway"] != key }
      ps = o.dig("pointSpread", key) || {}
      market = (key == "home" ? rh : ra) / (rh + ra)
      model = pred[key]
      op = line_num(ps.dig("open", "line"))
      cl = line_num(ps.dig("close", "line"))
      cands << {
        "ev" => mini_ev(ev), "key" => key, "teamId" => c["team"]["id"], "oppAbbr" => opp["team"]["abbreviation"],
        "ml" => (key == "home" ? ml_h : ml_a).to_i, "model" => model, "market" => market, "edge" => model - market,
        "steam" => !op.nil? && !cl.nil? && cl < op,
      }
    end
  end

  score = ->(c) { c["edge"] * 2 + (c["model"] - 0.5) + (c["steam"] ? 0.03 : 0) }
  pick = lambda do |pool, taken = []|
    legs = []
    used = taken.map { |l| l["ev"]["id"] }
    pool.sort_by { |c| -score.call(c) }.each do |c|
      next if used.include?(c["ev"]["id"])
      legs << c
      used << c["ev"]["id"]
      break if legs.size + taken.size == 3
    end
    legs
  end
  legs = pick.call(cands.select { |c| c["model"] >= 0.6 && c["edge"] >= -0.01 && c["ml"] >= -400 })
  if legs.size < 3
    extra = cands.select { |c| c["ml"] >= -450 }.sort_by { |c| -c["model"] }
    used = legs.map { |l| l["ev"]["id"] }
    extra.each do |c|
      break if legs.size == 3
      next if used.include?(c["ev"]["id"])
      legs << c
      used << c["ev"]["id"]
    end
  end
  legs
end

# ---------- prop parlay: DraftKings player props vs. game logs ----------
def fetch_props(ev)
  out = []
  (1..3).each do |page|
    d = get("#{CORE}events/#{ev['id']}/competitions/#{ev['id']}/odds/100/propBets?limit=1000&page=#{page}")
    break unless d
    (d["items"] || []).each do |i|
      t = PROP_TYPES[i.dig("type", "name")]
      line = i.dig("current", "target", "value")
      open = i.dig("open", "target", "value")
      ath = i.dig("athlete", "$ref").to_s[%r{athletes/(\d+)}, 1]
      out << { "ev" => ev, "ath" => ath, "type" => i["type"]["name"], "t" => t, "line" => line, "open" => open || line } if t && ath && line && line >= t["min"]
    end
    break if page >= (d["pageCount"] || 1)
  end
  out
end

def evaluate_prop(c)
  gl = get("#{WEB}#{c['ath']}/gamelog")
  info = get("#{WEB}#{c['ath']}")
  return nil unless gl && info
  idx = (gl["names"] || []).index(c["t"]["stat"])
  season = (gl["seasonTypes"] || []).find { |s| s["displayName"].to_s =~ /regular/i } || (gl["seasonTypes"] || [])[0]
  cat = (season&.dig("categories") || []).find { |x| x["displayName"].to_s =~ /regular/i } || season&.dig("categories", 0)
  return nil if idx.nil? || cat.nil? || (cat["events"] || []).size < 2
  games = cat["events"].map { |e| { "v" => e["stats"][idx].to_f, "opp" => gl.dig("events", e["eventId"], "opponent", "abbreviation") } }
  avg = games.sum { |g| g["v"] } / games.size
  side = avg >= c["line"] ? "over" : "under"
  hits = games.count { |g| side == "over" ? g["v"] > c["line"] : g["v"] < c["line"] }
  move = c["line"] - c["open"]
  move_agrees = if move.zero? then 0 elsif (move.positive?) == (side == "over") then 1 else -1 end
  edge = (avg - c["line"]).abs / c["line"]
  hit_rate = hits.to_f / games.size
  a = info["athlete"] || {}
  c.merge(
    "ev" => mini_ev(c["ev"]), "games" => games, "avg" => avg, "side" => side, "hits" => hits, "hitRate" => hit_rate,
    "move" => move, "moveAgrees" => move_agrees, "edge" => edge,
    "name" => a["displayName"], "pos" => a.dig("position", "abbreviation"), "teamAbbr" => a.dig("team", "abbreviation"),
    "headshot" => a.dig("headshot", "href"),
    "score" => [edge, 0.6].min + 0.4 * (hit_rate - 0.5) + 0.08 * move_agrees
  )
end

def prop_parlay(events)
  pre = events.select { |e| e.dig("status", "type", "state") == "pre" }
  all = pmap(pre, 6) { |ev| fetch_props(ev) }.compact.flatten
  seen = {}
  cands = all.select { |c| k = c["ath"] + c["type"]; seen[k] ? false : (seen[k] = true) }
             .sort_by { |c| [-(c["line"] - c["open"]).abs / c["line"], -(c["line"] / c["t"]["min"])] }
             .first(30)
  evaluated = pmap(cands) { |c| evaluate_prop(c) }.compact
  strong = evaluated.select { |p| p["hitRate"] >= 0.66 && p["edge"] >= 0.08 && p["moveAgrees"] >= 0 }.sort_by { |p| -p["score"] }
  backup = evaluated.select { |p| p["hitRate"] >= 0.66 && p["moveAgrees"] >= 0 && !strong.include?(p) }.sort_by { |p| -p["score"] }
  legs = []
  [->(p) { legs.none? { |l| l["ev"]["id"] == p["ev"]["id"] } }, ->(_p) { true }].each do |pass|
    (strong + backup).each do |p|
      break if legs.size == 3
      legs << p if !legs.include?(p) && legs.none? { |l| l["ath"] == p["ath"] } && pass.call(p)
    end
  end
  legs
end

# ---------- grading ----------
def final_summary(event_id)
  s = get("#{ESPN}summary?event=#{event_id}")
  comp = s&.dig("header", "competitions", 0)
  return nil unless comp && comp.dig("status", "type", "completed")
  [s, comp]
end

def grade_game_leg(leg)
  s, comp = final_summary(leg["ev"]["id"])
  return nil unless s
  us = comp["competitors"].find { |x| x["id"] == leg["teamId"] }
  them = comp["competitors"].find { |x| x["id"] != leg["teamId"] }
  return "void" if us.nil? || us["score"].to_i == them["score"].to_i
  leg["final"] = "#{us['score']}-#{them['score']}"
  us["winner"] ? "win" : "loss"
end

def grade_prop_leg(leg)
  s, = final_summary(leg["ev"]["id"])
  return nil unless s
  val = nil
  (s.dig("boxscore", "players") || []).each do |tp|
    (tp["statistics"] || []).each do |cat|
      i = (cat["keys"] || []).index(leg["t"]["stat"])
      next unless i
      a = (cat["athletes"] || []).find { |x| x.dig("athlete", "id") == leg["ath"] }
      val = a["stats"][i].to_f if a
    end
  end
  return "void" if val.nil? # didn't play: books void the leg
  leg["actual"] = val
  hit = leg["side"] == "over" ? val > leg["line"] : val < leg["line"]
  hit ? "win" : "loss"
end

# Grade each leg, then settle the parlay at 1 unit.
def settle(parlay, kind)
  legs = parlay["legs"] || []
  return if legs.empty?
  # Keep grading every leg, even after the parlay is decided, so each one shows hit or miss.
  legs.each do |leg|
    next if leg["result"]
    leg["result"] = kind == "game" ? grade_game_leg(leg) : grade_prop_leg(leg)
  end
  return if parlay["result"]
  results = legs.map { |l| l["result"] }
  if results.include?("loss")
    parlay["result"] = "loss"
    parlay["units"] = -1.0
  elsif results.all?
    live = legs.reject { |l| l["result"] == "void" }
    if live.empty?
      parlay["result"] = "void"
      parlay["units"] = 0.0
    else
      dec = live.reduce(1.0) { |acc, l| acc * decimal(kind == "game" ? l["ml"] : PROP_ODDS) }
      parlay["result"] = "win"
      parlay["units"] = (dec - 1).round(2)
    end
  end
end

def parlay_odds(legs, kind)
  return nil if legs.empty?
  dec = legs.reduce(1.0) { |acc, l| acc * decimal(kind == "game" ? l["ml"] : PROP_ODDS) }
  dec >= 2 ? "+#{((dec - 1) * 100).round}" : (-100 / (dec - 1)).round.to_s
end

def totals(weeks)
  %w[game prop].map do |kind|
    settled = weeks.map { |w| w[kind] }.compact.select { |p| %w[win loss].include?(p["result"]) }
    [kind, {
      "w" => settled.count { |p| p["result"] == "win" },
      "l" => settled.count { |p| p["result"] == "loss" },
      "units" => settled.sum { |p| p["units"] }.round(2),
    }]
  end.to_h
end

# ---------- main ----------
def main
  data = File.exist?(RECORD_FILE) ? JSON.parse(File.read(RECORD_FILE)) : { "history" => [] }
  data["history"] ||= []
  sb = get("#{ESPN}scoreboard") or abort("Couldn't load the NFL scoreboard")
  season = sb.dig("season", "year")
  stype = sb.dig("season", "type")
  week = sb.dig("week", "number")
  key = "#{season}-#{stype}-#{week}"
  now = Time.now.utc

  # A new week started: file last week's locked picks into history.
  cur = data["current"]
  if cur && cur["key"] != key
    data["history"].unshift(cur) if cur["locked"]
    cur = nil
  end

  if [2, 3].include?(stype) && (cur.nil? || !cur["locked"])
    events = sb["events"] || []
    g = game_parlay(events)
    pr = prop_parlay(events)
    cur = {
      "key" => key, "season" => season, "week" => week, "label" => stype == 3 ? "Playoffs Wk #{week}" : "Week #{week}",
      "game" => { "legs" => g, "odds" => parlay_odds(g, "game") },
      "prop" => { "legs" => pr, "odds" => parlay_odds(pr, "prop") },
      "locked" => false,
    }
    first = (g + pr).map { |l| Time.parse(l["ev"]["date"]) }.min
    cur["lockAt"] = (first - LOCK_BEFORE).iso8601 if first
    if first && now >= first - LOCK_BEFORE
      cur["locked"] = true
      cur["lockedAt"] = now.iso8601
      data["since"] ||= "#{cur['label']}, #{season}"
    end
  end

  # Grade the locked current week and anything still pending.
  ([cur] + data["history"]).compact.select { |w| w["locked"] }.each do |w|
    settle(w["game"], "game")
    settle(w["prop"], "prop")
  end

  data["current"] = cur
  data["totals"] = totals(([cur] + data["history"]).compact.select { |w| w["locked"] })
  data["updated"] = now.iso8601
  Dir.mkdir(File.dirname(RECORD_FILE)) unless Dir.exist?(File.dirname(RECORD_FILE))
  File.write(RECORD_FILE, JSON.pretty_generate(data) + "\n")

  puts "#{cur ? cur['label'] : key}: game #{cur&.dig('game', 'legs')&.size || 0} legs (#{cur&.dig('game', 'odds')}), " \
       "prop #{cur&.dig('prop', 'legs')&.size || 0} legs (#{cur&.dig('prop', 'odds')}), locked=#{cur&.dig('locked')}"
  puts "Record: #{data['totals'].map { |k, v| "#{k} #{v['w']}-#{v['l']} #{format('%+.2f', v['units'])}u" }.join(' · ')}"
end

main if $PROGRAM_NAME == __FILE__

import fs from "fs";

function need(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

need("STRAVA_CLIENT_ID");
need("STRAVA_CLIENT_SECRET");
need("STRAVA_REFRESH_TOKEN");
need("STRAVA_CLUB_ID");

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
} = process.env;

const TZ = "America/Chicago";

async function postForm(url, formObj) {
  const body = new URLSearchParams(formObj);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}\n${txt}`);
  }
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${txt}`);
  }
  return res.json();
}

// Format a Date as YYYY-MM-DD in America/Chicago
function ymdInTZ(dateObj) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dateObj);
}

// Yesterday's YYYY-MM-DD in America/Chicago (stable anchor = noon UTC)
function yesterdayYMD() {
  const todayYMD = ymdInTZ(new Date());
  const [y, m, d] = todayYMD.split("-").map(Number);
  const todayNoonUtcMs = Date.UTC(y, m - 1, d, 12, 0, 0);
  const ydayNoonUtcMs = todayNoonUtcMs - 24 * 3600 * 1000;
  return ymdInTZ(new Date(ydayNoonUtcMs));
}

// Convert local midnight (YYYY-MM-DD 00:00:00 in America/Chicago) to UTC epoch seconds, DST-safe.
function tzMidnightToUtcEpochSeconds(dateYYYYMMDD) {
  const target = `${dateYYYYMMDD} 00:00:00`;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const [Y, M, D] = dateYYYYMMDD.split("-").map(Number);

  let lo = Date.UTC(Y, M - 1, D, 0, 0, 0) - 36 * 3600 * 1000;
  let hi = Date.UTC(Y, M - 1, D, 0, 0, 0) + 36 * 3600 * 1000;

  function fmtStr(ms) {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
      "minute"
    )}:${get("second")}`;
  }

  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    const s = fmtStr(mid);
    if (s < target) lo = mid;
    else hi = mid;
  }

  return Math.floor(hi / 1000);
}

function miles(meters) {
  return (Number(meters || 0) / 1609.344) || 0;
}

function activityStartUtcSeconds(a) {
  const ms = Date.parse(a?.start_date);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function fmtUtc(ts) {
  try {
    return new Date(ts * 1000).toISOString();
  } catch {
    return String(ts);
  }
}

async function main() {
  // Refresh access token
  const tokenData = await postForm("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const accessToken = tokenData?.access_token;
  if (!accessToken) throw new Error("No access_token returned from Strava refresh.");

  // Report date = yesterday in Chicago
  const reportDate = yesterdayYMD();
  const startUtc = tzMidnightToUtcEpochSeconds(reportDate);

  // Next date (YYYY-MM-DD) using noon-UTC anchor
  const [Y, M, D] = reportDate.split("-").map(Number);
  const reportNoonUtcMs = Date.UTC(Y, M - 1, D, 12, 0, 0);
  const nextDate = ymdInTZ(new Date(reportNoonUtcMs + 24 * 3600 * 1000));
  const endUtc = tzMidnightToUtcEpochSeconds(nextDate);

  console.log(`Report date (local): ${reportDate} (${TZ})`);
  console.log(`Window UTC: [${startUtc} ${fmtUtc(startUtc)}] -> [${endUtc} ${fmtUtc(endUtc)}]`);

  // Fetch members (paginate)
  const members = [];
  for (let page = 1; page <= 20; page++) {
    const chunk = await getJson(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?per_page=200&page=${page}`,
      accessToken
    );
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    members.push(...chunk);
    if (chunk.length < 200) break;
  }
  if (members.length === 0) throw new Error("Fetched 0 club members. Check STRAVA_CLUB_ID / permissions.");

  // Fetch club activities until we are sure we covered the report window
  // Strategy: keep paging until the OLDEST activity fetched is older than startUtc
  const activities = [];
  const perPage = 200;
  const maxPages = 60; // guardrail
  let oldestSeen = null;

  for (let page = 1; page <= maxPages; page++) {
    const chunk = await getJson(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=${perPage}&page=${page}`,
      accessToken
    );

    if (!Array.isArray(chunk) || chunk.length === 0) break;

    activities.push(...chunk);

    // Update oldestSeen based on this chunk
    for (const a of chunk) {
      const t = activityStartUtcSeconds(a);
      if (t == null) continue;
      oldestSeen = (oldestSeen == null) ? t : Math.min(oldestSeen, t);
    }

    // If we have gone older than the report window start, we can stop early
    if (oldestSeen != null && oldestSeen < startUtc) {
      console.log(`Stopping early at page ${page}: oldestSeen=${fmtUtc(oldestSeen)} is older than startUtc=${fmtUtc(startUtc)}`);
      break;
    }

    if (chunk.length < perPage) break; // end of feed
  }

  if (activities.length === 0) throw new Error("Fetched 0 club activities. Check STRAVA_CLUB_ID / permissions.");

  // Filter to yesterday window
  const filtered = activities.filter((a) => {
    const t = activityStartUtcSeconds(a);
    return t != null && t >= startUtc && t < endUtc;
  });

  // Debug counts
  const allTimes = activities
    .map(activityStartUtcSeconds)
    .filter((t) => t != null)
    .sort((a, b) => a - b);

  const newest = allTimes.length ? allTimes[allTimes.length - 1] : null;
  const oldest = allTimes.length ? allTimes[0] : null;

  console.log(`Activities fetched: ${activities.length}`);
  console.log(`Activities newest: ${newest ? fmtUtc(newest) : "n/a"}`);
  console.log(`Activities oldest: ${oldest ? fmtUtc(oldest) : "n/a"}`);
  console.log(`Activities in window: ${filtered.length}`);

  // Roster
  const roster = members.map((m) => ({
    id: String(m.id),
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim() || `Member ${m.id}`,
  }));

  // Aggregate by athlete id
  const byId = new Map(); // id -> {Walk,Run,Ride,Hike}
  const typeCounts = new Map();

  for (const a of filtered) {
    const id = String(a?.athlete?.id ?? "");
    if (!id) continue;

    const t = String(a?.type ?? "");
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);

    if (!byId.has(id)) byId.set(id, { Walk: 0, Run: 0, Ride: 0, Hike: 0 });

    const rec = byId.get(id);
    const dist = miles(a?.distance);

    if (t === "Walk") rec.Walk += dist;
    else if (t === "Run") rec.Run += dist;
    else if (t === "Ride") rec.Ride += dist;
    else if (t === "Hike") rec.Hike += dist;
  }

  console.log("Activity types in window:", Object.fromEntries(typeCounts));

  const rows = [];
  const inactive = [];

  for (const member of roster) {
    const rec = byId.get(member.id);
    const total = rec ? rec.Walk + rec.Run + rec.Ride + rec.Hike : 0;

    if (!rec || total <= 0.00001) {
      inactive.push({ name: member.name });
      continue;
    }

    rows.push({
      name: member.name,
      Walk: rec.Walk,
      Run: rec.Run,
      Ride: rec.Ride,
      Hike: rec.Hike,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  inactive.sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    reportDate,
    timezone: TZ,
    windowUtc: { startUtc, endUtc },
    totals: {
      members: roster.length,
      activitiesFetched: activities.length,
      activitiesInWindow: filtered.length,
      activeMembers: rows.length,
      inactiveMembers: inactive.length,
    },
    // Debug: helps verify window coverage when something looks off
    debug: {
      fetchedOldestUtc: oldest ? fmtUtc(oldest) : null,
      fetchedNewestUtc: newest ? fmtUtc(newest) : null,
      typesInWindow: Object.fromEntries(typeCounts),
    },
    rows,
    inactive,
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`report-data.json written for ${reportDate}`);
}

await main();

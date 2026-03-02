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
  STRAVA_CLUB_ID
} = process.env;

const TZ = "America/Chicago";

async function postForm(url, formObj) {
  const body = new URLSearchParams(formObj);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}\n${txt}`);
  }
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${txt}`);
  }
  return res.json();
}

// YYYY-MM-DD for yesterday in America/Chicago
function yesterdayInTZ() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmt.format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const todayAnchor = Date.UTC(y, m - 1, d); // anchor day boundary
  const yday = new Date(todayAnchor - 24 * 3600 * 1000);
  return fmt.format(yday);
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
    hourCycle: "h23"
  });

  const [Y, M, D] = dateYYYYMMDD.split("-").map(Number);
  let lo = Date.UTC(Y, M - 1, D) - 36 * 3600 * 1000;
  let hi = Date.UTC(Y, M - 1, D) + 36 * 3600 * 1000;

  function fmtStr(ms) {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type) => parts.find(p => p.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
    // matches "YYYY-MM-DD HH:MM:SS"
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

async function main() {
  const tokenData = await postForm("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error("No access_token returned from Strava refresh.");

  const reportDate = yesterdayInTZ();
  const startUtc = tzMidnightToUtcEpochSeconds(reportDate);
  const endUtc = startUtc + 86400; // next midnight boundary in local day window representation

  // Roster (for "No Activity")
  const members = await getJson(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?per_page=200`,
    accessToken
  );

  // Activities (fetch a big chunk and filter locally)
  const activities = await getJson(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=200`,
    accessToken
  );

  const filtered = activities.filter(a => {
    const t = Math.floor(Date.parse(a.start_date) / 1000);
    return Number.isFinite(t) && t >= startUtc && t < endUtc;
  });

  const roster = members.map(m => ({
    id: String(m.id),
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim() || `Member ${m.id}`
  }));

  // Aggregate by member
  const byId = new Map(); // id -> {Walk,Run,Ride,Hike}
  for (const a of filtered) {
    const id = String(a?.athlete?.id ?? "");
    if (!id) continue;

    if (!byId.has(id)) byId.set(id, { Walk: 0, Run: 0, Ride: 0, Hike: 0 });
    const rec = byId.get(id);

    const dist = miles(a.distance);
    if (a.type === "Walk") rec.Walk += dist;
    else if (a.type === "Run") rec.Run += dist;
    else if (a.type === "Ride") rec.Ride += dist;
    else if (a.type === "Hike") rec.Hike += dist;
  }

  const rows = [];
  const inactive = [];

  for (const member of roster) {
    const rec = byId.get(member.id);
    const total = rec ? (rec.Walk + rec.Run + rec.Ride + rec.Hike) : 0;

    if (!rec || total <= 0.00001) {
      inactive.push({ name: member.name });
      continue;
    }

    rows.push({
      name: member.name,
      Walk: rec.Walk,
      Run: rec.Run,
      Ride: rec.Ride,
      Hike: rec.Hike
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  inactive.sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    reportDate,
    timezone: TZ,
    windowUtc: { startUtc, endUtc },
    rows,
    inactive
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`report-data.json written for ${reportDate}`);
}

await main();

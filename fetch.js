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

  // Noon UTC anchor avoids “date slips” when formatting across timezones.
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

  // Search within ±36h around UTC midnight of that date
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

  // Determine report date (yesterday in Chicago)
  const reportDate = yesterdayYMD();

  // DST-safe window: [start of reportDate local midnight, start of next date local midnight)
  const startUtc = tzMidnightToUtcEpochSeconds(reportDate);

  // Compute next date YYYY-MM-DD using noon-UTC anchor again
  const [Y, M, D] = reportDate.split("-").map(Number);
  const reportNoonUtcMs = Date.UTC(Y, M - 1, D, 12, 0, 0);
  const nextDate = ymdInTZ(new Date(reportNoonUtcMs + 24 * 3600 * 1000));
  const endUtc = tzMidnightToUtcEpochSeconds(nextDate);

  // Fetch club members (for "No Activity")
  // Note: some clubs exceed 200 members; keep simple but safe: paginate a bit.
  const members = [];
  for (let page = 1; page <= 10; page++) {
    const chunk = await getJson(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?per_page=200&page=${page}`,
      accessToken
    );
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    members.push(...chunk);
    if (chunk.length < 200) break;
  }
  if (members.length === 0) throw new Error("Fetched 0 club members. Check STRAVA_CLUB_ID / permissions.");

  // Fetch club activities (pull recent pages, filter locally)
  const activities = [];
  for (let page = 1; page <= 10; page++) {
    const chunk = await getJson(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=200&page=${page}`,
      accessToken
    );
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    activities.push(...chunk);
    if (chunk.length < 200) break;
  }
  if (activities.length === 0) throw new Error("Fetched 0 club activities. Check STRAVA_CLUB_ID / permissions.");

  const filtered = activities.filter((a) => {
    const t = Math.floor(Date.parse(a?.start_date) / 1000);
    return Number.isFinite(t) && t >= startUtc && t < endUtc;
  });

  // Roster map
  const roster = members.map((m) => ({
    id: String(m.id),
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim() || `Member ${m.id}`,
  }));
  const rosterById = new Map(roster.map((r) => [r.id, r.name]));

  // Aggregate by athlete id
  const byId = new Map(); // id -> {Walk,Run,Ride,Hike}
  for (const a of filtered) {
    const id = String(a?.athlete?.id ?? "");
    if (!id) continue;

    if (!byId.has(id)) byId.set(id, { Walk: 0, Run: 0, Ride: 0, Hike: 0 });

    const rec = byId.get(id);
    const dist = miles(a?.distance);

    if (a?.type === "Walk") rec.Walk += dist;
    else if (a?.type === "Run") rec.Run += dist;
    else if (a?.type === "Ride") rec.Ride += dist;
    else if (a?.type === "Hike") rec.Hike += dist;
  }

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
    rows,
    inactive,
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`report-data.json written for ${reportDate}`);
  console.log(
    `Members=${payload.totals.members} Active=${payload.totals.activeMembers} NoActivity=${payload.totals.inactiveMembers} ActivitiesInWindow=${payload.totals.activitiesInWindow}`
  );
}

await main();

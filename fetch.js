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

// YYYY-MM-DD in America/Chicago
function ymdInTZ(dateObj) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dateObj);
}

// Yesterday YYYY-MM-DD in America/Chicago (stable anchor = noon UTC)
function yesterdayYMD() {
  const todayYMD = ymdInTZ(new Date());
  const [y, m, d] = todayYMD.split("-").map(Number);
  const todayNoonUtcMs = Date.UTC(y, m - 1, d, 12, 0, 0);
  const ydayNoonUtcMs = todayNoonUtcMs - 24 * 3600 * 1000;
  return ymdInTZ(new Date(ydayNoonUtcMs));
}

function miles(meters) {
  return (Number(meters || 0) / 1609.344) || 0;
}

function parseAnyDateToMs(v) {
  if (!v) return null;
  if (typeof v === "number") {
    // Might be seconds or ms; guess
    if (v > 1e12) return v;        // ms
    if (v > 1e9) return v * 1000;  // seconds
    return null;
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function activityStartMs(activity) {
  // Try common fields in order
  const candidates = [
    activity?.start_date,
    activity?.start_date_local,
    activity?.startDate,          // sometimes camelCase in wrappers
    activity?.startDateLocal,
    activity?.start_time,
    activity?.startTime,
    activity?.activity?.start_date,
    activity?.activity?.start_date_local,
  ];

  for (const c of candidates) {
    const ms = parseAnyDateToMs(c);
    if (ms != null) return ms;
  }
  return null;
}

function activityDateInTZ(activity) {
  const ms = activityStartMs(activity);
  if (ms == null) return null;
  return ymdInTZ(new Date(ms));
}

async function main() {
  const tokenData = await postForm("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const accessToken = tokenData?.access_token;
  if (!accessToken) throw new Error("No access_token returned from Strava refresh.");

  const reportDate = yesterdayYMD();
  console.log(`Report date (Central): ${reportDate} (${TZ})`);

  // Members (paginate)
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

  // Activities (start with just the first page to diagnose)
  const activities = await getJson(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=200&page=1`,
    accessToken
  );

  if (!Array.isArray(activities) || activities.length === 0) {
    throw new Error("Fetched 0 club activities. Check STRAVA_CLUB_ID / permissions.");
  }

  console.log(`Activities fetched: ${activities.length}`);

  // Diagnostic: show keys + a trimmed sample of first activity
  const first = activities[0];
  console.log("FIRST ACTIVITY KEYS:", Object.keys(first));

  // Print a trimmed sample (avoid huge output)
  const sample = {
    id: first?.id,
    name: first?.name,
    type: first?.type,
    sport_type: first?.sport_type,
    start_date: first?.start_date,
    start_date_local: first?.start_date_local,
    start_time: first?.start_time,
    athlete: first?.athlete,
    distance: first?.distance,
    raw: first,
  };
  console.log("FIRST ACTIVITY SAMPLE:", JSON.stringify(sample, null, 2).slice(0, 4000));

  // Now filter by Central date equality
  const filtered = activities.filter((a) => activityDateInTZ(a) === reportDate);

  const parsedDates = activities
    .map(activityDateInTZ)
    .filter((d) => d != null)
    .sort();

  const oldest = parsedDates.length ? parsedDates[0] : null;
  const newest = parsedDates.length ? parsedDates[parsedDates.length - 1] : null;

  console.log(`Oldest activity date (Central): ${oldest ?? "n/a"}`);
  console.log(`Newest activity date (Central): ${newest ?? "n/a"}`);
  console.log(`Activities in reportDate (Central): ${filtered.length}`);

  // If we still can't parse ANY activity date, fail loud with a clear message
  if (parsedDates.length === 0) {
    throw new Error(
      "Could not parse activity timestamps from Strava club activities response. " +
      "See FIRST ACTIVITY SAMPLE in logs; we need to map the correct timestamp field."
    );
  }

  // Roster
  const roster = members.map((m) => ({
    id: String(m.id),
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim() || `Member ${m.id}`,
  }));

  // Aggregate by athlete id
  const byId = new Map();
  const typeCounts = new Map();

  for (const a of filtered) {
    const id = String(a?.athlete?.id ?? "");
    if (!id) continue;

    const t = String(a?.type ?? a?.sport_type ?? "");
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);

    if (!byId.has(id)) byId.set(id, { Walk: 0, Run: 0, Ride: 0, Hike: 0 });

    const rec = byId.get(id);
    const dist = miles(a?.distance);

    if (t === "Walk") rec.Walk += dist;
    else if (t === "Run") rec.Run += dist;
    else if (t === "Ride") rec.Ride += dist;
    else if (t === "Hike") rec.Hike += dist;
  }

  console.log("Activity types in reportDate:", Object.fromEntries(typeCounts));

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
    totals: {
      members: roster.length,
      activitiesFetched: activities.length,
      activitiesInWindow: filtered.length,
      activeMembers: rows.length,
      inactiveMembers: inactive.length,
    },
    debug: {
      oldestFetchedCentral: oldest,
      newestFetchedCentral: newest,
      firstActivityKeys: Object.keys(first),
    },
    rows,
    inactive,
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`report-data.json written for ${reportDate}`);
}

await main();

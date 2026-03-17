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
need("WORKER_REPORT_URL");
need("REPORT_API_TOKEN");

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
  WORKER_REPORT_URL,
  REPORT_API_TOKEN,
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
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const res = await fetch(url, { headers });
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

async function main() {
  // Still use Strava OAuth for club roster lookup
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

  if (members.length === 0) {
    throw new Error("Fetched 0 club members. Check STRAVA_CLUB_ID / permissions.");
  }

  console.log(`Members fetched: ${members.length}`);

  // Activities now come from the Cloudflare Worker report endpoint
  const reportUrl =
    `${WORKER_REPORT_URL}?date=${encodeURIComponent(reportDate)}&token=${encodeURIComponent(REPORT_API_TOKEN)}`;

  const reportJson = await getJson(reportUrl, null);
  const activities = Array.isArray(reportJson?.activities) ? reportJson.activities : [];

  console.log(`Activities fetched from worker: ${activities.length}`);

  if (activities.length > 0) {
    console.log(
      "FIRST ACTIVITY SAMPLE:",
      JSON.stringify(activities[0], null, 2).slice(0, 4000)
    );
  } else {
    console.log("FIRST ACTIVITY SAMPLE: none");
  }

  // Roster
  const roster = members.map((m) => ({
    id: String(m.id),
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim() || `Member ${m.id}`,
  }));

  // Aggregate by athlete id
  const byId = new Map();
  const typeCounts = new Map();

  for (const a of activities) {
    const id = String(a?.athlete_id ?? "");
    if (!id) continue;

    const t = String(a?.type ?? "");
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);

    if (!byId.has(id)) byId.set(id, { Walk: 0, Run: 0, Ride: 0, Hike: 0 });

    const rec = byId.get(id);
    const dist = miles(a?.distance_m);

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
      activitiesInWindow: activities.length,
      activeMembers: rows.length,
      inactiveMembers: inactive.length,
    },
    debug: {
      workerReportUrl: WORKER_REPORT_URL,
      firstActivityKeys: activities[0] ? Object.keys(activities[0]) : [],
    },
    rows,
    inactive,
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`report-data.json written for ${reportDate}`);
}

await main();

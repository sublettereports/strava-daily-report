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
    const txt = await res.text();
    throw new Error(`POST failed: ${res.status} ${txt}`);
  }
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GET failed: ${res.status} ${txt}`);
  }
  return res.json();
}

function yesterdayChicago() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmt.format(now);
  const [y, m, d] = today.split("-").map(Number);
  const todayUtc = Date.UTC(y, m - 1, d);
  const ydayUtc = todayUtc - 24 * 3600 * 1000;
  const yday = new Date(ydayUtc);
  return fmt.format(yday);
}

function utcFromChicagoMidnight(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

function miles(meters) {
  return (meters || 0) / 1609.344;
}

async function main() {
  const tokenData = await postForm(
    "https://www.strava.com/oauth/token",
    {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }
  );

  const accessToken = tokenData.access_token;

  const reportDate = yesterdayChicago();
  const startUtc = utcFromChicagoMidnight(reportDate);
  const endUtc = startUtc + 86400;

  const members = await getJson(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?per_page=200`,
    accessToken
  );

  const activities = await getJson(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=200`,
    accessToken
  );

  const filtered = activities.filter(a => {
    const t = Math.floor(Date.parse(a.start_date) / 1000);
    return t >= startUtc && t < endUtc;
  });

  const roster = members.map(m => ({
    id: m.id,
    name: `${m.firstname || ""} ${m.lastname || ""}`.trim()
  }));

  const rows = [];
  const inactive = [];

  for (const member of roster) {
    const acts = filtered.filter(a => a.athlete.id === member.id);
    if (!acts.length) {
      inactive.push({ name: member.name });
      continue;
    }

    let walk = 0, run = 0, ride = 0, hike = 0;

    for (const a of acts) {
      const dist = miles(a.distance);
      if (a.type === "Walk") walk += dist;
      if (a.type === "Run") run += dist;
      if (a.type === "Ride") ride += dist;
      if (a.type === "Hike") hike += dist;
    }

    rows.push({
      name: member.name,
      Walk: walk,
      Run: run,
      Ride: ride,
      Hike: hike
    });
  }

  const payload = {
    reportDate,
    rows,
    inactive
  };

  fs.writeFileSync("report-data.json", JSON.stringify(payload, null, 2));
  console.log("report-data.json written");
}

await main();

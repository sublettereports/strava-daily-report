import axios from "axios";
import fs from "fs";
import PDFDocument from "pdfkit";

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
  STRAVA_LOGO_URL
} = process.env;

// Report date in Month Day, Year
const reportDate = new Date(Date.now() - 86400000);
const options = { year: "numeric", month: "long", day: "numeric" };
const dateLabel = reportDate.toLocaleDateString("en-US", options);

const fileName = `strava-daily-report-${reportDate.toISOString().split("T")[0]}.pdf`;

async function getAccessToken() {
  const res = await axios.post("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  return res.data.access_token;
}

async function run() {
  const token = await getAccessToken();

  // Pull activities and members
  const activities = await axios.get(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const members = await axios.get(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const totals = { Walk: [], Run: [], Ride: [], Hike: [], None: [] };
  const activeIds = new Set();

  // Process activities safely
  for (const a_attach of activities.data) {
    if (!a_attach.activity || !a_attach.activity.distance) continue;

    const a = a_attach.activity;
    const miles = a.distance / 1609.34;
    const name = `${a.athlete.firstname} ${a.athlete.lastname}`;
    activeIds.add(a.athlete.id);

    if (totals[a.type]) {
      totals[a.type].push(`${name} — ${miles.toFixed(2)} mi`);
    }
  }

  // Add inactive members to NO ACTIVITY
  for (const m of members.data) {
    if (!activeIds.has(m.id)) {
      totals.None.push(`${m.firstname} ${m.lastname} — 0.00 mi`);
    }
  }

  // Generate PDF
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  const pageHeight = doc.page.height - 80;
  const startY =

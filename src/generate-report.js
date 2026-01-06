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

const reportDate = new Date(Date.now() - 86400000);
const dateLabel = reportDate.toISOString().split("T")[0];
const fileName = `strava-daily-report-${dateLabel}.pdf`;

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

  for (const a_attach of activities.data) {
    const a = a_attach.activity;
    const miles = a.distance / 1609.34;
    const name = a.athlete.firstname + " " + a.athlete.lastname;
    activeIds.add(a.athlete.id);

    if (totals[a.type]) {
      totals[a.type].push(`${name} — ${miles.toFixed(2)} mi`);
    }
  }

  for (const m of members.data) {
    if (!activeIds.has(m.id)) {
      totals.None.push(`${m.firstname} ${m.lastname} — 0.00 mi`);
    }
  }

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  const logo = await axios.get(STRAVA_LOGO_URL, { responseType: "arraybuffer" });
  doc.image(logo.data, 40, 20, { width: 520 });

  doc.moveDown(3);
  doc.fontSize(18).text(`Strava Daily Report — ${dateLabel}`, { align: "center" });
  doc.moveDown();

  const columns = [
    ["Walk", totals.Walk],
    ["Run", totals.Run],
    ["Ride", totals.Ride],
    ["Hike / No Activity", [...totals.Hike, "", "NO ACTIVITY", ...totals.None]]
  ];

  let x = 40;
  for (const [title, list] of columns) {
    doc.fontSize(12).text(title, x, 150);
    doc.fontSize(10);
    let y = 170;
    for (const line of list) {
      doc.text(line, x, y);
      y += 14;
    }
    x += 135;
  }

  doc.end();
}

run();

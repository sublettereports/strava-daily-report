const axios = require('axios');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const REQUIRED_ENV_VARS = [
  'STRAVA_CLIENT_ID',
  'STRAVA_CLIENT_SECRET',
  'STRAVA_REFRESH_TOKEN',
  'STRAVA_CLUB_ID',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_BCC'
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function validateEnv() {
  for (const name of REQUIRED_ENV_VARS) requireEnv(name);
}

async function getAccessToken() {
  const response = await axios.post(
    'https://www.strava.com/oauth/token',
    null,
    {
      params: {
        client_id: requireEnv('STRAVA_CLIENT_ID'),
        client_secret: requireEnv('STRAVA_CLIENT_SECRET'),
        refresh_token: requireEnv('STRAVA_REFRESH_TOKEN'),
        grant_type: 'refresh_token'
      },
      timeout: 30000
    }
  );

  return response.data.access_token;
}

async function fetchAllPages(url, accessToken) {
  const all = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { page, per_page: perPage },
      timeout: 30000
    });

    const rows = response.data || [];
    all.push(...rows);

    if (rows.length < perPage) break;
    page++;
  }

  return all;
}

async function fetchFirstPage(url, accessToken) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { page: 1, per_page: 100 },
    timeout: 30000
  });

  return response.data || [];
}

async function getClubMembers(token, clubId) {
  return fetchAllPages(`https://www.strava.com/api/v3/clubs/${clubId}/members`, token);
}

async function getClubActivities(token, clubId) {
  return fetchFirstPage(`https://www.strava.com/api/v3/clubs/${clubId}/activities`, token);
}

function metersToMiles(meters) {
  if (!meters || isNaN(meters)) return 0;
  return meters * 0.000621371;
}

function formatMiles(m) {
  return `${m.toFixed(2)} mi`;
}

function getName(obj) {
  return `${obj.firstname || ''} ${obj.lastname || ''}`.trim();
}

function buildData(members, activities) {
  const memberMap = new Map();
  members.forEach(m => memberMap.set(m.id, getName(m)));

  const categories = {
    walk: new Map(),
    run: new Map(),
    ride: new Map(),
    hike: new Map()
  };

  const active = new Set();

  for (const a of activities) {
    // DEBUG (leave this for now)
    console.log('DEBUG:', a.type, a.sport_type, a.distance);

    const type = (a.sport_type || a.type || '').toLowerCase();

    let bucket = null;
    if (type.includes('walk')) bucket = 'walk';
    else if (type.includes('run')) bucket = 'run';
    else if (type.includes('ride')) bucket = 'ride';
    else if (type.includes('hike')) bucket = 'hike';

    if (!bucket) continue;

    const athleteId = a.athlete?.id;
    if (!athleteId || !memberMap.has(athleteId)) continue;

    const distanceMeters = a.distance || a.moving_distance || 0;
    const miles = metersToMiles(distanceMeters);

    active.add(athleteId);

    const current = categories[bucket].get(athleteId) || {
      name: memberMap.get(athleteId),
      miles: 0
    };

    current.miles += miles;
    categories[bucket].set(athleteId, current);
  }

  const sort = arr => Array.from(arr.values()).sort((a,b)=>b.miles-a.miles);

  const noActivity = members
    .filter(m => !active.has(m.id))
    .map(m => ({ name: getName(m), miles: 0 }));

  return {
    walk: sort(categories.walk),
    run: sort(categories.run),
    ride: sort(categories.ride),
    hike: sort(categories.hike),
    noActivity
  };
}

async function createPdf(data, date, file) {
  const doc = new PDFDocument({ margin: 36 });
  doc.pipe(fs.createWriteStream(file));

  doc.fontSize(20).text(`Strava Daily Report - ${date}`, { align: 'center' });
  doc.moveDown();

  function draw(title, rows) {
    doc.fontSize(14).text(title);
    rows.forEach(r => doc.fontSize(10).text(`${r.name} - ${formatMiles(r.miles)}`));
    doc.moveDown();
  }

  draw('Walk', data.walk);
  draw('Run', data.run);
  draw('Ride', data.ride);
  draw('Hike / No Activity', [...data.hike, ...data.noActivity]);

  doc.end();
}

async function sendEmail(file, date) {
  const transporter = nodemailer.createTransport({
    host: requireEnv('EMAIL_HOST'),
    port: Number(requireEnv('EMAIL_PORT')),
    secure: true,
    auth: {
      user: requireEnv('EMAIL_USER'),
      pass: requireEnv('EMAIL_PASS')
    }
  });

  await transporter.sendMail({
    from: requireEnv('EMAIL_USER'),
    to: requireEnv('EMAIL_USER'),
    bcc: requireEnv('EMAIL_BCC'),
    subject: `Strava Report ${date}`,
    text: 'Attached',
    attachments: [{ path: file }]
  });
}

async function runReport() {
  validateEnv();

  const token = await getAccessToken();
  const clubId = requireEnv('STRAVA_CLUB_ID');

  const [members, activities] = await Promise.all([
    getClubMembers(token, clubId),
    getClubActivities(token, clubId)
  ]);

  console.log('Members:', members.length);
  console.log('Activities:', activities.length);

  const data = buildData(members, activities);

  const file = `report.pdf`;

  await createPdf(data, new Date().toDateString(), file);
  console.log('PDF created');

  await sendEmail(file);
  console.log('Email sent');
}

runReport().catch(err => {
  console.error(err);
  process.exit(1);
});

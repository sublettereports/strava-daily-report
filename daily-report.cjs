const axios = require('axios');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const DEBUG = true;

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
  for (const name of REQUIRED_ENV_VARS) {
    requireEnv(name);
  }
}

function debugLog(label, value) {
  if (!DEBUG) return;

  try {
    console.log(`\n========== ${label} ==========`);
    if (typeof value === 'string') {
      console.log(value);
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    console.log(`========== END ${label} ==========\n`);
  } catch (error) {
    console.log(`\n========== ${label} ==========`);
    console.log(value);
    console.log(`========== END ${label} ==========\n`);
  }
}

function safeMiles(meters) {
  return Number(((Number(meters) || 0) * 0.000621371).toFixed(2));
}

function summarizeMember(member) {
  return {
    id: member?.id ?? null,
    firstname: member?.firstname ?? null,
    lastname: member?.lastname ?? null,
    name: getMemberName(member),
    username: member?.username ?? null,
    resource_state: member?.resource_state ?? null
  };
}

function summarizeActivity(activity) {
  return {
    id: activity?.id ?? null,
    name: activity?.name ?? null,
    type: activity?.type ?? null,
    sport_type: activity?.sport_type ?? null,
    distance_meters: activity?.distance ?? 0,
    distance_miles: safeMiles(activity?.distance),
    start_date: activity?.start_date ?? null,
    start_date_local: activity?.start_date_local ?? null,
    timezone: activity?.timezone ?? null,
    athlete_id: activity?.athlete?.id ?? null,
    athlete_firstname: activity?.athlete?.firstname ?? null,
    athlete_lastname: activity?.athlete?.lastname ?? null,
    athlete_name: getActivityAthleteName(activity)
  };
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

  if (!response.data || !response.data.access_token) {
    throw new Error('Strava did not return an access token.');
  }

  return response.data.access_token;
}

async function fetchAllPages(url, accessToken, label = 'FETCH') {
  const all = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        page,
        per_page: perPage
      },
      timeout: 30000
    });

    const rows = Array.isArray(response.data) ? response.data : [];

    debugLog(`${label} PAGE`, {
      url,
      page,
      perPage,
      rowsFetched: rows.length,
      firstFew: rows.slice(0, 5)
    });

    all.push(...rows);

    if (rows.length < perPage) {
      break;
    }

    page += 1;
  }

  debugLog(`${label} COMPLETE`, {
    url,
    totalRows: all.length
  });

  return all;
}

async function getClubMembers(accessToken, clubId) {
  return fetchAllPages(
    `https://www.strava.com/api/v3/clubs/${clubId}/members`,
    accessToken,
    'CLUB MEMBERS'
  );
}

async function getClubActivities(accessToken, clubId) {
  return fetchAllPages(
    `https://www.strava.com/api/v3/clubs/${clubId}/activities`,
    accessToken,
    'CLUB ACTIVITIES'
  );
}

function getPreviousChicagoDayInfo() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);

  const chicagoTodayUtc = new Date(Date.UTC(year, month - 1, day));
  const chicagoYesterdayUtc = new Date(chicagoTodayUtc.getTime() - 24 * 60 * 60 * 1000);

  const reportYear = chicagoYesterdayUtc.getUTCFullYear();
  const reportMonth = chicagoYesterdayUtc.getUTCMonth() + 1;
  const reportDay = chicagoYesterdayUtc.getUTCDate();

  const isoDate = `${reportYear}-${String(reportMonth).padStart(2, '0')}-${String(reportDay).padStart(2, '0')}`;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const prettyDate = `${monthNames[reportMonth - 1]} ${reportDay}, ${reportYear}`;

  debugLog('REPORT DATE WINDOW', {
    nowSystem: now.toString(),
    nowISO: now.toISOString(),
    chicagoYear: year,
    chicagoMonth: month,
    chicagoDay: day,
    chicagoTodayUtc: chicagoTodayUtc.toISOString(),
    chicagoYesterdayUtc: chicagoYesterdayUtc.toISOString(),
    isoDate,
    prettyDate
  });

  return {
    isoDate,
    prettyDate
  };
}

function metersToMiles(meters) {
  return Number(meters || 0) * 0.000621371;
}

function formatMiles(miles) {
  return `${miles.toFixed(2)} mi`;
}

function getMemberName(member) {
  const first = (member.firstname || '').trim();
  const last = (member.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || 'Unnamed Athlete';
}

function getActivityAthleteName(activity) {
  const athlete = activity.athlete || {};
  const first = (athlete.firstname || '').trim();
  const last = (athlete.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || 'Unnamed Athlete';
}

function normalizeSportType(activity) {
  return String(activity.sport_type || activity.type || '').trim();
}

function bucketForSportType(sportType) {
  const value = String(sportType || '').toLowerCase();

  if (value.includes('walk')) return 'walk';
  if (value.includes('run')) return 'run';
  if (value.includes('ride') || value.includes('bike') || value.includes('cycling')) return 'ride';
  if (value.includes('hike')) return 'hike';

  return null;
}

function activityMatchesReportDate(activity, isoDate) {
  const local = String(activity.start_date_local || '');
  return local.startsWith(isoDate);
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildMemberKey(member) {
  if (member && member.id != null) {
    return `id:${String(member.id)}`;
  }

  const name = getMemberName(member);
  return `name:${normalizeName(name)}`;
}

function buildActivityKey(activity) {
  if (activity && activity.athlete && activity.athlete.id != null) {
    return `id:${String(activity.athlete.id)}`;
  }

  const name = getActivityAthleteName(activity);
  return `name:${normalizeName(name)}`;
}

function buildReportData(members, activities, reportIsoDate) {
  const memberMap = new Map();

  for (const member of members) {
    const key = buildMemberKey(member);
    const name = getMemberName(member);

    if (!memberMap.has(key)) {
      memberMap.set(key, {
        key,
        name
      });
    }
  }

  debugLog('MEMBER MAP SUMMARY', {
    totalMembers: members.length,
    uniqueMemberKeys: memberMap.size,
    sampleMembers: members.slice(0, 15).map(member => ({
      summary: summarizeMember(member),
      memberKey: buildMemberKey(member),
      normalizedName: normalizeName(getMemberName(member))
    }))
  });

  debugLog('RAW ACTIVITIES SUMMARY', {
    totalActivities: activities.length,
    sampleActivities: activities.slice(0, 25).map(activity => ({
      summary: summarizeActivity(activity),
      activityKey: buildActivityKey(activity),
      normalizedAthleteName: normalizeName(getActivityAthleteName(activity)),
      matchesReportDate: activityMatchesReportDate(activity, reportIsoDate),
      normalizedSportType: normalizeSportType(activity),
      bucket: bucketForSportType(normalizeSportType(activity))
    }))
  });

  const filteredActivities = activities.filter(activity => activityMatchesReportDate(activity, reportIsoDate));

  debugLog('FILTERED ACTIVITIES SUMMARY', {
    reportIsoDate,
    filteredCount: filteredActivities.length,
    sampleFilteredActivities: filteredActivities.slice(0, 25).map(activity => ({
      summary: summarizeActivity(activity),
      activityKey: buildActivityKey(activity),
      normalizedAthleteName: normalizeName(getActivityAthleteName(activity)),
      normalizedSportType: normalizeSportType(activity),
      bucket: bucketForSportType(normalizeSportType(activity))
    }))
  });

  const categories = {
    walk: new Map(),
    run: new Map(),
    ride: new Map(),
    hike: new Map()
  };

  const activeKeys = new Set();

  for (const activity of filteredActivities) {
    const category = bucketForSportType(normalizeSportType(activity));

    if (!category) {
      debugLog('SKIPPED ACTIVITY - NO CATEGORY', {
        reportIsoDate,
        activity: summarizeActivity(activity),
        normalizedSportType: normalizeSportType(activity)
      });
      continue;
    }

    const activityKey = buildActivityKey(activity);
    let member = memberMap.get(activityKey);
    let matchType = 'id';

    if (!member) {
      const fallbackNameKey = `name:${normalizeName(getActivityAthleteName(activity))}`;
      member = memberMap.get(fallbackNameKey);
      matchType = 'name';
    }

    if (!member) {
      debugLog('UNMATCHED ACTIVITY', {
        reportIsoDate,
        activity: summarizeActivity(activity),
        activityKey,
        fallbackNameKey: `name:${normalizeName(getActivityAthleteName(activity))}`,
        availableMemberKeySamples: Array.from(memberMap.keys()).slice(0, 25)
      });
      continue;
    }

    const miles = metersToMiles(activity.distance);
    activeKeys.add(member.key);

    const current = categories[category].get(member.key) || {
      name: member.name,
      miles: 0
    };

    current.miles += miles;
    categories[category].set(member.key, current);

    debugLog('MATCHED ACTIVITY', {
      reportIsoDate,
      matchType,
      category,
      member,
      activity: summarizeActivity(activity),
      milesAdded: safeMiles(activity.distance),
      memberRunningTotal: Number(current.miles.toFixed(2))
    });
  }

  const memberMatchDiagnostics = members.slice(0, 25).map(member => {
    const memberIdKey = member && member.id != null ? `id:${String(member.id)}` : null;
    const memberNameKey = `name:${normalizeName(getMemberName(member))}`;

    const matchedById = filteredActivities.filter(activity => {
      if (memberIdKey == null) return false;
      return buildActivityKey(activity) === memberIdKey;
    });

    const matchedByName = filteredActivities.filter(activity => {
      return `name:${normalizeName(getActivityAthleteName(activity))}` === memberNameKey;
    });

    return {
      member: summarizeMember(member),
      memberIdKey,
      memberNameKey,
      matchedByIdCount: matchedById.length,
      matchedByNameCount: matchedByName.length,
      matchedById: matchedById.slice(0, 10).map(summarizeActivity),
      matchedByName: matchedByName.slice(0, 10).map(summarizeActivity)
    };
  });

  debugLog('MEMBER MATCH CHECKS', memberMatchDiagnostics);

  const walk = Array.from(categories.walk.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const run = Array.from(categories.run.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const ride = Array.from(categories.ride.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const hike = Array.from(categories.hike.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const noActivity = Array.from(memberMap.values())
    .filter(member => !activeKeys.has(member.key))
    .map(member => ({
      name: member.name,
      miles: 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  debugLog('FINAL CATEGORY COUNTS', {
    walk: walk.length,
    run: run.length,
    ride: ride.length,
    hike: hike.length,
    noActivity: noActivity.length,
    activeKeys: activeKeys.size
  });

  debugLog('FINAL CATEGORY SAMPLES', {
    walk: walk.slice(0, 15),
    run: run.slice(0, 15),
    ride: ride.slice(0, 15),
    hike: hike.slice(0, 15),
    noActivity: noActivity.slice(0, 15)
  });

  return { walk, run, ride, hike, noActivity };
}

async function fetchLogoBuffer() {
  const logoUrl = (process.env.STRAVA_LOGO_URL || '').trim();
  if (!logoUrl) {
    return null;
  }

  try {
    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.warn(`Logo download failed: ${error.message}`);
    return null;
  }
}

function splitIntoChunks(rows, chunkSize) {
  if (chunkSize <= 0) {
    return [rows];
  }

  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }

  return chunks.length ? chunks : [[]];
}

function drawColumn(doc, x, y, width, title, rows) {
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(title, x, y, { width, align: 'left' });

  let currentY = y + 22;

  if (!rows.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .text('None', x, currentY, { width, align: 'left' });
    return;
  }

  for (const row of rows) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(row.name, x, currentY, {
        width: width - 55,
        align: 'left'
      });

    doc
      .font('Helvetica')
      .fontSize(10)
      .text(formatMiles(row.miles), x + width - 55, currentY, {
        width: 55,
        align: 'right'
      });

    currentY += 14;
  }
}

function renderPageHeader(doc, prettyDate, logoBuffer, isFirstPage) {
  const pageWidth = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const contentWidth = pageWidth - left - right;

  if (isFirstPage && logoBuffer) {
    try {
      doc.image(logoBuffer, left, 24, {
        fit: [contentWidth, 70],
        align: 'center'
      });
      doc.y = 110;
    } catch (error) {
      console.warn(`Logo rendering failed: ${error.message}`);
      doc.y = 50;
    }
  } else {
    doc.y = 36;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(`Strava Daily Report - ${prettyDate}`, left, doc.y, {
      width: contentWidth,
      align: 'center'
    });

  doc.moveDown(1);

  return {
    left,
    contentWidth,
    startY: doc.y + 8
  };
}

async function createPdf(reportData, prettyDate, outputPath) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 36,
    autoFirstPage: true
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const logoBuffer = await fetchLogoBuffer();

  const firstHeader = renderPageHeader(doc, prettyDate, logoBuffer, true);

  const columnGap = 14;
  const totalGap = columnGap * 3;
  const columnWidth = (firstHeader.contentWidth - totalGap) / 4;
  const rowHeight = 14;
  const titleHeight = 22;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 10;
  const usableHeight = bottomLimit - (firstHeader.startY + titleHeight);
  const rowsPerPage = Math.max(1, Math.floor(usableHeight / rowHeight));

  const hikeAndNoActivity = [...reportData.hike, ...reportData.noActivity];

  const pageChunks = {
    walk: splitIntoChunks(reportData.walk, rowsPerPage),
    run: splitIntoChunks(reportData.run, rowsPerPage),
    ride: splitIntoChunks(reportData.ride, rowsPerPage),
    hikeNoActivity: splitIntoChunks(hikeAndNoActivity, rowsPerPage)
  };

  const totalPages = Math.max(
    pageChunks.walk.length,
    pageChunks.run.length,
    pageChunks.ride.length,
    pageChunks.hikeNoActivity.length
  );

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    if (pageIndex > 0) {
      doc.addPage();
      renderPageHeader(doc, prettyDate, null, false);
    }

    const startX = doc.page.margins.left;
    const startY = doc.y + 8;

    drawColumn(
      doc,
      startX,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Walk' : 'Walk (cont.)',
      pageChunks.walk[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + columnWidth + columnGap,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Run' : 'Run (cont.)',
      pageChunks.run[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + (columnWidth + columnGap) * 2,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Ride' : 'Ride (cont.)',
      pageChunks.ride[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + (columnWidth + columnGap) * 3,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Hike / No Activity' : 'Hike / No Activity (cont.)',
      pageChunks.hikeNoActivity[pageIndex] || []
    );
  }

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function sendEmailWithAttachment(filePath, prettyDate) {
  const transporter = nodemailer.createTransport({
    host: requireEnv('EMAIL_HOST'),
    port: Number(requireEnv('EMAIL_PORT')),
    secure: Number(requireEnv('EMAIL_PORT')) === 465,
    auth: {
      user: requireEnv('EMAIL_USER'),
      pass: requireEnv('EMAIL_PASS')
    }
  });

  const fileName = path.basename(filePath);

  await transporter.sendMail({
    from: requireEnv('EMAIL_USER'),
    to: requireEnv('EMAIL_USER'),
    bcc: requireEnv('EMAIL_BCC'),
    subject: `Strava Daily Report - ${prettyDate}`,
    text: `Attached is the Strava Daily Report for ${prettyDate}.`,
    attachments: [
      {
        filename: fileName,
        path: filePath
      }
    ]
  });
}

async function runReport() {
  validateEnv();

  const clubId = requireEnv('STRAVA_CLUB_ID');
  const { isoDate, prettyDate } = getPreviousChicagoDayInfo();

  console.log(`Building report for ${prettyDate} (${isoDate})`);

  const accessToken = await getAccessToken();

  debugLog('ACCESS TOKEN RECEIVED', {
    received: Boolean(accessToken),
    tokenLength: accessToken ? accessToken.length : 0
  });

  const [members, activities] = await Promise.all([
    getClubMembers(accessToken, clubId),
    getClubActivities(accessToken, clubId)
  ]);

  console.log(`Members fetched: ${members.length}`);
  console.log(`Recent club activities fetched: ${activities.length}`);

  debugLog('TOP LEVEL FETCH SUMMARY', {
    membersCount: members.length,
    activitiesCount: activities.length,
    memberSample: members.slice(0, 15).map(summarizeMember),
    activitySample: activities.slice(0, 25).map(summarizeActivity)
  });

  const reportData = buildReportData(members, activities, isoDate);

  console.log(`Walk entries: ${reportData.walk.length}`);
  console.log(`Run entries: ${reportData.run.length}`);
  console.log(`Ride entries: ${reportData.ride.length}`);
  console.log(`Hike entries: ${reportData.hike.length}`);
  console.log(`No Activity entries: ${reportData.noActivity.length}`);

  const outputFile = path.join(process.cwd(), `strava-daily-report-${isoDate}.pdf`);

  await createPdf(reportData, prettyDate, outputFile);
  console.log(`PDF created: ${outputFile}`);

  await sendEmailWithAttachment(outputFile, prettyDate);
  console.log('Email sent successfully');
}

runReport().catch(error => {
  if (error.response) {
    console.error('Strava/API error response:', error.response.status, error.response.data);
  } else {
    console.error(error);
  }
  process.exit(1);
});

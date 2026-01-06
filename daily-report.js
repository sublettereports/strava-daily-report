// daily-report.js
const axios = require('axios');
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');

// ===== CONFIG =====
const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REFRESH_TOKEN = 'YOUR_REFRESH_TOKEN';
const CLUB_ID = 'YOUR_CLUB_ID'; // numeric Strava club ID

// Email config will come later

// ===== HELPER FUNCTIONS =====
async function getAccessToken() {
  const response = await axios.post('https://www.strava.com/oauth/token', null, {
    params: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }
  });
  return response.data.access_token;
}

function formatDateYYYYMMDD(date) {
  return date.toISOString().split('T')[0];
}

// ===== MAIN =====
async function runReport() {
  const accessToken = await getAccessToken();

  // Get yesterday's date
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const startDate = new Date(yesterday.setHours(0,0,0,0)).getTime() / 1000;
  const endDate = new Date(yesterday.setHours(23,59,59,999)).getTime() / 1000;

  // Pull club activities
  const activities = await axios.get(`https://www.strava.com/api/v3/clubs/${CLUB_ID}/activities`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // Filter activities for yesterday
  const yesterdayActivities = activities.data.filter(act => {
    const startTime = new Date(act.start_date).getTime() / 1000;
    return startTime >= startDate && startTime <= endDate;
  });

  console.log('Yesterday activities:', yesterdayActivities);
}

runReport();

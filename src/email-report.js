import nodemailer from "nodemailer";
import fs from "fs";

const {
  EMAIL_HOST,
  EMAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,
  EMAIL_BCC
} = process.env;

const files = fs.readdirSync(".");
const pdf = files.find(f => f.startsWith("strava-daily-report"));

if (!pdf) throw new Error("PDF not found");

const reportDate = new Date(Date.now() - 86400000);
const options = { year: "numeric", month: "long", day: "numeric" };
const dateLabel = reportDate.toLocaleDateString("en-US", options);

const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: Number(EMAIL_PORT),
  secure: false,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

await transporter.sendMail({
  from: EMAIL_USER,
  to: EMAIL_USER,
  bcc: EMAIL_BCC.split(","),
  subject: `Strava Daily Report — ${dateLabel}`,
  text: `This is all of the club activities for ${dateLabel}.`,
  attachments: [{ filename: pdf, path: pdf }]
});

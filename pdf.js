import puppeteer from "puppeteer";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname as _dirname } from "path";
import links from "./form-links.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);
dotenv.config();

const PROGRAM_YEAR = 2021;

const PHPSESSID = process.env.PHPSESSID;
if (!PHPSESSID) {
  console.error("❌ Please set the PHPSESSID environment variable in the .env file.");
  process.exit(1);
}

let browser;
let dbConnection;

try {
  // create a db connection
  dbConnection = await createDBConnection();
  if (!dbConnection) throw new Error("Failed to connect to DB");

  // create a browser instance
  browser = await createBrowser();

  const students = await getStudents(dbConnection, 1);

  for (const student of students) {
    const { stud_id, year, name, program, file_names } = student;
    try {
      await generatePDF(browser, stud_id, year, name, program, file_names);
    } catch (error) {
      console.error(`❌ Error generating PDF for student ${stud_id}:`, error.message);
      continue; // skip and go to next student
    }
  }
} catch (err) {
  console.error("❌ Fatal error:", err.message);
} finally {
  if (browser) await browser.close();
  if (dbConnection) await dbConnection.end();
  process.exit(0);
}

async function generatePDF(browser, stud_id, year, name, program, file_names) {
  let files = links[year];
  if (!files) {
    console.error("❌ No files found for year:", year);
    return;
  }

  files = files.filter((file) => file_names.includes(file.file_name));
  if (files.length === 0) {
    console.log(`ℹ️ No new files to generate for student ID ${stud_id} for year ${year}.`);
    return;
  }

  for (const file of files) {
    const page = await browser.newPage();
    try {
      await page.setCookie({
        name: "PHPSESSID",
        value: process.env.PHPSESSID,
        domain: process.env.HOSTNAME,
        path: "/",
        httpOnly: true,
        secure: false,
      });

      const url = `${process.env.BASE_URL}/${file.url}?stud_id=${stud_id}`;
      console.log("📄 Generating PDF for:", url);

      // safer navigation with timeout
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Remove all hrefs from anchor tags and wait for images, but max 10s
      await page.evaluate(async () => {
        // Remove all href attributes from anchor tags
        document.querySelectorAll('a[href]').forEach(a => a.removeAttribute('href'));

        const timeout = new Promise((resolve) => setTimeout(resolve, 10000));
        const images = Array.from(document.images);
        const loaders = images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.onload = img.onerror = resolve;
          });
        });
        await Promise.race([Promise.all(loaders), timeout]);
      });

      const outputDir = path.join(
        __dirname,
        `output/${program.replace(/[^a-zA-Z0-9]/g, "_")}/${year}/${stud_id}_${name.replace(/[^a-zA-Z0-9]/g, "_")}`
      );
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const pdfPath = path.join(
        outputDir,
        `${stud_id}_${file.file_name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}.pdf`
      );

      // protect PDF generation with timeout
      await Promise.race([
        page.pdf({
          path: pdfPath,
          format: "A4",
          printBackground: true,
          margin: { bottom: "1cm", top: "1cm" },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("PDF generation timeout")), 30000)
        ),
      ]);

      await logPDFGeneration(dbConnection, stud_id, name, program, year, url, file.file_name);
    } finally {
      await page.close();
    }
  }
}

async function createBrowser() {
  return await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  });
}

async function createDBConnection() {
  try {
    return await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      namedPlaceholders: true,
      connectTimeout: 10000, // 10s
    });
  } catch (error) {
    console.error("❌ Error establishing database connection:", error.message);
    return false;
  }
}

async function getStudents(connection, limit = 1) {
  const fileNames = links[PROGRAM_YEAR].map((file) => `'${file.file_name}'`).join(", ");
  try {
    const [rows] = await connection.execute(`
      SELECT 
        st.stud_id,
        CONCAT_WS('_', st.fname, st.lname) AS name,
        aa.a68 as program,
        st.account_year as year,
        group_concat(aa2.file_name) as file_names
      FROM student_tb st
      LEFT JOIN application_answers aa 
        ON aa.stud_id = st.stud_id 
        AND aa.file_name = 'application'
      LEFT JOIN application_answers aa2 
        ON aa2.stud_id = st.stud_id 
        AND aa2.file_name NOT IN (
          SELECT file_name FROM pdf_generated WHERE stud_id = st.stud_id
        )
        AND aa2.file_name IN (${fileNames})
      WHERE aa.a68 IN ('DESC', 'Connect Detroit')
      AND aa2.file_name != '' 
      AND st.account_year = ${PROGRAM_YEAR}
      GROUP BY st.stud_id
      ORDER BY st.stud_id
      LIMIT ${limit};
    `);
    return rows;
  } catch (error) {
    console.error("❌ Error fetching students:", error.message);
    return [];
  }
}

async function logPDFGeneration(connection, stud_id, name, program, year, link, file_name) {
  try {
    await connection.execute(
      `
      INSERT INTO pdf_generated (stud_id, name, program, year, link, file_name)
      VALUES (:stud_id, :name, :program, :year, :link, :file_name)
    `,
      { stud_id, name, program, year, link, file_name }
    );
    return true;
  } catch (error) {
    console.error("❌ Error logging PDF generation:", error.message);
    return false;
  }
}

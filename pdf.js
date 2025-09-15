import puppeteer from "puppeteer";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname as _dirname } from 'path';
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


// create a db connection
const dbConnection = await createDBConnection();
if (!dbConnection) {
  console.error("❌ Failed to establish database connection.");
  process.exit(1);
}

// create a browser instance
const browser = await createBrowser();

const students = await getStudents(dbConnection, 10);
console.log(students);process.exit(1);


for (const student of students) {
  const { stud_id, year, name, program, file_names } = student;
  try {
    await generatePDF(browser, stud_id, year, name, program, file_names);
  } catch (error) {
    console.error("❌ Error generating PDF:", error);
    process.exit(1);
  }
}

// close the browser and db connection after all students are processed
process.on('beforeExit', async () => {
  await browser.close();
  await dbConnection.end();
});

async function generatePDF(browser, stud_id, year, name, program, file_names) {
  let files = links[year];
  if (!files) {
    console.error("❌ No files found for year:", year);
    return;
  }

  files = files.filter(file => file_names.includes(file.file_name));
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

      await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

      await page.evaluate(async () => {
        const images = Array.from(document.images);
        await Promise.all(
          images.map((img) => {
            if (img.complete) return;
            return new Promise((resolve) => {
              img.onload = img.onerror = resolve;
            });
          })
        );
      });

      const outputDir = path.join(
        __dirname,
        `output/${program.replace(/[^a-zA-Z0-9]/g, "_")}/${year}/${stud_id}_${name.replace(/[^a-zA-Z0-9]/g, "_")}`
      );

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      await page.pdf({
        path: path.join(
          outputDir,
          `${stud_id}_${file.file_name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}.pdf`
        ),
        format: "A4",
        printBackground: true,
        margin: {
          bottom: "1cm",
          top: "1cm",
        },
      });

      await logPDFGeneration(dbConnection, stud_id, name, program, year, url, file.file_name);
    } finally {
      await page.close();
    }
  }
}

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  });
  return browser;
}

async function createDBConnection() {
    try {
      const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        namedPlaceholders: true,
      });
      return connection;
    } catch (error) {
      console.error("❌ Error establishing database connection:", error);
      return false;
    }
}

async function getStudents(connection, limit = 1) {
  const fileNames = links[PROGRAM_YEAR].map(file => `'${file.file_name}'`).join(", ");
  try {
    const [rows] = await connection.execute(`
      SELECT 
        st.stud_id,
        CONCAT_WS('_', st.fname, st.lname) AS name,
        aa.a68 as program,
        st.account_year as year,
        group_concat(aa2.file_name) as file_names
      FROM student_tb st
      left join application_answers aa on aa.stud_id = st.stud_id and aa.file_name = 'application'
      left join application_answers aa2 on aa2.stud_id = st.stud_id 
        and aa2.file_name not in (select file_name from pdf_generated where stud_id = st.stud_id ) 
        and aa2.file_name in (${fileNames})
      where aa.a68 in ('DESC', 'Connect Detroit')
      and aa2.file_name != '' 
      and st.account_year = 2021 
      group by st.stud_id
      order by st.stud_id
      limit ${limit};
    `);
    return rows;
  } catch (error) {
    console.error("❌ Error fetching students:", error);
    return false;
  }
}

async function logPDFGeneration(connection, stud_id, name, program, year, link, file_name) {
  try {
    await connection.execute(`
      INSERT INTO pdf_generated (stud_id, name, program, year, link, file_name)
      VALUES (:stud_id, :name, :program, :year, :link, :file_name)
    `, {
      stud_id,
      name,
      program,
      year,
      link,
      file_name
    });
    return true;
  } catch (error) {
    console.error("❌ Error logging PDF generation:", error);
    return false;
  }
}

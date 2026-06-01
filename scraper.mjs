/**
 * DRAM / Memory Spot Price Tracker
 * ==================================
 * 从 bomman.com 抓取 TrendForce 内存现货价格趋势
 * 通过 sitemap 自动发现最新文章，每周约 1-2 次更新
 *
 * 用法:
 *   npm run scrape
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

// ── 工具函数 ──

function saveCSV(filename, rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fp = path.join(DATA_DIR, filename);

  const seen = new Set();
  if (fs.existsSync(fp)) {
    const existing = fs.readFileSync(fp, "utf-8").trim().split("\n").slice(1);
    existing.forEach((line) => {
      const date = line.split(",")[0];
      if (date) seen.add(date);
    });
  } else {
    const header = Object.keys(rows[0]).join(",");
    fs.writeFileSync(fp, header + "\n");
  }

  const newRows = rows.filter((r) => !seen.has(r.date || ""));
  if (newRows.length === 0) {
    console.log("  (no new rows)");
    return fp;
  }

  const lines = newRows.map((r) => Object.values(r).join(",")).join("\n");
  fs.appendFileSync(fp, lines + "\n");
  return fp;
}

// ── 主抓取逻辑 ──

async function scrapeBomman(browser) {
  // 1. 从 sitemap 获取最新文章列表
  console.log("  Fetching sitemap...");
  const sitemapResp = await fetch(
    "https://www.bomman.com/server-news-sitemap.xml"
  );
  if (!sitemapResp.ok) {
    throw new Error(`Sitemap returned ${sitemapResp.status}`);
  }
  const xml = await sitemapResp.text();
  const urls = [
    ...xml.matchAll(
      /<loc>(https:\/\/www\.bomman\.com\/pps\/details\/\d+)<\/loc>/g
    ),
  ].map((m) => m[1]);
  console.log(`  Found ${urls.length} articles in sitemap`);

  // 2. 检查近期文章，筛选内存/DRAM/NAND 相关
  const page = await browser.newPage();
  const results = [];
  // 必须同时包含"现货"(或"价格")和存储关键词，避免匹配到行业新闻
  const spotWords = ["现货", "价格"];
  const chipWords = ["内存", "DRAM", "DDR", "NAND", "存储芯片"];
  const checkCount = 60; // 检查最近 60 篇

  for (const url of urls.slice(0, checkCount)) {
    if (results.length > 0) break; // 取最近一篇即可

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });

      const data = await page
        .$eval("#__NEXT_DATA__", (el) => JSON.parse(el.textContent || "{}"))
        .catch(() => null);

      if (!data?.props?.pageProps?.data) continue;

      const article = data.props.pageProps.data;
      const title = article.title || "";
      const createDate = article.createTime
        ? article.createTime.slice(0, 10)
        : "";

      if (
        !spotWords.some((k) => title.includes(k)) ||
        !chipWords.some((k) => title.includes(k))
      )
        continue;

      const daysAgo =
        (new Date() - new Date(createDate)) / (1000 * 60 * 60 * 24);
      if (daysAgo > 14) {
        console.log(
          `  Skipping old article: ${createDate} — ${title.slice(0, 60)}`
        );
        continue;
      }

      const content = (article.content || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      results.push({
        date: createDate,
        source: "bomman",
        title: title.replace(/,/g, " "),
        summary: content.slice(0, 600).replace(/,/g, " "),
      });

      console.log(`  Article: ${createDate} — ${title}`);
      console.log(`  Preview: ${content.slice(0, 150)}...`);
    } catch {
      // 跳过无效文章
    }
  }

  await page.close();
  return results;
}

// ── JSON 导出 ──

function exportJSON() {
  const docsDir = path.join(__dirname, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const csvPath = path.join(DATA_DIR, "bomman_prices.csv");
  if (!fs.existsSync(csvPath)) return;

  const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  if (lines.length < 2) return;

  const headers = lines[0].split(",");
  const json = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] || "";
    });
    return obj;
  });

  const jsonPath = path.join(docsDir, "bomman_prices.json");
  fs.writeFileSync(jsonPath, JSON.stringify(json));
  console.log(`  Exported ${json.length} rows → ${jsonPath}`);
}

// ── 主流程 ──

async function main() {
  console.log(
    `[${new Date().toISOString()}] Memory spot price scraper`
  );

  const browser = await chromium.launch({ headless: true });

  try {
    console.log("\n── bomman (TrendForce spot prices) ──");
    const rows = await scrapeBomman(browser);

    if (rows.length > 0) {
      const saved = saveCSV("bomman_prices.csv", rows);
      console.log(`  Saved ${rows.length} rows → ${saved}`);
    } else {
      console.log("  No new memory articles found");
    }

    console.log("\n── export JSON ──");
    exportJSON();
  } finally {
    await browser.close();
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

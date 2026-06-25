/**
 * DRAM / Memory Price Tracker
 * ==================================
 * 从 ZOL (中关村在线) 抓取 DDR4/DDR5 内存零售价格
 * 每日统计均价、最低价、最高价、样本数
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
const TODAY = new Date().toISOString().slice(0, 10);
const ZOL_MEMORY_URL = "https://detail.zol.com.cn/memory/";

// ── 工具函数 ──

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetries(operation, options = {}) {
  const {
    attempts = 3,
    delayMs = 2_000,
    label = "operation",
    onRetry = ({ attempt, maxAttempts, error }) => {
      console.warn(
        `  ${label} failed on attempt ${attempt}/${maxAttempts}: ${error.message}`
      );
    },
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry({ attempt, maxAttempts: attempts, error });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastError;
}

export function saveCSV(filename, rows, dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fp = path.join(dataDir, filename);

  if (rows.length === 0) {
    return { filePath: fp, addedRows: 0, skippedRows: 0 };
  }

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
    console.log("  (no new rows — date already exists in CSV)");
    return { filePath: fp, addedRows: 0, skippedRows: rows.length };
  }

  const lines = newRows.map((r) => Object.values(r).join(",")).join("\n");
  fs.appendFileSync(fp, lines + "\n");
  return {
    filePath: fp,
    addedRows: newRows.length,
    skippedRows: rows.length - newRows.length,
  };
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── ZOL 内存价格抓取 ──

export async function navigateToZOL(page) {
  const response = await page.goto(ZOL_MEMORY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  await page.waitForSelector("[class*=price]", { timeout: 15_000 });
  await page.waitForTimeout(3_000);
  return response;
}

async function scrapeZOLOnce(browser) {
  const page = await browser.newPage();
  const allProducts = [];

  try {
    await navigateToZOL(page);

    // ZOL 价格元素的父容器中包含完整产品信息
    const products = await page.$$eval(
      "[class*=price]",
      (els) =>
        els
          .filter((el) => el.textContent.includes("参考价"))
          .map((priceEl) => {
            // 向上找到产品卡片容器
            let container = priceEl;
            for (let i = 0; i < 5; i++) {
              container = container.parentElement;
              if (!container) break;
              const text = container.textContent?.trim() || "";
              if (text.length > 30 && text.length < 800) break;
            }
            const text = (container?.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            const priceMatch = text.match(/参考价[：:]\s*[¥￥]\s*(\d+)/);
            return {
              text,
              price: priceMatch ? parseInt(priceMatch[1]) : 0,
            };
          })
    );

    for (const p of products) {
      if (p.price > 0) {
        const namePart = p.text.split("参考价")[0].trim();
        allProducts.push({ name: namePart, price: p.price });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  // 去重：按 name+price 组合
  const seen = new Set();
  const unique = allProducts.filter((p) => {
    const key = `${p.name}|${p.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Total unique products: ${unique.length}`);

  // 按 DDR4 / DDR5 分类
  const ddr4 = unique.filter(
    (p) => p.name.includes("DDR4") && !p.name.includes("DDR5")
  );
  const ddr5 = unique.filter(
    (p) => p.name.includes("DDR5") && !p.name.includes("DDR4")
  );

  console.log(
    `  DDR4: ${ddr4.length} samples, DDR5: ${ddr5.length} samples`
  );

  // 生成汇总行
  const results = [];

  for (const [label, items] of [
    ["DDR4", ddr4],
    ["DDR5", ddr5],
  ]) {
    if (items.length === 0) continue;
    const prices = items.map((i) => i.price);
    results.push({
      date: TODAY,
      source: "zol",
      category: label,
      avg_price_cny: Math.round(avg(prices)),
      min_price_cny: Math.min(...prices),
      max_price_cny: Math.max(...prices),
      sample_count: prices.length,
    });
    console.log(
      `  ${label}: avg ¥${Math.round(avg(prices))} (${prices.length} samples, range ¥${Math.min(...prices)}-¥${Math.max(...prices)})`
    );
  }

  return results;
}

export async function scrapeZOL(browser) {
  return withRetries(() => scrapeZOLOnce(browser), {
    attempts: 3,
    delayMs: 2_000,
    label: "ZOL scrape",
  });
}

// ── JSON + HTML 导出 ──

function exportJSON() {
  const docsDir = path.join(__dirname, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const csvPath = path.join(DATA_DIR, "zol_prices.csv");
  if (!fs.existsSync(csvPath)) return;

  const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  if (lines.length < 2) return;

  const headers = lines[0].split(",");
  const json = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const v = vals[i];
      if (
        ["avg_price_cny", "min_price_cny", "max_price_cny", "sample_count"].includes(h)
      ) {
        obj[h] = parseInt(v);
      } else {
        obj[h] = v;
      }
    });
    return obj;
  });

  // JSON 文件
  const jsonPath = path.join(docsDir, "zol_prices.json");
  fs.writeFileSync(jsonPath, JSON.stringify(json));
  console.log(`  Exported ${json.length} rows → ${jsonPath}`);

  // 自包含 HTML（数据直接嵌入，无需 HTTP 服务器）
  const htmlPath = path.join(docsDir, "index.html");
  const jsonLiteral = JSON.stringify(json);
  const html = buildHTML(jsonLiteral);
  fs.writeFileSync(htmlPath, html);
  console.log(`  Exported self-contained HTML → ${htmlPath}`);
}

function buildHTML(jsonLiteral) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DDR4/DDR5 内存价格追踪</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<style>
  :root { --bg: #f5f6fa; --card: #fff; --text: #2c3e50; --muted: #7f8c8d; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
  header { text-align: center; padding: 30px 0 10px; }
  header h1 { font-size: 28px; font-weight: 700; }
  header p { color: var(--muted); font-size: 14px; margin-top: 4px; }
  .stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { flex: 1; min-width: 150px; background: var(--card); padding: 16px 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
  .stat .val { font-size: 24px; font-weight: 700; }
  .stat.ddr4 .val { color: #3498db; }
  .stat.ddr5 .val { color: #e74c3c; }
  .stat .lbl { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .card { background: var(--card); border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); padding: 24px; margin-bottom: 20px; }
  .card h2 { font-size: 16px; margin-bottom: 16px; }
  .chart { width: 100%; height: 360px; }
  .footer { text-align: center; padding: 20px; color: var(--muted); font-size: 12px; }
  @media (max-width: 768px) { .stats { flex-direction: column; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>DDR4 / DDR5 内存价格追踪</h1>
    <p>数据来源：ZOL 中关村在线 | 每日自动更新 | 价格单位：人民币 (CNY)</p>
  </header>

  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>价格走势</h2>
    <div class="chart" id="trend-chart"></div>
  </div>

  <div class="card">
    <h2>最新价格分布</h2>
    <div class="chart" id="range-chart"></div>
  </div>

  <div class="footer">
    最后更新: <span id="last-update">-</span> &nbsp;|&nbsp;
    数据仅供参考，不构成投资建议
  </div>
</div>

<script>
const DATA = ${jsonLiteral};

if (DATA.length === 0) {
  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="val">-</div><div class="lbl">等待首次数据抓取</div></div>';
} else {
  document.getElementById("last-update").textContent =
    DATA[DATA.length - 1].date;

  const latestDate = DATA[DATA.length - 1].date;
  const latestDay = DATA.filter(r => r.date === latestDate);
  const ddr4 = latestDay.find(r => r.category === "DDR4");
  const ddr5 = latestDay.find(r => r.category === "DDR5");

  document.getElementById("stats").innerHTML = [
    ddr5 ? '<div class="stat ddr5"><div class="val">¥' + ddr5.avg_price_cny + '</div><div class="lbl">DDR5 均价 (' + ddr5.sample_count + ' 样本)</div></div>' : "",
    ddr4 ? '<div class="stat ddr4"><div class="val">¥' + ddr4.avg_price_cny + '</div><div class="lbl">DDR4 均价 (' + ddr4.sample_count + ' 样本)</div></div>' : "",
    ddr5 ? '<div class="stat"><div class="val">¥' + ddr5.min_price_cny + ' - ¥' + ddr5.max_price_cny + '</div><div class="lbl">DDR5 价格区间</div></div>' : "",
    '<div class="stat"><div class="val">' + (DATA.length / 2) + '</div><div class="lbl">累计数据天数</div></div>',
  ].join("");

  // 价格走势
  const dates = [...new Set(DATA.map(r => r.date))].sort();
  const ddr4Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR4");
    return r ? r.avg_price_cny : null;
  });
  const ddr5Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR5");
    return r ? r.avg_price_cny : null;
  });

  const trendChart = echarts.init(document.getElementById("trend-chart"));
  trendChart.setOption({
    tooltip: { trigger: "axis", valueFormatter: v => "¥" + v },
    legend: { data: ["DDR4 均价", "DDR5 均价"], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: "category", data: dates },
    yAxis: { type: "value", name: "CNY", axisLabel: { formatter: "¥{value}" } },
    series: [
      { name: "DDR4 均价", type: "line", data: ddr4Series, smooth: true, symbol: "circle", symbolSize: 6,
        lineStyle: { color: "#3498db", width: 2 }, itemStyle: { color: "#3498db" } },
      { name: "DDR5 均价", type: "line", data: ddr5Series, smooth: true, symbol: "circle", symbolSize: 6,
        lineStyle: { color: "#e74c3c", width: 2 }, itemStyle: { color: "#e74c3c" } },
    ],
  });

  // 价格分布
  const categories = ["DDR4", "DDR5"];
  const minData = categories.map(c => {
    const r = latestDay.find(x => x.category === c);
    return r ? r.min_price_cny : 0;
  });
  const avgData = categories.map(c => {
    const r = latestDay.find(x => x.category === c);
    return r ? r.avg_price_cny : 0;
  });
  const maxData = categories.map(c => {
    const r = latestDay.find(x => x.category === c);
    return r ? r.max_price_cny : 0;
  });

  const rangeChart = echarts.init(document.getElementById("range-chart"));
  rangeChart.setOption({
    tooltip: { trigger: "axis", valueFormatter: v => "¥" + v },
    legend: { data: ["最低价", "均价", "最高价"], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: "category", data: categories },
    yAxis: { type: "value", name: "CNY", axisLabel: { formatter: "¥{value}" } },
    series: [
      { name: "最低价", type: "bar", data: minData, itemStyle: { color: "#27ae60" } },
      { name: "均价", type: "bar", data: avgData, itemStyle: { color: "#3498db" } },
      { name: "最高价", type: "bar", data: maxData, itemStyle: { color: "#e74c3c" } },
    ],
  });
}
</script>
</body>
</html>`;
}

// ── 主流程 ──

export async function main() {
  console.log(
    `[${new Date().toISOString()}] Memory price scraper — ZOL`
  );

  const browser = await chromium.launch({ headless: true });

  try {
    console.log("\n── ZOL (中关村在线 DDR4/DDR5 零售价) ──");
    const rows = await scrapeZOL(browser);

    if (rows.length > 0) {
      const saved = saveCSV("zol_prices.csv", rows);
      if (saved.addedRows > 0) {
        console.log(`  Saved ${saved.addedRows} new rows → ${saved.filePath}`);
      } else {
        console.log(`  No new CSV rows written → ${saved.filePath}`);
      }
    } else {
      console.log("  No data extracted");
    }

    console.log("\n── export JSON ──");
    exportJSON();
  } finally {
    await browser.close();
  }

  console.log("\nDone.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

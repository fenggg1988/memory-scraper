/**
 * DRAM / Memory Price Tracker
 * ==================================
 * 数据源：RamRadar RAM Price Index（美国零售价，聚合自 eBay / Newegg / B&H Photo）
 *   公开 CSV：https://ramradar.app/ram-price-index/data.csv
 *   单位：美元每 GB（USD/GB），按内存模组（DIMM）规格归一化，可直接跨容量比较
 *
 * 相比原来的 ZOL（中关村在线）方案：
 *   - 数据源位于美国，GitHub Actions 海外服务器可正常访问（ZOL 在国外被墙）
 *   - 纯 CSV 下载 + 解析，无需 Playwright / 无头浏览器，CI 更快更稳
 *   - 价格归一化为 $/GB，比「整条模组人民币价」更可比
 *
 * 用法:
 *   npm run scrape
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DOCS_DIR = path.join(__dirname, "docs");
const TODAY = new Date().toISOString().slice(0, 10);

// RamRadar 公开 CSV（无需 API key，海外可访问）
const RAMRADAR_CSV_URL = "https://ramradar.app/ram-price-index/data.csv";

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

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
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

// ── RamRadar CSV 抓取与解析 ──

export async function fetchCsv(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "memory-price-scraper/2.0 (+github actions)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  return res.text();
}

export function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
}

/**
 * 从 RamRadar 全量 CSV 构建每日 DDR4/DDR5（桌面 DIMM）行。
 * 每个 (date, ram_type) 取一行，价格单位 USD/GB。
 */
export function buildDailyRows(allRows) {
  const desktop = allRows.filter(
    (r) =>
      r.form_factor === "DIMM" &&
      (r.ram_type === "DDR4" || r.ram_type === "DDR5")
  );

  const byDate = new Map();
  for (const r of desktop) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    const bucket = byDate.get(r.date);
    bucket[r.ram_type] = {
      avg: parseFloat(r.avg_price_per_gb),
      min: parseFloat(r.min_price_per_gb),
      max: parseFloat(r.max_price_per_gb),
      count: parseInt(r.product_count, 10) || 0,
    };
  }

  const out = [];
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const types = byDate.get(date);
    for (const cat of ["DDR4", "DDR5"]) {
      const t = types[cat];
      if (!t || !isFinite(t.avg)) continue;
      out.push({
        date,
        source: "ramradar",
        category: cat,
        avg_price: round2(t.avg),
        min_price: round2(t.min),
        max_price: round2(t.max),
        sample_count: t.count,
      });
    }
  }
  return out;
}

// ── JSON + HTML 导出 ──

function exportJSON() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const csvPath = path.join(DATA_DIR, "ram_prices.csv");
  if (!fs.existsSync(csvPath)) return;

  const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  if (lines.length < 2) return;

  const headers = lines[0].split(",");
  const json = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const v = vals[i];
      if (["avg_price", "min_price", "max_price", "sample_count"].includes(h)) {
        obj[h] = parseFloat(v);
      } else {
        obj[h] = v;
      }
    });
    return obj;
  });

  // JSON 文件
  const jsonPath = path.join(DOCS_DIR, "ram_prices.json");
  fs.writeFileSync(jsonPath, JSON.stringify(json));
  console.log(`  Exported ${json.length} rows → ${jsonPath}`);

  // 自包含 HTML（数据直接嵌入，无需 HTTP 服务器）
  const htmlPath = path.join(DOCS_DIR, "index.html");
  const html = buildHTML(JSON.stringify(json));
  fs.writeFileSync(htmlPath, html);
  console.log(`  Exported self-contained HTML → ${htmlPath}`);
}

function buildHTML(jsonLiteral) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DDR4/DDR5 内存价格追踪 (USD/GB)</title>
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
    <p>数据来源：RamRadar（eBay / Newegg / B&H 零售价，归一化为 USD/GB）| 每日自动更新</p>
  </header>

  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>价格走势 (USD/GB)</h2>
    <div class="chart" id="trend-chart"></div>
  </div>

  <div class="card">
    <h2>最新价格分布 (USD/GB)</h2>
    <div class="chart" id="range-chart"></div>
  </div>

  <div class="footer">
    最后更新: <span id="last-update">-</span> &nbsp;|&nbsp;
    价格单位：美元每 GB (USD/GB) &nbsp;|&nbsp; 数据仅供参考，不构成投资建议
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
    ddr5 ? '<div class="stat ddr5"><div class="val">$' + ddr5.avg_price.toFixed(2) + '/GB</div><div class="lbl">DDR5 均价 (' + ddr5.sample_count + ' 样本)</div></div>' : "",
    ddr4 ? '<div class="stat ddr4"><div class="val">$' + ddr4.avg_price.toFixed(2) + '/GB</div><div class="lbl">DDR4 均价 (' + ddr4.sample_count + ' 样本)</div></div>' : "",
    ddr5 ? '<div class="stat"><div class="val">$' + ddr5.min_price.toFixed(2) + ' - $' + ddr5.max_price.toFixed(2) + '</div><div class="lbl">DDR5 价格区间</div></div>' : "",
    '<div class="stat"><div class="val">' + (DATA.length / 2) + '</div><div class="lbl">累计数据天数</div></div>',
  ].join("");

  // 价格走势
  const dates = [...new Set(DATA.map(r => r.date))].sort();
  const ddr4Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR4");
    return r ? r.avg_price : null;
  });
  const ddr5Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR5");
    return r ? r.avg_price : null;
  });

  const trendChart = echarts.init(document.getElementById("trend-chart"));
  trendChart.setOption({
    tooltip: { trigger: "axis", valueFormatter: v => "$" + v + "/GB" },
    legend: { data: ["DDR4 均价", "DDR5 均价"], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: "category", data: dates },
    yAxis: { type: "value", name: "USD/GB", axisLabel: { formatter: (v) => "$" + v } },
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
    return r ? r.min_price : 0;
  });
  const avgData = categories.map(c => {
    const r = latestDay.find(x => x.category === c);
    return r ? r.avg_price : 0;
  });
  const maxData = categories.map(c => {
    const r = latestDay.find(x => x.category === c);
    return r ? r.max_price : 0;
  });

  const rangeChart = echarts.init(document.getElementById("range-chart"));
  rangeChart.setOption({
    tooltip: { trigger: "axis", valueFormatter: v => "$" + v + "/GB" },
    legend: { data: ["最低价", "均价", "最高价"], bottom: 0 },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: "category", data: categories },
    yAxis: { type: "value", name: "USD/GB", axisLabel: { formatter: (v) => "$" + v } },
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
  console.log(`[${new Date().toISOString()}] Memory price scraper — RamRadar`);

  console.log("\n── Downloading RamRadar CSV ──");
  const csv = await withRetries(() => fetchCsv(RAMRADAR_CSV_URL), {
    attempts: 3,
    delayMs: 2_000,
    label: "RamRadar CSV fetch",
  });

  const allRows = parseCsv(csv);
  console.log(`  Parsed ${allRows.length} raw rows from RamRadar`);

  const daily = buildDailyRows(allRows);
  console.log(`  Built ${daily.length} daily DDR4/DDR5 (DIMM) rows`);

  if (daily.length > 0) {
    const saved = saveCSV("ram_prices.csv", daily);
    if (saved.addedRows > 0) {
      console.log(
        `  Saved ${saved.addedRows} new rows → ${saved.filePath} (skipped ${saved.skippedRows})`
      );
    } else {
      console.log(`  No new CSV rows written → ${saved.filePath}`);
    }
  } else {
    console.log("  No data extracted");
  }

  console.log("\n── export JSON + HTML ──");
  exportJSON();

  console.log("\nDone.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

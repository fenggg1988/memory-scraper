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

// memoryindex.io — HBM / DDR5 现货与合约价聚合（含 HBM3 / HBM3E / HBM4 每 stack 价格）
const MEMORYINDEX_URL = "https://memoryindex.io/zh";
// 官方公开样例 CSV（结构化，含 unit/source/as_of/30日与同比涨跌），HBM 首选数据源
const HBM_API_URL = "https://memoryindex.io/api/public/sample-prices.csv";

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

/**
 * 读 CSV 为行数组（已去掉 \r）。
 * 注意：Windows 下 git（autocrlf）会把仓库里的 LF 换成 CRLF，
 * 若不过滤 \r，行尾字段会带上 "\r"，导致表头变成 "sample_count\r" 之类的脏 key。
 */
function readCsvLines(fp) {
  return fs
    .readFileSync(fp, "utf-8")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function saveCSV(filename, rows, dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fp = path.join(dataDir, filename);

  if (rows.length === 0) {
    return { filePath: fp, addedRows: 0, skippedRows: 0 };
  }

  const seen = new Set();
  if (fs.existsSync(fp)) {
    const existing = readCsvLines(fp).slice(1);
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

// ── HBM 价格（memoryindex.io 聚合，TrendForce / Silicon Analysts 口径）──
//
// 页面有两种呈现：
//   1) 顶部滚动条（marquee）：<span class="text-muted-foreground">HBM3E-36G</span>
//      <span class="text-foreground">$2,108.00</span><span class="text-up">+0.26%</span>
//   2) 主价格表（权威，含来源与口径日期）：<div class="num text-xs text-primary">HBM3E-36G</div>
//      ... <td class="num ... text-right text-sm">US$2,108.00<div ...>¥15,009</div></td>
//      ... 来源链接 + <div class="num mt-1 text-[10px] text-muted-foreground">2026-07</div>
//
// 我们优先用主价格表（能拿到 source_label / as_of，便于识别上游换源、换口径），
// 表解析失败时回退到 marquee。只取 HBM* 品种，按标称容量换算 $/GB。

/** 口径断点标记：同一品种相邻观测值相差超过阈值 → 上游换了报价口径/来源，不是真实行情 */
export const BREAK_FLAG = "basis_break";
const BREAK_RATIO = 1.5; // >1.5x 或 <1/1.5x 视为断点

const NUM = "([0-9][0-9,]*(?:\\.[0-9]+)?)";

export function parseMemoryIndex(html) {
  const re = new RegExp(
    `text-muted-foreground">([A-Za-z0-9\\-]{2,20})<\\/span><span class="text-foreground">\\$${NUM}<\\/span><span class="text-(up|down)">([+-][0-9.]+)%`,
    "g"
  );
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, item, priceStr, dir, pct] = m;
    if (seen.has(item)) continue;
    seen.add(item);
    const price = parseFloat(priceStr.replace(/,/g, ""));
    if (!isFinite(price)) continue;
    // 注意：页面里涨跌幅文本自带符号（如 text-down">-0.04%"），
    // 所以这里直接取数值即可，不能再按 up/down 乘 ±1（否则负号会被double-negate成上涨）。
    const pctVal = parseFloat(pct);
    const capMatch = item.match(/-(\d+)G$/);
    const capacity = capMatch ? parseInt(capMatch[1], 10) : null;
    out.push({
      item,
      price_usd: price,
      capacity_gb: capacity,
      price_per_gb: capacity ? round2(price / capacity) : null,
      change_pct: isFinite(pctVal) ? pctVal : 0,
      change_dir: dir === "down" ? "down" : "up",
      source_label: null,
      as_of: null,
      unit: null,
    });
  }
  return out;
}

/** 解析主价格表（权威来源，含来源名与口径日期） */
export function parseMemoryIndexTable(html) {
  const out = [];
  const rows = html.split(/<tr[^>]*>/).slice(1);
  for (const row of rows) {
    const itemM = row.match(/text-xs text-primary">([A-Za-z0-9\-]{2,20})</);
    if (!itemM) continue;
    const item = itemM[1];
    const nameM = row.match(/text-xs font-medium">([^<]{2,60})</);
    const unitM = row.match(/mt-1 text-\[10px\] text-muted-foreground">([^<]{1,20})</);
    // 现货价：第一个 text-right text-sm 单元格
    const spotM = row.match(new RegExp(`text-right text-sm">US\\$${NUM}`));
    if (!spotM) continue;
    const price = parseFloat(spotM[1].replace(/,/g, ""));
    if (!isFinite(price)) continue;
    // 当日 / 30日 高低的 US$ 数值（按出现顺序取 4 个）
    const highs = [...row.matchAll(new RegExp(`text-(?:up|down)">US\\$${NUM}`, "g"))].map((x) =>
      parseFloat(x[1].replace(/,/g, ""))
    );
    // 30日涨跌 / 同比
    const pcts = [...row.matchAll(new RegExp(`text-xs text-(?:up|down)">([+-]?[0-9.]+)%`, "g"))].map(
      (x) => parseFloat(x[1])
    );
    const srcM = row.match(/hover:underline">([^<]{2,80})</) || row.match(/<a [^>]*>([^<]{2,80})<\/a>/);
    const asOfM = row.match(/mt-1 text-\[10px\] text-muted-foreground">([0-9]{4}-[0-9]{2})</);
    const capMatch = item.match(/-(\d+)G$/);
    const capacity = capMatch ? parseInt(capMatch[1], 10) : null;
    out.push({
      item,
      name: nameM ? nameM[1] : null,
      unit: unitM ? unitM[1] : null,
      price_usd: price,
      capacity_gb: capacity,
      price_per_gb: capacity ? round2(price / capacity) : null,
      day_high: highs[0] ?? null,
      day_low: highs[1] ?? null,
      d30_high: highs[2] ?? null,
      d30_low: highs[3] ?? null,
      change_pct: pcts[0] ?? null,
      yoy_pct: pcts[1] ?? null,
      source_label: srcM ? srcM[1].trim() : null,
      as_of: asOfM ? asOfM[1] : null,
      change_dir: null,
    });
  }
  return out;
}

/** 标记「口径断点」：相邻两日同品种价格突变超过阈值，或 unit 变化（上游换源/换单位，非真实行情） */
export function markBreaks(rows) {
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item).push(r);
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      let broke = false;
      const p = prev.price_usd;
      const c = cur.price_usd;
      if (p > 0 && c > 0) {
        const ratio = c / p;
        if (ratio > BREAK_RATIO || ratio < 1 / BREAK_RATIO) broke = true;
      }
      if (prev.unit && cur.unit && prev.unit !== cur.unit) broke = true;
      if (broke) cur.flag = BREAK_FLAG;
    }
  }
  return rows;
}

export async function fetchHbm() {
  // 优先用官方公开 API 样例 CSV：结构化字段（unit / source / as_of / 30日与同比涨跌），
  // 比 HTML 抓取可靠，且能直接看出上游是否换了口径或来源。
  try {
    const api = await fetchHbmApi();
    if (api.length > 0) return { rows: api, via: "api" };
  } catch (e) {
    console.warn(`  HBM API fetch failed, falling back to HTML: ${e.message}`);
  }

  const res = await fetch(MEMORYINDEX_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 memory-price-scraper/2.1",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${MEMORYINDEX_URL}: HTTP ${res.status}`);
  const html = await res.text();
  const table = parseMemoryIndexTable(html).filter((r) => r.item.startsWith("HBM"));
  if (table.length > 0) return { rows: table, via: "table" };
  const marquee = parseMemoryIndex(html).filter((r) => r.item.startsWith("HBM"));
  return { rows: marquee, via: "marquee" };
}

/**
 * 解析官方公开样例 CSV（https://memoryindex.io/api/public/sample-prices.csv）
 * 表头：session_utc,contract_id,ticker,name,segment,unit,spot_usd,chg_24h_pct,chg_30d_pct,chg_yoy_pct,basis,as_of,source
 */
export function parseHbmApiCsv(text) {
  const lines = text.replace(/\r/g, "").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const get = (name) => {
      const i = idx(name);
      return i >= 0 && cells[i] !== undefined ? cells[i].trim() : "";
    };
    if (get("segment") !== "HBM") continue;
    const ticker = get("ticker");
    const price = parseFloat(get("spot_usd"));
    if (!ticker || !isFinite(price)) continue;
    const capMatch = ticker.match(/-(\d+)G$/);
    const capacity = capMatch ? parseInt(capMatch[1], 10) : null;
    // source 字段可能含逗号，被 split 拆碎 —— 用 header 之后的剩余片段拼回
    const srcIdx = idx("source");
    const source = srcIdx >= 0 ? cells.slice(srcIdx).join(",").trim() : "";
    out.push({
      item: ticker,
      name: get("name").replace(/^"|"$/g, ""),
      unit: get("unit").replace(/^"|"$/g, ""),
      price_usd: price,
      capacity_gb: capacity,
      price_per_gb: capacity ? round2(price / capacity) : null,
      change_pct: parseFloat(get("chg_24h_pct")),
      d30_pct: parseFloat(get("chg_30d_pct")),
      yoy_pct: parseFloat(get("chg_yoy_pct")),
      source_label: source.replace(/^"|"$/g, ""),
      as_of: get("as_of"),
      basis: get("basis"),
      change_dir: null,
    });
  }
  return out;
}

async function fetchHbmApi() {
  const res = await fetch(HBM_API_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 memory-price-scraper/2.2",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${HBM_API_URL}`);
  return parseHbmApiCsv(await res.text());
}

const HBM_CSV = "hbm_prices.csv";
/** HBM CSV 列顺序（含 source_label/as_of/unit 用于溯源，flag 用于口径断点标记） */
export const HBM_FIELDS = [
  "date",
  "source",
  "item",
  "capacity_gb",
  "price_usd",
  "price_per_gb",
  "unit",
  "change_pct",
  "d30_pct",
  "yoy_pct",
  "source_label",
  "as_of",
  "flag",
];

function hbmFieldValue(r, f) {
  const v = r[f];
  if (v === undefined || v === null) return "";
  // 简单 CSV 转义：字段里的逗号换成「;」（source 名称里可能出现逗号），避免破坏列结构
  return String(v).replace(/[",]/g, (c) => (c === "," ? ";" : ""));
}

/**
 * 合并式写入：读旧行 → 合并新行（按 date+source+item 去重）→ 标记口径断点 → 按日期排序重写。
 * 重写而非追加，保证历史行的 flag 与列结构始终一致。
 */
function saveHbmCSV(rows, dataDir = DATA_DIR) {
  const fp = path.join(dataDir, HBM_CSV);
  fs.mkdirSync(dataDir, { recursive: true });
  if (rows.length === 0) return { filePath: fp, addedRows: 0 };

  const existing = loadHbmRows(dataDir);
  const { rows: merged0, added } = mergeHbmRows(existing, rows);

  const merged = markBreaks(merged0);
  merged.sort((a, b) =>
    a.date === b.date
      ? String(a.item).localeCompare(String(b.item))
      : String(a.date).localeCompare(String(b.date))
  );

  const body = merged
    .map((r) => HBM_FIELDS.map((f) => hbmFieldValue(r, f)).join(","))
    .join("\n");
  fs.writeFileSync(fp, HBM_FIELDS.join(",") + "\n" + body + "\n");
  return { filePath: fp, addedRows: added };
}

/**
 * 合并新旧 HBM 行（键 = 日期 + 品种）：
 *  - 新日期 → 追加
 *  - 已有该日 → 只补齐缺失的元数据（unit / source_label / as_of / 30日 / 同比），价格保持首次抓取值
 */
function mergeHbmRows(existing, incoming) {
  const key = (r) => `${r.date}|${r.item}`;
  const map = new Map(existing.map((r) => [key(r), r]));
  let added = 0;
  for (const r of incoming) {
    const k = key(r);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, r);
      added += 1;
      continue;
    }
    for (const f of ["unit", "name", "basis", "source_label", "as_of", "d30_pct", "yoy_pct"]) {
      const empty = cur[f] === undefined || cur[f] === null || cur[f] === "";
      const has = r[f] !== undefined && r[f] !== null && r[f] !== "" && !Number.isNaN(r[f]);
      if (empty && has) cur[f] = r[f];
    }
  }
  return { rows: [...map.values()], added };
}

function loadHbmRows(dataDir = DATA_DIR) {
  const fp = path.join(dataDir, HBM_CSV);
  if (!fs.existsSync(fp)) return [];
  const lines = readCsvLines(fp);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const textFields = new Set(["date", "source", "item", "unit", "source_label", "as_of", "flag"]);
  const rows = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const v = vals[i] === undefined ? "" : vals[i];
      obj[h] = textFields.has(h) ? (v === "" ? (h === "flag" ? null : "") : v) : v === "" ? null : parseFloat(v);
    });
    if (!obj.flag) obj.flag = null;
    return obj;
  });
  // 历史行可能没有 flag 列（旧版本写入），这里统一重算
  return markBreaks(rows);
}

function exportJSON() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const csvPath = path.join(DATA_DIR, "ram_prices.csv");
  if (!fs.existsSync(csvPath)) return;

  const lines = readCsvLines(csvPath);
  if (lines.length < 2) return;

  const headers = lines[0].split(",").map((h) => h.trim());
  const json = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const v = (vals[i] ?? "").trim();
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
  const hbmRows = loadHbmRows();
  const hbmPath = path.join(DOCS_DIR, "hbm_prices.json");
  fs.writeFileSync(hbmPath, JSON.stringify(hbmRows));
  console.log(`  Exported ${hbmRows.length} HBM rows → ${hbmPath}`);

  const htmlPath = path.join(DOCS_DIR, "index.html");
  const html = buildHTML(JSON.stringify(json), JSON.stringify(hbmRows));
  fs.writeFileSync(htmlPath, html);
  console.log(`  Exported self-contained HTML → ${htmlPath}`);
}

function buildHTML(jsonLiteral, hbmLiteral = "[]") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>DDR4/DDR5/HBM 内存价格追踪</title>
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
  .note { font-size: 12px; color: var(--muted); margin: -8px 0 12px; }
  .chart { width: 100%; height: 360px; }
  .footer { text-align: center; padding: 20px; color: var(--muted); font-size: 12px; }
  @media (max-width: 768px) { .stats { flex-direction: column; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>DDR4 / DDR5 / HBM 内存价格追踪</h1>
    <p>数据来源：RamRadar（零售价，USD/GB）+ memoryindex.io（HBM 现货/合约价聚合）| 每日自动更新</p>
  </header>

  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>HBM 价格（USD / stack）</h2>
    <div class="stats" id="hbm-stats"></div>
    <p class="note" id="hbm-note"></p>
    <div class="chart" id="hbm-bar" style="height:320px"></div>
  </div>

  <div class="card">
    <h2>HBM 每 stack 价格走势 (USD/stack)</h2>
    <div class="chart" id="hbm-stack-trend" style="height:340px"></div>
  </div>

  <div class="card">
    <h2>HBM 每 GB 价格走势 (USD/GB)</h2>
    <div class="chart" id="hbm-trend" style="height:340px"></div>
  </div>

  <div class="card">
    <h2>DDR 与 HBM 价格走势对比 (USD/GB)</h2>
    <div class="chart" id="trend-chart" style="height:400px"></div>
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
const HBM_DATA = ${hbmLiteral};

// 页面显示的最后更新日期 = 两个数据集里最新的日期
const LAST_UPDATE_DATE = [...new Set([...DATA.map(r => r.date), ...HBM_DATA.map(r => r.date)])].sort().pop() || "-";
document.getElementById("last-update").textContent = LAST_UPDATE_DATE;

const HBM_PALETTE = { "HBM3-24G": "#3498db", "HBM3E-36G": "#9b59b6", "HBM4-48G": "#e67e22" };
const HBM_FALLBACK = ["#3498db", "#9b59b6", "#e67e22", "#1abc9c", "#f1c40f"];
const hbmColor = (it, i) => HBM_PALETTE[it] || HBM_FALLBACK[i % HBM_FALLBACK.length];
const HBM_ITEMS = [...new Set(HBM_DATA.map(r => r.item))].sort();
const HBM_DATES = [...new Set(HBM_DATA.map(r => r.date))].sort();
const HBM_BREAK = "basis_break";
const hbmRow = (d, it) => HBM_DATA.find(x => x.date === d && x.item === it) || null;
const isBreak = r => !!r && r.flag === HBM_BREAK;
const BREAK_DATES = [...new Set(HBM_DATA.filter(isBreak).map(r => r.date))].sort();

// 口径断点后的「有效观测」= 该品种在断点之后（含断点当日）的数据，用于日环比时的同口径比较
function hbmObs(item) {
  return HBM_DATES.map(d => hbmRow(d, item)).filter(Boolean);
}

// 日环比：只用「同一口径内」相邻两天计算；跨断点或断点当日一律返回 null，避免出现 ×7 这种假暴涨
function hbmDayChange(item) {
  const obs = hbmObs(item);
  if (obs.length < 2) return null;
  const cur = obs[obs.length - 1], prev = obs[obs.length - 2];
  if (isBreak(cur) || isBreak(prev)) return null;
  if (!prev.price_usd) return null;
  return (cur.price_usd - prev.price_usd) / prev.price_usd * 100;
}

// 红涨绿跌（A股/国内口径）
const upDownColor = v => v > 0 ? "#e74c3c" : (v < 0 ? "#27ae60" : "#7f8c8d");
const upDownArrow = v => v > 0 ? "▲" : (v < 0 ? "▼" : "—");

// 通用折线趋势图配置（与 DDR 走势图同款样式）
// 口径断点：断点当日不参与连线（置 null），并在断点日期画一条竖线标注，避免把换源前后的价格连成一条假趋势
function hbmLineOption(metric, axisName, unitSuffix) {
  const series = HBM_ITEMS.map((it, i) => ({
    name: it, type: "line", smooth: true, connectNulls: false,
    symbol: "circle", symbolSize: HBM_DATES.length <= 3 ? 8 : 5,
    data: HBM_DATES.map(d => {
      const r = hbmRow(d, it);
      if (!r) return null;
      return isBreak(r) ? null : r[metric];
    }),
    lineStyle: { color: hbmColor(it, i), width: 2 },
    itemStyle: { color: hbmColor(it, i) },
    emphasis: { focus: "series" },
  }));

  // 断点日期竖向标注（挂在第一条 series 上，图例只出现一次）
  if (BREAK_DATES.length && series.length) {
    series[0].markLine = {
      silent: true, symbol: "none",
      lineStyle: { color: "#e67e22", type: "dashed", width: 1 },
      label: { formatter: "口径变更", color: "#e67e22", fontSize: 10, position: "insideEndTop" },
      data: BREAK_DATES.map(d => ({ xAxis: d })),
    };
  }

  const needZoom = HBM_DATES.length > 40;
  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v, p) => {
        if (v == null) {
          const r = hbmRow(HBM_DATES[p.dataIndex], p.seriesName);
          return isBreak(r) ? "口径变更（不连线）" : "-";
        }
        return "$" + Number(v).toFixed(2) + unitSuffix;
      },
    },
    legend: { data: HBM_ITEMS, bottom: 0 },
    grid: { left: 66, right: 24, top: 16, bottom: needZoom ? 58 : 34 },
    xAxis: {
      type: "category", data: HBM_DATES, boundaryGap: false,
      axisLabel: { hideOverlap: true },
    },
    yAxis: {
      type: "value", name: axisName, scale: true,
      axisLabel: { formatter: v => "$" + v },
    },
    dataZoom: needZoom
      ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 24 }]
      : undefined,
    series,
    graphic: HBM_DATES.length === 1
      ? [{ type: "text", left: "center", top: 40,
           style: { text: "已有 1 天数据，明日起将连成趋势线", fill: "#7f8c8d", fontSize: 12 } }]
      : undefined,
  };
}

function renderHbm() {
  const el = document.getElementById("hbm-stats");
  if (!HBM_DATA.length) {
    el.innerHTML = '<div class="stat"><div class="val">-</div><div class="lbl">等待首次 HBM 抓取</div></div>';
    return;
  }
  const latestHbmDate = HBM_DATES[HBM_DATES.length - 1];
  const latestHbm = HBM_DATA.filter(r => r.date === latestHbmDate);

  el.innerHTML = latestHbm.map(r => {
    const dod = hbmDayChange(r.item);
    let chg;
    if (dod != null) {
      chg = '<span style="color:' + upDownColor(dod) + '">' + upDownArrow(dod) + Math.abs(dod).toFixed(2) + '% 日环比</span>';
    } else {
      const obs = hbmObs(r.item);
      const prev = obs.length >= 2 ? obs[obs.length - 2] : null;
      const why = isBreak(r) ? '口径变更日，不计算日环比'
        : (prev && isBreak(prev)) ? '日环比不可比（前值口径变更）'
        : '日环比待累积';
      chg = '<span style="color:#7f8c8d">— ' + why + '</span>';
    }
    const perGb = r.price_per_gb ? (" · $" + r.price_per_gb.toFixed(2) + "/GB") : "";
    return '<div class="stat"><div class="val">$' + r.price_usd.toFixed(2) + '</div>' +
      '<div class="lbl">' + r.item + perGb + '<br>' + chg + '</div></div>';
  }).join("");

  const note = document.getElementById("hbm-note");
  if (note) {
    const parts = [
      "最新日期 " + latestHbmDate + "，已累积 " + HBM_DATES.length + " 天（自 " + HBM_DATES[0] + " 起）",
      "数据源 memoryindex.io 官方公开 API（api/public/sample-prices.csv，HTML 表为回退），含 unit/来源/口径日期，趋势由本看板每日采集累积",
      "涨跌幅为日环比（红涨绿跌）",
    ];
    if (BREAK_DATES.length) {
      const detail = HBM_DATA.filter(isBreak).map(r => r.item + " " + r.date).join("、");
      parts.push(
        "⚠ 检测到上游口径变更： " + detail + "（价格突变 >1.5 倍，疑为上游换源或误按人民币折算），" +
        "该点已标记为断点，不参与连线与日环比计算"
      );
    }
    const srcs = [...new Set(HBM_DATA.filter(r => r.source_label).map(r => r.item + ": " + r.source_label + (r.as_of ? " (" + r.as_of + ")" : "")))];
    if (srcs.length) parts.push("上游标注来源 — " + srcs.join("；"));
    note.textContent = parts.join(" · ");
  }

  // 每 stack 价格走势（折线，每日累积）
  echarts.init(document.getElementById("hbm-stack-trend"))
    .setOption(hbmLineOption("price_usd", "USD/stack", "/stack"));

  // 每 GB 价格走势（折线，每日累积）
  echarts.init(document.getElementById("hbm-trend"))
    .setOption(hbmLineOption("price_per_gb", "USD/GB", "/GB"));

  // 当日各品种每 stack 价格
  const hbmBar = echarts.init(document.getElementById("hbm-bar"));
  hbmBar.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 70, right: 20, top: 10, bottom: 30 },
    xAxis: { type: "category", data: latestHbm.map(r => r.item) },
    yAxis: { type: "value", name: "USD/stack", axisLabel: { formatter: v => "$" + v } },
    series: [{
      type: "bar", barWidth: "45%",
      data: latestHbm.map((r, i) => ({
        value: r.price_usd,
        itemStyle: { color: hbmColor(r.item, i) },
      })),
      label: { show: true, position: "top", formatter: p => "$" + p.value.toFixed(0) },
    }],
  });
}

if (DATA.length === 0) {
  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="val">-</div><div class="lbl">等待首次数据抓取</div></div>';
} else {
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

  // 价格走势对比：DDR4 / DDR5 均价 + HBM 各品种每 GB 价格
  const dates = [...new Set([...DATA.map(r => r.date), ...HBM_DATES])].sort();
  const ddr4Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR4");
    return r ? r.avg_price : null;
  });
  const ddr5Series = dates.map(d => {
    const r = DATA.find(x => x.date === d && x.category === "DDR5");
    return r ? r.avg_price : null;
  });
  const hbmOverlaySeries = HBM_ITEMS.map((it, i) => ({
    name: it, type: "line", smooth: true, connectNulls: false,
    symbol: "circle", symbolSize: 5,
    data: dates.map(d => {
      const r = hbmRow(d, it);
      // 口径断点当日不连线（否则会把换源前后的价格连成假趋势）
      return r && !isBreak(r) ? r.price_per_gb : null;
    }),
    lineStyle: { color: hbmColor(it, i), width: 2, type: "dashed" },
    itemStyle: { color: hbmColor(it, i) },
    emphasis: { focus: "series" },
  }));

  const trendChart = echarts.init(document.getElementById("trend-chart"));
  trendChart.setOption({
    tooltip: { trigger: "axis", valueFormatter: v => v == null ? "-" : "$" + Number(v).toFixed(2) + "/GB" },
    legend: { data: ["DDR4 均价", "DDR5 均价", ...HBM_ITEMS], bottom: 0 },
    grid: { left: 60, right: 24, top: 16, bottom: 34 },
    xAxis: { type: "category", data: dates, boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: "USD/GB", scale: true, axisLabel: { formatter: (v) => "$" + v } },
    series: [
      { name: "DDR4 均价", type: "line", data: ddr4Series, smooth: true, symbol: "circle", symbolSize: 5,
        lineStyle: { color: "#3498db", width: 2 }, itemStyle: { color: "#3498db" }, emphasis: { focus: "series" } },
      { name: "DDR5 均价", type: "line", data: ddr5Series, smooth: true, symbol: "circle", symbolSize: 5,
        lineStyle: { color: "#e74c3c", width: 2 }, itemStyle: { color: "#e74c3c" }, emphasis: { focus: "series" } },
      ...hbmOverlaySeries,
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

renderHbm();
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

  console.log("\n── HBM prices (memoryindex.io) ──");
  try {
    const { rows: hbm, via } = await withRetries(() => fetchHbm(), {
      attempts: 3,
      delayMs: 2_000,
      label: "memoryindex fetch",
    });
    console.log(`  Parsed via ${via === "api" ? "官方 API 样例 CSV" : via === "table" ? "主价格表" : "顶部滚动条（回退）"}`);
    if (hbm.length > 0) {
      const rows = hbm.map((r) => ({ date: TODAY, source: "memoryindex", ...r }));
      const savedHbm = saveHbmCSV(rows);
      console.log(
        `  HBM items: ${hbm
          .map(
            (r) =>
              r.item +
              " $" +
              r.price_usd +
              " ($" +
              r.price_per_gb +
              "/GB" +
              (r.source_label ? ", 来源: " + r.source_label + " " + (r.as_of || "") : "") +
              ")"
          )
          .join("; ")}`
      );
      const flagged = loadHbmRows().filter((r) => r.flag === BREAK_FLAG);
      if (flagged.length > 0) {
        console.warn(
          `  ⚠ 检测到 ${flagged.length} 条口径断点（相邻日价格突变 >${BREAK_RATIO}x，已标记不参与连线/日环比）: ` +
            flagged.map((r) => `${r.date} ${r.item} $${r.price_usd}`).join(", ")
        );
      }
      console.log(
        savedHbm.addedRows > 0
          ? `  Saved ${savedHbm.addedRows} new HBM rows → ${savedHbm.filePath}`
          : `  No new HBM rows → ${savedHbm.filePath}`
      );
    } else {
      console.log("  No HBM items parsed");
    }
  } catch (e) {
    console.warn(`  HBM fetch failed (non-fatal): ${e.message}`);
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

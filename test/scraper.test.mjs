import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  saveCSV,
  withRetries,
  parseCsv,
  buildDailyRows,
  parseTrendforceWafer,
  parseDramexchangeWafer,
  saveNandCSV,
  loadNandRows,
} from "../scraper.mjs";

test("parseCsv maps header to object keys", () => {
  const text = "date,ram_type,form_factor,avg_price_per_gb,min_price_per_gb,max_price_per_gb,product_count\n2026-08-16,DDR5,DIMM,15.12,13.44,18.00,195";
  const rows = parseCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-08-16");
  assert.equal(rows[0].ram_type, "DDR5");
  assert.equal(rows[0].avg_price_per_gb, "15.12");
});

test("buildDailyRows extracts DDR4/DDR5 desktop DIMM rows", () => {
  const csv = [
    "date,ram_type,form_factor,avg_price_per_gb,min_price_per_gb,max_price_per_gb,product_count",
    "2026-08-16,DDR4,DIMM,7.66,6.87,8.50,97",
    "2026-08-16,DDR5,DIMM,15.12,13.44,18.00,195",
    "2026-08-16,DDR4,SODIMM,6.87,6.00,7.50,79",
    "2026-08-16,DDR5,SODIMM,12.16,10.00,14.00,80",
  ].join("\n");
  const rows = buildDailyRows(parseCsv(csv));
  // SODIMM rows excluded, only DIMM DDR4/DDR5 kept
  assert.equal(rows.length, 2);
  const ddr4 = rows.find((r) => r.category === "DDR4");
  const ddr5 = rows.find((r) => r.category === "DDR5");
  assert.equal(ddr4.avg_price, 7.66);
  assert.equal(ddr4.sample_count, 97);
  assert.equal(ddr5.avg_price, 15.12);
  assert.equal(ddr5.sample_count, 195);
});

test("withRetries retries failures and returns the successful attempt result", async () => {
  let attempts = 0;
  const retryEvents = [];

  const result = await withRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`fail ${attempts}`);
      return "success";
    },
    {
      attempts: 3,
      delayMs: 0,
      label: "unit-test operation",
      onRetry: (event) => retryEvents.push(event),
    }
  );

  assert.equal(result, "success");
  assert.equal(attempts, 3);
  assert.deepEqual(
    retryEvents.map((event) => [event.attempt, event.maxAttempts, event.error.message]),
    [
      [1, 3, "fail 1"],
      [2, 3, "fail 2"],
    ]
  );
});

test("saveCSV reports how many rows were actually appended", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scraper-"));

  const first = saveCSV(
    "prices.csv",
    [
      { date: "2026-06-25", source: "ramradar", category: "DDR4", avg_price: 7.1, min_price: 6.5, max_price: 8.0, sample_count: 90 },
      { date: "2026-06-25", source: "ramradar", category: "DDR5", avg_price: 14.5, min_price: 13.0, max_price: 16.0, sample_count: 180 },
    ],
    tempDir
  );
  const second = saveCSV(
    "prices.csv",
    [
      { date: "2026-06-25", source: "ramradar", category: "DDR4", avg_price: 7.1, min_price: 6.5, max_price: 8.0, sample_count: 90 },
      { date: "2026-06-26", source: "ramradar", category: "DDR4", avg_price: 7.2, min_price: 6.6, max_price: 8.1, sample_count: 92 },
    ],
    tempDir
  );

  assert.equal(first.addedRows, 2);
  assert.equal(first.skippedRows, 0);
  assert.equal(second.addedRows, 1);
  assert.equal(second.skippedRows, 1);

  const lines = fs.readFileSync(path.join(tempDir, "prices.csv"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 4);
});

// ── NAND wafer spot ──

function waferRow(item, nums, trend) {
  return (
    `<tr><td style="width:auto"><span data-toggle="tooltip">${item}</span></td>` +
    nums.map((n) => `<td class="lcd-num-l">${n}</td>`).join("") +
    `<td class="percent-cell"><span class="${trend}">0.00 %</span></td></tr>`
  );
}

test("parseTrendforceWafer converts USD/die to USD/GB and keeps upstream date", () => {
  const html =
    '<div class="price-block"><h2>Wafer Spot Price</h2>' +
    "<p>Last Update 2026-10-12 14:40 (GMT+8)</p>" +
    '<table class="price-table"><tbody>' +
    "<tr><td>Item</td><td>Weekly High</td></tr>" +
    waferRow("512Gb TLC", ["21.00", "16.80", "21.00", "16.80", "18.833"], "flat-trend") +
    waferRow("256Gb TLC", ["20.00", "16.80", "20.00", "16.80", "18.365"], "up-trend") +
    waferRow("128Gb TLC", ["15.00", "8.00", "15.00", "8.00", "9.967"], "down-trend") +
    "</tbody></table></div>";

  const { rows, upstream_updated, via } = parseTrendforceWafer(html);
  assert.equal(via, "trendforce");
  assert.equal(upstream_updated, "2026-10-12 14:40");
  assert.equal(rows.length, 3);

  const big = rows.find((r) => r.item === "NAND-512Gb-TLC");
  assert.equal(big.capacity_gb, 64);
  assert.equal(big.price_usd, 18.833);
  assert.equal(big.price_per_gb, 0.29);
  assert.equal(big.unit, "USD / die");
  assert.equal(big.change_dir, "flat");

  assert.equal(rows.find((r) => r.item === "NAND-256Gb-TLC").price_per_gb, 0.57);
  assert.equal(rows.find((r) => r.item === "NAND-128Gb-TLC").change_dir, "down");
});

test("parseDramexchangeWafer works as fallback with its own markup", () => {
  const html =
    '<div class="tab_title">Wafer Spot Price Last Update:Oct.12 2026 14:40 (GMT+8)</div>' +
    "<table><tbody><tr>" +
    '<td class="tab_tr_gray2"><a href="/Price/Wafer_Spot">512Gb TLC</a></td>' +
    '<td class="tab_tr_gray">21.00</td><td class="tab_tr_gray">16.80</td>' +
    '<td class="tab_tr_gray">21.00</td><td class="tab_tr_gray">16.80</td>' +
    '<td class="tab_tr_gray">18.833</td>' +
    '<td class="tab_tr_font9"><img src="stable.gif"><br> 0.00 %</td>' +
    "</tr></tbody></table>";

  const { rows, via } = parseDramexchangeWafer(html);
  assert.equal(via, "dramexchange");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, "NAND-512Gb-TLC");
  assert.equal(rows[0].price_usd, 18.833);
});

test("saveNandCSV dedupes by date+item and preserves history", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nand-scraper-"));
  const day1 = [
    { date: "2026-10-19", source: "trendforce", item: "NAND-512Gb-TLC", capacity_gb: 64, price_usd: 18.833, price_per_gb: 0.29, unit: "USD / die", change_pct: 0, upstream_updated: "2026-10-12 14:40" },
  ];
  const first = saveNandCSV(day1, tempDir);
  const second = saveNandCSV(
    [...day1, { ...day1[0], date: "2026-10-20" }],
    tempDir
  );

  assert.equal(first.addedRows, 1);
  assert.equal(second.addedRows, 1);

  const rows = loadNandRows(tempDir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price_usd, 18.833);
  assert.equal(rows[0].upstream_updated, "2026-10-12 14:40");
  assert.equal(rows[1].date, "2026-10-20");
});

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

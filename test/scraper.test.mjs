import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  navigateToZOL,
  saveCSV,
  withRetries,
} from "../scraper.mjs";

test("navigateToZOL waits for DOM content and price elements instead of network idle", async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options]);
      return { status: () => 200 };
    },
    async waitForSelector(selector, options) {
      calls.push(["waitForSelector", selector, options]);
    },
    async waitForTimeout(ms) {
      calls.push(["waitForTimeout", ms]);
    },
  };

  await navigateToZOL(page);

  assert.equal(calls[0][0], "goto");
  assert.equal(calls[0][1], "https://detail.zol.com.cn/memory/");
  assert.equal(calls[0][2].waitUntil, "domcontentloaded");
  assert.equal(calls[0][2].timeout, 45_000);
  assert.equal(calls[1][0], "waitForSelector");
  assert.equal(calls[1][1], "[class*=price]");
  assert.equal(calls[1][2].timeout, 15_000);
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

  const first = saveCSV("prices.csv", [
    { date: "2026-06-25", source: "zol", category: "DDR4" },
    { date: "2026-06-25", source: "zol", category: "DDR5" },
  ], tempDir);
  const second = saveCSV("prices.csv", [
    { date: "2026-06-25", source: "zol", category: "DDR4" },
    { date: "2026-06-26", source: "zol", category: "DDR4" },
  ], tempDir);

  assert.equal(first.addedRows, 2);
  assert.equal(first.skippedRows, 0);
  assert.equal(second.addedRows, 1);
  assert.equal(second.skippedRows, 1);

  const lines = fs.readFileSync(path.join(tempDir, "prices.csv"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 4);
});

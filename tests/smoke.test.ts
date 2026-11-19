import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rogerio-desk-"));
const app = await createApp({
  ...process.env,
  PORT: "0",
  SQLITE_PATH: path.join(dir, "desk.sqlite"),
  FINANCAS_DIR: path.join(dir, "financas"),
});

afterAll(async () => {
  await app.stop();
});

it("permanece no ar com preço público e batimento dos agentes", async () => {
  const started = Date.now();
  let health: any = null;
  while (Date.now() - started < 90_000) {
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    health = await response.json();
    if (health?.feeds?.BTCUSDT && health.feeds.BTCUSDT.tickerStale === false && health.feeds.BTCUSDT.tickerAgeMs < 20_000) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  expect(health.ok).toBe(true);
  expect(health.timezone).toBe("America/Sao_Paulo");
  expect(health.feeds.BTCUSDT.tickerStale).toBe(false);

  const klines = await fetch(`http://127.0.0.1:${app.port}/api/klines?symbol=BTCUSDT&interval=1h`);
  const candles = await klines.json();
  expect(candles.bars.length).toBeGreaterThan(50);

  const state = await fetch(`http://127.0.0.1:${app.port}/api/state`);
  const body = await state.json();
  const btc = body.tickers.find((ticker: { symbol: string }) => ticker.symbol === "BTCUSDT");
  expect(btc.price).toBeGreaterThan(1000);
  expect(btc.quoteVolume).toBeGreaterThan(0);
  expect(body.autoTrade).toBe(true);
  expect(body.layout).toBe("desk");

  while (Date.now() - started < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const later = await (await fetch(`http://127.0.0.1:${app.port}/health`)).json();
  expect(later.ok).toBe(true);
  expect(later.uptimeSec).toBeGreaterThan(60);
  expect(later.agents.every((agent: { lastHeartbeat: number | null }) => agent.lastHeartbeat)).toBe(true);
  expect(fs.existsSync(path.join(dir, "financas", "desk_signals.md"))).toBe(true);
}, 180_000);

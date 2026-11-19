import path from "node:path";
import { loadConfig } from "./config.js";
import { DeskDb } from "./db.js";
import { Bus } from "./bus.js";
import { Logger } from "./log.js";
import { listenHttp } from "./http.js";
import { MarketHub } from "./market/hub.js";
import { createMemory, startAgents } from "./services/agents.js";
import { AlertCenter } from "./services/alerts.js";
import { CopyDesk } from "./services/copyDesk.js";
import { Simulator } from "./services/simulator.js";
import type { StateSources } from "./state.js";
import type { ActivityTag } from "./shared/types.js";

export interface RunningApp {
  port: number;
  stop: () => Promise<void>;
}

export async function createApp(env: NodeJS.ProcessEnv = process.env): Promise<RunningApp> {
  const config = loadConfig(env);
  const db = new DeskDb(config.sqlitePath);
  db.autoTradeDefault = !config.autoTradePausedDefault;
  db.migrate();
  db.prune(Date.now());
  const log = new Logger(db);
  const memory = createMemory(db);
  const alerts = new AlertCenter(db, log, config);
  const market = new MarketHub(config, db, log);
  const sim = new Simulator(db, market, alerts);
  sim.load();
  for (const [key, signal] of [...memory.active]) {
    if (!sim.trades.some((trade) => trade.signalId === signal.id && trade.status === "open")) {
      memory.active.delete(key);
      db.expireSignal(signal.id, "sem posição aberta ao iniciar");
    }
  }
  const dedupe = new Map<string, number>();
  const activity = (tag: ActivityTag, text: string, symbol?: string | null, cooldownMs = 0) => {
    const key = `${tag}|${text}`;
    const now = Date.now();
    if (cooldownMs && now - (dedupe.get(key) ?? 0) < cooldownMs) return;
    dedupe.set(key, now);
    const line = { id: crypto.randomUUID(), ts: now, tag, text, symbol: symbol ?? null };
    db.insertActivity(line);
    memory.activity.unshift(line);
    if (memory.activity.length > 120) memory.activity.pop();
  };
  sim.bindActivity((tag, text, symbol) => activity(tag, text, symbol));
  market.onStale = (symbol) => {
    alerts.push({
      kind: "data_failure",
      level: "critical",
      title: `Feed defasado: ${symbol}`,
      body: "A cotação pública deixou de atualizar. A mesa não trata dado velho como ao vivo.",
      symbol,
      dedupeKey: `stale:${symbol}`,
      cooldownMs: 60_000,
    });
    activity("SCAN", `${symbol}: DADOS INDISPONÍVEIS. Feed sem atualização recente.`, symbol, 60_000);
  };
  market.onRecovered = (symbol) => {
    activity("SCAN", `${symbol}: feed público restabelecido.`, symbol, 30_000);
  };
  const copy = new CopyDesk(config, db, market, sim, log);
  copy.load();
  copy.start();
  const bootAt = Date.now();
  const agents = startAgents({ config, db, bus: new Bus(), log, market, memory, alerts, sim, activity });
  const sources: StateSources = {
    config,
    db,
    market,
    memory,
    sim,
    copy,
    alerts,
    bootAt,
    agentViews: () => agents.views(sim.contributions()),
  };
  const httpServer = await listenHttp({
    port: config.port,
    host: config.host,
    sources,
    db,
    market,
    memory,
    sim,
    copy,
    publicDir: path.resolve("dist/public"),
    accessToken: config.accessToken,
    accessTokenSha256: config.accessTokenSha256,
    onAutoTrade: (enabled) => {
      activity("EXEC", enabled ? "Simulação automática ligada." : "Simulação automática pausada. Nenhuma entrada nova.", null);
      if (!enabled) return;
      for (const [key, signal] of [...memory.active]) {
        if (!sim.trades.some((trade) => trade.signalId === signal.id)) {
          memory.active.delete(key);
          db.expireSignal(signal.id, "reavaliado ao retomar o play");
        }
      }
    },
  });
  await market.start(db.listWatchlist());
  const simTimer = setInterval(() => sim.tick(), 1000);
  log.info("mesa", `http://${config.host}:${httpServer.port}`);
  return {
    port: httpServer.port,
    stop: async () => {
      clearInterval(simTimer);
      agents.stop();
      copy.stop();
      await market.stop();
      await httpServer.close();
      db.close();
    },
  };
}

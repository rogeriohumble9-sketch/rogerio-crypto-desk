import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { DeskDb } from "../db.js";
import { buildFrame, frameToCell, type FrameSnapshot } from "../domain/analyze.js";
import { classifyText } from "../domain/news.js";
import { reviewSignal, usdLimit } from "../domain/risk.js";
import { riskReward, buildSignal, type SignalDraft } from "../domain/signals.js";
import { bulletLines, manualBlock, readNote, writeDeskFile } from "../financas.js";
import type { MarketHub } from "../market/hub.js";
import { parseFeed } from "../rss.js";
import { formatBrt } from "../shared/time.js";
import {
  CORE_SYMBOLS,
  INTERVALS,
  type AgentHealth,
  type AgentId,
  type AgentView,
  type NewsView,
  type ReadingView,
  type Regime,
  type SignalView,
  type Style,
} from "../shared/types.js";
import type { AlertCenter } from "./alerts.js";
import type { Simulator } from "./simulator.js";
import type { ActivityTag } from "../shared/types.js";
import type { Logger } from "../log.js";
import type { Bus } from "../bus.js";

export const AGENT_META: Record<AgentId, { name: string; role: string; intervalMs: number }> = {
  market: { name: "Analista de Mercado", role: "Regime, volume e dominância", intervalMs: 30_000 },
  technical: { name: "Analista Técnico", role: "RSI, MACD, médias, Bollinger e ATR", intervalMs: 20_000 },
  news: { name: "Analista de Notícias", role: "RSS, macro e arquivos da mesa", intervalMs: 180_000 },
  signal: { name: "Analista de Sinais", role: "Scalping e swing com confluência", intervalMs: 20_000 },
  risk: { name: "Gestor de Risco", role: "R:R, tamanho e bloqueio da sessão", intervalMs: 15_000 },
};

const FEEDS: [string, string][] = [
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"],
  ["BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"],
];

export interface Memory {
  frames: Map<string, Map<string, FrameSnapshot | null>>;
  technical: import("../shared/types.js").DashboardState["technical"];
  regime: Regime;
  dominance: number | null;
  dominanceAt: number | null;
  marketCap: number | null;
  dominanceError: string | null;
  quoteVolume: number | null;
  avgAtrPct: number | null;
  extremeVol: boolean;
  comment: string;
  marketAt: number | null;
  readings: ReadingView[];
  active: Map<string, SignalView>;
  signals: SignalView[];
  news: NewsView[];
  whales: import("../shared/types.js").FileNote | null;
  riskNotes: import("../shared/types.js").FileNote | null;
  whaleStamp: number;
  activity: import("../shared/types.js").ActivityLine[];
}

export function createMemory(db: DeskDb): Memory {
  const signals = db.recentSignals(100);
  const now = Date.now();
  const active = new Map<string, SignalView>();
  for (const signal of signals) {
    if (signal.status === "approved" && signal.validUntil && signal.validUntil > now) {
      active.set(`${signal.symbol}|${signal.style}`, signal);
    }
  }
  return {
    frames: new Map(),
    technical: {},
    regime: "indisponivel",
    dominance: null,
    dominanceAt: null,
    marketCap: null,
    dominanceError: null,
    quoteVolume: null,
    avgAtrPct: null,
    extremeVol: false,
    comment: "Aguardando candles públicos.",
    marketAt: null,
    readings: [],
    active,
    signals,
    news: db.recentNews(60),
    whales: null,
    riskNotes: null,
    whaleStamp: 0,
    activity: db.recentActivity(80),
  };
}

export interface DeskHandlers {
  config: AppConfig;
  db: DeskDb;
  bus: Bus;
  log: Logger;
  market: MarketHub;
  memory: Memory;
  alerts: AlertCenter;
  sim: Simulator;
  activity: (tag: ActivityTag, text: string, symbol?: string | null, dedupeMs?: number) => void;
}

interface Proposed {
  id: string;
  symbol: string;
  createdAt: number;
  draft: SignalDraft;
  contributors: AgentId[];
}

interface Beat {
  status: AgentHealth;
  last: number | null;
  message: string;
  restarts: number;
}

export function startAgents(ctx: DeskHandlers): { stop: () => void; views: (contributions: Record<AgentId, number | null>) => AgentView[] } {
  const beats = new Map<AgentId, Beat>();
  let running = true;
  const rejectSeen = new Map<string, number>();

  ctx.bus.on("signal:proposed", async (payload) => {
    await onProposed(ctx, payload as Proposed, rejectSeen);
  });
  ctx.bus.on("signal:approved", async (payload) => {
    const body = payload as { signal: SignalView; size: import("../domain/risk.js").SizeResult; contributors: string[] };
    if (!ctx.db.getAutoTrade()) {
      ctx.activity("EXEC", `${body.signal.symbol} aprovado com a mesa em pausa. Nenhuma ordem foi aberta.`, body.signal.symbol);
      return;
    }
    ctx.sim.openFromSignal(body.signal, body.size, body.contributors);
  });

  const jobs: { id: AgentId; run: () => Promise<string> }[] = [
    { id: "market", run: () => runMarket(ctx) },
    { id: "technical", run: () => runTechnical(ctx) },
    { id: "news", run: () => runNews(ctx) },
    { id: "signal", run: () => runSignals(ctx) },
    { id: "risk", run: () => runRisk(ctx) },
  ];
  for (const job of jobs) {
    beats.set(job.id, { status: "starting", last: null, message: "iniciando", restarts: 0 });
    void loop(job);
  }

  async function loop(job: { id: AgentId; run: () => Promise<string> }): Promise<void> {
    const interval = AGENT_META[job.id].intervalMs;
    while (running) {
      const started = Date.now();
      try {
        const message = await job.run();
        const beat = beats.get(job.id)!;
        beat.status = "healthy";
        beat.last = Date.now();
        beat.message = message;
      } catch (error) {
        const beat = beats.get(job.id)!;
        beat.status = "unhealthy";
        beat.last = Date.now();
        beat.message = error instanceof Error ? error.message : "falha no ciclo";
        beat.restarts += 1;
        ctx.log.error(job.id, beat.message);
        await sleep(2_000);
      }
      await sleep(Math.max(500, interval - (Date.now() - started)));
    }
  }

  return {
    stop() {
      running = false;
    },
    views(contributions) {
      const now = Date.now();
      return (Object.keys(AGENT_META) as AgentId[]).map((id) => {
        const beat = beats.get(id)!;
        const meta = AGENT_META[id];
        let status = beat.status;
        if (beat.last && now - beat.last > meta.intervalMs * 4) status = "unhealthy";
        return {
          id,
          name: meta.name,
          role: meta.role,
          status,
          lastHeartbeat: beat.last,
          ageMs: beat.last ? now - beat.last : null,
          message: beat.message,
          restarts: beat.restarts,
          contributionUsd: contributions[id],
        };
      });
    },
  };
}

async function runMarket(ctx: DeskHandlers): Promise<string> {
  const stale = ctx.market.isTickerStale("BTCUSDT") || ctx.market.isKlineStale("BTCUSDT", "4h");
  const frame = stale ? null : buildFrame(ctx.market.getCandles("BTCUSDT", "4h"), "4h", false);
  let regime: Regime = "indisponivel";
  if (frame?.ema9 != null && frame.ema21 != null && frame.ema50 != null) {
    if (frame.ema9 > frame.ema21 && frame.ema21 > frame.ema50 && frame.close > frame.ema50 && frame.structure !== "baixa") regime = "alta";
    else if (frame.ema9 < frame.ema21 && frame.ema21 < frame.ema50 && frame.close < frame.ema50 && frame.structure !== "alta") regime = "baixa";
    else regime = "lateral";
  }
  if (ctx.memory.regime !== regime) {
    if (ctx.memory.regime !== "indisponivel" && regime !== "indisponivel") {
      ctx.alerts.push({
        kind: "trend_change",
        level: "info",
        title: `Regime ${regime}`,
        body: `O BTC saiu de ${ctx.memory.regime} para ${regime} no 4h.`,
        symbol: "BTCUSDT",
        dedupeKey: `regime:${regime}`,
        cooldownMs: 10 * 60_000,
      });
      ctx.activity("SCAN", `Regime do BTC mudou para ${regime}.`, "BTCUSDT");
    }
    ctx.db.insertRegime(Date.now(), regime);
    ctx.memory.regime = regime;
  }
  if (!ctx.memory.dominanceAt || Date.now() - ctx.memory.dominanceAt > 120_000) {
    try {
      const response = await fetch(ctx.config.coingeckoUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json", "user-agent": "RogerioCryptoTradingDesk/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data?: { market_cap_percentage?: { btc?: number }; total_market_cap?: { usd?: number } } };
      const btc = body.data?.market_cap_percentage?.btc;
      if (typeof btc !== "number") throw new Error("dominância ausente");
      ctx.memory.dominance = btc;
      ctx.memory.marketCap = body.data?.total_market_cap?.usd ?? null;
      ctx.memory.dominanceAt = Date.now();
      ctx.memory.dominanceError = null;
    } catch (error) {
      ctx.memory.dominanceError = error instanceof Error ? error.message : "falha";
    }
  }
  let volume = 0;
  let volumeOk = false;
  for (const symbol of ctx.market.listSymbols()) {
    const ticker = ctx.market.tickers.get(symbol);
    if (ticker && !ctx.market.isTickerStale(symbol)) {
      volume += ticker.quoteVolume;
      volumeOk = true;
    }
  }
  ctx.memory.quoteVolume = volumeOk ? volume : null;
  const atrs: number[] = [];
  for (const symbol of CORE_SYMBOLS) {
    const cell = ctx.memory.technical[symbol]?.["1h"];
    if (cell && !cell.stale && cell.atrPct != null) atrs.push(cell.atrPct);
  }
  ctx.memory.avgAtrPct = atrs.length ? atrs.reduce((a, b) => a + b, 0) / atrs.length : null;
  const threshold = ctx.db.getSettings().extremeVolAtrPct;
  const extreme = atrs.some((value) => value >= threshold);
  if (extreme && !ctx.memory.extremeVol) {
    ctx.alerts.push({
      kind: "extreme_vol",
      level: "warning",
      title: "Volatilidade extrema",
      body: `ATR de 1h acima de ${threshold}% em algum ativo do núcleo.`,
      dedupeKey: "extreme-vol",
      cooldownMs: 30 * 60_000,
    });
    ctx.activity("RISK", `Volatilidade extrema: ATR 1h acima de ${threshold}%.`, null);
  }
  ctx.memory.extremeVol = extreme;
  const dominance =
    ctx.memory.dominance == null
      ? "Dominância do BTC indisponível."
      : `Dominância do BTC ${ctx.memory.dominance.toFixed(1)}% (CoinGecko, ${formatBrt(ctx.memory.dominanceAt ?? Date.now())}).`;
  const volText = ctx.memory.quoteVolume == null ? "Volume agregado indisponível." : `Volume 24h agregado US$ ${(ctx.memory.quoteVolume / 1e9).toFixed(2)} bi.`;
  const atrText = ctx.memory.avgAtrPct == null ? "ATR médio indisponível." : `ATR médio de 1h ${ctx.memory.avgAtrPct.toFixed(2)}%.`;
  ctx.memory.comment = `Regime ${regime}. ${dominance} ${volText} ${atrText}`;
  ctx.memory.marketAt = Date.now();
  ctx.activity("SCAN", ctx.memory.comment, "BTCUSDT", 60_000);
  return `regime ${regime}`;
}

async function runTechnical(ctx: DeskHandlers): Promise<string> {
  let ready = 0;
  for (const symbol of ctx.market.listSymbols()) {
    const row: Memory["technical"][string] = {};
    let frames = ctx.memory.frames.get(symbol);
    if (!frames) {
      frames = new Map();
      ctx.memory.frames.set(symbol, frames);
    }
    for (const interval of INTERVALS) {
      const stale = ctx.market.isTickerStale(symbol) || ctx.market.isKlineStale(symbol, interval);
      const candles = ctx.market.getCandles(symbol, interval);
      const frame = buildFrame(candles, interval, stale);
      frames.set(interval, frame);
      row[interval] = frameToCell(frame, interval, stale, stale || !frame ? "DADOS INDISPONÍVEIS" : "leitura atual");
      if (!stale && frame) ready += 1;
    }
    ctx.memory.technical[symbol] = row;
  }
  ctx.activity("SCAN", `Indicadores recalculados. Séries frescas: ${ready}.`, null, 60_000);
  return `${ready} séries frescas`;
}

async function runNews(ctx: DeskHandlers): Promise<string> {
  let inserted = 0;
  const errors: string[] = [];
  for (const [source, url] of FEEDS) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/rss+xml, application/xml, text/xml, */*", "user-agent": "RogerioCryptoTradingDesk/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseFeed(await response.text()).slice(0, 15);
      for (const item of items) {
        const cls = classifyText(item.title, item.summary);
        const news: NewsView = {
          id: createHash("sha1").update(`${source}|${item.title}`).digest("hex").slice(0, 16),
          ts: item.ts ?? Date.now(),
          source,
          title: item.title,
          link: item.link,
          summary: item.summary,
          sentiment: cls.sentiment,
          relevance: cls.relevance,
          confirmation: cls.confirmation,
          heuristic: true,
        };
        const isNew = ctx.db.upsertNews(news);
        if (!isNew) continue;
        inserted += 1;
        ctx.memory.news.unshift(news);
        const fresh = item.ts != null && Date.now() - item.ts < 6 * 60 * 60_000;
        if (fresh && news.relevance === "alta" && news.sentiment !== "neutro") {
          ctx.alerts.push({
            kind: "news",
            level: news.sentiment === "negativo" ? "warning" : "info",
            title: news.title,
            body: `${source} · ${news.sentiment} · ${news.confirmation} · classificação heurística`,
            dedupeKey: `news:${news.id}`,
            cooldownMs: 1,
          });
          ctx.activity("NEWS", `${source}: ${news.title}`, null);
        }
      }
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : "falha"}`);
    }
  }
  ctx.memory.news = ctx.memory.news.slice(0, 80);
  const newsFile = readNote(ctx.config.financasDir, "3_news.md");
  const whales = readNote(ctx.config.financasDir, "2_whales.md");
  const riskNotes = readNote(ctx.config.financasDir, "5_risk.md");
  ctx.memory.whales = whales;
  ctx.memory.riskNotes = riskNotes;
  if (newsFile && !newsFile.missing) {
    for (const line of bulletLines(newsFile.content)) {
      const cls = classifyText(line, "");
      const item: NewsView = {
        id: createHash("sha1").update(`3_news|${line}`).digest("hex").slice(0, 16),
        ts: newsFile.updatedAt || Date.now(),
        source: "Arquivo 3_news.md",
        title: line.slice(0, 180),
        link: null,
        summary: "Trecho do relatório externo. Classificação heurística.",
        sentiment: cls.sentiment,
        relevance: cls.relevance,
        confirmation: cls.confirmation,
        heuristic: true,
      };
      if (ctx.db.upsertNews(item)) {
        inserted += 1;
        ctx.memory.news.unshift(item);
      }
    }
  }
  if (whales && !whales.missing && whales.updatedAt !== ctx.memory.whaleStamp) {
    ctx.memory.whaleStamp = whales.updatedAt;
    ctx.activity("WHALE", `Arquivo 2_whales.md atualizado (${formatBrt(whales.updatedAt)}).`, null);
  } else if (ctx.config.financasDir && whales?.missing) {
    ctx.activity("WHALE", "2_whales.md ausente em FINANCAS_DIR.", null, 6 * 60 * 60_000);
  }
  if (errors.length) ctx.log.warn("news", errors.join(" | "));
  return inserted ? `${inserted} notícias novas` : "sem novidade";
}

async function runSignals(ctx: DeskHandlers): Promise<string> {
  const now = Date.now();
  for (const [key, signal] of ctx.memory.active) {
    if (signal.validUntil && signal.validUntil < now && !ctx.sim.trades.some((trade) => trade.signalId === signal.id && trade.status === "open")) {
      ctx.memory.active.delete(key);
      ctx.db.expireSignal(signal.id, "validade esgotada");
    }
  }
  const readings: ReadingView[] = [];
  let proposed = 0;
  for (const symbol of ctx.market.listSymbols()) {
    for (const style of ["SCALPING", "SWING"] as Style[]) {
      const plan = style === "SCALPING" ? { primary: "5m" as const, confirm: "15m" as const } : { primary: "4h" as const, confirm: "1d" as const };
      const frames = ctx.memory.frames.get(symbol);
      const draft = buildSignal({
        style,
        primary: frames?.get(plan.primary) ?? null,
        confirm: frames?.get(plan.confirm) ?? null,
        regime: ctx.memory.regime,
        tickerStale: ctx.market.isTickerStale(symbol),
      });
      readings.push({
        symbol,
        style,
        direction: draft.direction,
        confidence: draft.confidence,
        score: draft.score,
        maxScore: draft.maxScore,
        timeframe: draft.timeframe,
        justification: draft.justification,
        criteria: draft.criteria,
        entry: draft.entry,
        stopLoss: draft.stopLoss,
        takeProfit1: draft.takeProfit1,
        takeProfit2: draft.takeProfit2,
        rr: draft.rr,
        price: ctx.market.price(symbol),
        updatedAt: now,
        tradable: draft.tradable,
      });
      if (!draft.tradable || (draft.direction !== "BUY" && draft.direction !== "SELL")) continue;
      const key = `${symbol}|${style}`;
      const existing = ctx.memory.active.get(key);
      if (existing && existing.direction === draft.direction && existing.validUntil && existing.validUntil > now) continue;
      const contributors = contributorsFor(ctx, symbol, draft.direction);
      proposed += 1;
      await ctx.bus.emit("signal:proposed", {
        id: crypto.randomUUID(),
        symbol,
        createdAt: now,
        draft,
        contributors,
      } satisfies Proposed);
    }
  }
  ctx.memory.readings = readings;
  writeReports(ctx);
  return `${readings.filter((item) => item.tradable).length} leituras operáveis, ${proposed} propostas`;
}

async function runRisk(ctx: DeskHandlers): Promise<string> {
  const account = ctx.sim.view();
  if (manualBlock(ctx.memory.riskNotes)) {
    ctx.activity("RISK", "Arquivo 5_risk.md pede MESA: BLOQUEAR.", null, 10 * 60_000);
  }
  if (account.blocked && account.blockReason) return account.blockReason;
  const risk = account.liveRiskUsd == null ? "patrimônio indisponível" : `risco por trade agora US$ ${account.liveRiskUsd.toFixed(2)}`;
  return `sessão ${account.sessionDate}. ${risk}. perda diária US$ ${account.dailyLossLimitUsd.toFixed(2)}, meta US$ ${account.dailyTargetUsd.toFixed(2)}`;
}

async function onProposed(ctx: DeskHandlers, proposed: Proposed, rejectSeen: Map<string, number>): Promise<void> {
  const { draft, symbol } = proposed;
  const settings = ctx.db.getSettings();
  const account = ctx.sim.view();
  let entry = draft.entry;
  let stop = draft.stopLoss;
  let tp1 = draft.takeProfit1;
  let rr = draft.rr;
  const ticker = ctx.market.tickers.get(symbol);
  const stale = ctx.market.isTickerStale(symbol) || draft.direction === "DATA_UNAVAILABLE";
  if (!stale && ticker && entry && stop && tp1 && (draft.direction === "BUY" || draft.direction === "SELL")) {
    const drift = Math.abs(ticker.price - entry) / entry;
    if (drift > 0.004) {
      rememberReject(ctx, proposed, "preço ao vivo afastou do candle de entrada", rejectSeen);
      return;
    }
    entry = ticker.price;
    rr = riskReward(entry, stop, tp1);
  }
  const cooldownMs = draft.style === "SCALPING" ? 10 * 60_000 : 60 * 60_000;
  const lastExit = ctx.sim.lastExit.get(`${symbol}|${draft.style}`) ?? 0;
  if (Date.now() - lastExit < cooldownMs) {
    rememberReject(ctx, proposed, "pausa após a última saída neste ativo e estilo", rejectSeen);
    return;
  }
  if (manualBlock(ctx.memory.riskNotes)) {
    rememberReject(ctx, proposed, "bloqueio manual no arquivo 5_risk.md", rejectSeen);
    return;
  }
  const decision = reviewSignal({
    direction: draft.direction,
    entry,
    stop,
    takeProfit1: tp1,
    rr,
    dataStale: stale,
    duplicate: ctx.sim.hasSymbol(symbol) || ctx.memory.active.has(`${symbol}|${draft.style}`),
    extremeVol: ctx.memory.extremeVol,
    sessionBlocked: account.blocked === "loss" || account.blocked === "profit" ? account.blocked : null,
    sessionLossStreak: account.sessionLossStreak,
    openPositions: account.openPositions,
    openRiskPct: account.openRiskPct,
    settings,
    equity: account.equity ?? settings.initialCapital,
    freeCash: ctx.sim.freeCash(),
  });
  if (!decision.ok) {
    rememberReject(ctx, proposed, decision.reason, rejectSeen);
    return;
  }
  if (decision.size.riskAmount > usdLimit({ ...settings, initialCapital: account.equity ?? settings.initialCapital }, "risk") + 0.05) {
    rememberReject(ctx, proposed, "tamanho acima do risco percentual configurado", rejectSeen);
    return;
  }
  const signal: SignalView = {
    id: proposed.id,
    symbol,
    style: draft.style,
    direction: draft.direction,
    status: "approved",
    price: ticker?.price ?? entry,
    entry,
    stopLoss: stop,
    takeProfit1: tp1,
    takeProfit2: draft.takeProfit2,
    timeframe: draft.timeframe,
    rr,
    confidence: draft.confidence,
    score: draft.score,
    criteria: draft.criteria,
    justification: draft.justification,
    createdAt: proposed.createdAt,
    validUntil: proposed.createdAt + draft.validForMs,
    rejectReason: null,
  };
  ctx.db.insertSignal(signal);
  ctx.memory.signals.unshift(signal);
  ctx.memory.signals = ctx.memory.signals.slice(0, 120);
  ctx.memory.active.set(`${symbol}|${draft.style}`, signal);
  const previous = [...ctx.memory.active.values()].find((item) => item.symbol === symbol && item.style === draft.style && item.id !== signal.id);
  if (previous) ctx.db.expireSignal(previous.id, "substituído por sinal novo");
  await ctx.bus.emit("signal:approved", { signal, size: decision.size, contributors: proposed.contributors });
}

function rememberReject(ctx: DeskHandlers, proposed: Proposed, reason: string, seen: Map<string, number>): void {
  const key = `${proposed.symbol}|${proposed.draft.style}|${reason}`;
  const now = Date.now();
  if (now - (seen.get(key) ?? 0) < 15 * 60_000) return;
  seen.set(key, now);
  const draft = proposed.draft;
  const signal: SignalView = {
    id: proposed.id,
    symbol: proposed.symbol,
    style: draft.style,
    direction: draft.direction,
    status: "rejected",
    price: draft.price,
    entry: draft.entry,
    stopLoss: draft.stopLoss,
    takeProfit1: draft.takeProfit1,
    takeProfit2: draft.takeProfit2,
    timeframe: draft.timeframe,
    rr: draft.rr,
    confidence: draft.confidence,
    score: draft.score,
    criteria: draft.criteria,
    justification: draft.justification,
    createdAt: proposed.createdAt,
    validUntil: null,
    rejectReason: reason,
  };
  ctx.db.insertSignal(signal);
  ctx.memory.signals.unshift(signal);
  ctx.memory.signals = ctx.memory.signals.slice(0, 120);
  ctx.activity("RISK", `${proposed.symbol} ${draft.style} recusado: ${reason}`, proposed.symbol, 15 * 60_000);
}

function contributorsFor(ctx: DeskHandlers, symbol: string, direction: "BUY" | "SELL"): AgentId[] {
  const ids: AgentId[] = ["technical", "signal", "risk"];
  if (
    (direction === "BUY" && ctx.memory.regime !== "baixa" && ctx.memory.regime !== "indisponivel") ||
    (direction === "SELL" && ctx.memory.regime !== "alta" && ctx.memory.regime !== "indisponivel")
  ) {
    ids.unshift("market");
  }
  const aligned = ctx.memory.news.find((item) => {
    const text = `${item.title} ${item.summary}`.toUpperCase();
    const mentions = text.includes(symbol.replace("USDT", "")) || text.includes("BITCOIN") || text.includes("CRYPTO");
    if (!mentions || item.relevance === "baixa") return false;
    return direction === "BUY" ? item.sentiment === "positivo" : item.sentiment === "negativo";
  });
  if (aligned) ids.push("news");
  return ids;
}

function writeReports(ctx: DeskHandlers): void {
  if (!ctx.config.financasDir) return;
  const now = Date.now();
  const lines = [
    "# Sinais da mesa",
    "",
    `Atualizado em ${formatBrt(now)}.`,
    "",
    "Análise e simulação. Nenhuma ordem real é enviada.",
    "",
    "## Leituras",
  ];
  if (!ctx.memory.readings.length) lines.push("- Sem leitura neste ciclo.");
  for (const reading of ctx.memory.readings) {
    lines.push(
      `- ${reading.symbol} · ${reading.style} · ${labelDir(reading.direction)} · ${reading.timeframe} · ${reading.justification}`,
    );
  }
  const account = ctx.sim.view(now);
  const sim = [
    "# Simulador da mesa",
    "",
    `Atualizado em ${formatBrt(now)}.`,
    "",
    `- Capital inicial: US$ ${account.initialCapital.toFixed(2)}`,
    `- Patrimônio: ${account.equity == null ? "DADOS INDISPONÍVEIS" : `US$ ${account.equity.toFixed(2)}`}`,
    `- Caixa: US$ ${account.cash.toFixed(2)}`,
    `- P&L do dia: ${account.dayPnl == null ? "DADOS INDISPONÍVEIS" : `US$ ${account.dayPnl.toFixed(2)}`}`,
    `- Risco por trade no início: US$ ${account.riskPerTradeUsd.toFixed(2)} (${ctx.db.getSettings().riskPerTradePct}%)`,
    `- Limite de perda diária: US$ ${account.dailyLossLimitUsd.toFixed(2)}`,
    `- Meta diária: US$ ${account.dailyTargetUsd.toFixed(2)}`,
    `- Bloqueio: ${account.blockReason ?? "nenhum"}`,
    "",
    "## Posições",
  ];
  const open = ctx.sim.openTrades();
  if (!open.length) sim.push("- Nenhuma posição simulada aberta.");
  for (const trade of open) {
    sim.push(
      `- ${trade.symbol} ${trade.side} qty ${trade.qtyOpen} entrada ${trade.entryFill} stop ${trade.stopLoss} TP1 ${trade.takeProfit1} TP2 ${trade.takeProfit2}`,
    );
  }
  try {
    writeDeskFile(ctx.config.financasDir, "desk_signals.md", lines.join("\n") + "\n");
    writeDeskFile(ctx.config.financasDir, "desk_simulador.md", sim.join("\n") + "\n");
  } catch (error) {
    ctx.log.warn("financas", error instanceof Error ? error.message : "falha ao gravar");
  }
}

function labelDir(direction: string): string {
  if (direction === "BUY") return "COMPRA";
  if (direction === "SELL") return "VENDA";
  if (direction === "WAIT") return "AGUARDAR";
  return "DADOS INDISPONÍVEIS";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

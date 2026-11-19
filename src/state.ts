import { emaSeries } from "./domain/indicators.js";
import type { MarketHub } from "./market/hub.js";
import type { Memory } from "./services/agents.js";
import type { AlertCenter } from "./services/alerts.js";
import type { CopyDesk } from "./services/copyDesk.js";
import type { Simulator } from "./services/simulator.js";
import { CORE_SYMBOLS, INTERVALS, type AgentView, type BookView, type DashboardState, type HealthReport, type Interval, type KlineResponse, type TradeView } from "./shared/types.js";
import type { DeskDb } from "./db.js";
import type { AppConfig } from "./config.js";
import { unrealizedPnl } from "./domain/simulator.js";

export interface StateSources {
  config: AppConfig;
  db: DeskDb;
  market: MarketHub;
  memory: Memory;
  sim: Simulator;
  copy: CopyDesk;
  alerts: AlertCenter;
  bootAt: number;
  agentViews: () => AgentView[];
}

const SAFETY = "Análise e simulação. Nenhuma ordem real é enviada e nenhuma chave de API é pedida.";

export function buildState(src: StateSources, now = Date.now()): DashboardState {
  const settings = src.db.getSettings();
  const account = src.sim.view(now);
  return {
    now,
    timezone: "America/Sao_Paulo",
    safety: SAFETY,
    market: {
      regime: src.memory.regime,
      btcDominance: src.memory.dominance,
      totalMarketCapUsd: src.memory.marketCap,
      dominanceUpdatedAt: src.memory.dominanceAt,
      dominanceSource: "CoinGecko /global",
      totalQuoteVolume: src.memory.quoteVolume,
      avgAtrPct: src.memory.avgAtrPct,
      extremeVol: src.memory.extremeVol,
      comment: src.memory.comment,
      updatedAt: src.memory.marketAt,
    },
    feeds: {
      wsStatus: src.market.wsStatus,
      restBase: src.market.restBase,
      wsBase: src.market.wsBase,
      usingFallback: src.market.usingFallback,
      staleSymbols: src.market.listSymbols().filter((symbol) => src.market.isTickerStale(symbol, now)),
      lastWsMessageAgeMs: src.market.lastWsMessageAt ? now - src.market.lastWsMessageAt : null,
    },
    tickers: src.market.listSymbols().map((symbol) => {
      const ticker = src.market.tickers.get(symbol);
      const stale = src.market.isTickerStale(symbol, now);
      return {
        symbol,
        price: stale ? null : (ticker?.price ?? null),
        changePct: stale ? null : (ticker?.changePct ?? null),
        sessionChangePct: sessionChange(src.market, symbol, ticker?.price, stale),
        quoteVolume: stale ? null : (ticker?.quoteVolume ?? null),
        high: stale ? null : (ticker?.high ?? null),
        low: stale ? null : (ticker?.low ?? null),
        updatedAt: ticker?.updatedAt ?? null,
        ageMs: ticker ? now - ticker.updatedAt : null,
        stale,
        source: ticker?.source ?? null,
        spark: stale ? [] : (ticker?.spark ?? []),
      };
    }),
    agents: src.agentViews(),
    opportunities: [...src.memory.active.values()]
      .filter((signal) => signal.validUntil != null && signal.validUntil > now)
      .map((signal) => ({ ...signal, price: src.market.price(signal.symbol) })),
    readings: src.memory.readings,
    signals: src.memory.signals.slice(0, 60),
    trades: src.sim.trades.slice(0, 40).map((trade) => toTradeView(src.market, trade)),
    account,
    settings,
    news: src.memory.news.slice(0, 30),
    whales: src.memory.whales,
    riskNotes: src.memory.riskNotes,
    alerts: src.alerts.recent.slice(0, 20),
    watchlist: src.market.listSymbols().filter((symbol) => !CORE_SYMBOLS.includes(symbol as (typeof CORE_SYMBOLS)[number])),
    core: [...CORE_SYMBOLS],
    technical: src.memory.technical,
    logs: src.db.recentLogs(12),
    activity: src.memory.activity.slice(0, 40),
    orders: src.sim.orders.slice(0, 40),
    autoTrade: src.db.getAutoTrade(),
    layout: src.db.getLayout(),
    copy: src.copy.view(now),
    financasDir: src.config.financasDir,
    liveKlines: Object.fromEntries(
      src.market.listSymbols().map((symbol) => {
        const candle = src.market.liveKlines.get(symbol);
        const fresh = candle && !src.market.isKlineStale(symbol, "1m", now) && !src.market.isTickerStale(symbol, now);
        return [symbol, fresh ? candle : null];
      }),
    ),
  };
}

export function buildHealth(src: StateSources, now = Date.now()): HealthReport {
  const feeds = src.market.feedHealth(now);
  const agents = src.agentViews();
  const staleFeeds = Object.entries(feeds)
    .filter(([, feed]) => feed.tickerStale)
    .map(([symbol]) => symbol);
  const ready = CORE_SYMBOLS.some((symbol) => feeds[symbol] && !feeds[symbol].tickerStale);
  return {
    ok: true,
    ready,
    time: now,
    timezone: "America/Sao_Paulo",
    uptimeSec: Math.round((now - src.bootAt) / 1000),
    restBase: src.market.restBase,
    wsBase: src.market.wsBase,
    usingFallback: src.market.usingFallback,
    wsStatus: src.market.wsStatus,
    lastWsMessageAgeMs: src.market.lastWsMessageAt ? now - src.market.lastWsMessageAt : null,
    feeds,
    agents,
    staleFeeds,
  };
}

export function buildKlines(market: MarketHub, symbol: string, interval: Interval, now = Date.now()): KlineResponse | null {
  if (!market.symbols.has(symbol)) return null;
  const candles = market.getCandles(symbol, interval);
  const closes = candles.map((candle) => candle.close);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const bars = candles.map((candle) => ({
    time: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
  const line = (series: Array<number | null>) =>
    bars.flatMap((bar, index) => (series[index] == null ? [] : [{ time: bar.time, value: series[index] as number }]));
  const updated = market.feedHealth(now)[symbol]?.klineAgeMs[interval] ?? null;
  return {
    symbol,
    interval,
    stale: market.isKlineStale(symbol, interval, now) || market.isTickerStale(symbol, now),
    ageMs: updated,
    bars,
    ema9: line(ema9),
    ema21: line(ema21),
    ema50: line(ema50),
  };
}

export function buildBook(market: MarketHub, symbol: string, now = Date.now()): BookView | null {
  if (!market.symbols.has(symbol)) return null;
  const book = market.books.get(symbol);
  const age = book ? now - book.updatedAt : null;
  return {
    symbol,
    bids: book?.bids ?? [],
    asks: book?.asks ?? [],
    updatedAt: book?.updatedAt ?? null,
    ageMs: age,
    stale: age == null || age > 30_000,
  };
}

function sessionChange(market: MarketHub, symbol: string, price: number | undefined, stale: boolean): number | null {
  if (stale || price == null || !(price > 0)) return null;
  const open = market.sessionOpens.get(symbol);
  if (open == null || !(open > 0)) return null;
  return ((price - open) / open) * 100;
}

function toTradeView(market: MarketHub, trade: import("./db.js").TradeRow): TradeView {
  const mark = trade.status === "open" ? market.price(trade.symbol) : null;
  const unreal =
    trade.status === "closed"
      ? 0
      : mark == null
        ? null
        : unrealizedPnl(
            {
              side: trade.side,
              qty: trade.qty,
              qtyOpen: trade.qtyOpen,
              entryFill: trade.entryFill,
              stop: trade.stopLoss,
              tp1: trade.takeProfit1,
              tp2: trade.takeProfit2,
              tp1Hit: trade.tp1Hit,
              fees: trade.fees,
              realizedPnl: trade.realizedPnl,
              status: trade.status,
              closeReason: trade.closeReason === "SL" || trade.closeReason === "TP2" ? trade.closeReason : null,
            },
            mark,
          );
  return {
    id: trade.id,
    signalId: trade.signalId,
    symbol: trade.symbol,
    style: trade.style,
    side: trade.side,
    status: trade.status,
    qty: trade.qty,
    qtyOpen: trade.qtyOpen,
    entryFill: trade.entryFill,
    stopLoss: trade.stopLoss,
    takeProfit1: trade.takeProfit1,
    takeProfit2: trade.takeProfit2,
    tp1Hit: trade.tp1Hit,
    tp1At: trade.tp1At,
    fees: trade.fees,
    realizedPnl: trade.realizedPnl,
    unrealizedPnl: unreal,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    closeReason: trade.closeReason,
  };
}

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

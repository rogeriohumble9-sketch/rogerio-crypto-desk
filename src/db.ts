import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS } from "./domain/risk.js";
import type {
  ActivityLine,
  ActivityTag,
  AlertView,
  Candle,
  DeskLayout,
  Interval,
  NewsView,
  RiskSettings,
  SignalView,
  Style,
} from "./shared/types.js";

export interface SimPersisted {
  cash: number;
  peak: number;
  lossStreak: number;
  sessionLossStreak: number;
  sessionDate: string;
  sessionStartEquity: number;
  latched: null | "loss" | "profit" | "streak";
  blockReason: string | null;
  startedAt: number;
}

export interface TradeRow {
  id: string;
  signalId: string | null;
  symbol: string;
  style: Style;
  side: "BUY" | "SELL";
  status: "open" | "closed";
  qty: number;
  qtyOpen: number;
  entryFill: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1Hit: boolean;
  tp1At: number | null;
  fees: number;
  realizedPnl: number;
  feePct: number;
  slippagePct: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  contributors: string[];
}

export class DeskDb {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (symbol, interval, open_time)
      );
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        style TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        price REAL,
        entry REAL,
        stop_loss REAL,
        take_profit_1 REAL,
        take_profit_2 REAL,
        timeframe TEXT,
        rr REAL,
        confidence TEXT,
        score INTEGER,
        criteria_json TEXT,
        justification TEXT,
        created_at INTEGER NOT NULL,
        valid_until INTEGER,
        reject_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT,
        symbol TEXT NOT NULL,
        style TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        qty REAL NOT NULL,
        qty_open REAL NOT NULL,
        entry_fill REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit_1 REAL NOT NULL,
        take_profit_2 REAL NOT NULL,
        tp1_hit INTEGER NOT NULL,
        tp1_at INTEGER,
        fees REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        fee_pct REAL NOT NULL,
        slippage_pct REAL NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        close_reason TEXT,
        contributors TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS equity_points (ts INTEGER PRIMARY KEY, equity REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        symbol TEXT
      );
      CREATE TABLE IF NOT EXISTS news (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        link TEXT,
        summary TEXT,
        sentiment TEXT NOT NULL,
        relevance TEXT NOT NULL,
        confirmation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS regime_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        regime TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        tag TEXT NOT NULL,
        text TEXT NOT NULL,
        symbol TEXT
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        side TEXT NOT NULL,
        reason TEXT NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS copy_traders (
        address TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS copy_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        address TEXT,
        coin TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `);
  }

  getAutoTrade(): boolean {
    const raw = this.getRaw("autoTrade");
    return raw !== "off";
  }

  saveAutoTrade(enabled: boolean): void {
    this.setRaw("autoTrade", enabled ? "on" : "off");
  }

  listCopyTraders(): string[] {
    const rows = this.db.prepare("SELECT address FROM copy_traders ORDER BY added_at ASC").all() as { address: string }[];
    return rows.map((row) => row.address);
  }

  addCopyTrader(address: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO copy_traders(address, added_at) VALUES(?, ?)").run(address, at);
  }

  removeCopyTrader(address: string): void {
    this.db.prepare("DELETE FROM copy_traders WHERE address = ?").run(address);
  }

  insertCopyEvent(event: { id: string; ts: number; address: string | null; coin: string | null; action: string; reason: string }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO copy_events(id, ts, address, coin, action, reason) VALUES(?, ?, ?, ?, ?, ?)")
      .run(event.id, event.ts, event.address, event.coin, event.action, event.reason);
  }

  recentCopyEvents(limit = 80): { id: string; ts: number; address: string | null; coin: string | null; action: string; reason: string }[] {
    const rows = this.db.prepare("SELECT * FROM copy_events ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      address: row.address == null ? null : String(row.address),
      coin: row.coin == null ? null : String(row.coin),
      action: String(row.action),
      reason: String(row.reason),
    }));
  }

  clearCopyEvents(): void {
    this.db.exec("DELETE FROM copy_events");
  }

  getCopyBlob(key: string): string | null {
    return this.getRaw(key);
  }

  saveCopyBlob(key: string, value: string): void {
    this.setRaw(key, value);
  }

  insertOrder(order: import("./shared/types.js").OrderView): void {
    this.db
      .prepare("INSERT OR REPLACE INTO orders(id, ts, symbol, kind, side, reason, price, qty, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(order.id, order.ts, order.symbol, order.kind, order.side, order.reason, order.price, order.qty, order.status);
  }

  recentOrders(limit = 80): import("./shared/types.js").OrderView[] {
    const rows = this.db.prepare("SELECT * FROM orders ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      symbol: String(row.symbol),
      kind: row.kind === "EXIT" ? "EXIT" : "ENTRY",
      side: row.side === "SELL" ? "SELL" : "BUY",
      reason: (["OPEN", "TP1", "TP2", "SL"].includes(String(row.reason)) ? String(row.reason) : "OPEN") as import("./shared/types.js").OrderView["reason"],
      price: Number(row.price),
      qty: Number(row.qty),
      status: "filled" as const,
    }));
  }

  private getRaw(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setRaw(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getSettings(): RiskSettings {
    const raw = this.getRaw("settings");
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(settings: RiskSettings): void {
    this.setRaw("settings", JSON.stringify(settings));
  }

  getLayout(): DeskLayout {
    return this.getRaw("layout") === "clean" ? "clean" : "desk";
  }

  saveLayout(layout: DeskLayout): void {
    this.setRaw("layout", layout);
  }

  getSim(): SimPersisted | null {
    const raw = this.getRaw("sim");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SimPersisted;
    } catch {
      return null;
    }
  }

  saveSim(state: SimPersisted): void {
    this.setRaw("sim", JSON.stringify(state));
  }

  listWatchlist(): string[] {
    const rows = this.db.prepare("SELECT symbol FROM watchlist ORDER BY added_at ASC").all() as { symbol: string }[];
    return rows.map((row) => row.symbol);
  }

  addWatchlist(symbol: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO watchlist(symbol, added_at) VALUES(?, ?)").run(symbol, at);
  }

  removeWatchlist(symbol: string): void {
    this.db.prepare("DELETE FROM watchlist WHERE symbol = ?").run(symbol);
  }

  saveCandles(symbol: string, interval: Interval, candles: Candle[]): void {
    const insert = this.db.prepare(
      `INSERT INTO candles(symbol, interval, open_time, open, high, low, close, volume)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`,
    );
    this.db.exec("BEGIN");
    try {
      for (const candle of candles) {
        insert.run(symbol, interval, candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume);
      }
      if (candles.length) {
        const cutoff = candles[Math.max(0, candles.length - 400)].openTime;
        this.db.prepare("DELETE FROM candles WHERE symbol = ? AND interval = ? AND open_time < ?").run(symbol, interval, cutoff);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  loadCandles(symbol: string, interval: Interval, limit = 400): Candle[] {
    const rows = this.db
      .prepare(
        "SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ? ORDER BY open_time DESC LIMIT ?",
      )
      .all(symbol, interval, limit) as Record<string, number>[];
    return rows
      .reverse()
      .map((row) => ({
        openTime: Number(row.open_time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }));
  }

  insertSignal(signal: SignalView): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signals(
          id, symbol, style, direction, status, price, entry, stop_loss, take_profit_1, take_profit_2,
          timeframe, rr, confidence, score, criteria_json, justification, created_at, valid_until, reject_reason
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signal.id,
        signal.symbol,
        signal.style,
        signal.direction,
        signal.status,
        signal.price,
        signal.entry,
        signal.stopLoss,
        signal.takeProfit1,
        signal.takeProfit2,
        signal.timeframe,
        signal.rr,
        signal.confidence,
        signal.score,
        JSON.stringify(signal.criteria),
        signal.justification,
        signal.createdAt,
        signal.validUntil,
        signal.rejectReason,
      );
  }

  expireSignal(id: string, reason: string | null): void {
    this.db.prepare("UPDATE signals SET status = 'expired', reject_reason = COALESCE(?, reject_reason) WHERE id = ?").run(reason, id);
  }

  recentSignals(limit = 80): SignalView[] {
    const rows = this.db.prepare("SELECT * FROM signals ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(mapSignal);
  }

  signalsBetween(from: number, to: number): SignalView[] {
    const rows = this.db
      .prepare("SELECT * FROM signals WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC")
      .all(from, to) as Record<string, unknown>[];
    return rows.map(mapSignal);
  }

  insertTrade(trade: TradeRow): void {
    this.tradeStmt().run(...tradeParams(trade));
  }

  updateTrade(trade: TradeRow): void {
    this.tradeStmt().run(...tradeParams(trade));
  }

  private tradeStmt() {
    return this.db.prepare(
      `INSERT INTO trades(
        id, signal_id, symbol, style, side, status, qty, qty_open, entry_fill, stop_loss, take_profit_1, take_profit_2,
        tp1_hit, tp1_at, fees, realized_pnl, fee_pct, slippage_pct, opened_at, closed_at, close_reason, contributors
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, qty_open = excluded.qty_open, tp1_hit = excluded.tp1_hit, tp1_at = excluded.tp1_at,
        fees = excluded.fees, realized_pnl = excluded.realized_pnl, closed_at = excluded.closed_at, close_reason = excluded.close_reason`,
    );
  }

  listTrades(): TradeRow[] {
    const rows = this.db.prepare("SELECT * FROM trades ORDER BY opened_at DESC").all() as Record<string, unknown>[];
    return rows.map(mapTrade);
  }

  insertEquity(ts: number, equity: number): void {
    this.db.prepare("INSERT OR REPLACE INTO equity_points(ts, equity) VALUES(?, ?)").run(ts, equity);
  }

  equityCurve(limit = 240): { t: number; equity: number }[] {
    const rows = this.db.prepare("SELECT ts, equity FROM equity_points ORDER BY ts DESC LIMIT ?").all(limit) as {
      ts: number;
      equity: number;
    }[];
    return rows.reverse().map((row) => ({ t: Number(row.ts), equity: Number(row.equity) }));
  }

  firstEquityOnOrAfter(ts: number): number | null {
    const row = this.db.prepare("SELECT equity FROM equity_points WHERE ts >= ? ORDER BY ts ASC LIMIT 1").get(ts) as
      | { equity: number }
      | undefined;
    return row ? Number(row.equity) : null;
  }

  insertAlert(alert: AlertView): void {
    this.db
      .prepare("INSERT OR REPLACE INTO alerts(id, ts, kind, level, title, body, symbol) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(alert.id, alert.ts, alert.kind, alert.level, alert.title, alert.body, alert.symbol);
  }

  recentAlerts(limit = 40): AlertView[] {
    const rows = this.db.prepare("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      kind: String(row.kind),
      level: row.level === "critical" || row.level === "warning" ? row.level : "info",
      title: String(row.title),
      body: String(row.body),
      symbol: row.symbol == null ? null : String(row.symbol),
    }));
  }

  upsertNews(item: NewsView): boolean {
    const existing = this.db.prepare("SELECT id FROM news WHERE id = ?").get(item.id);
    this.db
      .prepare(
        `INSERT INTO news(id, ts, source, title, link, summary, sentiment, relevance, confirmation)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(item.id, item.ts, item.source, item.title, item.link, item.summary, item.sentiment, item.relevance, item.confirmation);
    return !existing;
  }

  recentNews(limit = 80): NewsView[] {
    const rows = this.db.prepare("SELECT * FROM news ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(mapNews);
  }

  newsBetween(from: number, to: number): NewsView[] {
    const rows = this.db.prepare("SELECT * FROM news WHERE ts >= ? AND ts <= ?").all(from, to) as Record<string, unknown>[];
    return rows.map(mapNews);
  }

  insertRegime(ts: number, regime: string): void {
    this.db.prepare("INSERT INTO regime_log(ts, regime) VALUES(?, ?)").run(ts, regime);
  }

  regimesSince(from: number): { ts: number; regime: string }[] {
    const rows = this.db.prepare("SELECT ts, regime FROM regime_log WHERE ts >= ? ORDER BY ts ASC").all(from) as {
      ts: number;
      regime: string;
    }[];
    return rows.map((row) => ({ ts: Number(row.ts), regime: String(row.regime) }));
  }

  insertLog(line: { ts: number; level: string; scope: string; message: string }): void {
    this.db.prepare("INSERT INTO logs(ts, level, scope, message) VALUES(?, ?, ?, ?)").run(line.ts, line.level, line.scope, line.message);
  }

  recentLogs(limit = 30): { ts: number; level: string; scope: string; message: string }[] {
    const rows = this.db.prepare("SELECT ts, level, scope, message FROM logs ORDER BY id DESC LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
    return rows
      .reverse()
      .map((row) => ({ ts: Number(row.ts), level: String(row.level), scope: String(row.scope), message: String(row.message) }));
  }

  insertActivity(line: ActivityLine): void {
    this.db.prepare("INSERT OR REPLACE INTO activity(id, ts, tag, text, symbol) VALUES(?, ?, ?, ?, ?)").run(
      line.id,
      line.ts,
      line.tag,
      line.text,
      line.symbol,
    );
  }

  recentActivity(limit = 80): ActivityLine[] {
    const rows = this.db.prepare("SELECT * FROM activity ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      tag: String(row.tag) as ActivityTag,
      text: String(row.text),
      symbol: row.symbol == null ? null : String(row.symbol),
    }));
  }

  resetSimulation(): void {
    this.db.exec("DELETE FROM trades; DELETE FROM equity_points; DELETE FROM orders;");
  }

  prune(now: number): void {
    const week = now - 7 * 86_400_000;
    const twoWeeks = now - 14 * 86_400_000;
    this.db.prepare("DELETE FROM logs WHERE ts < ?").run(week);
    this.db.prepare("DELETE FROM activity WHERE ts < ?").run(week);
    this.db.prepare("DELETE FROM news WHERE ts < ?").run(twoWeeks);
  }

  close(): void {
    this.db.close();
  }
}

function mapSignal(row: Record<string, unknown>): SignalView {
  let criteria: SignalView["criteria"] = [];
  try {
    criteria = JSON.parse(String(row.criteria_json ?? "[]"));
  } catch {
    criteria = [];
  }
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    style: row.style === "SWING" ? "SWING" : "SCALPING",
    direction: row.direction as SignalView["direction"],
    status: row.status as SignalView["status"],
    price: row.price == null ? null : Number(row.price),
    entry: row.entry == null ? null : Number(row.entry),
    stopLoss: row.stop_loss == null ? null : Number(row.stop_loss),
    takeProfit1: row.take_profit_1 == null ? null : Number(row.take_profit_1),
    takeProfit2: row.take_profit_2 == null ? null : Number(row.take_profit_2),
    timeframe: String(row.timeframe ?? ""),
    rr: row.rr == null ? null : Number(row.rr),
    confidence: (row.confidence as SignalView["confidence"]) ?? null,
    score: Number(row.score ?? 0),
    criteria,
    justification: String(row.justification ?? ""),
    createdAt: Number(row.created_at),
    validUntil: row.valid_until == null ? null : Number(row.valid_until),
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
  };
}

function mapTrade(row: Record<string, unknown>): TradeRow {
  let contributors: string[] = [];
  try {
    contributors = JSON.parse(String(row.contributors ?? "[]"));
  } catch {
    contributors = [];
  }
  return {
    id: String(row.id),
    signalId: row.signal_id == null ? null : String(row.signal_id),
    symbol: String(row.symbol),
    style: row.style === "SWING" ? "SWING" : "SCALPING",
    side: row.side === "SELL" ? "SELL" : "BUY",
    status: row.status === "closed" ? "closed" : "open",
    qty: Number(row.qty),
    qtyOpen: Number(row.qty_open),
    entryFill: Number(row.entry_fill),
    stopLoss: Number(row.stop_loss),
    takeProfit1: Number(row.take_profit_1),
    takeProfit2: Number(row.take_profit_2),
    tp1Hit: Number(row.tp1_hit) === 1,
    tp1At: row.tp1_at == null ? null : Number(row.tp1_at),
    fees: Number(row.fees),
    realizedPnl: Number(row.realized_pnl),
    feePct: Number(row.fee_pct),
    slippagePct: Number(row.slippage_pct),
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    closeReason: row.close_reason == null ? null : String(row.close_reason),
    contributors,
  };
}

function mapNews(row: Record<string, unknown>): NewsView {
  return {
    id: String(row.id),
    ts: Number(row.ts),
    source: String(row.source),
    title: String(row.title),
    link: row.link == null ? null : String(row.link),
    summary: String(row.summary ?? ""),
    sentiment: row.sentiment === "positivo" || row.sentiment === "negativo" ? row.sentiment : "neutro",
    relevance: row.relevance === "alta" || row.relevance === "baixa" ? row.relevance : "media",
    confirmation: row.confirmation === "confirmado" || row.confirmation === "rumor" ? row.confirmation : "indeterminado",
    heuristic: true,
  };
}

function tradeParams(trade: TradeRow): Array<string | number | null> {
  return [
    trade.id,
    trade.signalId,
    trade.symbol,
    trade.style,
    trade.side,
    trade.status,
    trade.qty,
    trade.qtyOpen,
    trade.entryFill,
    trade.stopLoss,
    trade.takeProfit1,
    trade.takeProfit2,
    trade.tp1Hit ? 1 : 0,
    trade.tp1At,
    trade.fees,
    trade.realizedPnl,
    trade.feePct,
    trade.slippagePct,
    trade.openedAt,
    trade.closedAt,
    trade.closeReason,
    JSON.stringify(trade.contributors),
  ];
}

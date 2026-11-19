import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import type { DeskDb } from "../db.js";
import type { Logger } from "../log.js";
import { startOfCivilDay } from "../domain/reports.js";
import { sessionDate } from "../shared/time.js";
import { CORE_SYMBOLS, INTERVAL_MS, INTERVALS, type Candle, type FeedSymbolHealth, type Interval } from "../shared/types.js";

export interface LiveTicker {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  high: number;
  low: number;
  updatedAt: number;
  source: "ws" | "rest";
  spark: number[];
}

export interface LiveBook {
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
  updatedAt: number;
}

interface MiniPayload {
  s?: string;
  c?: string;
  o?: string;
  h?: string;
  l?: string;
  q?: string;
}

interface KlinePayload {
  s?: string;
  k?: { t?: number; s?: string; i?: string; o?: string; h?: string; l?: string; c?: string; v?: string };
}

export class MarketHub {
  readonly symbols = new Set<string>(CORE_SYMBOLS);
  readonly tickers = new Map<string, LiveTicker>();
  readonly books = new Map<string, LiveBook>();
  readonly candles = new Map<string, Map<Interval, Candle[]>>();
  readonly liveKlines = new Map<string, Candle>();
  wsStatus: "connecting" | "live" | "reconnecting" | "down" = "connecting";
  restBase: string;
  wsBase: string;
  usingFallback = false;
  lastWsMessageAt = 0;
  readonly sessionOpens = new Map<string, number>();
  private sessionOpenDate = "";
  onStale: ((symbol: string) => void) | null = null;
  onRecovered: ((symbol: string) => void) | null = null;

  private readonly klineUpdated = new Map<string, Map<Interval, number>>();
  private readonly dirty = new Set<string>();
  private readonly sparkAt = new Map<string, number>();
  private readonly seenFresh = new Set<string>();
  private readonly staleNow = new Set<string>();
  private preferFallback = false;
  private lastPrimaryTry = 0;
  private loggedFallback = false;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private rotate = 0;
  private timers: NodeJS.Timeout[] = [];
  private wsLoop: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: DeskDb,
    private readonly log: Logger,
  ) {
    this.restBase = config.restPrimary;
    this.wsBase = config.wsPrimary;
  }

  listSymbols(): string[] {
    const extra = [...this.symbols].filter((symbol) => !CORE_SYMBOLS.includes(symbol as (typeof CORE_SYMBOLS)[number]));
    return [...CORE_SYMBOLS.filter((symbol) => this.symbols.has(symbol)), ...extra];
  }

  getCandles(symbol: string, interval: Interval): Candle[] {
    return this.candles.get(symbol)?.get(interval) ?? [];
  }

  isTickerStale(symbol: string, now = Date.now()): boolean {
    const ticker = this.tickers.get(symbol);
    if (!ticker || !(ticker.price > 0)) return true;
    return now - ticker.updatedAt > this.config.staleTickerMs;
  }

  isKlineStale(symbol: string, interval: Interval, now = Date.now()): boolean {
    const at = this.klineUpdated.get(symbol)?.get(interval);
    if (!at) return true;
    const limit = interval === "1m" ? 90_000 : this.config.staleKlineMs;
    return now - at > limit;
  }

  price(symbol: string): number | null {
    if (this.isTickerStale(symbol)) return null;
    return this.tickers.get(symbol)?.price ?? null;
  }

  feedHealth(now = Date.now()): Record<string, FeedSymbolHealth> {
    const out: Record<string, FeedSymbolHealth> = {};
    for (const symbol of this.listSymbols()) {
      const ticker = this.tickers.get(symbol);
      const book = this.books.get(symbol);
      const klineAgeMs: FeedSymbolHealth["klineAgeMs"] = {};
      const klineStale: FeedSymbolHealth["klineStale"] = {};
      for (const interval of INTERVALS) {
        const at = this.klineUpdated.get(symbol)?.get(interval) ?? null;
        klineAgeMs[interval] = at == null ? null : now - at;
        klineStale[interval] = this.isKlineStale(symbol, interval, now);
      }
      out[symbol] = {
        tickerAgeMs: ticker ? now - ticker.updatedAt : null,
        tickerStale: this.isTickerStale(symbol, now),
        bookAgeMs: book ? now - book.updatedAt : null,
        bookStale: !book || now - book.updatedAt > this.config.staleBookMs,
        klineAgeMs,
        klineStale,
      };
    }
    return out;
  }

  loadCache(): void {
    for (const symbol of this.listSymbols()) {
      for (const interval of INTERVALS) {
        const rows = this.db.loadCandles(symbol, interval, 400);
        if (!rows.length) continue;
        this.series(symbol).set(interval, rows);
        const last = rows[rows.length - 1];
        const age = Date.now() - (last.openTime + INTERVAL_MS[interval]);
        if (age >= 0 && age < (interval === "1m" ? 90_000 : this.config.staleKlineMs)) {
          this.touchKline(symbol, interval);
        }
        if (interval === "1m") this.liveKlines.set(symbol, last);
      }
    }
  }

  async start(extra: string[]): Promise<void> {
    for (const symbol of extra) this.symbols.add(symbol);
    this.loadCache();
    this.stopped = false;
    this.wsLoop = this.runWs();
    void this.backfill().catch((error) => this.log.error("market", `backfill: ${text(error)}`));
    this.timers.push(setInterval(() => void this.poll().catch((error) => this.log.warn("market", text(error))), 8_000));
    this.timers.push(setInterval(() => this.flush(), 15_000));
    this.timers.push(setInterval(() => this.checkStale(), 2_000));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.ws?.terminate();
    this.ws = null;
    this.flush();
    await this.wsLoop?.catch(() => undefined);
  }

  async validateSymbol(raw: string): Promise<{ ok: true; symbol: string } | { ok: false; error: string }> {
    const symbol = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      return { ok: false, error: "Informe o par contra USDT, por exemplo ADAUSDT." };
    }
    if (this.symbols.has(symbol)) return { ok: false, error: "Esse ativo já está na mesa." };
    let info: { symbols?: { status?: string; quoteAsset?: string }[] };
    try {
      info = (await this.rest(`/api/v3/exchangeInfo?symbol=${symbol}`)) as typeof info;
    } catch {
      return { ok: false, error: "A Binance pública não confirmou esse par agora." };
    }
    const row = info.symbols?.[0];
    if (!row || row.status !== "TRADING" || row.quoteAsset !== "USDT") {
      return { ok: false, error: "O par não está em negociação à vista contra USDT." };
    }
    let ticker: { quoteVolume?: string };
    try {
      ticker = (await this.rest(`/api/v3/ticker/24hr?symbol=${symbol}`)) as typeof ticker;
    } catch {
      return { ok: false, error: "Não foi possível ler o volume de 24h." };
    }
    const quoteVolume = Number(ticker.quoteVolume);
    if (!(quoteVolume >= this.config.minQuoteVolume)) {
      return {
        ok: false,
        error: `Volume de 24h abaixo do mínimo de US$ ${Math.round(this.config.minQuoteVolume).toLocaleString("pt-BR")}.`,
      };
    }
    return { ok: true, symbol };
  }

  async addSymbol(symbol: string): Promise<void> {
    this.symbols.add(symbol);
    this.db.addWatchlist(symbol, Date.now());
    await this.backfillSymbol(symbol);
    this.reconnect();
  }

  removeSymbol(symbol: string): { ok: true } | { ok: false; error: string } {
    if (CORE_SYMBOLS.includes(symbol as (typeof CORE_SYMBOLS)[number])) {
      return { ok: false, error: "BTC, ETH, XRP, BNB e SOL ficam fixos na mesa." };
    }
    if (!this.symbols.has(symbol)) return { ok: false, error: "Ativo não está na lista." };
    this.symbols.delete(symbol);
    this.db.removeWatchlist(symbol);
    this.tickers.delete(symbol);
    this.books.delete(symbol);
    this.reconnect();
    return { ok: true };
  }

  private series(symbol: string): Map<Interval, Candle[]> {
    let map = this.candles.get(symbol);
    if (!map) {
      map = new Map();
      this.candles.set(symbol, map);
    }
    return map;
  }

  private touchKline(symbol: string, interval: Interval): void {
    let map = this.klineUpdated.get(symbol);
    if (!map) {
      map = new Map();
      this.klineUpdated.set(symbol, map);
    }
    map.set(interval, Date.now());
  }

  private upsert(symbol: string, interval: Interval, candle: Candle, fresh: boolean): void {
    const list = this.series(symbol).get(interval) ?? [];
    const index = list.findIndex((item) => item.openTime === candle.openTime);
    if (index >= 0) list[index] = candle;
    else {
      list.push(candle);
      list.sort((a, b) => a.openTime - b.openTime);
      if (list.length > 400) list.splice(0, list.length - 400);
    }
    this.series(symbol).set(interval, list);
    if (fresh) this.touchKline(symbol, interval);
    if (interval === "1m") this.liveKlines.set(symbol, candle);
    this.dirty.add(`${symbol}|${interval}`);
  }

  private setTicker(symbol: string, patch: Omit<LiveTicker, "symbol" | "updatedAt" | "spark">): void {
    const prev = this.tickers.get(symbol);
    const spark = prev?.spark ? [...prev.spark] : [];
    const now = Date.now();
    const last = this.sparkAt.get(symbol) ?? 0;
    if (!spark.length || now - last >= 30_000) {
      spark.push(patch.price);
      if (spark.length > 36) spark.shift();
      this.sparkAt.set(symbol, now);
    }
    this.tickers.set(symbol, { symbol, ...patch, updatedAt: now, spark });
  }

  private async rest(pathname: string): Promise<unknown> {
    const now = Date.now();
    if (this.preferFallback && now - this.lastPrimaryTry > 15 * 60_000) this.preferFallback = false;
    const bases = this.preferFallback
      ? [this.config.restFallback, this.config.restPrimary]
      : [this.config.restPrimary, this.config.restFallback];
    let last: unknown = new Error("falha REST");
    for (const base of bases) {
      try {
        const response = await fetch(base + pathname, {
          signal: AbortSignal.timeout(12_000),
          headers: { accept: "application/json", "user-agent": "RogerioCryptoTradingDesk/1.0" },
        });
        if (response.status === 451 || response.status === 403) {
          last = new Error(`HTTP ${response.status}`);
          if (base === this.config.restPrimary) this.markFallback("REST");
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.restBase = base;
        if (base !== this.config.restPrimary) this.markFallback("REST");
        return await response.json();
      } catch (error) {
        last = error;
        if (base === this.config.restPrimary) this.markFallback("REST");
      }
    }
    throw last instanceof Error ? last : new Error("falha REST Binance");
  }

  private markFallback(kind: string): void {
    this.preferFallback = true;
    this.usingFallback = true;
    this.lastPrimaryTry = Date.now();
    if (!this.loggedFallback) {
      this.loggedFallback = true;
      this.log.warn("market", `${kind}: host principal indisponível (possível HTTP 451). Usando Binance Vision.`);
    }
  }

  private async backfill(): Promise<void> {
    await this.refresh24h();
    const jobs: { symbol: string; interval: Interval }[] = [];
    for (const symbol of this.listSymbols()) {
      for (const interval of INTERVALS) jobs.push({ symbol, interval });
    }
    await pool(jobs, 3, async (job) => {
      const candles = await this.fetchKlines(job.symbol, job.interval, 300);
      for (const candle of candles) this.upsert(job.symbol, job.interval, candle, true);
    });
    await this.refreshSessionOpens();
    this.flush();
    this.log.info("market", `histórico público carregado para ${this.listSymbols().length} ativos`);
  }

  private async backfillSymbol(symbol: string): Promise<void> {
    await this.refresh24h();
    for (const interval of INTERVALS) {
      const candles = await this.fetchKlines(symbol, interval, 300);
      for (const candle of candles) this.upsert(symbol, interval, candle, true);
    }
    this.flush();
  }

  private async fetchKlines(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const data = await this.rest(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => {
        const item = row as unknown[];
        return {
          openTime: Number(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
        };
      })
      .filter((candle) => Number.isFinite(candle.openTime) && Number.isFinite(candle.close));
  }

  private async refreshSessionOpens(): Promise<void> {
    const date = sessionDate(Date.now());
    if (this.sessionOpenDate !== date) {
      this.sessionOpens.clear();
      this.sessionOpenDate = date;
    }
    const start = startOfCivilDay(date);
    for (const symbol of this.listSymbols()) {
      if (this.sessionOpens.has(symbol)) continue;
      try {
        const data = await this.rest(`/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${start}&limit=1`);
        const row = Array.isArray(data) ? (data[0] as unknown[] | undefined) : undefined;
        const open = row ? Number(row[1]) : NaN;
        if (open > 0) this.sessionOpens.set(symbol, open);
      } catch {
        /* a sessão fica indisponível até a próxima leitura */
      }
    }
  }

  private async refresh24h(): Promise<void> {
    const symbols = encodeURIComponent(JSON.stringify(this.listSymbols()));
    const data = (await this.rest(`/api/v3/ticker/24hr?symbols=${symbols}`)) as {
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      quoteVolume: string;
      highPrice: string;
      lowPrice: string;
    }[];
    if (!Array.isArray(data)) return;
    for (const row of data) {
      const prev = this.tickers.get(row.symbol);
      if (prev && prev.source === "ws" && Date.now() - prev.updatedAt < 2_000) {
        prev.quoteVolume = Number(row.quoteVolume);
        prev.high = Number(row.highPrice);
        prev.low = Number(row.lowPrice);
        continue;
      }
      this.setTicker(row.symbol, {
        price: Number(row.lastPrice),
        changePct: Number(row.priceChangePercent),
        quoteVolume: Number(row.quoteVolume),
        high: Number(row.highPrice),
        low: Number(row.lowPrice),
        source: "rest",
      });
    }
  }

  private async poll(): Promise<void> {
    if (this.wsStatus !== "live" || Date.now() - this.lastWsMessageAt > 5_000) {
      await this.refresh24h();
    }
    await this.refreshSessionOpens();
    const interval = INTERVALS[this.rotate % INTERVALS.length];
    this.rotate += 1;
    if (interval === "1m" && this.wsStatus === "live" && Date.now() - this.lastWsMessageAt < 5_000) return;
    for (const symbol of this.listSymbols()) {
      const candles = await this.fetchKlines(symbol, interval, interval === "1m" ? 120 : 300);
      for (const candle of candles) this.upsert(symbol, interval, candle, true);
    }
  }

  private flush(): void {
    for (const key of this.dirty) {
      const [symbol, interval] = key.split("|");
      if (!isInterval(interval)) continue;
      const candles = this.getCandles(symbol, interval);
      if (candles.length) this.db.saveCandles(symbol, interval, candles);
    }
    this.dirty.clear();
  }

  private checkStale(): void {
    const now = Date.now();
    for (const symbol of this.listSymbols()) {
      const stale = this.isTickerStale(symbol, now);
      if (!stale) {
        this.seenFresh.add(symbol);
        if (this.staleNow.has(symbol)) {
          this.staleNow.delete(symbol);
          this.onRecovered?.(symbol);
        }
      } else if (!this.staleNow.has(symbol) && this.seenFresh.has(symbol)) {
        this.staleNow.add(symbol);
        this.onStale?.(symbol);
      }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.lastWsMessageAt && now - this.lastWsMessageAt > 25_000) {
      this.log.warn("market", "WebSocket sem mensagens. Reconectando.");
      this.ws.terminate();
    }
  }

  private reconnect(): void {
    this.ws?.terminate();
  }

  private async runWs(): Promise<void> {
    while (!this.stopped) {
      const result = await this.openSocket();
      if (this.stopped) return;
      if (result === "failed") {
        this.wsStatus = "reconnecting";
        await sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
      } else {
        this.wsStatus = "reconnecting";
        await sleep(this.backoff);
        this.backoff = Math.min(Math.max(this.backoff * 2, 1000), 30_000);
      }
    }
  }

  private openSocket(): Promise<"closed" | "failed"> {
    const bases = this.preferFallback ? [this.config.wsFallback, this.config.wsPrimary] : [this.config.wsPrimary, this.config.wsFallback];
    return this.tryBases(bases);
  }

  private async tryBases(bases: string[]): Promise<"closed" | "failed"> {
    for (const base of bases) {
      const result = await this.tryBase(base);
      if (result === "closed") return "closed";
      if (base === this.config.wsPrimary) this.markFallback("WS");
    }
    return "failed";
  }

  private tryBase(base: string): Promise<"closed" | "failed"> {
    const streams: string[] = [];
    for (const symbol of this.listSymbols()) {
      const lower = symbol.toLowerCase();
      streams.push(`${lower}@miniTicker`, `${lower}@kline_1m`, `${lower}@depth20@1000ms`);
    }
    const url = `${base}/stream?streams=${streams.join("/")}`;
    return new Promise((resolve) => {
      let opened = false;
      let settled = false;
      const ws = new WebSocket(url);
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve("failed");
      };
      const timer = setTimeout(() => {
        if (!opened) fail();
      }, 8_000);
      ws.on("open", () => {
        opened = true;
        clearTimeout(timer);
        this.ws = ws;
        this.wsStatus = "live";
        this.wsBase = base;
        this.backoff = 1000;
        if (base !== this.config.wsPrimary) this.markFallback("WS");
        this.log.info("market", `WebSocket público em ${base.replace("wss://", "")}`);
      });
      ws.on("message", (raw) => this.onMessage(raw.toString()));
      ws.on("ping", () => ws.pong());
      ws.on("unexpected-response", (_req, res) => {
        this.log.warn("market", `WebSocket HTTP ${res.statusCode ?? "?"}`);
        fail();
      });
      ws.on("error", () => {
        if (!opened) fail();
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!opened) {
          fail();
          return;
        }
        if (!settled) {
          settled = true;
          resolve("closed");
        }
      });
    });
  }

  private onMessage(raw: string): void {
    this.lastWsMessageAt = Date.now();
    let msg: { stream?: string; data?: unknown };
    try {
      msg = JSON.parse(raw) as { stream?: string; data?: unknown };
    } catch {
      return;
    }
    const stream = msg.stream ?? "";
    const data = (msg.data ?? msg) as MiniPayload & KlinePayload & { bids?: [string, string][]; asks?: [string, string][]; e?: string };
    if (data.e === "24hrMiniTicker" || stream.includes("miniTicker")) {
      if (!data.s) return;
      const price = Number(data.c);
      const open = Number(data.o);
      if (!(price > 0)) return;
      this.setTicker(data.s, {
        price,
        changePct: open ? ((price - open) / open) * 100 : 0,
        quoteVolume: Number(data.q),
        high: Number(data.h),
        low: Number(data.l),
        source: "ws",
      });
      return;
    }
    if (data.e === "kline" || stream.includes("@kline_")) {
      const k = data.k;
      const symbol = k?.s ?? data.s;
      const interval = k?.i;
      if (!symbol || !k || !isInterval(interval ?? "")) return;
      this.upsert(
        symbol,
        interval as Interval,
        {
          openTime: Number(k.t),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        },
        true,
      );
      return;
    }
    if (stream.includes("@depth") || Array.isArray(data.bids)) {
      const symbol = stream.split("@")[0]?.toUpperCase();
      if (!symbol) return;
      const levels = (rows: [string, string][] | undefined) =>
        (rows ?? []).slice(0, 8).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }));
      this.books.set(symbol, { bids: levels(data.bids), asks: levels(data.asks), updatedAt: Date.now() });
    }
  }
}

function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      try {
        await fn(current);
      } catch (error) {
        console.warn(`[market] ${text(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: size }, () => worker()));
}

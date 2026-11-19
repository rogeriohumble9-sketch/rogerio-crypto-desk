import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import type { DeskDb } from "../db.js";
import { atr as atrOf } from "../domain/indicators.js";
import { COPY_DEFAULTS, remainingLossBudget, riskToStop, appendFillPoint, classifyFill, closeCash, coinAllowed, copySessionBlock, decideCopy, drawdownFromPoints, skipLabel, unrealizedCopy, winStreak } from "../domain/copy.js";
import { applyRiskVerdict, parseCopySeed, RISK_VERDICT, type SeedBlocked, type SeedWatch } from "../domain/copySeed.js";
import { readNote } from "../financas.js";
import type { Logger } from "../log.js";
import type { MarketHub } from "../market/hub.js";
import { sessionDate } from "../shared/time.js";
import type { Candle, CopyCurvePoint, CopyEventView, CopyLogTag, CopySettings, CopyTapeFill, CopyTraderView, CopyView, CopyWatchView } from "../shared/types.js";
import { entryFillPrice } from "../domain/risk.js";
import type { Simulator } from "./simulator.js";

interface BookPosition {
  id: string;
  address: string;
  coin: string;
  side: "BUY" | "SELL";
  qty: number;
  entry: number;
  stop: number;
  stopSource: "publico" | "atr";
  sourceLeverage: number | null;
  openedAt: number;
  lastMark: number | null;
}

interface Book {
  cash: number;
  startedAt: number;
  sessionDate: string;
  sessionStartEquity: number;
  latched: null | "loss" | "profit";
  volume: number;
  copies: number;
  seen: string[];
  seeded: string[];
  positions: BookPosition[];
  curve: CopyCurvePoint[];
  closed: { address: string; pnl: number; ts: number }[];
  realized: Record<string, number>;
}

interface TraderCache {
  address: string;
  displayName: string | null;
  accountValue: number | null;
  dayPnl: number | null;
  dayRoi: number | null;
  dayVolume: number | null;
  weekPnl: number | null;
  positions: { coin: string; size: number; entry: number; leverage: number | null; unrealized: number }[];
  leverage: Map<string, number>;
  stops: Map<string, number>;
  fills: CopyTapeFill[];
  feedAt: number | null;
  updatedAt: number | null;
  error: string | null;
}

interface HlFill {
  coin?: string;
  px?: string;
  sz?: string;
  side?: string;
  time?: number;
  dir?: string;
  hash?: string;
  tid?: number;
  startPosition?: string;
}

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_WS = "wss://api.hyperliquid.xyz/ws";
const LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export class CopyDesk {
  private settings: CopySettings = { ...COPY_DEFAULTS };
  private book: Book = emptyBook();
  private traders: string[] = [];
  private cache = new Map<string, TraderCache>();
  private suggestions: string[] = [];
  private watches: SeedWatch[] = RISK_VERDICT.watch;
  private blocked: SeedBlocked[] = RISK_VERDICT.blocked;
  private watchStats = new Map<string, CopyWatchView>();
  private watchFetchedAt = 0;
  private events: CopyEventView[] = [];
  private wsStatus: CopyView["ws"] = "off";
  private socket: WebSocket | null = null;
  private stopped = false;
  private leaderboardAt = 0;
  private leaderboard = new Map<string, { displayName: string | null; dayPnl: number; dayRoi: number; dayVolume: number; weekPnl: number }>();
  private atrCache = new Map<string, { at: number; atr: number | null }>();
  private mids: Record<string, number> = {};
  private midsAt = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly db: DeskDb,
    private readonly market: MarketHub,
    private readonly sim: Simulator,
    private readonly log: Logger,
  ) {}

  load(): void {
    const savedSettings = this.db.getCopyBlob("copySettings");
    if (savedSettings) {
      try {
        const saved = JSON.parse(savedSettings) as Partial<CopySettings>;
        this.settings = { ...COPY_DEFAULTS, ...saved };
        if (saved.maxDeviationPct === 0.5) {
          this.settings.maxDeviationPct = COPY_DEFAULTS.maxDeviationPct;
          this.db.saveCopyBlob("copySettings", JSON.stringify(this.settings));
        }
      } catch {
        this.settings = { ...COPY_DEFAULTS };
      }
    }
    const savedBook = this.db.getCopyBlob("copyBook");
    if (savedBook) {
      try {
        const parsed = JSON.parse(savedBook) as Partial<Book>;
        this.book = { ...emptyBook(), ...parsed, curve: parsed.curve ?? [], closed: parsed.closed ?? [], realized: parsed.realized ?? {} };
        if (!this.book.curve.length) {
          this.book.curve = [{ t: this.book.startedAt, equity: this.book.cash, fillId: "abertura" }];
        }
      } catch {
        this.book = emptyBook();
      }
    } else {
      this.book = emptyBook();
      this.book.cash = this.settings.initialCapital;
      this.book.sessionStartEquity = this.book.cash;
      this.persistBook();
    }
    this.traders = this.db.listCopyTraders();
    this.events = this.db.recentCopyEvents(80).map((event) => ({
      ...event,
      action: normalizeTag(event.action),
    }));
    this.bindSharedValue();
    this.applySeed();
  }

  start(): void {
    this.stopped = false;
    this.wsStatus = "conectando";
    void this.cycle().catch((error) => this.log.warn("copia", text(error)));
    this.timers.push(setInterval(() => void this.cycle().catch((error) => this.log.warn("copia", text(error))), 8_000));
    this.timers.push(setInterval(() => this.markStops(), 1_000));
    this.connectWs();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.socket?.terminate();
    this.socket = null;
  }

  view(now = Date.now()): CopyView {
    this.rollSession(now);
    const equity = this.equity();
    const dayPnl = equity == null ? null : equity - this.book.sessionStartEquity;
    const curve = this.book.curve;
    const lastFillEquity = curve.length ? curve[curve.length - 1].equity : null;
    const wins = this.book.closed.filter((item) => item.pnl > 0).length;
    const openRisk = this.openRiskUsd();
    return {
      settings: this.settings,
      paused: this.isPaused(),
      pausedSource: this.db.getCopyBlob("copyPaused") == null ? "env" : "salvo",
      openRiskUsd: openRisk,
      remainingLossUsd: dayPnl == null ? null : remainingLossBudget(this.settings.dailyLossUsd, dayPnl),
      cash: this.settings.mode === "shared" ? this.sim.freeCash() : this.book.cash,
      equity,
      totalPnl: lastFillEquity == null ? null : lastFillEquity - this.settings.initialCapital,
      drawdownPct: drawdownFromPoints(curve),
      winRate: this.book.closed.length ? wins / this.book.closed.length : null,
      streak: winStreak(this.book.closed.map((item) => item.pnl)),
      copyCount: this.book.copies,
      dayPnl,
      volume: this.book.volume,
      blocked: this.book.latched,
      blockReason: this.blockReason(dayPnl),
      startedAt: this.book.startedAt || null,
      traders: this.traders.map((address) => this.traderView(address)),
      suggestions: this.suggestions.filter((address) => !this.traders.includes(address)),
      watches: this.watches.map((watch) => this.watchStats.get(watch.code) ?? emptyWatch(watch)),
      blockedSeeds: this.blocked,
      positions: this.book.positions.map((position) => ({
        id: position.id,
        address: position.address,
        coin: position.coin,
        side: position.side,
        qty: position.qty,
        entry: position.entry,
        stop: position.stop,
        stopSource: position.stopSource,
        sourceLeverage: position.sourceLeverage,
        unrealizedPnl: this.markOf(position),
        openedAt: position.openedAt,
      })),
      events: this.events.slice(0, 80),
      curve,
      ws: this.wsStatus,
    };
  }

  addTrader(raw: string): { ok: true } | { ok: false; error: string } {
    const address = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) return { ok: false, error: "Endereço público inválido. Use 0x e 40 caracteres hexadecimais." };
    const blocked = this.blocked.find((item) => item.kind === "hyperliquid" && item.id === address);
    if (blocked) return { ok: false, error: `Bloqueado: ${blocked.reason}. A mesa não copia.` };
    if (this.traders.includes(address)) return { ok: false, error: "Esse endereço já está na lista." };
    if (this.traders.length >= 12) return { ok: false, error: "A mesa segue no máximo 12 endereços." };
    this.db.addCopyTrader(address, Date.now());
    this.traders.push(address);
    this.logEvent(address, null, "TRACK", "carteira pública adicionada. Stats vêm da Hyperliquid, sem chave.");
    this.resubscribe();
    void this.refreshTrader(address).catch((error) => this.log.warn("copia", text(error)));
    return { ok: true };
  }

  removeTrader(raw: string): void {
    const address = raw.trim().toLowerCase();
    this.traders = this.traders.filter((item) => item !== address);
    this.db.removeCopyTrader(address);
    this.cache.delete(address);
    this.book.seeded = this.book.seeded.filter((item) => item !== address);
    this.persistBook();
    this.resubscribe();
  }

  isPaused(): boolean {
    const saved = this.db.getCopyBlob("copyPaused");
    if (saved != null) return saved === "on";
    return this.config.copyPausedDefault;
  }

  /** Pausa só as ENTRADAS novas. Saídas copiadas, stops e fechamento manual continuam valendo. */
  setPaused(paused: boolean): void {
    this.db.saveCopyBlob("copyPaused", paused ? "on" : "off");
    this.logEvent(null, null, "SYNC", paused ? "Cópia PAUSADA: sem novas entradas. Stops e saídas continuam." : "Cópia RETOMADA: novas entradas liberadas (sujeitas às regras de risco).");
  }

  /** Fecha a mercado (simulado) todas as posições copiadas abertas, de um trader ou de todos. */
  closeAll(address?: string, reason = "fechamento manual a mercado (Risk Manager)"): { closed: { id: string; address: string; coin: string; side: "BUY" | "SELL"; qty: number; entry: number; exit: number; pnl: number }[]; failed: string[]; totalPnl: number; equityAfter: number | null } {
    const target = address?.trim().toLowerCase();
    const closed: { id: string; address: string; coin: string; side: "BUY" | "SELL"; qty: number; entry: number; exit: number; pnl: number }[] = [];
    const failed: string[] = [];
    for (const position of [...this.book.positions]) {
      if (target && position.address.toLowerCase() !== target) continue;
      const mark = this.market.price(`${position.coin}USDT`) ?? position.lastMark;
      if (mark == null) {
        failed.push(`${position.coin}: sem preço da Binance`);
        continue;
      }
      const qty = position.qty;
      const exit = exitFill(position.side, mark);
      const pnl = this.closePosition(position, mark, "EXIT", reason);
      closed.push({ id: position.id, address: position.address, coin: position.coin, side: position.side, qty, entry: position.entry, exit, pnl });
    }
    this.applyDailyLatch();
    return { closed, failed, totalPnl: closed.reduce((sum, item) => sum + item.pnl, 0), equityAfter: this.equity() };
  }

  private dayPnlNow(): number | null {
    const equity = this.equity();
    return equity == null ? null : equity - this.book.sessionStartEquity;
  }

  private openRiskUsd(): number | null {
    let total = 0;
    for (const position of this.book.positions) {
      const mark = this.market.price(`${position.coin}USDT`) ?? position.lastMark;
      total += riskToStop({ coin: position.coin, side: position.side, qty: position.qty, stop: position.stop, entry: position.entry, mark });
    }
    return total;
  }

  updateSettings(patch: Partial<CopySettings>): { ok: true; value: CopySettings } | { ok: false; error: string } {
    const next: CopySettings = { ...this.settings, ...patch };
    if (next.mode !== "separate" && next.mode !== "shared") return { ok: false, error: "Modo inválido." };
    if (!(next.initialCapital >= 100 && next.initialCapital <= 1_000_000)) return { ok: false, error: "Capital da cópia fora da faixa." };
    if (!(next.riskPct >= 0.1 && next.riskPct <= 5)) return { ok: false, error: "Risco da cópia fora da faixa." };
    if (!(next.dailyLossUsd >= 1 && next.dailyLossUsd <= 1_000)) return { ok: false, error: "Perda diária da cópia fora da faixa." };
    if (!(next.dailyTargetUsd >= 1 && next.dailyTargetUsd <= 5_000)) return { ok: false, error: "Meta diária da cópia fora da faixa." };
    if (!(next.maxFillAgeMs >= 5_000 && next.maxFillAgeMs <= 600_000)) return { ok: false, error: "Atraso máximo fora da faixa." };
    if (!(next.maxDeviationPct >= 0.05 && next.maxDeviationPct <= 5)) return { ok: false, error: "Desvio máximo fora da faixa." };
    if (!(Number.isInteger(next.maxOpenPositions) && next.maxOpenPositions >= 1 && next.maxOpenPositions <= 10)) return { ok: false, error: "Máximo de posições abertas fora da faixa." };
    const switched = next.mode !== this.settings.mode;
    this.settings = next;
    this.db.saveCopyBlob("copySettings", JSON.stringify(next));
    if (switched && next.mode === "separate" && this.book.positions.length === 0) {
      this.book.cash = next.initialCapital;
      this.book.sessionStartEquity = next.initialCapital;
      this.persistBook();
    }
    this.bindSharedValue();
    return { ok: true, value: next };
  }

  reset(): void {
    for (const position of [...this.book.positions]) this.closePosition(position, position.lastMark ?? position.entry, "EXIT", "livro zerado");
    this.book = emptyBook();
    this.book.cash = this.settings.initialCapital;
    this.book.sessionStartEquity = this.book.cash;
    this.persistBook();
    this.db.clearCopyEvents();
    this.events = [];
    this.logEvent(null, null, "SYNC", "Livro de cópia zerado. Caixa hipotético separado voltou ao capital inicial.");
  }

  private async cycle(): Promise<void> {
    this.rollSession(Date.now());
    await this.refreshMids();
    await this.refreshLeaderboard();
    this.readWhaleSuggestions();
    this.applySeed();
    void this.refreshWatches();
    for (const address of this.traders) {
      await this.refreshTrader(address);
      await this.pollFills(address);
    }
    this.applyDailyLatch();
  }

  private async refreshMids(): Promise<void> {
    try {
      const data = (await hl({ type: "allMids" })) as Record<string, string>;
      const next: Record<string, number> = {};
      for (const [coin, price] of Object.entries(data)) {
        const value = Number(price);
        if (value > 0 && !coin.startsWith("#") && !coin.startsWith("@")) next[coin] = value;
      }
      this.mids = next;
      this.midsAt = Date.now();
    } catch (error) {
      this.log.warn("copia", `mids públicos: ${text(error)}`);
    }
  }

  private async refreshLeaderboard(): Promise<void> {
    if (Date.now() - this.leaderboardAt < 15 * 60_000 && this.leaderboard.size) return;
    if (!this.traders.length) return;
    try {
      const response = await fetch(LEADERBOARD, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        leaderboardRows?: { ethAddress?: string; displayName?: string | null; windowPerformances?: [string, { pnl?: string; roi?: string; vlm?: string }][] }[];
      };
      const next = new Map<string, { displayName: string | null; dayPnl: number; dayRoi: number; dayVolume: number; weekPnl: number }>();
      for (const row of body.leaderboardRows ?? []) {
        const address = row.ethAddress?.toLowerCase();
        if (!address) continue;
        const windows = Object.fromEntries(row.windowPerformances ?? []);
        next.set(address, {
          displayName: row.displayName ?? null,
          dayPnl: Number(windows.day?.pnl),
          dayRoi: Number(windows.day?.roi),
          dayVolume: Number(windows.day?.vlm),
          weekPnl: Number(windows.week?.pnl),
        });
      }
      this.leaderboard = next;
      this.leaderboardAt = Date.now();
    } catch (error) {
      this.log.warn("copia", `leaderboard público: ${text(error)}`);
    }
  }

  private applySeed(): void {
    const note = readNote(this.config.financasDir, "2_copy_traders.md");
    const seed = note && !note.missing ? parseCopySeed(note.content) : applyRiskVerdict(RISK_VERDICT);
    this.watches = seed.watch;
    this.blocked = seed.blocked;
    for (const item of seed.blocked) {
      if (item.kind === "hyperliquid" && this.traders.includes(item.id)) this.removeTrader(item.id);
    }
    for (const address of seed.copy) {
      if (!this.traders.includes(address)) this.addTrader(address);
    }
  }

  private async refreshWatches(): Promise<void> {
    if (Date.now() - this.watchFetchedAt < 5 * 60_000 && this.watchStats.size === this.watches.length) return;
    const windows = [
      { lastDays: "1", label: "7d" },
      { lastDays: "2", label: "30d" },
      { lastDays: "3", label: "90d" },
      { lastDays: "4", label: "365d" },
    ];
    for (const watch of this.watches) {
      const card = emptyWatch(watch);
      card.fetchedAt = Date.now();
      try {
        for (const window of windows) {
          const pnl = (await okx(`/api/v5/copytrading/public-pnl?uniqueCode=${watch.code}&instType=SPOT&lastDays=${window.lastDays}`)) as {
            data?: { pnl?: string; pnlRatio?: string; beginTs?: string }[];
          };
          const stats = (await okx(`/api/v5/copytrading/public-stats?uniqueCode=${watch.code}&instType=SPOT&lastDays=${window.lastDays}`)) as {
            data?: { winRatio?: string; curCopyTraderPnl?: string; investAmt?: string }[];
          };
          const latest = pnl.data?.[0];
          const stat = stats.data?.[0];
          card.windows.push({
            label: window.label,
            pnl: latest?.pnl == null ? null : Number(latest.pnl),
            roi: latest?.pnlRatio == null ? null : Number(latest.pnlRatio),
            winRatio: stat?.winRatio == null ? null : Number(stat.winRatio),
            sourceTime: latest?.beginTs == null ? null : Number(latest.beginTs),
          });
          if (window.lastDays === "3" && stat) {
            card.copyTraderPnl = stat.curCopyTraderPnl == null ? null : Number(stat.curCopyTraderPnl);
            card.aum = stat.investAmt == null ? null : Number(stat.investAmt);
          }
        }
      } catch (error) {
        card.error = text(error);
      }
      this.watchStats.set(watch.code, card);
    }
    this.watchFetchedAt = Date.now();
  }

  private readWhaleSuggestions(): void {
    const note = readNote(this.config.financasDir, "2_whales.md");
    if (!note || note.missing) {
      this.suggestions = [];
      return;
    }
    const found = note.content.match(/0x[a-fA-F0-9]{40}/g) ?? [];
    this.suggestions = [...new Set(found.map((item) => item.toLowerCase()))].slice(0, 20);
  }

  private async refreshTrader(address: string): Promise<void> {
    const current = this.cache.get(address) ?? emptyTrader(address);
    try {
      const state = (await hl({ type: "clearinghouseState", user: address })) as {
        marginSummary?: { accountValue?: string };
        assetPositions?: { position?: { coin?: string; szi?: string; entryPx?: string; leverage?: { value?: number }; unrealizedPnl?: string } }[];
      };
      const orders = (await hl({ type: "frontendOpenOrders", user: address })) as {
        coin?: string;
        isTrigger?: boolean;
        triggerPx?: string;
        orderType?: string;
        reduceOnly?: boolean;
      }[];
      const positions = (state.assetPositions ?? [])
        .map((item) => item.position)
        .filter((position) => position && Number(position.szi) !== 0)
        .map((position) => ({
          coin: String(position!.coin),
          size: Number(position!.szi),
          entry: Number(position!.entryPx),
          leverage: position!.leverage?.value ?? null,
          unrealized: Number(position!.unrealizedPnl),
        }));
      const leverage = new Map<string, number>();
      for (const position of positions) if (position.leverage != null) leverage.set(position.coin, position.leverage);
      const stops = new Map<string, number>();
      if (Array.isArray(orders)) {
        for (const order of orders) {
          const trigger = Number(order.triggerPx);
          const label = `${order.orderType ?? ""}`.toLowerCase();
          if (!order.coin || !(trigger > 0)) continue;
          if (order.isTrigger || label.includes("stop") || order.reduceOnly) stops.set(order.coin, trigger);
        }
      }
      const board = this.leaderboard.get(address);
      this.cache.set(address, {
        ...current,
        accountValue: Number(state.marginSummary?.accountValue) || null,
        displayName: board?.displayName ?? current.displayName,
        dayPnl: board && Number.isFinite(board.dayPnl) ? board.dayPnl : null,
        dayRoi: board && Number.isFinite(board.dayRoi) ? board.dayRoi : null,
        dayVolume: board && Number.isFinite(board.dayVolume) ? board.dayVolume : null,
        weekPnl: board && Number.isFinite(board.weekPnl) ? board.weekPnl : null,
        positions,
        leverage,
        stops,
        fills: current.fills,
        feedAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      current.error = text(error);
      current.updatedAt = Date.now();
      this.cache.set(address, current);
    }
  }

  private async pollFills(address: string): Promise<void> {
    const fills = (await hl({ type: "userFills", user: address })) as HlFill[];
    if (!Array.isArray(fills)) return;
    this.touchFeed(address);
    await this.ingest(address, fills, !this.book.seeded.includes(address), "rest");
    for (const fill of fills) {
      const id = fillId(fill);
      const known = this.cache.get(address)?.fills.some((item) => item.id === id);
      if (!id || known) continue;
      this.pushTape(address, fill, "rest", { outcome: "historico", reason: "histórico anterior ao acompanhamento — não copiado" });
    }
  }

  private async ingest(address: string, fills: HlFill[], seed: boolean, source: "ws" | "rest"): Promise<void> {
    const ordered = [...fills].sort((a, b) => Number(a.time) - Number(b.time));
    if (seed) {
      let outside = 0;
      for (const fill of ordered) {
        this.rememberFill(fill);
        const outsideCoin = !coinAllowed(String(fill.coin ?? ""));
        if (outsideCoin) outside += 1;
        this.pushTape(address, fill, source, {
          outcome: "historico",
          reason: outsideCoin ? "ativo fora da lista" : "histórico anterior ao acompanhamento — não copiado",
        });
      }
      if (outside > 0) {
        this.logEvent(address, null, "SKIP", `ativo fora da lista — ${outside} fills do histórico fora de BTC, ETH, SOL, BNB e XRP`);
      }
      this.book.seeded.push(address);
      this.persistBook();
      this.logEvent(address, null, "SYNC", "Histórico público marcado como já visto. Só fills novos e frescos podem ser copiados.");
      return;
    }
    for (const fill of ordered) await this.onFill(address, fill, source);
  }

  private async onFill(address: string, fill: HlFill, source: "ws" | "rest"): Promise<void> {
    if (this.alreadySeen(fill)) return;
    this.rememberFill(fill);
    const coin = String(fill.coin ?? "");
    const px = Number(fill.px);
    const kind = classifyFill(String(fill.dir ?? ""));
    const symbol = `${coin}USDT`;
    const position = this.book.positions.find((item) => item.address === address && item.coin === coin && item.qty > 0);
    const mark = await this.ensurePrice(symbol);
    if (!this.atrCache.has(symbol)) await this.cacheAtr(symbol);
    const unrealized = position && mark != null ? unrealizedCopy(position.side, position.entry, position.qty, mark) : position ? null : 0;
    const decision = decideCopy({
      now: Date.now(),
      fillTime: Number(fill.time),
      maxFillAgeMs: this.settings.maxFillAgeMs,
      coin,
      kind,
      fillPrice: px,
      binancePrice: mark,
      maxDeviationPct: this.settings.maxDeviationPct,
      blocked: this.book.latched,
      paused: this.isPaused(),
      dayPnl: this.dayPnlNow() ?? undefined,
      dailyLossUsd: this.settings.dailyLossUsd,
      maxOpenPositions: this.settings.maxOpenPositions,
      openPositions: this.book.positions
        .filter((item) => item.qty > 0)
        .map((item) => ({ coin: item.coin, side: item.side, qty: item.qty, stop: item.stop, entry: item.entry, mark: this.market.price(`${item.coin}USDT`) ?? item.lastMark })),
      sameSideOpen: Boolean(position && ((kind === "open-long" && position.side === "BUY") || (kind === "open-short" && position.side === "SELL"))),
      unrealizedPnl: unrealized,
      publicStop: this.cache.get(address)?.stops.get(coin) ?? null,
      atr: this.atrCache.get(symbol)?.atr ?? null,
      equity: this.riskEquity() ?? 0,
      freeCash: this.freeCash(),
      riskPct: this.settings.riskPct,
      feePctPerSide: 0.1,
      slippagePct: 0.02,
    });
    if (decision.action === "skip") {
      const age = Date.now() - Number(fill.time);
      const quiet =
        age > Math.max(this.settings.maxFillAgeMs * 2, 5 * 60_000) &&
        (decision.reason.startsWith("fill atrasado") || decision.reason === "ativo fora da lista");
      this.pushTape(address, fill, source, { outcome: "descartada", reason: decision.reason });
      if (!quiet) {
        const label = skipLabel(decision.reason);
        this.logEvent(address, coin, "SKIP", label === decision.reason ? decision.reason : `${label} — ${decision.reason}`);
      }
      return;
    }
    if (decision.action === "exit") {
      if (!position) {
        this.pushTape(address, fill, source, { outcome: "descartada", reason: "saída pública sem posição copiada aberta" });
        this.logEvent(address, coin, "SKIP", "saída pública sem posição copiada aberta");
        return;
      }
      const fraction = fractionClosed(fill);
      const copiedQty = position.qty * fraction;
      const pnl = this.closePosition(position, px, "EXIT", `${decision.reason}. Fração ${fraction.toFixed(2)}.`, fraction);
      this.pushTape(address, fill, source, {
        outcome: "copiada",
        reason: decision.reason,
        ourSide: position.side,
        ourQty: copiedQty,
        ourEntry: position.entry,
        ourStop: position.stop,
        ourPnl: pnl,
      });
      return;
    }
    const leverage = this.cache.get(address)?.leverage.get(coin) ?? null;
    const opened = this.openPosition(address, coin, decision, leverage);
    this.pushTape(address, fill, source, {
      outcome: "copiada",
      reason: decision.reason,
      ourSide: opened.side,
      ourQty: opened.qty,
      ourEntry: opened.entry,
      ourStop: opened.stop,
    });
  }

  private openPosition(address: string, coin: string, decision: Extract<ReturnType<typeof decideCopy>, { action: "enter" }>, leverage: number | null): BookPosition {
    const fee = decision.entryFill * decision.qty * 0.001;
    const cashDelta = decision.side === "BUY" ? -(decision.entryFill * decision.qty + fee) : decision.entryFill * decision.qty - fee;
    this.addCash(cashDelta);
    const position: BookPosition = {
      id: crypto.randomUUID(),
      address,
      coin,
      side: decision.side,
      qty: decision.qty,
      entry: decision.entryFill,
      stop: decision.stop,
      stopSource: decision.stopSource,
      sourceLeverage: leverage,
      openedAt: Date.now(),
      lastMark: decision.entryFill,
    };
    this.book.positions.unshift(position);
    this.book.volume += decision.notional;
    this.book.copies += 1;
    this.recordFill(`open:${position.id}`);
    this.persistBook();
    const side = decision.side === "BUY" ? "compra" : "venda";
    this.logEvent(address, coin, "MIRROR", `${side} 1x. ${decision.reason} Fonte ${leverage ?? "—"}x não é copiada.`);
    this.logEvent(address, coin, "FILL", `${side} qty ${decision.qty} a ${decision.entryFill.toFixed(4)}. Risco US$ ${decision.riskAmount.toFixed(2)}. Notional US$ ${decision.notional.toFixed(2)}.`);
    return position;
  }

  private closePosition(position: BookPosition, rawExit: number, action: "EXIT", reason: string, fraction = 1): number {
    const qty = Math.min(position.qty, position.qty * Math.min(1, Math.max(0, fraction)));
    if (!(qty > 0)) return 0;
    const exit = exitFill(position.side, rawExit);
    const closed = closeCash(position.side, position.entry, exit, qty, 0.1);
    this.addCash(closed.cashDelta);
    this.book.realized[position.address] = (this.book.realized[position.address] ?? 0) + closed.pnl;
    this.book.closed.push({ address: position.address, pnl: closed.pnl, ts: Date.now() });
    position.qty = Math.max(0, position.qty - qty);
    if (position.qty <= 1e-10) this.book.positions = this.book.positions.filter((item) => item.id !== position.id);
    this.recordFill(`exit:${position.id}:${this.book.closed.length}`);
    this.persistBook();
    this.stampPnl(position.address, position.coin, closed.pnl);
    this.logEvent(position.address, position.coin, action, `${reason} P&L US$ ${closed.pnl.toFixed(2)}.`);
    return closed.pnl;
  }

  private markStops(): void {
    for (const position of [...this.book.positions]) {
      const mark = this.market.price(`${position.coin}USDT`);
      if (mark == null) continue;
      position.lastMark = mark;
      const hit = position.side === "BUY" ? mark <= position.stop : mark >= position.stop;
      if (hit) this.closePosition(position, position.stop, "EXIT", `stop ${position.stopSource} atingido na Binance`);
    }
    this.applyDailyLatch();
  }

  private async ensurePrice(symbol: string): Promise<number | null> {
    const live = this.market.price(symbol);
    if (live != null) return live;
    const cached = this.atrCache.get(`px:${symbol}`);
    if (cached && Date.now() - cached.at < 15_000 && cached.atr != null) return cached.atr;
    try {
      const data = (await this.binance(`/api/v3/ticker/price?symbol=${symbol}`)) as { price?: string };
      const px = Number(data.price);
      if (px > 0) {
        this.atrCache.set(`px:${symbol}`, { at: Date.now(), atr: px });
        return px;
      }
    } catch {
      /* sem preço público para conferir */
    }
    return null;
  }

  private async cacheAtr(symbol: string): Promise<void> {
    const cached = this.atrCache.get(symbol);
    if (cached && Date.now() - cached.at < 5 * 60_000) return;
    try {
      const data = await this.binance(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=50`);
      if (!Array.isArray(data)) {
        this.atrCache.set(symbol, { at: Date.now(), atr: null });
        return;
      }
      const candles: Candle[] = data.map((row) => {
        const item = row as unknown[];
        return { openTime: Number(item[0]), open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]), volume: Number(item[5]) };
      });
      this.atrCache.set(symbol, { at: Date.now(), atr: atrOf(candles, 14) });
    } catch {
      this.atrCache.set(symbol, { at: Date.now(), atr: null });
    }
  }

  private async binance(pathname: string): Promise<unknown> {
    const bases = [this.config.restFallback, this.config.restPrimary];
    let last: unknown;
    for (const base of bases) {
      try {
        const response = await fetch(base + pathname, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("Binance indisponível");
  }

  private connectWs(): void {
    if (this.stopped) return;
    this.wsStatus = this.socket ? "reconectando" : "conectando";
    const ws = new WebSocket(HL_WS);
    this.socket = ws;
    ws.on("open", () => {
      this.wsStatus = "ao vivo";
      this.sendSubs();
    });
    ws.on("message", (raw) => {
      let msg: { channel?: string; data?: { user?: string; isSnapshot?: boolean; fills?: HlFill[] } };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.channel !== "userFills" || !msg.data?.user) return;
      const address = msg.data.user.toLowerCase();
      if (!this.traders.includes(address) || !msg.data.fills) return;
      this.touchFeed(address);
      void this.ingest(address, msg.data.fills, !this.book.seeded.includes(address), "ws");
    });
    ws.on("close", () => {
      if (this.stopped) return;
      this.wsStatus = "reconectando";
      setTimeout(() => this.connectWs(), 3_000);
    });
    ws.on("error", () => ws.terminate());
  }

  private resubscribe(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.sendSubs();
  }

  private sendSubs(): void {
    for (const address of this.traders) {
      this.socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: address } }));
    }
  }

  private traderView(address: string): CopyTraderView {
    const cache = this.cache.get(address);
    const fresh = cache?.feedAt != null && Date.now() - cache.feedAt <= FEED_STALE_MS;
    const midsFresh = this.midsAt > 0 && Date.now() - this.midsAt <= FEED_STALE_MS;
    return {
      address,
      displayName: cache?.displayName ?? null,
      accountValue: cache?.accountValue ?? null,
      dayPnl: cache?.dayPnl ?? null,
      dayRoi: cache?.dayRoi ?? null,
      dayVolume: cache?.dayVolume ?? null,
      weekPnl: cache?.weekPnl ?? null,
      copiedPnl: this.copiedPnl(address),
      positions: (cache?.positions ?? []).map((position) => ({
        coin: position.coin,
        side: position.size < 0 ? ("short" as const) : ("long" as const),
        size: Math.abs(position.size),
        entry: Number.isFinite(position.entry) ? position.entry : null,
        mark: fresh && midsFresh ? (this.mids[position.coin] ?? null) : null,
        leverage: position.leverage,
        unrealized: fresh && Number.isFinite(position.unrealized) ? position.unrealized : null,
      })),
      fills: (cache?.fills ?? []).map((fill) => this.withLiveCopyPnl(address, fill)),
      feedAgeMs: cache?.feedAt == null ? null : Date.now() - cache.feedAt,
      feedStale: !fresh,
      updatedAt: cache?.updatedAt ?? null,
      error: cache?.error ?? null,
    };
  }

  private withLiveCopyPnl(address: string, fill: CopyTapeFill): CopyTapeFill {
    if (fill.outcome !== "copiada" || fill.ourEntry == null) return fill;
    const open = this.book.positions.find((position) => position.address === address && position.coin === fill.coin && position.entry === fill.ourEntry);
    if (!open) return fill;
    return { ...fill, ourPnl: this.markOf(open) };
  }

  private equity(): number | null {
    if (this.settings.mode === "shared") return this.sim.equity();
    let equity = this.book.cash;
    for (const position of this.book.positions) {
      const mark = position.lastMark ?? this.market.price(`${position.coin}USDT`);
      if (mark == null) return null;
      equity += position.side === "BUY" ? mark * position.qty : -(mark * position.qty);
    }
    return equity;
  }

  private riskEquity(): number | null {
    return this.settings.mode === "shared" ? this.sim.equity() : this.equity();
  }

  private freeCash(): number {
    if (this.settings.mode === "shared") return this.sim.freeCash();
    const equity = this.equity();
    if (equity == null) return 0;
    return Math.max(0, Math.min(this.book.cash, equity));
  }

  private addCash(delta: number): void {
    this.book.cash += delta;
    if (this.settings.mode === "shared") this.sim.adjustCash(delta);
  }

  private bindSharedValue(): void {
    this.sim.setExternalValue(() => (this.settings.mode === "shared" ? this.marketValue() : 0));
  }

  private marketValue(): number {
    let value = 0;
    for (const position of this.book.positions) {
      const mark = position.lastMark ?? this.market.price(`${position.coin}USDT`);
      if (mark == null) continue;
      value += position.side === "BUY" ? mark * position.qty : -(mark * position.qty);
    }
    return value;
  }

  private markOf(position: BookPosition): number | null {
    const mark = this.market.price(`${position.coin}USDT`) ?? position.lastMark;
    if (mark == null) return null;
    return unrealizedCopy(position.side, position.entry, position.qty, mark);
  }

  private rollSession(now: number): void {
    const today = sessionDate(now);
    if (this.book.sessionDate === today) return;
    const equity = this.equity();
    this.book.sessionDate = today;
    this.book.sessionStartEquity = equity ?? (this.settings.mode === "shared" ? this.sim.freeCash() : this.book.cash);
    this.book.latched = null;
    this.persistBook();
    this.logEvent(null, null, "SYNC", "Nova sessão BRT da cópia. Limites diários reiniciados.");
  }

  private applyDailyLatch(): void {
    const equity = this.equity();
    if (equity == null) return;
    const decision = copySessionBlock({
      dayPnl: equity - this.book.sessionStartEquity,
      dailyLossUsd: this.settings.dailyLossUsd,
      dailyTargetUsd: this.settings.dailyTargetUsd,
      latched: this.book.latched,
    });
    if (decision.blocked === this.book.latched) return;
    this.book.latched = decision.blocked;
    this.persistBook();
    if (decision.reason) this.logEvent(null, null, "SKIP", `${skipLabel(decision.reason)} — ${decision.reason}`);
  }

  private blockReason(dayPnl: number | null): string | null {
    if (dayPnl == null) return null;
    return copySessionBlock({
      dayPnl,
      dailyLossUsd: this.settings.dailyLossUsd,
      dailyTargetUsd: this.settings.dailyTargetUsd,
      latched: this.book.latched,
    }).reason;
  }

  private alreadySeen(fill: HlFill): boolean {
    const id = fillId(fill);
    return Boolean((id && this.book.seen.includes(id)) || (fill.hash && this.book.seen.includes(fill.hash)));
  }

  private rememberFill(fill: HlFill): void {
    const id = fillId(fill);
    if (id) this.remember(id);
    if (fill.hash) this.remember(fill.hash);
  }

  private remember(id: string): void {
    this.book.seen.push(id);
    if (this.book.seen.length > 5_000) this.book.seen.splice(0, this.book.seen.length - 4_000);
  }

  private persistBook(): void {
    this.db.saveCopyBlob("copyBook", JSON.stringify(this.book));
  }

  private touchFeed(address: string): void {
    const cache = this.cache.get(address) ?? emptyTrader(address);
    cache.feedAt = Date.now();
    this.cache.set(address, cache);
  }

  private pushTape(
    address: string,
    fill: HlFill,
    source: "ws" | "rest",
    extra: Partial<CopyTapeFill> & Pick<CopyTapeFill, "outcome" | "reason">,
  ): void {
    const id = fillId(fill);
    if (!id) return;
    const cache = this.cache.get(address) ?? emptyTrader(address);
    const row: CopyTapeFill = {
      id,
      coin: String(fill.coin ?? ""),
      time: Number(fill.time),
      px: Number(fill.px),
      sz: Number(fill.sz),
      side: String(fill.side).toUpperCase() === "A" ? "SELL" : "BUY",
      dir: String(fill.dir ?? ""),
      source,
      outcome: extra.outcome,
      reason: extra.reason,
      ourSide: extra.ourSide ?? null,
      ourQty: extra.ourQty ?? null,
      ourEntry: extra.ourEntry ?? null,
      ourStop: extra.ourStop ?? null,
      ourPnl: extra.ourPnl ?? null,
    };
    cache.fills = [row, ...cache.fills.filter((item) => item.id !== id)].sort((a, b) => b.time - a.time).slice(0, 40);
    this.cache.set(address, cache);
  }

  private stampPnl(address: string, coin: string, pnl: number): void {
    const cache = this.cache.get(address);
    const row = cache?.fills.find((fill) => fill.outcome === "copiada" && fill.coin === coin && fill.ourPnl == null);
    if (row) row.ourPnl = pnl;
  }

  private recordFill(fillId: string): void {
    this.book.curve = appendFillPoint(this.book.curve, { t: Date.now(), equity: this.fillEquity(), fillId });
  }

  /** Patrimônio logo após um fill, marcado no preço desse fill. Não usa cotação posterior. */
  private fillEquity(): number {
    let equity = this.book.cash;
    for (const position of this.book.positions) {
      const mark = position.lastMark ?? position.entry;
      equity += position.side === "BUY" ? mark * position.qty : -(mark * position.qty);
    }
    return equity;
  }

  private copiedPnl(address: string): number | null {
    const realized = this.book.realized[address] ?? 0;
    let unrealized = 0;
    for (const position of this.book.positions.filter((item) => item.address === address)) {
      const mark = this.markOf(position);
      if (mark == null) return null;
      unrealized += mark;
    }
    return realized + unrealized;
  }

  private logEvent(address: string | null, coin: string | null, action: CopyLogTag, reason: string): void {
    const event: CopyEventView = { id: crypto.randomUUID(), ts: Date.now(), address, coin, action, reason };
    this.events.unshift(event);
    this.events = this.events.slice(0, 120);
    this.db.insertCopyEvent(event);
    this.log.info("copia", `${action} ${coin ?? ""} ${reason}`.trim());
  }
}

function emptyBook(): Book {
  const startedAt = Date.now();
  return {
    cash: COPY_DEFAULTS.initialCapital,
    startedAt,
    sessionDate: sessionDate(startedAt),
    sessionStartEquity: COPY_DEFAULTS.initialCapital,
    latched: null,
    volume: 0,
    copies: 0,
    seen: [],
    seeded: [],
    positions: [],
    curve: [{ t: startedAt, equity: COPY_DEFAULTS.initialCapital, fillId: "abertura" }],
    closed: [],
    realized: {},
  };
}

function normalizeTag(action: string): CopyLogTag {
  if (action === "entrada") return "FILL";
  if (action === "saida" || action === "stop") return "EXIT";
  if (action === "skip") return "SKIP";
  if (action === "SYNC" || action === "MIRROR" || action === "FILL" || action === "SKIP" || action === "TRACK" || action === "EXIT") return action;
  return "SYNC";
}

function emptyTrader(address: string): TraderCache {
  return {
    address,
    displayName: null,
    accountValue: null,
    dayPnl: null,
    dayRoi: null,
    dayVolume: null,
    weekPnl: null,
    positions: [],
    leverage: new Map(),
    stops: new Map(),
    fills: [],
    feedAt: null,
    updatedAt: null,
    error: null,
  };
}

const FEED_STALE_MS = 25_000;

function fillId(fill: HlFill): string | null {
  if (fill.time == null || !fill.coin || fill.px == null || fill.sz == null) return fill.hash ?? null;
  return `${fill.time}:${fill.coin}:${fill.px}:${fill.sz}:${fill.side ?? ""}:${fill.dir ?? ""}`;
}

function fractionClosed(fill: HlFill): number {
  const start = Math.abs(Number(fill.startPosition));
  const sz = Math.abs(Number(fill.sz));
  if (!(start > 0) || !(sz > 0)) return 1;
  return Math.min(1, sz / start);
}

function exitFill(side: "BUY" | "SELL", price: number): number {
  return entryFillPrice(side === "BUY" ? "SELL" : "BUY", price, 0.02);
}

function emptyWatch(watch: SeedWatch): CopyWatchView {
  return {
    name: watch.name,
    code: watch.code,
    profileUrl: `https://www.okx.com/copy-trading/account/${watch.code}?tab=trade`,
    fetchedAt: null,
    error: null,
    drawdown: null,
    aum: null,
    copyTraderPnl: null,
    windows: [],
  };
}

async function okx(pathname: string): Promise<unknown> {
  const response = await fetch(`https://www.okx.com${pathname}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
  const body = (await response.json()) as { code?: string; msg?: string };
  if (body.code && body.code !== "0") throw new Error(body.msg || `OKX ${body.code}`);
  return body;
}

async function hl(body: unknown): Promise<unknown> {
  const response = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

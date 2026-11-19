import type { DeskDb, SimPersisted, TradeRow } from "../db.js";
import { usdLimit, sessionDecision } from "../domain/risk.js";
import { applyBar, openPosition, openRiskAmount, positionMarketValue, unrealizedPnl, type SimPosition } from "../domain/simulator.js";
import type { SizeResult } from "../domain/risk.js";
import { sessionDate, sessionMonth, sessionWeekKey } from "../shared/time.js";
import { startOfCivilDay } from "../domain/reports.js";
import type { AccountView, AgentId, OrderView, SignalView } from "../shared/types.js";
import type { MarketHub } from "../market/hub.js";
import type { AlertCenter } from "./alerts.js";

type ActivityFn = (tag: "EXEC" | "FILL" | "RISK", text: string, symbol?: string | null) => void;

export class Simulator {
  cash = 0;
  peak = 0;
  lossStreak = 0;
  sessionLossStreak = 0;
  sessionDate = "";
  sessionStartEquity = 0;
  latched: SimPersisted["latched"] = null;
  blockReason: string | null = null;
  startedAt = 0;
  ready = false;
  trades: TradeRow[] = [];
  orders: OrderView[] = [];
  readonly lastExit = new Map<string, number>();
  private readonly watermarks = new Map<string, { high: number; low: number }>();
  private lastSnap = 0;
  private activity: ActivityFn = () => undefined;

  constructor(
    private readonly db: DeskDb,
    private readonly market: MarketHub,
    private readonly alerts: AlertCenter,
  ) {}

  bindActivity(fn: ActivityFn): void {
    this.activity = fn;
  }

  load(): void {
    const settings = this.db.getSettings();
    const saved = this.db.getSim();
    this.trades = this.db.listTrades();
    this.orders = this.db.recentOrders(80);
    if (!saved) {
      const now = Date.now();
      this.cash = settings.initialCapital;
      this.peak = this.cash;
      this.sessionDate = sessionDate(now);
      this.sessionStartEquity = this.cash;
      this.startedAt = now;
      this.db.insertEquity(now, this.cash);
      this.lastSnap = now;
      this.persist();
    } else {
      this.cash = saved.cash;
      this.peak = saved.peak;
      this.lossStreak = saved.lossStreak;
      this.sessionLossStreak = saved.sessionLossStreak;
      this.sessionDate = saved.sessionDate;
      this.sessionStartEquity = saved.sessionStartEquity;
      this.latched = saved.latched;
      this.blockReason = saved.blockReason;
      this.startedAt = saved.startedAt;
    }
    for (const trade of this.trades) {
      if (trade.status === "closed" && trade.closedAt) this.lastExit.set(`${trade.symbol}|${trade.style}`, trade.closedAt);
    }
    this.ready = true;
  }

  openTrades(): TradeRow[] {
    return this.trades.filter((trade) => trade.status === "open");
  }

  hasSymbol(symbol: string): boolean {
    return this.openTrades().some((trade) => trade.symbol === symbol);
  }

  private externalValue: () => number = () => 0;

  /** Valor de mercado de posições externas (cópia compartilhada). Não inclui alavancagem. */
  setExternalValue(fn: () => number): void {
    this.externalValue = fn;
  }

  adjustCash(delta: number): void {
    this.cash += delta;
    this.persist();
  }

  equity(): number | null {
    let equity = this.cash;
    for (const trade of this.openTrades()) {
      const mark = this.market.price(trade.symbol);
      if (mark == null) return null;
      equity += positionMarketValue(toSim(trade), mark);
    }
    equity += this.externalValue();
    return equity;
  }

  freeCash(): number {
    const equity = this.equity();
    if (equity == null) return 0;
    return Math.max(0, Math.min(this.cash, equity));
  }

  openRiskPct(): number {
    const equity = this.equity();
    if (equity == null || equity <= 0) return 0;
    const risk = this.openTrades().reduce((sum, trade) => sum + openRiskAmount(toSim(trade)), 0);
    return (risk / equity) * 100;
  }

  contributions(): Record<AgentId, number | null> {
    const ids: AgentId[] = ["market", "technical", "news", "signal", "risk"];
    if (!this.ready) {
      return { market: null, technical: null, news: null, signal: null, risk: null };
    }
    const sums: Record<AgentId, number> = { market: 0, technical: 0, news: 0, signal: 0, risk: 0 };
    for (const trade of this.trades) {
      const who = trade.contributors.filter((id): id is AgentId => ids.includes(id as AgentId));
      if (!who.length) continue;
      let pnl = trade.realizedPnl;
      if (trade.status === "open") {
        const mark = this.market.price(trade.symbol);
        if (mark != null) pnl += unrealizedPnl(toSim(trade), mark);
      }
      const share = pnl / who.length;
      for (const id of who) sums[id] += share;
    }
    return sums;
  }

  openFromSignal(signal: SignalView, size: SizeResult, contributors: string[]): void {
    if (signal.direction !== "BUY" && signal.direction !== "SELL") return;
    if (signal.entry == null || signal.stopLoss == null || signal.takeProfit1 == null || signal.takeProfit2 == null) return;
    if (this.hasSymbol(signal.symbol)) return;
    const settings = this.db.getSettings();
    const budgetBase = this.equity() ?? settings.initialCapital;
    const maxRisk = (budgetBase * settings.riskPerTradePct) / 100;
    if (size.riskAmount > maxRisk + 0.05) return;
    const opened = openPosition({
      side: signal.direction,
      qty: size.qty,
      entry: signal.entry,
      stop: signal.stopLoss,
      tp1: signal.takeProfit1,
      tp2: signal.takeProfit2,
      feePctPerSide: settings.feePctPerSide,
      slippagePct: settings.slippagePct,
    });
    this.cash += opened.cashDelta;
    const now = Date.now();
    const trade: TradeRow = {
      id: crypto.randomUUID(),
      signalId: signal.id,
      symbol: signal.symbol,
      style: signal.style,
      side: signal.direction,
      status: "open",
      qty: opened.position.qty,
      qtyOpen: opened.position.qtyOpen,
      entryFill: opened.position.entryFill,
      stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfit1,
      takeProfit2: signal.takeProfit2,
      tp1Hit: false,
      tp1At: null,
      fees: opened.position.fees,
      realizedPnl: opened.position.realizedPnl,
      feePct: settings.feePctPerSide,
      slippagePct: settings.slippagePct,
      openedAt: now,
      closedAt: null,
      closeReason: null,
      contributors,
    };
    this.trades.unshift(trade);
    this.watermarks.set(trade.id, { high: trade.entryFill, low: trade.entryFill });
    this.db.insertTrade(trade);
    this.recordOrder({
      symbol: trade.symbol,
      kind: "ENTRY",
      side: trade.side,
      reason: "OPEN",
      price: trade.entryFill,
      qty: trade.qty,
    });
    this.persist();
    const side = signal.direction === "BUY" ? "compra" : "venda";
    this.activity("EXEC", `${signal.symbol} ${side} simulada em ${signal.timeframe}. Risco orçado US$ ${size.riskAmount.toFixed(2)}.`, signal.symbol);
    this.alerts.push({
      kind: "opportunity",
      level: "info",
      title: `Simulação ${side} ${signal.symbol}`,
      body: signal.justification,
      symbol: signal.symbol,
      dedupeKey: `open:${trade.id}`,
      cooldownMs: 1,
    });
  }

  tick(): void {
    if (!this.ready) return;
    this.rollSession();
    for (const trade of this.openTrades()) {
      const mark = this.market.price(trade.symbol);
      if (mark == null) continue;
      const watermark = this.watermarks.get(trade.id) ?? { high: mark, low: mark };
      watermark.high = Math.max(watermark.high, mark);
      watermark.low = Math.min(watermark.low, mark);
      const effect = applyBar(toSim(trade), watermark.high, watermark.low, trade.feePct, trade.slippagePct);
      this.watermarks.set(trade.id, { high: mark, low: mark });
      if (!effect.events.length) continue;
      this.cash += effect.cashDelta;
      copySim(trade, effect.position);
      for (const event of effect.events) {
        if (event.kind === "TP1" || event.kind === "TP2" || event.kind === "SL") {
          this.recordOrder({
            symbol: trade.symbol,
            kind: "EXIT",
            side: trade.side === "BUY" ? "SELL" : "BUY",
            reason: event.kind,
            price: event.price,
            qty: event.qty,
          });
        }
        if (event.kind === "TP1") {
          trade.tp1At = Date.now();
          this.activity("FILL", `${trade.symbol} parcial no TP1.`, trade.symbol);
          this.alerts.push({
            kind: "take_profit",
            level: "info",
            title: `TP1 ${trade.symbol}`,
            body: "Metade da posição simulada saiu no primeiro alvo.",
            symbol: trade.symbol,
            dedupeKey: `tp1:${trade.id}`,
            cooldownMs: 1,
          });
        }
        if (event.kind === "SL") {
          this.activity("FILL", `${trade.symbol} stop simulado.`, trade.symbol);
          this.alerts.push({
            kind: "stop",
            level: "warning",
            title: `Stop ${trade.symbol}`,
            body: "A posição simulada bateu o stop.",
            symbol: trade.symbol,
            dedupeKey: `sl:${trade.id}`,
            cooldownMs: 1,
          });
        }
        if (event.kind === "TP2") {
          this.activity("FILL", `${trade.symbol} saída no TP2.`, trade.symbol);
          this.alerts.push({
            kind: "take_profit",
            level: "info",
            title: `TP2 ${trade.symbol}`,
            body: "O restante da posição simulada saiu no segundo alvo.",
            symbol: trade.symbol,
            dedupeKey: `tp2:${trade.id}`,
            cooldownMs: 1,
          });
        }
      }
      if (trade.status === "closed") {
        trade.closedAt = Date.now();
        if (trade.realizedPnl <= 0) {
          this.lossStreak += 1;
          this.sessionLossStreak += 1;
        } else {
          this.lossStreak = 0;
          this.sessionLossStreak = 0;
        }
        this.lastExit.set(`${trade.symbol}|${trade.style}`, trade.closedAt);
      }
      this.db.updateTrade(trade);
    }
    const equity = this.equity();
    if (equity != null) {
      if (equity > this.peak) this.peak = equity;
      this.applyLimits(equity);
      if (Date.now() - this.lastSnap > 60_000) {
        this.db.insertEquity(Date.now(), equity);
        this.lastSnap = Date.now();
      }
    }
    this.persist();
  }

  reset(): void {
    const settings = this.db.getSettings();
    const now = Date.now();
    this.db.resetSimulation();
    this.trades = [];
    this.orders = [];
    this.watermarks.clear();
    this.lastExit.clear();
    this.cash = settings.initialCapital;
    this.peak = this.cash;
    this.lossStreak = 0;
    this.sessionLossStreak = 0;
    this.latched = null;
    this.blockReason = null;
    this.sessionDate = sessionDate(now);
    this.sessionStartEquity = this.cash;
    this.startedAt = now;
    this.db.insertEquity(now, this.cash);
    this.lastSnap = now;
    this.persist();
    this.activity("RISK", "Simulação zerada. O caixa hipotético voltou ao capital inicial.", null);
  }

  view(now = Date.now()): AccountView {
    const settings = this.db.getSettings();
    const equity = this.ready ? this.equity() : null;
    const closed = this.trades.filter((trade) => trade.status === "closed");
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    const realized = this.trades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    let unrealized: number | null = 0;
    for (const trade of this.openTrades()) {
      const mark = this.market.price(trade.symbol);
      if (mark == null) {
        unrealized = null;
        break;
      }
      unrealized += unrealizedPnl(toSim(trade), mark);
    }
    const dayPnl = equity == null ? null : equity - this.sessionStartEquity;
    const dayBase = this.sessionStartEquity || settings.initialCapital;
    const weekBase = this.db.firstEquityOnOrAfter(startOfCivilDay(sessionWeekKey(now)));
    const monthBase = this.db.firstEquityOnOrAfter(startOfCivilDay(`${sessionMonth(now)}-01`));
    const curve = this.db.equityCurve(240);
    if (equity != null && (!curve.length || now - curve[curve.length - 1].t > 5_000)) {
      curve.push({ t: now, equity });
    }
    return {
      initialCapital: settings.initialCapital,
      cash: this.cash,
      equity,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      dayPnl,
      dayPnlPct: dayPnl == null || dayBase <= 0 ? null : (dayPnl / dayBase) * 100,
      weekPnl: equity == null || weekBase == null ? null : equity - weekBase,
      monthPnl: equity == null || monthBase == null ? null : equity - monthBase,
      peakEquity: this.ready ? this.peak : null,
      drawdownPct: equity == null || !(this.peak > 0) ? null : ((equity - this.peak) / this.peak) * 100,
      winRate: closed.length ? wins / closed.length : null,
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      lossStreak: this.lossStreak,
      sessionLossStreak: this.sessionLossStreak,
      openPositions: this.openTrades().length,
      openRiskPct: this.openRiskPct(),
      blocked: this.latched,
      blockReason: this.blockReason,
      sessionDate: this.sessionDate,
      equityCurve: curve,
      startedAt: this.startedAt || null,
      riskPerTradeUsd: usdLimit(settings, "risk"),
      dailyLossLimitUsd: usdLimit(settings, "loss"),
      dailyTargetUsd: usdLimit(settings, "target"),
      liveRiskUsd: equity == null ? null : (equity * settings.riskPerTradePct) / 100,
    };
  }

  private rollSession(): void {
    const today = sessionDate(Date.now());
    if (today === this.sessionDate) return;
    const equity = this.equity();
    this.sessionDate = today;
    this.sessionStartEquity = equity ?? this.cash;
    this.sessionLossStreak = 0;
    this.latched = null;
    this.blockReason = null;
    this.activity("RISK", "Nova sessão em America/Sao_Paulo. Limites diários reiniciados.", null);
  }

  private applyLimits(equity: number): void {
    const settings = this.db.getSettings();
    const decision = sessionDecision({
      dayPnl: equity - this.sessionStartEquity,
      sessionLossStreak: this.sessionLossStreak,
      settings,
      latched: this.latched,
    });
    if (decision.blocked === this.latched) return;
    this.latched = decision.blocked;
    this.blockReason = decision.reason;
    if (decision.blocked && decision.reason) {
      this.activity("RISK", decision.reason, null);
      this.alerts.push({
        kind: "risk_block",
        level: "warning",
        title: "Novas entradas bloqueadas",
        body: decision.reason,
        dedupeKey: `block:${this.sessionDate}:${decision.blocked}`,
        cooldownMs: 60_000,
      });
    }
  }

  private recordOrder(input: Omit<OrderView, "id" | "ts" | "status">): void {
    const order: OrderView = { id: crypto.randomUUID(), ts: Date.now(), status: "filled", ...input };
    this.orders.unshift(order);
    this.orders = this.orders.slice(0, 120);
    this.db.insertOrder(order);
  }

  private persist(): void {
    this.db.saveSim({
      cash: this.cash,
      peak: this.peak,
      lossStreak: this.lossStreak,
      sessionLossStreak: this.sessionLossStreak,
      sessionDate: this.sessionDate,
      sessionStartEquity: this.sessionStartEquity,
      latched: this.latched,
      blockReason: this.blockReason,
      startedAt: this.startedAt,
    });
  }
}

function toSim(trade: TradeRow): SimPosition {
  return {
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
  };
}

function copySim(trade: TradeRow, position: SimPosition): void {
  trade.qtyOpen = position.qtyOpen;
  trade.fees = position.fees;
  trade.realizedPnl = position.realizedPnl;
  trade.tp1Hit = position.tp1Hit;
  trade.status = position.status;
  trade.closeReason = position.closeReason;
}

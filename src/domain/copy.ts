import { entryFillPrice, exitFillPrice } from "./risk.js";
import { round } from "./indicators.js";

export const COPY_DEFAULTS = {
  mode: "separate" as const,
  initialCapital: 1000,
  riskPct: 0.5,
  dailyLossUsd: 15,
  dailyTargetUsd: 20,
  maxFillAgeMs: 60_000,
  maxDeviationPct: 0.3,
};

export interface CopySizeInput {
  equity: number;
  freeCash: number;
  riskPct: number;
  entry: number;
  stop: number;
  side: "BUY" | "SELL";
  feePctPerSide: number;
  slippagePct: number;
}

export interface CopySize {
  qty: number;
  notional: number;
  entryFill: number;
  riskAmount: number;
  cappedToCash: boolean;
}

const MIN_STOP_PCT = 0.0015;
const MAX_STOP_PCT = 0.06;

/** Risco percentual do patrimônio. O tamanho do trader não entra. Notional nunca passa do caixa (1x). */
export function sizeCopy(input: CopySizeInput): CopySize | { error: string } {
  if (!(input.equity > 0)) return { error: "capital inválido" };
  if (!(input.entry > 0) || !(input.stop > 0)) return { error: "preço ou stop inválido" };
  const fill = entryFillPrice(input.side, input.entry, input.slippagePct);
  const stopDistance = Math.abs(input.entry - input.stop);
  if (!(stopDistance > 0) || !(fill > 0)) return { error: "stop inválido" };
  const stopFrac = stopDistance / input.entry;
  const feeRate = input.feePctPerSide / 100;
  const riskAmount = input.equity * (input.riskPct / 100);
  const denom = stopFrac + 2 * feeRate;
  if (!(denom > 0)) return { error: "denominador de risco inválido" };
  let notional = riskAmount / denom;
  const free = Math.max(0, input.freeCash);
  const cappedToCash = notional > free;
  if (cappedToCash) notional = free;
  if (!(notional > 1)) return { error: "caixa livre insuficiente para copiar em 1x" };
  return {
    qty: round(notional / fill, 8),
    notional: round(notional, 8),
    entryFill: round(fill, 8),
    riskAmount: round(riskAmount, 8),
    cappedToCash,
  };
}

export function copySessionBlock(input: {
  dayPnl: number;
  dailyLossUsd: number;
  dailyTargetUsd: number;
  latched: null | "loss" | "profit";
}): { blocked: null | "loss" | "profit"; reason: string | null } {
  if (input.latched === "loss") {
    return { blocked: "loss", reason: `perda copiada do dia atingiu US$ ${input.dailyLossUsd.toFixed(2)} — novas cópias bloqueadas até a próxima sessão` };
  }
  if (input.latched === "profit") {
    return { blocked: "profit", reason: `meta copiada de US$ ${input.dailyTargetUsd.toFixed(2)} atingida — sem novas cópias nesta sessão` };
  }
  if (input.dayPnl <= -input.dailyLossUsd) {
    return { blocked: "loss", reason: `perda copiada do dia atingiu US$ ${input.dailyLossUsd.toFixed(2)} — novas cópias bloqueadas até a próxima sessão` };
  }
  if (input.dayPnl >= input.dailyTargetUsd) {
    return { blocked: "profit", reason: `meta copiada de US$ ${input.dailyTargetUsd.toFixed(2)} atingida — sem novas cópias nesta sessão` };
  }
  return { blocked: null, reason: null };
}

export type FillKind = "open-long" | "open-short" | "close-long" | "close-short" | "unknown";

export function classifyFill(dir: string): FillKind {
  const text = dir.toLowerCase();
  if (text.includes("open long") || text === "buy") return "open-long";
  if (text.includes("open short")) return "open-short";
  if (text.includes("close long")) return "close-long";
  if (text.includes("close short") || text.includes("short > long") || text.includes("long > short")) {
    if (text.includes("close short") || text.includes("short > long")) return "close-short";
    return "close-long";
  }
  if (text.includes("liquidation")) return text.includes("short") ? "close-short" : "close-long";
  return "unknown";
}

export interface StopChoice {
  stop: number | null;
  source: "publico" | "atr" | null;
  reason: string | null;
}

export function chooseStop(input: {
  side: "BUY" | "SELL";
  entry: number;
  publicStop: number | null;
  atr: number | null;
}): StopChoice {
  const publicOk = validStop(input.side, input.entry, input.publicStop);
  if (publicOk) return { stop: input.publicStop, source: "publico", reason: null };
  if (input.atr == null || !(input.atr > 0)) {
    return { stop: null, source: null, reason: "sem stop público e sem ATR da Binance para montar o stop" };
  }
  const raw = input.side === "BUY" ? input.entry - input.atr * 1.5 : input.entry + input.atr * 1.5;
  if (!validStop(input.side, input.entry, raw)) {
    return { stop: null, source: null, reason: "ATR não produziu stop entre 0,15% e 6% do preço" };
  }
  return { stop: raw, source: "atr", reason: null };
}

function validStop(side: "BUY" | "SELL", entry: number, stop: number | null): stop is number {
  if (stop == null || !(stop > 0) || !(entry > 0)) return false;
  if (side === "BUY" && !(stop < entry)) return false;
  if (side === "SELL" && !(stop > entry)) return false;
  const dist = Math.abs(entry - stop) / entry;
  return dist >= MIN_STOP_PCT && dist <= MAX_STOP_PCT;
}

export interface DecideInput {
  now: number;
  fillTime: number;
  maxFillAgeMs: number;
  coin: string;
  kind: FillKind;
  fillPrice: number;
  binancePrice: number | null;
  maxDeviationPct: number;
  blocked: null | "loss" | "profit";
  sameSideOpen: boolean;
  unrealizedPnl: number | null;
  publicStop: number | null;
  atr: number | null;
  equity: number;
  freeCash: number;
  riskPct: number;
  feePctPerSide: number;
  slippagePct: number;
}

export type CopyDecision =
  | { action: "skip"; reason: string }
  | { action: "exit"; reason: string }
  | {
      action: "enter";
      reason: string;
      side: "BUY" | "SELL";
      stop: number;
      stopSource: "publico" | "atr";
      qty: number;
      notional: number;
      entryFill: number;
      riskAmount: number;
    };

export const COPY_COINS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP"]);

export function coinAllowed(coin: string): boolean {
  const base = coin.split(":").pop()?.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() ?? "";
  return COPY_COINS.has(base);
}

export function decideCopy(input: DecideInput): CopyDecision {
  if (!coinAllowed(input.coin)) return { action: "skip", reason: "ativo fora da lista" };
  const age = input.now - input.fillTime;
  if (!(input.fillTime > 0) || age > input.maxFillAgeMs) {
    return { action: "skip", reason: `fill atrasado (${Math.max(0, Math.round(age / 1000))}s > ${Math.round(input.maxFillAgeMs / 1000)}s)` };
  }
  if (input.kind === "unknown") return { action: "skip", reason: "direção do fill público não reconhecida" };
  if (input.kind === "close-long" || input.kind === "close-short") {
    return { action: "exit", reason: `saída copiada (${input.kind})` };
  }
  if (input.binancePrice == null || !(input.binancePrice > 0)) {
    return { action: "skip", reason: "preço Binance indisponível para conferir o fill" };
  }
  const deviation = (Math.abs(input.fillPrice - input.binancePrice) / input.binancePrice) * 100;
  if (deviation > input.maxDeviationPct) {
    return { action: "skip", reason: `preço Hyperliquid desviou ${deviation.toFixed(2)}% da Binance (máx. ${input.maxDeviationPct}%)` };
  }
  if (input.blocked === "loss" || input.blocked === "profit") {
    return { action: "skip", reason: input.blocked === "loss" ? "limite de perda diária da cópia" : "meta diária da cópia atingida" };
  }
  const side = input.kind === "open-long" ? "BUY" : "SELL";
  if (input.sameSideOpen && input.unrealizedPnl != null && input.unrealizedPnl < 0) {
    return { action: "skip", reason: "não copia aumento em posição perdedora" };
  }
  const stop = chooseStop({ side, entry: input.fillPrice, publicStop: null, atr: input.atr });
  if (stop.stop == null || stop.source == null) return { action: "skip", reason: stop.reason ?? "stop indefinido" };
  const sized = sizeCopy({
    equity: input.equity,
    freeCash: input.freeCash,
    riskPct: input.riskPct,
    entry: input.fillPrice,
    stop: stop.stop,
    side,
    feePctPerSide: input.feePctPerSide,
    slippagePct: input.slippagePct,
  });
  if ("error" in sized) return { action: "skip", reason: sized.error };
  const via = stop.source === "publico" ? "stop público do trader" : "stop por ATR da Binance";
  const cap = sized.cappedToCash ? " Tamanho limitado ao caixa, 1x, sem alavancagem." : " Tamanho recalculado. Sem alavancagem.";
  return {
    action: "enter",
    reason: `${via}.${cap}`,
    side,
    stop: stop.stop,
    stopSource: stop.source,
    qty: sized.qty,
    notional: sized.notional,
    entryFill: sized.entryFill,
    riskAmount: sized.riskAmount,
  };
}

export interface FillEquityPoint {
  t: number;
  equity: number;
  fillId: string;
}

/** Só entra no gráfico um ponto ligado a um fill simulado gravado. Sem fill, a curva não anda. */
export function appendFillPoint(points: FillEquityPoint[], point: FillEquityPoint): FillEquityPoint[] {
  if (!point.fillId || !Number.isFinite(point.equity) || !Number.isFinite(point.t)) return points;
  if (points.some((item) => item.fillId === point.fillId)) return points;
  return [...points, point].sort((a, b) => a.t - b.t);
}

export function drawdownFromPoints(points: { equity: number }[]): number | null {
  if (!points.length) return null;
  let peak = points[0].equity;
  let drawdown = 0;
  for (const point of points) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) drawdown = Math.min(drawdown, ((point.equity - peak) / peak) * 100);
  }
  return drawdown;
}

export function winStreak(pnls: number[]): number {
  let streak = 0;
  for (let i = pnls.length - 1; i >= 0; i -= 1) {
    if (pnls[i] > 0) streak += 1;
    else break;
  }
  return streak;
}

export function skipLabel(reason: string): string {
  if (/atrasado/i.test(reason)) return "dado atrasado";
  if (/desvi/i.test(reason)) return "preço divergente";
  if (/perdedora|médio|media/i.test(reason)) return "médio para baixo";
  if (/alavanc/i.test(reason)) return "alavancagem";
  if (/caixa|capital inválido|perda|meta|risco/i.test(reason)) return "risk cap";
  return reason;
}

export function priceDeviationPct(hyperliquid: number, binance: number): number | null {
  if (!(hyperliquid > 0) || !(binance > 0)) return null;
  return (Math.abs(hyperliquid - binance) / binance) * 100;
}

export function unrealizedCopy(side: "BUY" | "SELL", entry: number, qty: number, mark: number): number {
  return side === "BUY" ? (mark - entry) * qty : (entry - mark) * qty;
}

export function closeCash(side: "BUY" | "SELL", entry: number, exit: number, qty: number, feePct: number): { cashDelta: number; pnl: number; fee: number } {
  const fill = exitFillPrice(side, exit, 0);
  const fee = Math.abs(fill * qty) * (feePct / 100);
  const pnl = side === "BUY" ? (fill - entry) * qty - fee : (entry - fill) * qty - fee;
  const cashDelta = side === "BUY" ? fill * qty - fee : -(fill * qty + fee);
  return { cashDelta, pnl, fee };
}

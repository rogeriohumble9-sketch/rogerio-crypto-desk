import type { RiskSettings } from "../shared/types.js";
import { round } from "./indicators.js";
import { MIN_RR, riskReward } from "./signals.js";

export const DEFAULT_SETTINGS: RiskSettings = {
  initialCapital: 1000,
  riskPerTradePct: 0.5,
  dailyLossLimitPct: 1.5,
  dailyProfitTargetPct: 2,
  feePctPerSide: 0.1,
  slippagePct: 0.02,
  maxOpenPositions: 4,
  maxLossStreak: 4,
  extremeVolAtrPct: 4,
  maxTotalRiskPct: 4,
};

/** Limites em dólar sobre o capital inicial. No padrão: risco US$ 5 (0,5%), perda diária US$ 15, meta US$ 20. */
export function usdLimit(settings: RiskSettings, kind: "risk" | "loss" | "target"): number {
  const pct =
    kind === "risk" ? settings.riskPerTradePct : kind === "loss" ? settings.dailyLossLimitPct : settings.dailyProfitTargetPct;
  return (settings.initialCapital * pct) / 100;
}

export function sessionDecision(input: {
  dayPnl: number;
  sessionLossStreak: number;
  settings: RiskSettings;
  latched: null | "loss" | "profit" | "streak";
}): { blocked: null | "loss" | "profit" | "streak"; reason: string | null } {
  if (input.latched === "loss" || input.latched === "profit") {
    const reason =
      input.latched === "loss"
        ? `limite de perda diária de US$ ${usdLimit(input.settings, "loss").toFixed(2)} atingido — bloqueado até a próxima sessão`
        : `meta diária de US$ ${usdLimit(input.settings, "target").toFixed(2)} atingida — sem novas entradas nesta sessão`;
    return { blocked: input.latched, reason };
  }
  const lossLimit = usdLimit(input.settings, "loss");
  const target = usdLimit(input.settings, "target");
  if (input.dayPnl <= -lossLimit) {
    return {
      blocked: "loss",
      reason: `limite de perda diária de US$ ${lossLimit.toFixed(2)} atingido — bloqueado até a próxima sessão`,
    };
  }
  if (input.dayPnl >= target) {
    return {
      blocked: "profit",
      reason: `meta diária de US$ ${target.toFixed(2)} atingida — sem novas entradas nesta sessão`,
    };
  }
  if (input.sessionLossStreak >= input.settings.maxLossStreak) {
    return {
      blocked: "streak",
      reason: `sequência de ${input.sessionLossStreak} perdas na sessão atingiu o limite`,
    };
  }
  return { blocked: null, reason: null };
}

export interface SizeInput {
  equity: number;
  freeCash: number;
  riskPct: number;
  entry: number;
  stop: number;
  side: "BUY" | "SELL";
  feePctPerSide: number;
  slippagePct: number;
}

export interface SizeResult {
  qty: number;
  notional: number;
  entryFill: number;
  riskAmount: number;
  stopDistancePct: number;
}

export function entryFillPrice(side: "BUY" | "SELL", price: number, slippagePct: number): number {
  const s = slippagePct / 100;
  return side === "BUY" ? price * (1 + s) : price * (1 - s);
}

export function exitFillPrice(side: "BUY" | "SELL", price: number, slippagePct: number): number {
  const s = slippagePct / 100;
  return side === "BUY" ? price * (1 - s) : price * (1 + s);
}

/**
 * Notional limitado pelo caixa e pelo risco.
 * A perda até o stop, mais as duas taxas, aproxima o orçamento de risco.
 */
export function sizePosition(input: SizeInput): SizeResult | { error: string } {
  if (!(input.equity > 0)) return { error: "capital inválido" };
  if (!(input.entry > 0) || !(input.stop > 0)) return { error: "preço ou stop inválido" };
  const fill = entryFillPrice(input.side, input.entry, input.slippagePct);
  if (!(fill > 0)) return { error: "preço de entrada inválido" };
  const stopDistance = Math.abs(input.entry - input.stop);
  if (!(stopDistance > 0)) return { error: "stop inválido" };
  const stopFrac = stopDistance / input.entry;
  const feeRate = input.feePctPerSide / 100;
  const riskAmount = input.equity * (input.riskPct / 100);
  const denom = stopFrac + 2 * feeRate;
  if (!(denom > 0)) return { error: "denominador de risco inválido" };
  let notional = riskAmount / denom;
  const free = Math.max(0, input.freeCash);
  if (notional > free) notional = free;
  if (notional < 10) return { error: "caixa livre insuficiente para o tamanho mínimo de US$ 10" };
  const qty = notional / fill;
  return {
    qty: round(qty, 8),
    notional: round(notional, 8),
    entryFill: round(fill, 8),
    riskAmount: round(riskAmount, 8),
    stopDistancePct: round(stopFrac * 100, 4),
  };
}

export interface ReviewInput {
  direction: "BUY" | "SELL" | "WAIT" | "DATA_UNAVAILABLE";
  entry: number | null;
  stop: number | null;
  takeProfit1: number | null;
  rr: number | null;
  dataStale: boolean;
  duplicate: boolean;
  extremeVol: boolean;
  sessionBlocked: null | "loss" | "profit";
  sessionLossStreak: number;
  openPositions: number;
  openRiskPct: number;
  settings: RiskSettings;
  equity: number;
  freeCash: number;
}

export type ReviewDecision = { ok: true; size: SizeResult } | { ok: false; reason: string };

export function reviewSignal(input: ReviewInput): ReviewDecision {
  if (input.dataStale || input.direction === "DATA_UNAVAILABLE") {
    return { ok: false, reason: "dados defasados — sinal não publicado" };
  }
  if (input.direction !== "BUY" && input.direction !== "SELL") {
    return { ok: false, reason: "sem confluência suficiente para compra ou venda" };
  }
  if (input.entry == null || input.stop == null || input.takeProfit1 == null) {
    return { ok: false, reason: "geometria incompleta" };
  }
  const rr = input.rr ?? riskReward(input.entry, input.stop, input.takeProfit1);
  if (rr == null || rr < MIN_RR - 1e-9) {
    return { ok: false, reason: `risco/retorno ${rr == null ? "inválido" : rr.toFixed(2)} abaixo de 1:${MIN_RR}` };
  }
  if (input.sessionBlocked === "loss") {
    return { ok: false, reason: "limite de perda diária atingido — novas entradas bloqueadas até a próxima sessão" };
  }
  if (input.sessionBlocked === "profit") {
    return { ok: false, reason: "meta diária de lucro atingida — mesa protege o dia e não abre nova entrada" };
  }
  if (input.sessionLossStreak >= input.settings.maxLossStreak) {
    return { ok: false, reason: `sequência de ${input.sessionLossStreak} perdas na sessão atingiu o limite` };
  }
  if (input.extremeVol) {
    return { ok: false, reason: `volatilidade extrema (ATR acima de ${input.settings.extremeVolAtrPct}%)` };
  }
  if (input.duplicate) {
    return { ok: false, reason: "já existe exposição ou sinal ativo neste ativo e estilo" };
  }
  if (input.openPositions >= input.settings.maxOpenPositions) {
    return { ok: false, reason: "número máximo de posições simuladas abertas" };
  }
  if (input.openRiskPct >= input.settings.maxTotalRiskPct - 1e-9) {
    return { ok: false, reason: "risco agregado das posições abertas no limite" };
  }
  const size = sizePosition({
    equity: input.equity,
    freeCash: input.freeCash,
    riskPct: input.settings.riskPerTradePct,
    entry: input.entry,
    stop: input.stop,
    side: input.direction,
    feePctPerSide: input.settings.feePctPerSide,
    slippagePct: input.settings.slippagePct,
  });
  if ("error" in size) return { ok: false, reason: size.error };
  const projectedRisk = input.openRiskPct + input.settings.riskPerTradePct;
  if (projectedRisk > input.settings.maxTotalRiskPct + 1e-9) {
    return { ok: false, reason: "esta entrada estouraria o risco agregado da mesa" };
  }
  return { ok: true, size };
}

export function clampSettings(input: Partial<RiskSettings>): { ok: true; value: RiskSettings } | { ok: false; error: string } {
  const merged: RiskSettings = { ...DEFAULT_SETTINGS, ...input };
  const rules: [keyof RiskSettings, number, number][] = [
    ["initialCapital", 100, 1_000_000],
    ["riskPerTradePct", 0.1, 5],
    ["dailyLossLimitPct", 0.5, 20],
    ["dailyProfitTargetPct", 0.5, 50],
    ["feePctPerSide", 0, 1],
    ["slippagePct", 0, 1],
    ["maxOpenPositions", 1, 20],
    ["maxLossStreak", 2, 10],
    ["extremeVolAtrPct", 1, 20],
    ["maxTotalRiskPct", 0.5, 20],
  ];
  for (const [key, min, max] of rules) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { ok: false, error: `${key} deve ficar entre ${min} e ${max}` };
    }
    (merged[key] as number) = key === "maxOpenPositions" || key === "maxLossStreak" ? Math.round(value) : value;
  }
  return { ok: true, value: merged };
}

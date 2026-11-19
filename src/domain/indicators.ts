import type { Candle } from "../shared/types.js";

export function round(n: number, digits = 8): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** EMA com semente na SMA. Índices anteriores ao período ficam null. */
export function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function smaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function lastNumber(series: Array<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

/**
 * RSI de Wilder. Retorna null se não houver períodos suficientes.
 * Série plana (ganho e perda médios zerados) devolve 50.
 */
export function rsi(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
  histogramPrev: number | null;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const line: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastE[i] != null && slowE[i] != null) line.push((fastE[i] as number) - (slowE[i] as number));
  }
  if (line.length < signalPeriod) return null;
  const sig = emaSeries(line, signalPeriod);
  const last = line.length - 1;
  if (sig[last] == null) return null;
  const histogram = line[last] - (sig[last] as number);
  let histogramPrev: number | null = null;
  if (last - 1 >= 0 && sig[last - 1] != null) {
    histogramPrev = line[last - 1] - (sig[last - 1] as number);
  }
  return { macd: line[last], signal: sig[last] as number, histogram, histogramPrev };
}

/** Desvio-padrão populacional (divisor n), como nas Bandas de Bollinger clássicas. */
export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: number; middle: number; lower: number } | null {
  if (closes.length < period || period <= 0) return null;
  const window = closes.slice(-period);
  const middle = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: middle + mult * sd, middle, lower: middle - mult * sd };
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1 || period <= 0) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let value = 0;
  for (let i = 0; i < period; i++) value += trs[i];
  value /= period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

/** Desvio-padrão amostral dos retornos simples da janela, em percentual. */
export function realizedVolPct(closes: number[], period = 20): number | null {
  if (closes.length < period + 1 || period <= 1) return null;
  const slice = closes.slice(-(period + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] === 0) return null;
    rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

export interface Swings {
  highs: number[];
  lows: number[];
}

export function swingPoints(candles: Candle[], wing = 3): Swings {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = wing; i < candles.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

export function structureOf(candles: Candle[], wing = 3): "alta" | "baixa" | "lateral" {
  const { highs, lows } = swingPoints(candles, wing);
  if (highs.length < 2 || lows.length < 2) return "lateral";
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows[lows.length - 1] < lows[lows.length - 2];
  if (hh && hl) return "alta";
  if (lh && ll) return "baixa";
  return "lateral";
}

export function breakoutOf(candles: Candle[], lookback = 20): "alta" | "baixa" | null {
  if (candles.length < lookback + 1) return null;
  const prev = candles.slice(-(lookback + 1), -1);
  const last = candles[candles.length - 1];
  const maxH = Math.max(...prev.map((c) => c.high));
  const minL = Math.min(...prev.map((c) => c.low));
  if (last.close > maxH) return "alta";
  if (last.close < minL) return "baixa";
  return null;
}

export function reversalHint(candles: Candle[]): string | null {
  if (candles.length < 2) return null;
  const a = candles[candles.length - 2];
  const b = candles[candles.length - 1];
  const bullEngulf = a.close < a.open && b.close > b.open && b.close >= a.open && b.open <= a.close;
  const bearEngulf = a.close > a.open && b.close < b.open && b.close <= a.open && b.open >= a.close;
  if (bullEngulf) return "engolfo de alta";
  if (bearEngulf) return "engolfo de baixa";
  const body = Math.abs(b.close - b.open);
  const range = b.high - b.low;
  if (range > 0 && body / range < 0.35) {
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const upperWick = b.high - Math.max(b.open, b.close);
    if (lowerWick > body * 2 && lowerWick > upperWick) return "martelo (pavio inferior)";
    if (upperWick > body * 2 && upperWick > lowerWick) return "estrela cadente (pavio superior)";
  }
  return null;
}

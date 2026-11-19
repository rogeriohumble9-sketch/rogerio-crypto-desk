import type { Candle, Interval, TechCell } from "../shared/types.js";
import {
  atr,
  bollinger,
  breakoutOf,
  emaSeries,
  lastNumber,
  macd,
  realizedVolPct,
  reversalHint,
  rsi,
  smaSeries,
  structureOf,
  swingPoints,
} from "./indicators.js";

export interface FrameSnapshot {
  interval: Interval;
  close: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  sma200: number | null;
  rsi: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  atr: number | null;
  atrPct: number | null;
  realizedVolPct: number | null;
  volume: number;
  volumeSma: number | null;
  swingLow: number | null;
  swingHigh: number | null;
  structure: "alta" | "baixa" | "lateral";
  breakout: "alta" | "baixa" | null;
  reversal: string | null;
  stale: boolean;
}

export function buildFrame(candles: Candle[], interval: Interval, stale: boolean): FrameSnapshot | null {
  if (candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const e9 = lastNumber(emaSeries(closes, 9));
  const e21 = lastNumber(emaSeries(closes, 21));
  const e50 = lastNumber(emaSeries(closes, 50));
  const s200 = lastNumber(smaSeries(closes, 200));
  const rsiV = rsi(closes, 14);
  const macdV = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atrV = atr(candles, 14);
  const volSma = lastNumber(smaSeries(volumes, 20));
  const swings = swingPoints(candles, 3);
  const atrPct = atrV != null && last.close > 0 ? (atrV / last.close) * 100 : null;
  return {
    interval,
    close: last.close,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    sma200: s200,
    rsi: rsiV,
    macdHist: macdV?.histogram ?? null,
    macdHistPrev: macdV?.histogramPrev ?? null,
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    atr: atrV,
    atrPct,
    realizedVolPct: realizedVolPct(closes, 20),
    volume: last.volume,
    volumeSma: volSma,
    swingLow: swings.lows.length ? swings.lows[swings.lows.length - 1] : null,
    swingHigh: swings.highs.length ? swings.highs[swings.highs.length - 1] : null,
    structure: structureOf(candles, 3),
    breakout: breakoutOf(candles, 20),
    reversal: reversalHint(candles),
    stale,
  };
}

export function frameToCell(frame: FrameSnapshot | null, interval: Interval, stale: boolean, note: string): TechCell {
  if (!frame) {
    return {
      interval,
      close: null,
      rsi: null,
      macdHist: null,
      ema9: null,
      ema21: null,
      ema50: null,
      sma200: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
      atr: null,
      atrPct: null,
      realizedVolPct: null,
      structure: "indisponivel",
      volumeRatio: null,
      breakout: null,
      reversal: null,
      support: null,
      resistance: null,
      stale: true,
      note,
    };
  }
  const volumeRatio = frame.volumeSma && frame.volumeSma > 0 ? frame.volume / frame.volumeSma : null;
  return {
    interval,
    close: frame.close,
    rsi: frame.rsi,
    macdHist: frame.macdHist,
    ema9: frame.ema9,
    ema21: frame.ema21,
    ema50: frame.ema50,
    sma200: frame.sma200,
    bbUpper: frame.bbUpper,
    bbMiddle: frame.bbMiddle,
    bbLower: frame.bbLower,
    atr: frame.atr,
    atrPct: frame.atrPct,
    realizedVolPct: frame.realizedVolPct,
    structure: frame.stale ? "indisponivel" : frame.structure,
    volumeRatio,
    breakout: frame.breakout,
    reversal: frame.reversal,
    support: frame.swingLow,
    resistance: frame.swingHigh,
    stale: frame.stale || stale,
    note,
  };
}

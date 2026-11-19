import { describe, expect, it } from "vitest";
import { atr, bollinger, emaSeries, macd, realizedVolPct, rsi, smaSeries } from "../src/domain/indicators.js";
import type { Candle } from "../src/shared/types.js";

describe("indicadores", () => {
  it("calcula a EMA com semente na média", () => {
    const series = emaSeries([1, 2, 3, 4, 5], 3);
    expect(series[2]).toBeCloseTo(2);
    expect(series[3]).toBeCloseTo(3);
    expect(series[4]).toBeCloseTo(4);
  });

  it("calcula a SMA", () => {
    expect(smaSeries([1, 2, 3, 4, 5], 2)).toEqual([null, 1.5, 2.5, 3.5, 4.5]);
  });

  it("calcula o RSI de Wilder num caso curto", () => {
    expect(rsi([1, 2, 3, 2, 2, 3], 3)).toBeCloseTo(80.95238095, 4);
  });

  it("devolve RSI 100 em alta contínua e 50 em série plana", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)).toBe(100);
    expect(rsi(Array.from({ length: 20 }, () => 10), 14)).toBe(50);
  });

  it("zera o MACD de uma série constante", () => {
    const result = macd(Array.from({ length: 50 }, () => 5));
    expect(result).not.toBeNull();
    expect(result!.macd).toBeCloseTo(0, 8);
    expect(result!.histogram).toBeCloseTo(0, 8);
  });

  it("calcula Bollinger com desvio populacional", () => {
    const bands = bollinger([1, 3], 2, 2);
    expect(bands!.middle).toBe(2);
    expect(bands!.upper).toBeCloseTo(4);
    expect(bands!.lower).toBeCloseTo(0);
  });

  it("calcula o ATR de Wilder", () => {
    const candles: Candle[] = [
      { openTime: 1, open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { openTime: 2, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { openTime: 3, open: 11, high: 11, low: 8, close: 9, volume: 1 },
    ];
    expect(atr(candles, 2)).toBeCloseTo(3);
  });

  it("mede volatilidade realizada zero numa série parada", () => {
    expect(realizedVolPct(Array.from({ length: 30 }, () => 20), 20)).toBeCloseTo(0);
  });
});

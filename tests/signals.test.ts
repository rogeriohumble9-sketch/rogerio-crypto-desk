import { describe, expect, it } from "vitest";
import type { FrameSnapshot } from "../src/domain/analyze.js";
import { MIN_RR, buildSignal, riskReward } from "../src/domain/signals.js";

function frame(partial: Partial<FrameSnapshot> = {}): FrameSnapshot {
  return {
    interval: "5m",
    close: 100,
    ema9: 101,
    ema21: 99,
    ema50: 98,
    sma200: 90,
    rsi: 55,
    macdHist: 0.2,
    macdHistPrev: 0.1,
    bbUpper: 110,
    bbMiddle: 100,
    bbLower: 90,
    atr: 1.2,
    atrPct: 1.2,
    realizedVolPct: 0.4,
    volume: 100,
    volumeSma: 80,
    swingLow: 97,
    swingHigh: 130,
    structure: "alta",
    breakout: null,
    reversal: null,
    stale: false,
    ...partial,
  };
}

describe("sinais e R:R", () => {
  it("exige no mínimo 1:2", () => {
    expect(MIN_RR).toBe(2);
    expect(riskReward(100, 95, 110)).toBeCloseTo(2);
    expect(riskReward(100, 95, 106)! < 2).toBe(true);
  });

  it("publica compra só com tendência, gatilho e confluência", () => {
    const signal = buildSignal({
      style: "SCALPING",
      primary: frame(),
      confirm: frame({ interval: "15m" }),
      regime: "alta",
      tickerStale: false,
    });
    expect(signal.direction).toBe("BUY");
    expect(signal.tradable).toBe(true);
    expect(signal.rr!).toBeGreaterThanOrEqual(2);
    expect(signal.entry).toBe(100);
    expect(signal.stopLoss!).toBeLessThan(100);
    expect(signal.takeProfit1!).toBeGreaterThan(signal.entry!);
  });

  it("não publica compra contra o regime de baixa", () => {
    const signal = buildSignal({
      style: "SCALPING",
      primary: frame(),
      confirm: frame({ interval: "15m" }),
      regime: "baixa",
      tickerStale: false,
    });
    expect(signal.direction).not.toBe("BUY");
    expect(signal.tradable).toBe(false);
  });

  it("recusa alvo quando a resistência não comporta 1:2", () => {
    const signal = buildSignal({
      style: "SCALPING",
      primary: frame({ swingHigh: 102 }),
      confirm: frame({ interval: "15m" }),
      regime: "alta",
      tickerStale: false,
    });
    expect(signal.direction).toBe("WAIT");
    expect(signal.tradable).toBe(false);
  });

  it("não transforma feed defasado em sinal", () => {
    const signal = buildSignal({
      style: "SWING",
      primary: frame({ interval: "4h", stale: true }),
      confirm: frame({ interval: "1d" }),
      regime: "alta",
      tickerStale: true,
    });
    expect(signal.direction).toBe("DATA_UNAVAILABLE");
    expect(signal.tradable).toBe(false);
  });
});

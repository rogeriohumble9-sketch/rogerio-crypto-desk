import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, reviewSignal, sessionDecision, sizePosition, usdLimit } from "../src/domain/risk.js";

const base = {
  direction: "BUY" as const,
  entry: 100,
  stop: 95,
  takeProfit1: 110,
  rr: 2,
  dataStale: false,
  duplicate: false,
  extremeVol: false,
  sessionBlocked: null,
  sessionLossStreak: 0,
  openPositions: 0,
  openRiskPct: 0,
  settings: DEFAULT_SETTINGS,
  equity: 1000,
  freeCash: 1000,
};

describe("risco", () => {
  it("usa 0,5% = US$ 5, perda diária US$ 15 e meta US$ 20", () => {
    expect(DEFAULT_SETTINGS.riskPerTradePct).toBe(0.5);
    expect(DEFAULT_SETTINGS.dailyLossLimitPct).toBe(1.5);
    expect(DEFAULT_SETTINGS.dailyProfitTargetPct).toBe(2);
    expect(usdLimit(DEFAULT_SETTINGS, "risk")).toBe(5);
    expect(usdLimit(DEFAULT_SETTINGS, "loss")).toBe(15);
    expect(usdLimit(DEFAULT_SETTINGS, "target")).toBe(20);
  });

  it("dimensiona o risco de US$ 5 no capital de US$ 1.000", () => {
    const size = sizePosition({
      equity: 1000,
      freeCash: 1000,
      riskPct: 0.5,
      entry: 100,
      stop: 95,
      side: "BUY",
      feePctPerSide: 0.1,
      slippagePct: 0,
    });
    expect("error" in size).toBe(false);
    if ("error" in size) return;
    expect(size.riskAmount).toBe(5);
    const qty = size.qty;
    const entryFee = 100 * qty * 0.001;
    const exitFee = 95 * qty * 0.001;
    const loss = (100 - 95) * qty + entryFee + exitFee;
    expect(loss).toBeCloseTo(5, 1);
  });

  it("bloqueia o dia ao perder US$ 15 e ao ganhar US$ 20", () => {
    expect(sessionDecision({ dayPnl: -15, sessionLossStreak: 0, settings: DEFAULT_SETTINGS, latched: null }).blocked).toBe("loss");
    expect(sessionDecision({ dayPnl: -14.99, sessionLossStreak: 0, settings: DEFAULT_SETTINGS, latched: null }).blocked).toBeNull();
    expect(sessionDecision({ dayPnl: 20, sessionLossStreak: 0, settings: DEFAULT_SETTINGS, latched: null }).blocked).toBe("profit");
    expect(sessionDecision({ dayPnl: -1, sessionLossStreak: 0, settings: DEFAULT_SETTINGS, latched: "loss" }).blocked).toBe("loss");
  });

  it("rejeita R:R abaixo de 1:2, dado velho e limite diário", () => {
    expect(reviewSignal({ ...base, rr: 1.2, takeProfit1: 106 }).ok).toBe(false);
    expect(reviewSignal({ ...base, dataStale: true }).ok).toBe(false);
    const blocked = reviewSignal({ ...base, sessionBlocked: "loss" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/perda diária/);
  });
});

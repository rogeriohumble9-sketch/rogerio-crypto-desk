import { describe, expect, it } from "vitest";
import { applyBar, openPosition } from "../src/domain/simulator.js";

describe("simulador", () => {
  it("fecha metade no TP1 e o resto no TP2, líquido de taxa", () => {
    const opened = openPosition({ side: "BUY", qty: 1, entry: 100, stop: 90, tp1: 110, tp2: 120, feePctPerSide: 0.1, slippagePct: 0 });
    expect(opened.cashDelta).toBeCloseTo(-100.1);
    const effect = applyBar(opened.position, 120, 100, 0.1, 0);
    expect(effect.events.map((event) => event.kind)).toEqual(["TP1", "TP2"]);
    expect(effect.position.status).toBe("closed");
    expect(effect.position.realizedPnl).toBeCloseTo(14.785, 6);
    const cash = 1000 + opened.cashDelta + effect.cashDelta;
    expect(cash).toBeCloseTo(1014.785, 6);
  });

  it("prioriza o stop quando o candle toca stop e alvo", () => {
    const opened = openPosition({ side: "BUY", qty: 1, entry: 100, stop: 95, tp1: 110, tp2: 120, feePctPerSide: 0, slippagePct: 0 });
    const effect = applyBar(opened.position, 130, 90, 0, 0);
    expect(effect.events.map((event) => event.kind)).toEqual(["SL"]);
    expect(effect.position.realizedPnl).toBeCloseTo(-5);
  });

  it("apura o P&L de uma venda", () => {
    const opened = openPosition({ side: "SELL", qty: 1, entry: 100, stop: 110, tp1: 90, tp2: 80, feePctPerSide: 0, slippagePct: 0 });
    const effect = applyBar(opened.position, 100, 80, 0, 0);
    expect(effect.position.status).toBe("closed");
    expect(effect.position.realizedPnl).toBeCloseTo(15);
    expect(1000 + opened.cashDelta + effect.cashDelta).toBeCloseTo(1015);
  });
});

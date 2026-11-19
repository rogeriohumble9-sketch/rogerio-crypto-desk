import { describe, expect, it } from "vitest";
import { RecoveryGate, startupGuard } from "../src/domain/guard.js";
import { riskToStopFromMark, closeAtMarket, openPosition } from "../src/domain/simulator.js";

describe("guarda de partida/recuperação", () => {
  const base = { dailyLossUsd: 15, openRiskUsd: 4, openCount: 2 };

  it("sem posição aberta não fecha nada", () => {
    expect(startupGuard({ ...base, openCount: 0, dayPnl: -14 }).close).toBe(false);
  });

  it("fecha tudo quando 80% ou mais do limite já foi usado (realizado + aberto)", () => {
    const d = startupGuard({ ...base, dayPnl: -12 });
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/80%|% do limite/);
    expect(startupGuard({ ...base, dayPnl: -11.99, openRiskUsd: 0 }).close).toBe(false);
  });

  it("fecha quando o limite restante não cobre o risco aberto", () => {
    const d = startupGuard({ dailyLossUsd: 15, dayPnl: -7, openRiskUsd: 8, openCount: 1 }); // restante 8 <= 8
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/não cobre o risco aberto/);
    expect(startupGuard({ dailyLossUsd: 15, dayPnl: -7, openRiskUsd: 7.9, openCount: 1 }).close).toBe(false);
  });

  it("dia no lucro com risco coberto não aciona", () => {
    expect(startupGuard({ ...base, dayPnl: 3 }).close).toBe(false);
  });

  it("limite já estourado fecha tudo", () => {
    const d = startupGuard({ ...base, dayPnl: -16.13 });
    expect(d.close).toBe(true);
    expect(d.remainingUsd).toBe(0);
  });

  it("roda uma vez na partida e uma vez a cada volta dos preços", () => {
    const gate = new RecoveryGate();
    expect(gate.observe(false)).toBe(false); // sem preço na partida
    expect(gate.observe(true)).toBe(true); // preços chegaram: roda
    expect(gate.observe(true)).toBe(false);
    expect(gate.observe(true)).toBe(false);
    expect(gate.observe(false)).toBe(false); // queda de feed
    expect(gate.observe(true)).toBe(true); // recuperou: roda de novo
    expect(gate.observe(true)).toBe(false);
  });

  it("carteira principal: risco até o stop parte do preço atual e fechar a mercado cobra taxa e slippage", () => {
    const opened = openPosition({ side: "BUY", qty: 2, entry: 100, stop: 98, tp1: 104, tp2: 108, feePctPerSide: 0.1, slippagePct: 0 });
    const risk = riskToStopFromMark(opened.position, 100, 0.1);
    expect(risk).toBeCloseTo(4 + 98 * 2 * 0.001, 8);
    expect(riskToStopFromMark(opened.position, 97, 0.1)).toBeCloseTo(98 * 2 * 0.001, 8);
    const closed = closeAtMarket(opened.position, 99, 0.1, 0.02);
    expect(closed).not.toBeNull();
    if (!closed) return;
    expect(closed.position.status).toBe("closed");
    expect(closed.position.closeReason).toBe("MANUAL");
    // P&L líquido já traz a taxa de entrada (−fee na abertura) e a de saída
    expect(closed.position.realizedPnl).toBeLessThan(-2);
    expect(closeAtMarket(closed.position, 99, 0.1, 0.02)).toBeNull();
  });
});

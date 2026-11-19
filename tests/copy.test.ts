import { describe, expect, it } from "vitest";
import { appendFillPoint, chooseStop, classifyFill, coinAllowed, copySessionBlock, decideCopy, drawdownFromPoints, sizeCopy, skipLabel, winStreak, type DecideInput } from "../src/domain/copy.js";
import { parseCopySeed, RISK_VERDICT } from "../src/domain/copySeed.js";

const fresh = Date.now();

function input(partial: Partial<DecideInput> = {}): DecideInput {
  return {
    now: fresh,
    fillTime: fresh - 1_000,
    maxFillAgeMs: 60_000,
    coin: "BTC",
    kind: "open-long",
    fillPrice: 100,
    binancePrice: 100.1,
    maxDeviationPct: 0.3,
    blocked: null,
    sameSideOpen: false,
    unrealizedPnl: 0,
    publicStop: 98,
    atr: 1.2,
    equity: 1000,
    freeCash: 1000,
    riskPct: 0.5,
    feePctPerSide: 0.1,
    slippagePct: 0,
    ...partial,
  };
}

describe("cópia simulada", () => {
  it("recalcula o tamanho para US$ 5 e ignora o tamanho do trader", () => {
    const sized = sizeCopy({
      equity: 1000,
      freeCash: 1000,
      riskPct: 0.5,
      entry: 100,
      stop: 98,
      side: "BUY",
      feePctPerSide: 0.1,
      slippagePct: 0,
    });
    expect("error" in sized).toBe(false);
    if ("error" in sized) return;
    expect(sized.riskAmount).toBe(5);
    expect(sized.notional).toBeLessThan(300);
    expect(sized.notional).toBeGreaterThan(100);
    expect(sized.cappedToCash).toBe(false);
  });

  it("não alavanca: o notional fica dentro do caixa", () => {
    const sized = sizeCopy({
      equity: 1000,
      freeCash: 80,
      riskPct: 0.5,
      entry: 100,
      stop: 98,
      side: "BUY",
      feePctPerSide: 0,
      slippagePct: 0,
    });
    expect("error" in sized).toBe(false);
    if ("error" in sized) return;
    expect(sized.notional).toBeLessThanOrEqual(80);
    expect(sized.cappedToCash).toBe(true);
  });

  it("usa o stop público e cai para o ATR quando ele não serve", () => {
    expect(chooseStop({ side: "BUY", entry: 100, publicStop: 98, atr: 1 }).source).toBe("publico");
    const atrStop = chooseStop({ side: "BUY", entry: 100, publicStop: 101, atr: 1.2 });
    expect(atrStop.source).toBe("atr");
    expect(atrStop.stop).toBeCloseTo(98.2);
  });

  it("pula fill atrasado, preço divergente e média em posição perdedora", () => {
    expect(decideCopy(input({ fillTime: fresh - 61_000 })).reason).toMatch(/atrasado/);
    expect(decideCopy(input({ binancePrice: null })).reason).toMatch(/Binance/);
    expect(decideCopy(input({ fillPrice: 100, binancePrice: 100.4 })).reason).toMatch(/desviou/);
    expect(decideCopy(input({ fillPrice: 100, binancePrice: 100.2 })).action).toBe("enter");
    const average = decideCopy(input({ sameSideOpen: true, unrealizedPnl: -2 }));
    expect(average.action).toBe("skip");
    expect(average.reason).toMatch(/perdedora/);
  });

  it("bloqueia cópias novas em -US$ 15 e +US$ 20 até a próxima sessão", () => {
    expect(copySessionBlock({ dayPnl: -15, dailyLossUsd: 15, dailyTargetUsd: 20, latched: null }).blocked).toBe("loss");
    expect(copySessionBlock({ dayPnl: -14.99, dailyLossUsd: 15, dailyTargetUsd: 20, latched: null }).blocked).toBeNull();
    expect(copySessionBlock({ dayPnl: 20, dailyLossUsd: 15, dailyTargetUsd: 20, latched: null }).blocked).toBe("profit");
    expect(copySessionBlock({ dayPnl: 0, dailyLossUsd: 15, dailyTargetUsd: 20, latched: "loss" }).blocked).toBe("loss");
    expect(decideCopy(input({ blocked: "loss" })).reason).toMatch(/perda diária/);
  });

  it("só acrescenta ponto na curva quando há fill gravado", () => {
    const start = appendFillPoint([], { t: 1, equity: 1000, fillId: "abertura" });
    const same = appendFillPoint(start, { t: 2, equity: 1500, fillId: "" });
    expect(same).toEqual(start);
    const next = appendFillPoint(start, { t: 2, equity: 995, fillId: "open:1" });
    expect(next.map((point) => point.equity)).toEqual([1000, 995]);
    expect(drawdownFromPoints(next)).toBeCloseTo(-0.5);
    expect(winStreak([10, -1, 4, 2])).toBe(2);
    expect(winStreak([])).toBe(0);
    expect(skipLabel("fill atrasado (80s > 60s)")).toBe("dado atrasado");
    expect(skipLabel("preço Hyperliquid desviou 1.20% da Binance")).toBe("preço divergente");
    expect(skipLabel("não copia aumento em posição perdedora")).toBe("médio para baixo");
    expect(skipLabel("perda copiada do dia atingiu US$ 15.00")).toBe("risk cap");
  });

  it("descarta ativo fora de BTC, ETH, SOL, BNB e XRP", () => {
    expect(coinAllowed("xyz:ANT")).toBe(false);
    expect(coinAllowed("BTC")).toBe(true);
    expect(decideCopy(input({ coin: "xyz:ANT" })).reason).toBe("ativo fora da lista");
  });

  it("semeia só o endereço Hyperliquid utilizável e deixa o de margem cheia de fora", () => {
    const seed = parseCopySeed(`
### 1) Idle-Vaporware-Taro — OKX spot
- uniqueCode \`69975B4CBC86203B\`
### 5) Carteira Hyperliquid \`0xec85bc052ec5b6d6cb2b40f5caa45e39b61a77fe\`
Hyperliquid userFills
### 6) Carteira Hyperliquid \`0x10e14ba2d77263543be1bdb2851b0933ddf4f4bd\`
inadequado para copiar, margem 100% usada
`);
    expect(seed.copy).toEqual(["0xec85bc052ec5b6d6cb2b40f5caa45e39b61a77fe"]);
    expect(seed.blocked.map((item) => item.id)).toContain("0x10e14ba2d77263543be1bdb2851b0933ddf4f4bd");
    expect(seed.blocked.map((item) => item.name)).toContain("Charely");
    expect(seed.watch.map((item) => item.name)).toEqual(["Idle-Vaporware-Taro"]);
    expect(seed.watch.map((item) => item.code)).not.toContain("0206AE3AC5461FEB");
    expect(RISK_VERDICT.watch.map((item) => item.name)).toEqual(["Idle-Vaporware-Taro", "BTV-Michael", "mimidaidan"]);
  });

  it("copia uma entrada fresca com stop e risco de US$ 5", () => {
    const decision = decideCopy(input());
    expect(decision.action).toBe("enter");
    if (decision.action !== "enter") return;
    expect(decision.stopSource).toBe("atr");
    expect(decision.riskAmount).toBe(5);
    expect(decision.side).toBe("BUY");
    expect(classifyFill("Open Short")).toBe("open-short");
    expect(classifyFill("Close Short")).toBe("close-short");
  });
});

import { describe, expect, it } from "vitest";
import { appendFillPoint, chooseStop, classifyFill, coinAllowed, copySessionBlock, decideCopy, drawdownFromPoints, remainingLossBudget, riskToStop, sizeCopy, skipLabel, winStreak, type DecideInput } from "../src/domain/copy.js";
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

describe("regras de risco da cópia (pausa, 1 por moeda, risco aberto)", () => {
  const long = (coin: string, mark = 100, stop = 98, qty = 2) => ({ coin, side: "BUY" as const, qty, stop, entry: 100, mark });

  it("pausa bloqueia entrada nova, mas deixa a saída passar", () => {
    const entry = decideCopy(input({ paused: true }));
    expect(entry).toEqual({ action: "skip", reason: "cópia pausada (sem novas entradas)" });
    expect(decideCopy(input({ paused: true, kind: "close-long" })).action).toBe("exit");
    expect(skipLabel("cópia pausada (sem novas entradas)")).toBe("cópia pausada");
  });

  it("no máximo 1 posição por moeda: não adiciona nem faz preço médio, nem do lado oposto", () => {
    const open = [long("BTC")];
    const same = decideCopy(input({ openPositions: open, sameSideOpen: true, unrealizedPnl: 3 }));
    expect(same.action).toBe("skip");
    expect(same.action === "skip" && same.reason).toMatch(/já há posição aberta em BTC/);
    const opposite = decideCopy(input({ openPositions: open, kind: "open-short" }));
    expect(opposite.action).toBe("skip");
    expect(decideCopy(input({ openPositions: [long("ETH")], dayPnl: 0, dailyLossUsd: 15 })).action).toBe("enter");
  });

  it("no máximo 2 posições abertas ao mesmo tempo", () => {
    const two = [long("ETH"), long("SOL")];
    const blocked = decideCopy(input({ openPositions: two, maxOpenPositions: 2 }));
    expect(blocked.action === "skip" && blocked.reason).toMatch(/2 posições abertas/);
    expect(decideCopy(input({ openPositions: [long("ETH")], maxOpenPositions: 2, dayPnl: 0, dailyLossUsd: 15 })).action).toBe("enter");
  });

  it("limite diário restante = limite − perda já tomada (realizado + aberto)", () => {
    expect(remainingLossBudget(15, 0)).toBe(15);
    expect(remainingLossBudget(15, 4)).toBe(15);
    expect(remainingLossBudget(15, -13.3)).toBeCloseTo(1.7, 6);
    expect(remainingLossBudget(15, -20)).toBe(0);
  });

  it("risco aberto total nunca passa do limite diário restante", () => {
    const open = [long("ETH", 100, 98, 2)]; // risco ao stop ≈ 4 + taxa
    const risk = riskToStop(open[0]);
    expect(risk).toBeGreaterThan(4);
    expect(risk).toBeLessThan(4.5);
    const ok = decideCopy(input({ openPositions: open, dayPnl: 0, dailyLossUsd: 15 }));
    expect(ok.action).toBe("enter"); // 4,2 + 5 < 15
    const tight = decideCopy(input({ openPositions: open, dayPnl: -8, dailyLossUsd: 15 })); // restante 7 < 4,2 + 5
    expect(tight.action).toBe("skip");
    expect(tight.action === "skip" && tight.reason).toMatch(/risco aberto/);
    const none = decideCopy(input({ openPositions: [], dayPnl: -11, dailyLossUsd: 15 })); // restante 4 < 5 novo
    expect(none.action).toBe("skip");
  });

  it("o risco ao stop usa o preço atual: posição já no prejuízo tem menos risco restante", () => {
    const fresh = riskToStop(long("ETH", 100, 98, 2));
    const losing = riskToStop(long("ETH", 98.5, 98, 2));
    expect(losing).toBeLessThan(fresh);
    expect(riskToStop(long("ETH", 97, 98, 2))).toBeCloseTo(98 * 2 * 0.001, 8); // já além do stop: só a taxa
  });

  it("a trava de perda diária usa realizado + aberto (dayPnl marcado a mercado)", () => {
    const locked = copySessionBlock({ dayPnl: -15.01, dailyLossUsd: 15, dailyTargetUsd: 20, latched: null });
    expect(locked.blocked).toBe("loss");
    expect(copySessionBlock({ dayPnl: -14.99, dailyLossUsd: 15, dailyTargetUsd: 20, latched: null }).blocked).toBeNull();
    expect(decideCopy(input({ blocked: "loss" })).action).toBe("skip");
  });
});


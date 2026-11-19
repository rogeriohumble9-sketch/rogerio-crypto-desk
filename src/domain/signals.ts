import type { Confidence, Criterion, Direction, Regime, Style } from "../shared/types.js";
import type { FrameSnapshot } from "./analyze.js";
import { round } from "./indicators.js";

export const MIN_RR = 2;
export const MAX_SCORE = 7;

const MIN_STOP_PCT = 0.0015;
const MAX_STOP_PCT = 0.06;

export interface StylePlan {
  style: Style;
  primary: "5m" | "4h";
  confirm: "15m" | "1d";
  context: "1m" | "1h";
  validForMs: number;
  label: string;
}

export const STYLE_PLANS: Record<Style, StylePlan> = {
  SCALPING: {
    style: "SCALPING",
    primary: "5m",
    confirm: "15m",
    context: "1m",
    validForMs: 20 * 60 * 1000,
    label: "5m",
  },
  SWING: {
    style: "SWING",
    primary: "4h",
    confirm: "1d",
    context: "1h",
    validForMs: 24 * 60 * 60 * 1000,
    label: "4h",
  },
};

export interface SignalDraft {
  style: Style;
  direction: Direction;
  tradable: boolean;
  price: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  timeframe: string;
  rr: number | null;
  confidence: Confidence | null;
  score: number;
  maxScore: number;
  criteria: Criterion[];
  justification: string;
  validForMs: number;
}

export function riskReward(entry: number, stop: number, target: number): number | null {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!(risk > 0) || !(entry > 0)) return null;
  return reward / risk;
}

export function confidenceFromScore(score: number): Confidence | null {
  if (score >= 6) return "Forte";
  if (score === 5) return "Moderada";
  if (score === 4) return "Fraca";
  return null;
}

interface SideEval {
  side: "BUY" | "SELL";
  criteria: Criterion[];
  score: number;
  tradable: boolean;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  rr: number | null;
  geometryNote: string;
}

function fmt(n: number | null, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 2 });
}

function evaluateSide(
  side: "BUY" | "SELL",
  primary: FrameSnapshot,
  confirm: FrameSnapshot,
  regime: Regime,
): SideEval {
  const close = primary.close;
  const criteria: Criterion[] = [];

  const confirmOpposes =
    side === "BUY"
      ? confirm.structure === "baixa" ||
        (confirm.ema9 != null && confirm.ema21 != null && confirm.ema9 < confirm.ema21)
      : confirm.structure === "alta" ||
        (confirm.ema9 != null && confirm.ema21 != null && confirm.ema9 > confirm.ema21);
  const regimeOpposes = side === "BUY" ? regime === "baixa" : regime === "alta";
  const trendPass = regime !== "indisponivel" && !regimeOpposes && !confirmOpposes;
  criteria.push({
    name: "Tendência",
    passed: trendPass,
    detail: trendPass
      ? `Regime ${regime}; confirmação ${confirm.interval} não contradiz ${side === "BUY" ? "compra" : "venda"}.`
      : `Tendência primeiro: regime ${regime} ou ${confirm.interval} contradiz a direção.`,
  });

  const triggerPass =
    side === "BUY"
      ? primary.ema9 != null &&
        primary.ema21 != null &&
        primary.ema9 > primary.ema21 &&
        close > primary.ema21
      : primary.ema9 != null &&
        primary.ema21 != null &&
        primary.ema9 < primary.ema21 &&
        close < primary.ema21;
  criteria.push({
    name: "Gatilho (EMA)",
    passed: triggerPass,
    detail: triggerPass
      ? `EMA 9 ${fmt(primary.ema9)} ${side === "BUY" ? "acima" : "abaixo"} da EMA 21 ${fmt(primary.ema21)}, preço do mesmo lado.`
      : "EMA 9/21 ainda não alinhadas com o preço.",
  });

  const rsiPass =
    primary.rsi != null && (side === "BUY" ? primary.rsi >= 38 && primary.rsi <= 68 : primary.rsi >= 32 && primary.rsi <= 62);
  criteria.push({
    name: "RSI",
    passed: rsiPass,
    detail:
      primary.rsi == null
        ? "RSI indisponível."
        : `RSI ${primary.rsi.toFixed(1)} ${rsiPass ? "na zona aceitável" : "fora da zona (evita extremo contra a operação)"}.`,
  });

  const hist = primary.macdHist;
  const prev = primary.macdHistPrev;
  const macdPass =
    hist != null &&
    (side === "BUY" ? hist > 0 || (prev != null && hist > prev && prev <= 0) : hist < 0 || (prev != null && hist < prev && prev >= 0));
  criteria.push({
    name: "MACD",
    passed: macdPass,
    detail: hist == null ? "MACD indisponível." : `Histograma ${hist >= 0 ? "positivo" : "negativo"} (${hist.toFixed(4)}).`,
  });

  const volumePass = primary.volumeSma != null && primary.volumeSma > 0 && primary.volume >= primary.volumeSma * 0.9;
  criteria.push({
    name: "Volume",
    passed: volumePass,
    detail: volumePass
      ? "Volume do candle na média ou acima (90% da SMA 20)."
      : "Volume abaixo de 90% da média de 20 candles.",
  });

  const bbPass =
    side === "BUY"
      ? primary.bbUpper != null && close <= primary.bbUpper * 1.002
      : primary.bbLower != null && close >= primary.bbLower * 0.998;
  criteria.push({
    name: "Bandas de Bollinger",
    passed: bbPass,
    detail: bbPass ? "Preço não está esticado fora da banda a favor." : "Preço esticado fora da banda — sem perseguir.",
  });

  const nearSupport =
    side === "BUY" &&
    primary.swingLow != null &&
    primary.atr != null &&
    close > primary.swingLow &&
    close - primary.swingLow <= primary.atr * 1.25;
  const nearResistance =
    side === "SELL" &&
    primary.swingHigh != null &&
    primary.atr != null &&
    primary.swingHigh > close &&
    primary.swingHigh - close <= primary.atr * 1.25;
  const paPass =
    side === "BUY"
      ? primary.structure === "alta" || primary.breakout === "alta" || nearSupport || primary.reversal === "engolfo de alta"
      : primary.structure === "baixa" || primary.breakout === "baixa" || nearResistance || primary.reversal === "engolfo de baixa";
  criteria.push({
    name: "Price action",
    passed: paPass,
    detail: paPass
      ? `Estrutura ${primary.structure}${primary.breakout ? `, rompimento de ${primary.breakout}` : ""}${primary.reversal ? `, ${primary.reversal}` : ""}.`
      : `Estrutura ${primary.structure} sem rompimento nem reação no nível.`,
  });

  const score = criteria.filter((c) => c.passed).length;
  const geometry = geometryFor(side, primary);
  const tradable = score >= 4 && trendPass && triggerPass && geometry.ok && (geometry.rr ?? 0) >= MIN_RR;

  return {
    side,
    criteria,
    score,
    tradable,
    entry: geometry.ok ? close : null,
    stop: geometry.stop,
    tp1: geometry.tp1,
    tp2: geometry.tp2,
    rr: geometry.rr,
    geometryNote: geometry.note,
  };
}

function geometryFor(
  side: "BUY" | "SELL",
  frame: FrameSnapshot,
): { ok: boolean; stop: number | null; tp1: number | null; tp2: number | null; rr: number | null; note: string } {
  const close = frame.close;
  const atrV = frame.atr;
  if (atrV == null || !(atrV > 0) || !(close > 0)) {
    return { ok: false, stop: null, tp1: null, tp2: null, rr: null, note: "ATR indisponível para o stop." };
  }
  let stop: number;
  if (side === "BUY") {
    const structural = frame.swingLow != null ? frame.swingLow - atrV * 0.1 : null;
    const volStop = close - atrV * 1.5;
    stop = structural != null ? Math.min(structural, volStop) : volStop;
    if (!(stop < close)) {
      return { ok: false, stop: null, tp1: null, tp2: null, rr: null, note: "Stop de compra não ficou abaixo do preço." };
    }
  } else {
    const structural = frame.swingHigh != null ? frame.swingHigh + atrV * 0.1 : null;
    const volStop = close + atrV * 1.5;
    stop = structural != null ? Math.max(structural, volStop) : volStop;
    if (!(stop > close)) {
      return { ok: false, stop: null, tp1: null, tp2: null, rr: null, note: "Stop de venda não ficou acima do preço." };
    }
  }
  const distPct = Math.abs(close - stop) / close;
  if (distPct < MIN_STOP_PCT || distPct > MAX_STOP_PCT) {
    return {
      ok: false,
      stop: round(stop),
      tp1: null,
      tp2: null,
      rr: null,
      note: `Distância do stop ${(distPct * 100).toFixed(2)}% fora da faixa 0,15%–6%.`,
    };
  }
  const risk = Math.abs(close - stop);
  const tp1 = side === "BUY" ? close + risk * MIN_RR : close - risk * MIN_RR;
  const tp2 = side === "BUY" ? close + risk * 3 : close - risk * 3;
  if (side === "BUY" && frame.swingHigh != null && frame.swingHigh > close && frame.breakout !== "alta") {
    const room = frame.swingHigh - close;
    if (room < risk * MIN_RR) {
      return {
        ok: false,
        stop: round(stop),
        tp1: round(tp1),
        tp2: round(tp2),
        rr: room / risk,
        note: "Resistência próxima não comporta R:R de 1:2 até o primeiro alvo.",
      };
    }
  }
  if (side === "SELL" && frame.swingLow != null && frame.swingLow < close && frame.breakout !== "baixa") {
    const room = close - frame.swingLow;
    if (room < risk * MIN_RR) {
      return {
        ok: false,
        stop: round(stop),
        tp1: round(tp1),
        tp2: round(tp2),
        rr: room / risk,
        note: "Suporte próximo não comporta R:R de 1:2 até o primeiro alvo.",
      };
    }
  }
  const rr = riskReward(close, stop, tp1);
  return {
    ok: rr != null && rr >= MIN_RR - 1e-9,
    stop: round(stop),
    tp1: round(tp1),
    tp2: round(tp2),
    rr,
    note: rr != null ? `R:R até o TP1 de ${rr.toFixed(2)} (mínimo ${MIN_RR}).` : "R:R inválido.",
  };
}

function justify(style: Style, side: "BUY" | "SELL" | "WAIT", evaln: SideEval | null, timeframe: string): string {
  const styleName = style === "SCALPING" ? "scalping" : "swing";
  if (!evaln || side === "WAIT") {
    const why = evaln?.geometryNote ?? "confluência insuficiente";
    return `Sem publicação em ${styleName} (${timeframe}). ${why} A mesa só publica compra ou venda com tendência a favor, gatilho de EMA e ao menos quatro regras. Não é garantia de resultado.`;
  }
  const passed = evaln.criteria.filter((c) => c.passed).map((c) => c.name.toLowerCase());
  const conf = confidenceFromScore(evaln.score);
  return `${side === "BUY" ? "Compra" : "Venda"} em ${styleName}, timeframe ${timeframe}. Regras a favor: ${passed.join(", ")}. ${evaln.geometryNote} Confiança ${conf ?? "—"} (${evaln.score}/${MAX_SCORE}), contagem de regras — não é probabilidade nem garantia.`;
}

export function buildSignal(input: {
  style: Style;
  primary: FrameSnapshot | null;
  confirm: FrameSnapshot | null;
  regime: Regime;
  tickerStale: boolean;
}): SignalDraft {
  const plan = STYLE_PLANS[input.style];
  const base = {
    style: input.style,
    timeframe: plan.label,
    maxScore: MAX_SCORE,
    validForMs: plan.validForMs,
  };
  if (input.tickerStale || !input.primary || input.primary.stale || !input.confirm || input.confirm.stale || input.regime === "indisponivel") {
    return {
      ...base,
      direction: "DATA_UNAVAILABLE",
      tradable: false,
      price: input.primary?.close ?? null,
      entry: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      rr: null,
      confidence: null,
      score: 0,
      criteria: [
        {
          name: "Dados",
          passed: false,
          detail: "Feed de preço, candles ou regime de mercado defasado ou incompleto. Dado velho não entra como sinal.",
        },
      ],
      justification:
        "Dados indisponíveis para este estilo. A mesa não transforma cotação defasada em oportunidade. Não é garantia de resultado.",
    };
  }

  const buy = evaluateSide("BUY", input.primary, input.confirm, input.regime);
  const sell = evaluateSide("SELL", input.primary, input.confirm, input.regime);
  const chosen = buy.tradable || sell.tradable ? (buy.tradable && (!sell.tradable || buy.score >= sell.score) ? buy : sell) : buy.score >= sell.score ? buy : sell;

  if (!chosen.tradable) {
    return {
      ...base,
      direction: "WAIT",
      tradable: false,
      price: input.primary.close,
      entry: chosen.entry,
      stopLoss: chosen.stop,
      takeProfit1: chosen.tp1,
      takeProfit2: chosen.tp2,
      rr: chosen.rr,
      confidence: null,
      score: chosen.score,
      criteria: chosen.criteria,
      justification: justify(input.style, "WAIT", chosen, plan.label),
    };
  }

  return {
    ...base,
    direction: chosen.side,
    tradable: true,
    price: input.primary.close,
    entry: chosen.entry,
    stopLoss: chosen.stop,
    takeProfit1: chosen.tp1,
    takeProfit2: chosen.tp2,
    rr: chosen.rr,
    confidence: confidenceFromScore(chosen.score),
    score: chosen.score,
    criteria: chosen.criteria,
    justification: justify(input.style, chosen.side, chosen, plan.label),
  };
}

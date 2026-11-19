import { exitFillPrice, entryFillPrice } from "./risk.js";
import { round } from "./indicators.js";

export type Side = "BUY" | "SELL";
export type CloseReason = "SL" | "TP2" | "MANUAL";

export interface FillEvent {
  kind: "OPEN" | "TP1" | "TP2" | "SL" | "MANUAL";
  qty: number;
  price: number;
  fee: number;
  pnl: number;
}

export interface SimPosition {
  side: Side;
  qty: number;
  qtyOpen: number;
  entryFill: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp1Hit: boolean;
  fees: number;
  realizedPnl: number;
  status: "open" | "closed";
  closeReason: CloseReason | null;
}

export interface BarEffect {
  position: SimPosition;
  cashDelta: number;
  events: FillEvent[];
}

function feeOf(notional: number, feePctPerSide: number): number {
  return Math.abs(notional) * (feePctPerSide / 100);
}

export function openPosition(input: {
  side: Side;
  qty: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  feePctPerSide: number;
  slippagePct: number;
}): { position: SimPosition; cashDelta: number; event: FillEvent } {
  const fill = entryFillPrice(input.side, input.entry, input.slippagePct);
  const fee = feeOf(fill * input.qty, input.feePctPerSide);
  const position: SimPosition = {
    side: input.side,
    qty: input.qty,
    qtyOpen: input.qty,
    entryFill: fill,
    stop: input.stop,
    tp1: input.tp1,
    tp2: input.tp2,
    tp1Hit: false,
    fees: fee,
    realizedPnl: -fee,
    status: "open",
    closeReason: null,
  };
  const cashDelta = input.side === "BUY" ? -(fill * input.qty + fee) : fill * input.qty - fee;
  return {
    position,
    cashDelta,
    event: { kind: "OPEN", qty: input.qty, price: fill, fee, pnl: -fee },
  };
}

function closeQty(
  position: SimPosition,
  qty: number,
  rawPrice: number,
  kind: "TP1" | "TP2" | "SL" | "MANUAL",
  feePctPerSide: number,
  slippagePct: number,
): { position: SimPosition; cashDelta: number; event: FillEvent } {
  const qtyClose = Math.min(position.qtyOpen, qty);
  const fill = exitFillPrice(position.side, rawPrice, slippagePct);
  const fee = feeOf(fill * qtyClose, feePctPerSide);
  const pnl =
    position.side === "BUY" ? (fill - position.entryFill) * qtyClose - fee : (position.entryFill - fill) * qtyClose - fee;
  const cashDelta = position.side === "BUY" ? fill * qtyClose - fee : -(fill * qtyClose + fee);
  const qtyOpen = round(position.qtyOpen - qtyClose, 8);
  const next: SimPosition = {
    ...position,
    qtyOpen,
    fees: position.fees + fee,
    realizedPnl: position.realizedPnl + pnl,
    tp1Hit: position.tp1Hit || kind === "TP1",
    status: qtyOpen <= 1e-10 ? "closed" : "open",
    closeReason: qtyOpen <= 1e-10 ? (kind === "SL" ? "SL" : kind === "MANUAL" ? "MANUAL" : "TP2") : position.closeReason,
  };
  if (next.status === "closed") next.qtyOpen = 0;
  return { position: next, cashDelta, event: { kind, qty: qtyClose, price: fill, fee, pnl } };
}

/** Fecha o que resta da posição ao preço de mercado (com slippage e taxa), sem esperar stop ou alvo. */
export function closeAtMarket(
  position: SimPosition,
  mark: number,
  feePctPerSide: number,
  slippagePct: number,
): { position: SimPosition; cashDelta: number; event: FillEvent } | null {
  if (position.status === "closed" || position.qtyOpen <= 0) return null;
  return closeQty(position, position.qtyOpen, mark, "MANUAL", feePctPerSide, slippagePct);
}

/** Perda adicional possível até o stop a partir do preço atual, com a taxa de saída. Sem preço, parte da entrada. */
export function riskToStopFromMark(position: SimPosition, mark: number | null, feePctPerSide: number): number {
  if (position.status === "closed" || position.qtyOpen <= 0) return 0;
  const ref = mark ?? position.entryFill;
  const distance = position.side === "BUY" ? ref - position.stop : position.stop - ref;
  return Math.max(0, distance) * position.qtyOpen + position.stop * position.qtyOpen * (feePctPerSide / 100);
}

/**
 * Atualiza a posição com a máxima e a mínima do candle.
 * Se stop e alvo acontecem no mesmo candle, o stop vence (premissa conservadora).
 */
export function applyBar(
  position: SimPosition,
  high: number,
  low: number,
  feePctPerSide: number,
  slippagePct: number,
): BarEffect {
  if (position.status === "closed" || position.qtyOpen <= 0) {
    return { position, cashDelta: 0, events: [] };
  }
  const hitSl = position.side === "BUY" ? low <= position.stop : high >= position.stop;
  const hitTp1 = !position.tp1Hit && (position.side === "BUY" ? high >= position.tp1 : low <= position.tp1);
  const hitTp2 = position.side === "BUY" ? high >= position.tp2 : low <= position.tp2;
  if (hitSl && (hitTp1 || hitTp2 || true)) {
    if (hitSl) {
      const closed = closeQty(position, position.qtyOpen, position.stop, "SL", feePctPerSide, slippagePct);
      return { position: closed.position, cashDelta: closed.cashDelta, events: [closed.event] };
    }
  }
  let current = position;
  let cashDelta = 0;
  const events: FillEvent[] = [];
  if (hitTp1) {
    const half = round(position.qty / 2, 8);
    const qty = Math.min(current.qtyOpen, half > 0 ? half : current.qtyOpen);
    const part = closeQty(current, qty, current.tp1, "TP1", feePctPerSide, slippagePct);
    current = part.position;
    cashDelta += part.cashDelta;
    events.push(part.event);
  }
  if (hitTp2 && current.qtyOpen > 0 && current.status === "open") {
    const rest = closeQty(current, current.qtyOpen, current.tp2, "TP2", feePctPerSide, slippagePct);
    current = rest.position;
    cashDelta += rest.cashDelta;
    events.push(rest.event);
  }
  return { position: current, cashDelta, events };
}

export function unrealizedPnl(position: SimPosition, mark: number): number {
  if (position.status === "closed" || position.qtyOpen <= 0) return 0;
  return position.side === "BUY"
    ? (mark - position.entryFill) * position.qtyOpen
    : (position.entryFill - mark) * position.qtyOpen;
}

export function positionMarketValue(position: SimPosition, mark: number): number {
  if (position.status === "closed" || position.qtyOpen <= 0) return 0;
  return position.side === "BUY" ? mark * position.qtyOpen : -(mark * position.qtyOpen);
}

export function openRiskAmount(position: SimPosition): number {
  if (position.status === "closed" || position.qtyOpen <= 0) return 0;
  return Math.abs(position.entryFill - position.stop) * position.qtyOpen;
}

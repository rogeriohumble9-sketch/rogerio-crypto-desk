import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { INTERVAL_MS, type Interval, type OrderView, type TradeView } from "../../src/shared/types";
import { brtChartTime } from "../../src/shared/time";
import { ageLabel, px } from "./format";

interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Props {
  symbol: string;
  interval: Interval;
  stale: boolean;
  ageMs: number | null;
  price: number | null;
  changePct: number | null;
  liveKline: { openTime: number; open: number; high: number; low: number; close: number } | null;
  orders: OrderView[];
  trade: TradeView | null;
}

export function ChartPane({ symbol, interval, stale, ageMs, price, changePct, liveKline, orders, trade }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const barsRef = useRef<Bar[]>([]);
  const ordersRef = useRef(orders);
  const tradeRef = useRef(trade);
  ordersRef.current = orders;
  tradeRef.current = trade;

  const paintOverlays = () => {
    const series = seriesRef.current;
    if (!series) return;
    const times = new Set(barsRef.current.map((bar) => bar.time));
    const markers: SeriesMarker<Time>[] = [];
    for (const order of ordersRef.current.filter((item) => item.symbol === symbol)) {
      const snapped = Math.floor(order.ts / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
      const time = brtChartTime(snapped) as UTCTimestamp;
      if (!times.has(time)) continue;
      const entry = order.kind === "ENTRY";
      markers.push({
        time,
        position: order.side === "BUY" ? "belowBar" : "aboveBar",
        color: entry ? (order.side === "BUY" ? "#1f9d62" : "#d4534b") : "#d7a15f",
        shape: entry ? (order.side === "BUY" ? "arrowUp" : "arrowDown") : "circle",
        text: entry ? "entrada" : order.reason === "SL" ? "stop" : order.reason,
      });
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    series.setMarkers(markers);
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    const tradeNow = tradeRef.current;
    if (!tradeNow || tradeNow.symbol !== symbol || tradeNow.status !== "open") return;
    const add = (value: number, color: string, title: string, style: LineStyle) => {
      linesRef.current.push(series.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    add(tradeNow.entryFill, "#c5ced6", "Entrada", LineStyle.Solid);
    add(tradeNow.stopLoss, "#d4534b", "Stop", LineStyle.Dashed);
    add(tradeNow.takeProfit1, "#1f9d62", "TP1", LineStyle.Dashed);
    add(tradeNow.takeProfit2, "#8fbfa8", "TP2", LineStyle.Dotted);
  };

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b97a8",
        fontFamily: "IBM Plex Mono, ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      localization: {
        locale: "pt-BR",
        timeFormatter: (time: Time) => {
          const date = new Date(Number(time) * 1000);
          return `${new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hourCycle: "h23" }).format(date)} BRT`;
        },
      },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#1f9d62",
      downColor: "#d4534b",
      borderUpColor: "#1f9d62",
      borderDownColor: "#d4534b",
      wickUpColor: "#1f9d62",
      wickDownColor: "#d4534b",
      priceLineVisible: true,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const load = async (fit: boolean) => {
      const response = await fetch(`/api/klines?symbol=${symbol}&interval=${interval}`);
      if (!response.ok || stop || !seriesRef.current) return;
      const data = (await response.json()) as { bars: { time: number; open: number; high: number; low: number; close: number }[] };
      const next = data.bars.map(toBar);
      const prev = barsRef.current;
      barsRef.current = next;
      if (!prev.length || fit || prev[0]?.time !== next[0]?.time || next.length < prev.length) {
        seriesRef.current.setData(next);
        if (fit) chartRef.current?.timeScale().fitContent();
      } else if (next.length) {
        seriesRef.current.update(next[next.length - 1]);
      }
      paintOverlays();
    };
    void load(true);
    const timer = setInterval(() => void load(false), 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // paintMarkers closes over orders/trade; the dedicated effect refreshes marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || stale || price == null) return;
    const bars = barsRef.current;
    if (!bars.length) return;
    const last = { ...bars[bars.length - 1] };
    if (interval === "1m" && liveKline) {
      const time = brtChartTime(liveKline.openTime) as UTCTimestamp;
      if (time === last.time) {
        last.high = Math.max(last.high, liveKline.high);
        last.low = Math.min(last.low, liveKline.low);
        last.close = liveKline.close;
      } else if (time > last.time) {
        bars.push({ time, open: liveKline.open, high: liveKline.high, low: liveKline.low, close: liveKline.close });
        series.update(bars[bars.length - 1]);
        return;
      }
    } else {
      const bucket = Math.floor(Date.now() / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
      const time = brtChartTime(bucket) as UTCTimestamp;
      if (time > last.time) {
        bars.push({ time, open: price, high: price, low: price, close: price });
        series.update(bars[bars.length - 1]);
        return;
      }
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
    }
    bars[bars.length - 1] = last;
    series.update(last);
  }, [price, liveKline, interval, stale]);

  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceLineColor: stale || changePct == null ? "#8b97a8" : changePct >= 0 ? "#1f9d62" : "#d4534b",
    });
    paintOverlays();
  }, [orders, trade, symbol, interval, changePct, stale]);

  return (
    <div className={`chart-host ${stale ? "is-stale" : ""}`}>
      <div ref={host} className="chart-canvas" />
      <div className="ohlc">
        {symbol.replace("USDT", "")} · {interval}
        {price == null ? " · DADOS INDISPONÍVEIS" : ` · ${px(price)}`}
        {ageMs != null ? ` · ${ageLabel(ageMs)}` : ""}
      </div>
      {stale && (
        <div className="stale-layer">
          <strong>DADOS INDISPONÍVEIS</strong>
          <span>{ageMs == null ? "sem leitura do feed público" : `última leitura ${ageLabel(ageMs)}`}</span>
        </div>
      )}
    </div>
  );
}

function toBar(bar: { time: number; open: number; high: number; low: number; close: number }): Bar {
  return { time: brtChartTime(bar.time) as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
}

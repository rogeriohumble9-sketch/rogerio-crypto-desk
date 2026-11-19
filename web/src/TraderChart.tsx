import { useEffect, useRef } from "react";
import { ColorType, createChart, type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { brtChartTime } from "../../src/shared/time";
import type { CopyTapeFill } from "../../src/shared/types";

export function TraderChart({ coin, fills, stale }: { coin: string; fills: CopyTapeFill[]; stale: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7eb8cc", fontFamily: "IBM Plex Mono, monospace" },
      grid: { vertLines: { color: "rgba(94,234,255,0.06)" }, horzLines: { color: "rgba(94,234,255,0.06)" } },
      rightPriceScale: { borderColor: "rgba(94,234,255,0.2)" },
      timeScale: { borderColor: "rgba(94,234,255,0.2)", timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#1f9d62",
      downColor: "#d4534b",
      borderUpColor: "#1f9d62",
      borderDownColor: "#d4534b",
      wickUpColor: "#1f9d62",
      wickDownColor: "#d4534b",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const signature = fills.map((fill) => `${fill.id}:${fill.outcome}:${fill.ourPnl ?? ""}`).join("|");
  const fillsRef = useRef(fills);
  fillsRef.current = fills;

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const response = await fetch(`/api/klines?symbol=${coin}USDT&interval=5m`);
      if (!response.ok || stop || !seriesRef.current) return;
      const data = (await response.json()) as { stale?: boolean; bars: { time: number; open: number; high: number; low: number; close: number }[] };
      const bars = data.bars.map((bar) => ({ time: brtChartTime(bar.time) as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
      seriesRef.current.setData(bars);
      const times = new Set(bars.map((bar) => bar.time));
      const markers: SeriesMarker<Time>[] = [];
      for (const fill of fillsRef.current) {
        const snapped = Math.floor(fill.time / 300_000) * 300_000;
        const time = brtChartTime(snapped) as UTCTimestamp;
        if (!times.has(time)) continue;
        markers.push({
          time,
          position: fill.side === "BUY" ? "belowBar" : "aboveBar",
          color: "#5eeaff",
          shape: fill.side === "BUY" ? "arrowUp" : "arrowDown",
          text: "fonte",
        });
        if (fill.outcome === "copiada") {
          markers.push({
            time,
            position: fill.ourSide === "SELL" ? "aboveBar" : "belowBar",
            color: "#e0a36a",
            shape: "circle",
            text: "cópia",
          });
        }
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      seriesRef.current.setMarkers(markers);
      chartRef.current?.timeScale().fitContent();
      host.current?.setAttribute("data-stale", data.stale || stale ? "1" : "0");
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [coin, signature, stale]);

  return (
    <div className={`trader-chart ${stale ? "is-stale" : ""}`}>
      <div ref={host} className="chart-canvas" />
      {stale && (
        <div className="stale-layer">
          <strong>DADOS INDISPONÍVEIS</strong>
          <span>feed da carteira sem atualização recente</span>
        </div>
      )}
    </div>
  );
}

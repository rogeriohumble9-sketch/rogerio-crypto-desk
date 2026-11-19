import { useEffect, useState } from "react";
import type { DashboardState, DeskLayout, Interval, OrderView, TradeView } from "../../src/shared/types";
import { INTERVALS } from "../../src/shared/types";
import { ChartPane } from "./ChartPane";
import { TraderChart } from "./TraderChart";
import { ageLabel, compactUsd, formatBrt, formatBrtClock, pct, px, signClass, usd } from "./format";
import { Button } from "./ui/button";

type Page = "mesa" | "sinais" | "mercado" | "noticias" | "risco" | "copia" | "relatorios";

export function App() {
  const state = useDesk();
  const [page, setPage] = useState<Page>("mesa");
  const [layout, setLayout] = useState<DeskLayout | null>(null);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("5m");
  const [windowMode, setWindowMode] = useState<"chart" | "equity">("chart");
  const [rail, setRail] = useState<"ordens" | "atividade">("ordens");

  useEffect(() => {
    if (state && layout == null) setLayout(state.layout);
  }, [state, layout]);

  if (!state || layout == null) return <div className="boot">Abrindo a mesa…</div>;

  const ticker = state.tickers.find((item) => item.symbol === symbol) ?? state.tickers[0];
  const openTrade = state.trades.find((trade) => trade.symbol === symbol && trade.status === "open") ?? null;
  const clean = layout === "clean";

  async function togglePlay() {
    await fetch("/api/autotrade", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !state!.autoTrade }),
    });
  }
  async function toggleClean() {
    const next: DeskLayout = clean ? "desk" : "clean";
    setLayout(next);
    if (next === "clean") setPage("mesa");
    await fetch("/api/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: next }),
    });
  }

  return (
    <div className={`shell ${clean ? "clean" : ""} ${page !== "mesa" && !clean ? "subpage" : ""}`}>
      <header className="top">
        <div className="brand">
          <strong>ROGÉRIO</strong>
          <span>simulação · sem ordem real</span>
        </div>
        <button className={`play ${state.autoTrade ? "on" : "off"}`} onClick={() => void togglePlay()}>
          {state.autoTrade ? "PAUSE" : "PLAY"}
        </button>
        <nav className="nav">
          {(
            [
              ["mesa", "Mesa"],
              ["sinais", "Sinais"],
              ["mercado", "Mercado"],
              ["noticias", "Notícias"],
              ["risco", "Risco"],
              ["copia", "Cópia"],
              ["relatorios", "Relatórios"],
            ] as [Page, string][]
          ).map(([id, label]) => (
            <button key={id} className={page === id && !clean ? "on" : ""} onClick={() => { setPage(id); setLayout("desk"); }}>
              {label}
            </button>
          ))}
          <button onClick={() => void toggleClean()}>{clean ? "Mesa completa" : "Modo limpo"}</button>
        </nav>
        <div className="clock">
          <div className="mono">{formatBrtClock(state.now)}</div>
          <div>{state.autoTrade ? "simulação ativa" : "simulação pausada"}</div>
        </div>
      </header>

      {(page === "mesa" || clean) && (
        <>
          <div className="strip">
            {state.tickers.map((item) => (
              <button key={item.symbol} className={`symbol-btn ${item.symbol === symbol ? "on" : ""} ${item.stale ? "stale" : ""}`} onClick={() => setSymbol(item.symbol)}>
                <b>{item.symbol.replace("USDT", "")}</b>
                <span className="mono px">{item.stale ? "DADOS INDISPONÍVEIS" : px(item.price)}</span>
                <span className={signClass(item.changePct)}>24h {item.changePct == null ? "DADOS INDISPONÍVEIS" : pct(item.changePct)}</span>
                <span className={signClass(item.sessionChangePct)}>sessão {item.sessionChangePct == null ? "DADOS INDISPONÍVEIS" : pct(item.sessionChangePct)}</span>
                <span>vol {compactUsd(item.quoteVolume)}</span>
              </button>
            ))}
          </div>
          <section className="metrics">
            <article className="glass balance">
              <p className="kicker">Saldo simulado</p>
              <p className="hero mono">{usd(state.account.equity)}</p>
              <p className="sub">iniciado em {usd(state.account.initialCapital)}{state.account.startedAt ? ` · ${formatBrt(state.account.startedAt)}` : ""}</p>
              <p className={signClass(state.account.dayPnl)}>{state.account.dayPnl == null ? "Dia: DADOS INDISPONÍVEIS" : `${usd(state.account.dayPnl)} no dia`}</p>
            </article>
            <article className="glass gauge-card">
              <Gauge value={state.account.drawdownPct} limit={state.account.dailyLossLimitUsd && state.account.initialCapital ? (state.account.dailyLossLimitUsd / state.account.initialCapital) * 100 : 1.5} />
              <div>
                <p className="kicker">Max drawdown</p>
                <p className="hero mono">{state.account.drawdownPct == null ? "DADOS INDISPONÍVEIS" : pct(state.account.drawdownPct)}</p>
                <p className="sub">escala até o limite diário</p>
              </div>
            </article>
            <article className="glass ring-card">
              <Ring value={state.account.winRate} />
              <div>
                <p className="kicker">Taxa de acerto</p>
                <p className="hero mono">{state.account.winRate == null ? "DADOS INDISPONÍVEIS" : pct(state.account.winRate * 100, 0)}</p>
                <p className="sub">{state.account.closedTrades ? `${state.account.wins} de ${state.account.closedTrades}` : "sem trade fechado"}</p>
              </div>
            </article>
            <article className="glass day-card">
              <p className="kicker">Limites do dia</p>
              <p>perda {usd(state.account.dailyLossLimitUsd)}</p>
              <p>meta {usd(state.account.dailyTargetUsd)}</p>
              <p>risco agora {usd(state.account.liveRiskUsd)}</p>
              <p className="sub">{state.account.blockReason ?? "sem bloqueio"}</p>
            </article>
          </section>
          <section className="stage">
            <div className="glass chart-card">
              <div className="chart-bar">
                <div className="mode">
                  <button className={windowMode === "chart" ? "on" : ""} onClick={() => setWindowMode("chart")}>Gráfico</button>
                  <button className={windowMode === "equity" ? "on" : ""} onClick={() => setWindowMode("equity")}>Curva</button>
                </div>
                <div className="tf">
                  {INTERVALS.map((item) => (
                    <button key={item} className={item === interval ? "on" : ""} onClick={() => setInterval(item)}>{item}</button>
                  ))}
                </div>
                <span className={`mono px ${signClass(ticker?.changePct ?? null)}`}>{ticker?.stale ? "DADOS INDISPONÍVEIS" : px(ticker?.price ?? null)}</span>
              </div>
              {windowMode === "equity" ? (
                <EquityCurve points={state.account.equityCurve} />
              ) : (
                <ChartPane
                  symbol={symbol}
                  interval={interval}
                  stale={Boolean(ticker?.stale)}
                  ageMs={ticker?.ageMs ?? null}
                  price={ticker?.price ?? null}
                  changePct={ticker?.changePct ?? null}
                  liveKline={state.liveKlines[symbol] ?? null}
                  orders={state.orders}
                  trade={openTrade}
                />
              )}
            </div>
            <aside className="glass rail">
              <div className="rail-tabs">
                <button className={rail === "ordens" ? "on" : ""} onClick={() => setRail("ordens")}>Ordens</button>
                <button className={rail === "atividade" ? "on" : ""} onClick={() => setRail("atividade")}>Atividade</button>
              </div>
              <div className="feed">
                {rail === "ordens" ? <Orders orders={state.orders} /> : <Activity lines={state.activity} />}
              </div>
            </aside>
          </section>
          <section className="agents">
            {state.agents.map((agent) => (
              <article key={agent.id} className="glass agent">
                <div className="who">
                  <span className={`avatar a-${agent.id}`}>{agent.name.split(" ").pop()?.slice(0, 1)}</span>
                  <div>
                    <strong>{agent.name}</strong>
                    <div><i className={`dot ${agent.status}`} />{agent.status === "healthy" ? "batimento" : agent.status === "starting" ? "iniciando" : "instável"}{agent.ageMs != null ? ` · ${ageLabel(agent.ageMs)}` : ""}</div>
                  </div>
                </div>
                <p className="mono">{usd(agent.contributionUsd)}</p>
                <small>rateio do P&L simulado</small>
              </article>
            ))}
          </section>
        </>
      )}

      {page !== "mesa" && !clean && <Secondary page={page} state={state} symbol={symbol} />}
    </div>
  );
}

function useDesk() {
  const [state, setState] = useState<DashboardState | null>(null);
  useEffect(() => {
    let source: EventSource | null = null;
    let stopped = false;
    let timer = 0;
    const connect = () => {
      source = new EventSource("/api/stream");
      source.addEventListener("state", (event) => {
        setState(JSON.parse((event as MessageEvent).data) as DashboardState);
      });
      source.onerror = () => {
        source?.close();
        if (!stopped) timer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      source?.close();
    };
  }, []);
  return state;
}

function Gauge({ value, limit }: { value: number | null; limit: number }) {
  const span = Math.max(limit, 1);
  const pctValue = value == null ? 0 : Math.min(1, Math.abs(Math.min(0, value)) / span);
  const length = Math.PI * 64;
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      <path d="M16 78 A64 64 0 0 1 144 78" className="track" />
      <path d="M16 78 A64 64 0 0 1 144 78" className="hot" strokeDasharray={`${length * pctValue} ${length}`} />
    </svg>
  );
}

function Ring({ value }: { value: number | null }) {
  const radius = 28;
  const length = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 80 80" aria-hidden="true">
      <circle cx="40" cy="40" r={radius} className="track" />
      <circle cx="40" cy="40" r={radius} className="win" strokeDasharray={`${value == null ? 0 : length * value} ${length}`} transform="rotate(-90 40 40)" />
    </svg>
  );
}

function EquityCurve({ points }: { points: { t: number; equity: number }[] }) {
  if (points.length < 2) {
    return <div className="equity-pane empty">{points.length === 1 ? `Um ponto real: ${usd(points[0].equity)}` : "DADOS INDISPONÍVEIS"}</div>;
  }
  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 100 - ((point.equity - min) / span) * 100;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  return (
    <div className="equity-pane">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={d} fill="none" stroke="#3ddc97" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function Orders({ orders }: { orders: OrderView[] }) {
  if (!orders.length) return <p className="sub">Nenhuma ordem simulada ainda.</p>;
  return orders.map((order) => (
    <div key={order.id} className="order">
      <span className={`tag ${order.kind === "ENTRY" ? "entry" : "exit"}`}>{order.kind === "ENTRY" ? "ENTRADA" : "SAÍDA"}</span>
      <strong>{order.symbol.replace("USDT", "")} · {order.side === "BUY" ? "compra" : "venda"} · {order.reason}</strong>
      <span />
      <span className="mono">{px(order.price)} · qty {order.qty.toLocaleString("pt-BR", { maximumFractionDigits: 6 })} · {formatBrtClock(order.ts)}</span>
    </div>
  ));
}

function Activity({ lines }: { lines: DashboardState["activity"] }) {
  if (!lines.length) return <p className="sub">Sem atividade registrada.</p>;
  return lines.map((line) => (
    <div key={line.id} className="act">
      <span className={`tag ${line.tag.toLowerCase()}`}>[{line.tag}]</span>
      <span>{line.text}</span>
      <span />
      <small>{formatBrtClock(line.ts)}</small>
    </div>
  ));
}

function Secondary({ page, state, symbol }: { page: Page; state: DashboardState; symbol: string }) {
  if (page === "sinais") return <Signals state={state} />;
  if (page === "mercado") return <Market state={state} symbol={symbol} />;
  if (page === "noticias") return <News state={state} />;
  if (page === "risco") return <Risk state={state} />;
  if (page === "copia") return <CopyPanel state={state} />;
  return <Reports />;
}

function Signals({ state }: { state: DashboardState }) {
  return (
    <div className="page">
      <h2>Sinais</h2>
      <p className="sub">{state.safety} R:R mínimo 1:2. Confiança é contagem de regras, não garantia.</p>
      {!state.opportunities.length && <p>Nenhuma compra ou venda aprovada neste momento.</p>}
      {state.opportunities.map((signal) => (
        <article key={signal.id} className="glass pad">
          <strong>{signal.symbol} · {signal.direction === "BUY" ? "COMPRA" : "VENDA"} · {signal.style}</strong>
          <p>{signal.justification}</p>
          <p className="mono">entrada {px(signal.entry)} · stop {px(signal.stopLoss)} · TP1 {px(signal.takeProfit1)} · TP2 {px(signal.takeProfit2)} · R:R {signal.rr?.toFixed(2) ?? "—"} · {signal.confidence ?? "—"}</p>
          <p className="sub">{formatBrt(signal.createdAt)} · válido até {signal.validUntil ? formatBrt(signal.validUntil) : "—"} · preço atual {px(signal.price)}</p>
        </article>
      ))}
      <h2>Histórico</h2>
      <table>
        <thead><tr><th>Quando</th><th>Ativo</th><th>Direção</th><th>Estado</th><th>Motivo</th></tr></thead>
        <tbody>
          {state.signals.map((signal) => (
            <tr key={signal.id}><td>{formatBrt(signal.createdAt)}</td><td>{signal.symbol}</td><td>{signal.direction}</td><td>{signal.status}</td><td>{signal.rejectReason ?? signal.confidence ?? ""}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Market({ state, symbol }: { state: DashboardState; symbol: string }) {
  const cells = state.technical[symbol] ?? {};
  return (
    <div className="page">
      <h2>Mercado</h2>
      <article className="glass pad">
        <p>Regime: {state.market.regime}</p>
        <p>{state.market.comment}</p>
        <p className="sub">Dominância: {state.market.btcDominance == null ? "DADOS INDISPONÍVEIS" : `${state.market.btcDominance.toFixed(2)}%`} · fonte {state.market.dominanceSource}{state.market.dominanceUpdatedAt ? ` · ${formatBrt(state.market.dominanceUpdatedAt)}` : ""}</p>
        <p className="sub">Feed {state.feeds.wsStatus} · {state.feeds.usingFallback ? "Binance Vision" : state.feeds.restBase}</p>
      </article>
      <table>
        <thead><tr><th>TF</th><th>RSI</th><th>MACD</th><th>Estrutura</th><th>ATR%</th></tr></thead>
        <tbody>
          {INTERVALS.map((interval) => {
            const cell = cells[interval];
            return (
              <tr key={interval}>
                <td>{interval}</td>
                <td>{cell?.stale || cell?.rsi == null ? "DADOS INDISPONÍVEIS" : cell.rsi.toFixed(1)}</td>
                <td>{cell?.stale || cell?.macdHist == null ? "DADOS INDISPONÍVEIS" : cell.macdHist.toFixed(4)}</td>
                <td>{cell?.stale ? "DADOS INDISPONÍVEIS" : cell?.structure ?? "—"}</td>
                <td>{cell?.stale || cell?.atrPct == null ? "DADOS INDISPONÍVEIS" : cell.atrPct.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function News({ state }: { state: DashboardState }) {
  return (
    <div className="page">
      <h2>Notícias</h2>
      <p className="sub">Classificação heurística. Rumor e confirmado são rótulos automáticos, não checagem editorial.</p>
      {state.news.map((item) => (
        <article key={item.id} className="glass pad">
          <strong>{item.title}</strong>
          <p className="sub">{item.source} · {formatBrt(item.ts)} · {item.sentiment} · {item.confirmation} · relevância {item.relevance}</p>
          {item.link && <a href={item.link}>{item.link}</a>}
        </article>
      ))}
      <h2>Baleias</h2>
      <FileNote note={state.whales} empty="Nenhum 2_whales.md. Defina FINANCAS_DIR para ler o relatório externo." />
    </div>
  );
}

function FileNote({ note, empty }: { note: DashboardState["whales"]; empty: string }) {
  if (!note || note.missing) return <p>{empty}</p>;
  return <pre className="note">{`Atualizado ${formatBrt(note.updatedAt)}\n\n${note.content}`}</pre>;
}

function Risk({ state }: { state: DashboardState }) {
  const [form, setForm] = useState(state.settings);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState("");
  async function save() {
    setError("");
    const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Não salvou.");
  }
  async function add() {
    setError("");
    const response = await fetch("/api/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Não adicionou.");
    else setSymbol("");
  }
  return (
    <div className="page">
      <h2>Risco e simulação</h2>
      <p className="sub">Padrão: 0,5% por trade (US$ 5 em US$ 1.000), perda diária US$ 15, meta US$ 20, R:R mínimo 1:2. Tudo editável. Nada disso envia ordem real.</p>
      {error && <p className="banner">{error}</p>}
      <div className="form">
        <Field label="Capital inicial (US$)" value={form.initialCapital} onChange={(value) => setForm({ ...form, initialCapital: value })} />
        <Field label="Risco por trade (%)" value={form.riskPerTradePct} onChange={(value) => setForm({ ...form, riskPerTradePct: value })} />
        <Field label="Perda diária (%)" value={form.dailyLossLimitPct} onChange={(value) => setForm({ ...form, dailyLossLimitPct: value })} />
        <Field label="Meta diária (%)" value={form.dailyProfitTargetPct} onChange={(value) => setForm({ ...form, dailyProfitTargetPct: value })} />
        <Field label="Taxa por lado (%)" value={form.feePctPerSide} onChange={(value) => setForm({ ...form, feePctPerSide: value })} />
        <Field label="Slippage (%)" value={form.slippagePct} onChange={(value) => setForm({ ...form, slippagePct: value })} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={() => void save()}>Salvar limites</Button>
        <Button variant="outline" onClick={() => void fetch("/api/simulator/reset", { method: "POST" })}>Zerar simulação</Button>
      </div>
      <div className="form">
        <label>Adicionar par USDT<input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="ADAUSDT" /></label>
        <Button variant="outline" onClick={() => void add()}>Adicionar</Button>
      </div>
      <p className="sub">Lista extra: {state.watchlist.length ? state.watchlist.join(", ") : "nenhum ativo além do núcleo."}</p>
      {state.watchlist.map((item) => (
        <Button key={item} variant="ghost" onClick={() => void fetch(`/api/watchlist/${item}`, { method: "DELETE" })}>Remover {item}</Button>
      ))}
      <h2>Trades simulados</h2>
      <table>
        <thead><tr><th>Ativo</th><th>Lado</th><th>Estado</th><th>Entrada</th><th>P&L</th></tr></thead>
        <tbody>
          {state.trades.map((trade) => (
            <tr key={trade.id}><td>{trade.symbol}</td><td>{trade.side}</td><td>{trade.status}</td><td className="mono">{px(trade.entryFill)}</td><td className="mono">{usd(trade.realizedPnl + (trade.unrealizedPnl ?? 0))}</td></tr>
          ))}
        </tbody>
      </table>
      <FileNote note={state.riskNotes} empty="Sem 5_risk.md externo." />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input type="number" step="0.01" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function CopyPanel({ state }: { state: DashboardState }) {
  const copy = state.copy;
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  const [watchCode, setWatchCode] = useState<string | null>(null);
  const opened = copy.traders.find((trader) => trader.address === openAddress) ?? null;
  const watch = copy.watches.find((item) => item.code === watchCode) ?? null;
  const balance = copy.curve.length ? copy.curve[copy.curve.length - 1].equity : null;
  async function follow(value: string) {
    setError("");
    const response = await fetch("/api/copy/traders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: value }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Não seguiu.");
    else setAddress("");
  }
  async function saveMode(mode: "separate" | "shared") {
    await fetch("/api/copy/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  }
  return (
    <div className="copy-screen">
      <header className="copy-top">
        <div>
          <h2>ROGÉRIO CRYPTO TRADING DESK · Copy Trading (SIMULADO)</h2>
          <p className="sub">{copy.traders.length} carteiras · {copy.copyCount} cópias · {copy.watches.length} acompanhamentos · {copy.blockedSeeds.length} bloqueados · desvio máx. {copy.settings.maxDeviationPct}% · feed {copy.ws}</p>
        </div>
        <div className="combo">combo {copy.streak}</div>
      </header>
      <div className="copy-tools">
        <input value={address} placeholder="0x endereço público" onChange={(event) => setAddress(event.target.value.trim())} />
        <Button onClick={() => void follow(address)}>Seguir</Button>
        <button className={copy.settings.mode === "separate" ? "on" : ""} onClick={() => void saveMode("separate")}>Caixa separado</button>
        <button className={copy.settings.mode === "shared" ? "on" : ""} onClick={() => void saveMode("shared")}>Caixa da mesa</button>
        <button
          className={copy.paused ? "on" : ""}
          title="Pausa só as entradas novas. Stops e saídas continuam."
          onClick={() =>
            void fetch("/api/copy/pause", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ paused: !copy.paused }),
            })
          }
        >
          {copy.paused ? "Cópia PAUSADA · retomar" : "Pausar cópia"}
        </button>
        <button
          title="Fecha a mercado (simulado) todas as posições copiadas abertas"
          onClick={() => {
            if (window.confirm("Fechar a mercado (simulado) todas as posições copiadas abertas?")) void fetch("/api/copy/close-all", { method: "POST" });
          }}
        >
          Fechar tudo
        </button>
        <button onClick={() => void fetch("/api/copy/reset", { method: "POST" })}>Zerar</button>
      </div>
      {copy.paused && (
        <p className="banner">
          Cópia PAUSADA: sem novas entradas. Stops e saídas continuam. Regras: máx. {copy.settings.maxOpenPositions} posições abertas, 1 por moeda, risco aberto total dentro do limite diário restante
          {copy.remainingLossUsd == null ? "" : ` (restante ${usd(copy.remainingLossUsd)})`}.
        </p>
      )}
      {error && <p className="banner">{error}</p>}
      {copy.suggestions.length > 0 && (
        <div className="copy-tools">
          {copy.suggestions.map((item) => (
            <button key={item} onClick={() => void follow(item)}>{shortAddr(item)} em 2_whales.md</button>
          ))}
        </div>
      )}
      <section className="copy-metrics">
        <article>
          <span>SALDO</span>
          <strong>{balance == null ? "DADOS INDISPONÍVEIS" : usd(balance)}</strong>
          <small>iniciado em {usd(copy.settings.initialCapital)} · só fills gravados</small>
        </article>
        <article>
          <span>P&L TOTAL</span>
          <strong className={signClass(copy.totalPnl)}>{copy.totalPnl == null ? "DADOS INDISPONÍVEIS" : usd(copy.totalPnl)}</strong>
          <small>{copy.blockReason ?? `dia ${copy.dayPnl == null ? "indisponível" : usd(copy.dayPnl)}`}</small>
        </article>
        <article className="with-gauge">
          <CopyGauge value={copy.drawdownPct} />
          <div>
            <span>MAX DRAWDOWN</span>
            <strong>{copy.drawdownPct == null ? "DADOS INDISPONÍVEIS" : pct(copy.drawdownPct)}</strong>
          </div>
        </article>
        <article className="with-gauge">
          <CopyRing value={copy.winRate} />
          <div>
            <span>WIN RATE</span>
            <strong>{copy.winRate == null ? "DADOS INDISPONÍVEIS" : pct(copy.winRate * 100, 0)}</strong>
          </div>
        </article>
      </section>
      <section className="copy-stage">
        <div className="copy-chart">
          <div className="copy-chart-label">HISTÓRICO DO SALDO</div>
          <FillCurve points={copy.curve} />
        </div>
        <aside className="copy-log">
          <div className="copy-chart-label">COPY LOG</div>
          <div className="copy-log-feed">
            {!copy.events.length && <p className="sub">Nenhum evento. Fill antigo não vira cópia.</p>}
            {copy.events.map((event) => (
              <p key={event.id} className={`log-line tag-${event.action}`}>
                <b>[{event.action}]</b> {event.coin ? `${event.coin} · ` : ""}{event.reason}
              </p>
            ))}
          </div>
        </aside>
      </section>
      <section className="copy-cards">
        {!copy.traders.length && <p className="sub">Nenhuma carteira seguida.</p>}
        {copy.traders.map((trader) => (
          <article key={trader.address} className={`clickable${trader.suspended ? " blocked" : ""}`} onClick={() => setOpenAddress(trader.address)}>
            <div className="who">
              <span className="avatar">{(trader.displayName ?? trader.address).slice(2, 3).toUpperCase()}</span>
              <div>
                <strong>{trader.displayName ?? "carteira"}</strong>
                <small className="addr">{shortAddr(trader.address)}</small>
                {trader.suspended && <small className="suspended"><b>SUSPENSO</b> até revisão do Risk Manager · sem novas entradas</small>}
              </div>
            </div>
            <p className={`mono ${signClass(trader.copiedPnl)}`}>{trader.copiedPnl == null ? "DADOS INDISPONÍVEIS" : usd(trader.copiedPnl)}</p>
            <small>P&L copiado · vol. fonte {trader.feedStale || trader.dayVolume == null ? "DADOS INDISPONÍVEIS" : compactUsd(trader.dayVolume)}</small>
            <button
              title="Suspende só as entradas novas deste trader. A pausa geral não o reativa."
              onClick={(event) => {
                event.stopPropagation();
                void fetch("/api/copy/suspend", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ address: trader.address, suspended: !trader.suspended }),
                });
              }}
            >
              {trader.suspended ? "Reativar" : "Suspender"}
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                void fetch(`/api/copy/traders/${trader.address}`, { method: "DELETE" });
                if (openAddress === trader.address) setOpenAddress(null);
              }}
            >
              Remover
            </button>
          </article>
        ))}
        {copy.blockedSeeds.map((item) => (
          <article key={item.id} className="blocked">
            <div className="who">
              <span className="avatar">{item.name.slice(0, 1)}</span>
              <div>
                <strong>{item.name}</strong>
                <small>bloqueado · sem cópia</small>
              </div>
            </div>
            <p>{item.reason}</p>
            <small>{item.kind === "okx" ? "OKX" : "Hyperliquid"} · a mesa não abre posição</small>
          </article>
        ))}
        {copy.watches.map((item) => (
          <article key={item.code} className="clickable watch" onClick={() => setWatchCode(item.code)}>
            <div className="who">
              <span className="avatar">{item.name.slice(0, 1)}</span>
              <div>
                <strong>{item.name}</strong>
                <small>acompanhamento · sem cópia</small>
              </div>
            </div>
            <p className="mono">{item.windows.find((window) => window.label === "90d")?.pnl == null ? "DADOS INDISPONÍVEIS" : usd(item.windows.find((window) => window.label === "90d")?.pnl ?? null, 0)}</p>
            <small>PnL 90d da OKX · {item.fetchedAt ? formatBrt(item.fetchedAt) : "leitura pendente"}</small>
          </article>
        ))}
      </section>
      {opened && <TraderDrawer trader={opened} onClose={() => setOpenAddress(null)} />}
      {watch && <WatchDrawer watch={watch} onClose={() => setWatchCode(null)} />}
    </div>
  );
}

function WatchDrawer({ watch, onClose }: { watch: DashboardState["copy"]["watches"][number]; onClose: () => void }) {
  return (
    <div className="drawer-back" onClick={onClose}>
      <section className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="copy-top">
          <div>
            <h2>{watch.name}</h2>
            <p className="sub">acompanhamento · sem cópia · OKX spot não publica fills. Drawdown: DADOS INDISPONÍVEIS.</p>
          </div>
          <button onClick={onClose}>Fechar</button>
        </header>
        <p className="sub">Lido em {watch.fetchedAt ? formatBrt(watch.fetchedAt) : "DADOS INDISPONÍVEIS"}{watch.error ? ` · ${watch.error}` : ""}</p>
        <table>
          <thead><tr><th>Janela</th><th>PnL</th><th>ROI</th><th>Win ratio</th><th>Horário da fonte</th></tr></thead>
          <tbody>
            {watch.windows.length === 0 && <tr><td colSpan={5}>DADOS INDISPONÍVEIS</td></tr>}
            {watch.windows.map((window) => (
              <tr key={window.label}>
                <td>{window.label}</td>
                <td className="mono">{window.pnl == null ? "DADOS INDISPONÍVEIS" : usd(window.pnl)}</td>
                <td className="mono">{window.roi == null ? "DADOS INDISPONÍVEIS" : pct(window.roi * 100)}</td>
                <td className="mono">{window.winRatio == null ? "DADOS INDISPONÍVEIS" : pct(window.winRatio * 100)}</td>
                <td>{window.sourceTime ? formatBrt(window.sourceTime) : "DADOS INDISPONÍVEIS"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub">PnL dos copiadores na fonte: {watch.copyTraderPnl == null ? "DADOS INDISPONÍVEIS" : usd(watch.copyTraderPnl)} · investAmt: {watch.aum == null ? "DADOS INDISPONÍVEIS" : usd(watch.aum, 0)}</p>
        <p className="sub"><a href={watch.profileUrl}>{watch.profileUrl}</a></p>
      </section>
    </div>
  );
}

function TraderDrawer({ trader, onClose }: { trader: DashboardState["copy"]["traders"][number]; onClose: () => void }) {
  const coins = [...new Set([...trader.positions.map((position) => position.coin), ...trader.fills.map((fill) => fill.coin)].filter(Boolean))];
  const [coin, setCoin] = useState(coins[0] ?? "BTC");
  const active = coins.includes(coin) ? coin : coins[0] ?? "BTC";
  return (
    <div className="drawer-back" onClick={onClose}>
      <section className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="copy-top">
          <div>
            <h2>{trader.displayName ?? "Carteira"} · {shortAddr(trader.address)}</h2>
            <p className="sub">
              {trader.feedStale ? "DADOS INDISPONÍVEIS" : "feed ao vivo"}
              {trader.feedAgeMs != null ? ` · ${ageLabel(trader.feedAgeMs)}` : ""}
              {" · "}simulação, sem ordem real
            </p>
          </div>
          <button onClick={onClose}>Fechar</button>
        </header>
        {trader.error && <p className="banner">{trader.error}</p>}
        <h3>Posições abertas na fonte</h3>
        {!trader.positions.length && <p className="sub">{trader.feedStale ? "DADOS INDISPONÍVEIS" : "Nenhuma posição aberta no último snapshot público."}</p>}
        {trader.positions.length > 0 && (
          <table>
            <thead>
              <tr><th>Ativo</th><th>Lado</th><th>Tamanho</th><th>Entrada</th><th>Mark</th><th>P&L não realizado</th><th>Alavancagem</th></tr>
            </thead>
            <tbody>
              {trader.positions.map((position) => (
                <tr key={position.coin}>
                  <td>{position.coin}</td>
                  <td>{position.side === "long" ? "compra" : "venda"}</td>
                  <td className="mono">{position.size}</td>
                  <td className="mono">{px(position.entry)}</td>
                  <td className="mono">{position.mark == null ? "DADOS INDISPONÍVEIS" : px(position.mark)}</td>
                  <td className="mono">{position.unrealized == null ? "DADOS INDISPONÍVEIS" : usd(position.unrealized)}</td>
                  <td>{position.leverage == null ? "DADOS INDISPONÍVEIS" : `${position.leverage}x fonte`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="copy-tools">
          {coins.map((item) => (
            <button key={item} className={item === active ? "on" : ""} onClick={() => setCoin(item)}>{item}</button>
          ))}
        </div>
        <TraderChart coin={active} stale={trader.feedStale} fills={trader.fills.filter((fill) => fill.coin === active)} />
        <div className="tape">
          <div>
            <h3>Entradas e saídas da fonte</h3>
            {!trader.fills.filter((fill) => fill.coin === active).length && <p className="sub">{trader.feedStale ? "DADOS INDISPONÍVEIS" : "Nenhum fill público recente."}</p>}
            {trader.fills.filter((fill) => fill.coin === active).map((fill) => (
              <p key={fill.id} className="log-line">
                <b>{fill.dir || fill.side}</b> {px(fill.px)} · qtd {fill.sz} · {formatBrtClock(fill.time)} · {fill.source === "ws" ? "websocket" : "polling"}
              </p>
            ))}
          </div>
          <div>
            <h3>Nossa simulação</h3>
            {trader.fills.filter((fill) => fill.coin === active).map((fill) => (
              <p key={`${fill.id}-ours`} className={`log-line ${fill.outcome === "copiada" ? "" : "tag-SKIP"}`}>
                {fill.outcome === "copiada" ? (
                  <>
                    <b>COPIADA</b> {fill.ourSide === "SELL" ? "venda" : "compra"} qty {fill.ourQty ?? "—"} · entrada {fill.ourEntry == null ? "—" : px(fill.ourEntry)} · stop {fill.ourStop == null ? "—" : px(fill.ourStop)} · P&L {fill.ourPnl == null ? "DADOS INDISPONÍVEIS" : usd(fill.ourPnl)}
                  </>
                ) : (
                  <>
                    <b>DESCARTADA</b> {fill.reason}
                  </>
                )}
              </p>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function FillCurve({ points }: { points: DashboardState["copy"]["curve"] }) {
  if (!points.length) return <div className="equity-pane empty">DADOS INDISPONÍVEIS</div>;
  if (points.length === 1) {
    return (
      <div className="equity-pane empty">
        <strong className="mono">{usd(points[0].equity)}</strong>
        <span>Um ponto registrado em {axisLabel(points[0].t)}. Sem fills simulados, a curva não se move.</span>
      </div>
    );
  }
  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 8 + (1 - (point.equity - min) / span) * 78;
    return { x, y, t: point.t, equity: point.equity };
  });
  const line = coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L 100 96 L 0 96 Z`;
  const ticks = [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]];
  return (
    <div className="fill-curve">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={area} className="area" />
        <path d={line} className="line" />
      </svg>
      <div className="axis">
        {ticks.map((tick) => (
          <span key={tick.t}>{axisLabel(tick.t)}</span>
        ))}
      </div>
    </div>
  );
}

function axisLabel(ts: number): string {
  const text = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
  return `${text} BRT`;
}

function CopyGauge({ value }: { value: number | null }) {
  const pctValue = value == null ? 0 : Math.min(1, Math.abs(Math.min(0, value)) / 15);
  const length = Math.PI * 28;
  return (
    <svg viewBox="0 0 80 48" aria-hidden="true">
      <path d="M8 40 A28 28 0 0 1 72 40" className="track" />
      <path d="M8 40 A28 28 0 0 1 72 40" className="cyan" strokeDasharray={`${length * pctValue} ${length}`} />
    </svg>
  );
}

function CopyRing({ value }: { value: number | null }) {
  const radius = 16;
  const length = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r={radius} className="track" />
      <circle cx="24" cy="24" r={radius} className="cyan" strokeDasharray={`${value == null ? 0 : length * value} ${length}`} transform="rotate(-90 24 24)" />
    </svg>
  );
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Reports() {
  const [period, setPeriod] = useState("daily");
  const [text, setText] = useState("Carregando…");
  useEffect(() => {
    void fetch(`/api/reports?period=${period}`).then((response) => response.json()).then((report) => {
      setText(`${report.label}\nSinais: ${report.signals}\nAprovados: ${report.approved}\nRejeitados: ${report.rejected}\nTrades positivos: ${report.positiveTrades}\nTrades negativos: ${report.negativeTrades}\nAcerto: ${report.winRate == null ? "DADOS INDISPONÍVEIS" : pct(report.winRate * 100)}\nP&L: ${usd(report.pnl)}\nMelhor: ${report.bestAsset?.symbol ?? "—"}\nPior: ${report.worstAsset?.symbol ?? "—"}`);
    });
  }, [period]);
  return (
    <div className="page">
      <h2>Relatórios</h2>
      <div className="nav">
        <button className={period === "daily" ? "on" : ""} onClick={() => setPeriod("daily")}>Diário</button>
        <button className={period === "weekly" ? "on" : ""} onClick={() => setPeriod("weekly")}>Semanal</button>
        <button className={period === "monthly" ? "on" : ""} onClick={() => setPeriod("monthly")}>Mensal</button>
        <a href={`/api/reports/export?period=${period}&format=md`}>Markdown</a>
        <a href={`/api/reports/export?period=${period}&format=csv`}>CSV</a>
      </div>
      <pre className="note">{text}</pre>
    </div>
  );
}

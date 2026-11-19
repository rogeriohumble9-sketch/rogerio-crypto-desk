# ROGÉRIO Crypto Trading Desk

Mesa de análise e simulação de cripto. Lê preços públicos, calcula indicadores, publica sinais com regras explícitas e opera um simulador de papel. Não envia ordem, não movimenta dinheiro, não acessa carteira e não pede senha, chave de API ou chave de saque.

A interface está em português. Os horários usam `America/Sao_Paulo` e o rótulo BRT.

## Rodar localmente

Requer Node.js 22 ou mais novo.

```bash
npm install
npm run build
npm start
```

Abra `http://127.0.0.1:8080`. A mesa já entra no layout completo: faixa de ativos, saldo, drawdown, taxa de acerto, gráfico de candles, fluxo de ordens e cartões dos agentes. **PLAY** liga a simulação automática. **PAUSE** não abre entrada nova; stop e alvo das posições já abertas continuam. **Modo limpo** esconde os painéis e deixa só o gráfico, ainda no tema escuro.

Testes:

```bash
npm test
```

O teste de fumaça sobe o servidor por cerca de dois minutos contra a Binance pública e confere `/health`.

## Limites da simulação

No padrão, sobre US$ 1.000 de capital hipotético:

| Regra | Valor |
| --- | --- |
| Risco por trade | 0,5% = US$ 5 |
| Perda diária | 1,5% = US$ 15, bloqueia entradas novas até a próxima sessão BRT |
| Meta diária | 2% = US$ 20, para o dia |
| Risco/retorno mínimo até o TP1 | 1:2 |
| Taxa estimada | 0,1% por lado |
| Slippage estimado | 0,02% |

Tudo isso é editável na aba Risco. A confiança do sinal é uma contagem de regras (Forte, Moderada, Fraca), não uma probabilidade e não uma garantia. Sem confluência, a mesa não publica compra nem venda. Cotação velha aparece como **DADOS INDISPONÍVEIS** e não entra como preço ao vivo.

O botão PLAY/PAUSE fica gravado. Com PLAY, sinal aprovado abre e encerra posição simulada sem pedido de confirmação.

## Cópia simulada

A aba Cópia segue endereços públicos da Hyperliquid (`POST https://api.hyperliquid.xyz/info`, fills por WebSocket e o leaderboard público). Não pede chave e não espelha o tamanho nem a alavancagem de quem é seguido.

- O padrão é um caixa separado de US$ 1.000. Dá para usar o caixa da mesa.
- Cada entrada é recalculada para no máximo 0,5% do patrimônio (US$ 5 no início), com stop público do trader ou, se não houver, stop por ATR da Binance. O registro diz qual foi usado.
- Sempre 1x. Aumentar posição perdedora não é copiado.
- Perda de US$ 15 no dia bloqueia cópias novas até a sessão seguinte. Meta de US$ 20 encerra o dia.
- Fill mais velho que 60s, ou preço que desvie mais de 0,3% da Binance, é ignorado. O motivo fica no registro.
- Endereços `0x` em `FINANCAS_DIR/2_whales.md` aparecem como candidatos, sem seguir sozinhos.
- `FINANCAS_DIR/2_copy_traders.md` é relido como semente, e o veredito do risco prevalece. Só a Hyperliquid `0xec85bc052ec5b6d6cb2b40f5caa45e39b61a77fe` é copiada, em BTC, ETH, SOL, BNB e XRP, sempre a 1x, com risco de US$ 5 e stop da própria mesa. Fill com mais de 60s ou preço a mais de 0,3% da Binance é `SKIP`. Ficam bloqueados, visíveis e sem cópia: `0x10e14ba2d77263543be1bdb2851b0933ddf4f4bd` (3x, 100% da margem) e Charely na OKX (−30,6% em 365 dias). Idle-Vaporware-Taro, BTV-Michael e mimidaidan são só acompanhamento.

## Variáveis de ambiente

| Variável | Padrão | Função |
| --- | --- | --- |
| `PORT` | `8080` | Porta HTTP única |
| `HOST` | `0.0.0.0` | Interface de escuta |
| `SQLITE_PATH` | `./data/desk.sqlite` | Banco da mesa |
| `FINANCAS_DIR` | vazio | Lê `3_news.md`, `2_whales.md` e `5_risk.md`. Grava `desk_signals.md` e `desk_simulador.md` a cada ciclo |
| `BINANCE_REST_BASE` | `https://api.binance.com` | REST público |
| `BINANCE_REST_FALLBACK` | `https://data-api.binance.vision` | Usado se o host principal responder 451 ou falhar |
| `BINANCE_WS_BASE` | `wss://stream.binance.com:9443` | WebSocket público |
| `BINANCE_WS_FALLBACK` | `wss://data-stream.binance.vision` | WebSocket alternativo |
| `STALE_TICKER_MS` | `20000` | Idade máxima para tratar o preço como ao vivo |
| `MIN_QUOTE_VOLUME_USDT` | `2000000` | Volume mínimo para incluir um par na lista |
| `ALERT_WEBHOOK_URL` | vazio | POST JSON opcional. Desligado por padrão |
| `TELEGRAM_BOT_TOKEN` | vazio | Telegram opcional. Desligado por padrão |
| `TELEGRAM_CHAT_ID` | vazio | Destino do Telegram |
| `DESK_ACCESS_TOKEN` | vazio | Se definido, o painel e as alterações (PLAY/PAUSE, limites, cópia) exigem `?token=` uma vez. O navegador guarda um cookie. `/health` continua aberto |

`MESA: BLOQUEAR` dentro de `5_risk.md` faz o gestor recusar entradas novas.

## Deploy público

O processo escuta `PORT` e grava o SQLite em `SQLITE_PATH`. Sem volume, o histórico some quando o container é recriado.

Docker:

```bash
docker build -t rogerio-desk .
docker run --rm -p 8080:8080 -v rogerio-data:/data -e SQLITE_PATH=/data/desk.sqlite rogerio-desk
```

VPS:

```bash
git clone <seu-repositorio>
cd <seu-repositorio>
docker compose up -d --build
```

Não há `docker-compose.yml` obrigatório. O comando direto acima basta. Atrás de um proxy, encaminhe a porta 8080 e preserve o upgrade se for usar o mesmo host. O painel usa SSE (`/api/stream`); o proxy não pode bufferizar essa resposta.

Render, Railway ou Fly:

1. Serviço web a partir deste Dockerfile.
2. Defina `PORT` com a porta que a plataforma injeta. O programa já lê `PORT`.
3. Aponte `SQLITE_PATH` para um disco persistente (`/data/desk.sqlite` no Fly com volume, ou o disco da Railway).
4. Saúde: `GET /health`.

O `/health` devolve a idade de cada feed e o batimento de cada agente. `ready` fica verdadeiro quando algum ativo do núcleo tem preço fresco.

Núcleo fixo: BTC, ETH, XRP, BNB e SOL contra USDT. Outros pares USDT entram pela aba Risco se existirem na Binance à vista e tiverem volume bastante.

## Rodar atrás de um túnel público

O servidor escuta em `0.0.0.0` (variável `HOST`). O painel só chama caminhos relativos (`/api/state`, `/api/stream`, `/api/klines`). A página em HTTPS usa HTTPS nessa mesma origem. O navegador não abre `ws://` contra a mesa: o ao vivo do painel é SSE. Os WebSockets da Binance e da Hyperliquid ficam no processo, já em `wss://`.

O proxy ou túnel precisa repassar `X-Forwarded-Proto: https` e não pode bufferizar `/api/stream`.

No servidor sempre ligado, com os relatórios em `/workspace/financas`:

```bash
tar -xzf trading-desk-src.tar.gz
cd trading-desk-src
npm install
npm run build
export HOST=0.0.0.0
export PORT=8080
export FINANCAS_DIR=/workspace/financas
export SQLITE_PATH=/workspace/financas/desk.sqlite
export DESK_ACCESS_TOKEN='escolha-um-valor-longo'
npm start
```

Túnel, a partir da mesma máquina:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Abra a URL `https://…` que o túnel mostrar, uma vez, como `https://…/?token=escolha-um-valor-longo`. O cookie fica no navegador. PLAY/PAUSE, limites, lista e cópia passam a ir com esse cookie. Sem `DESK_ACCESS_TOKEN`, a mesa abre direto. Não coloque o token no git nem no pacote.

`GET /health` não pede token, para o monitoramento do túnel.

## O que a mesa não faz

Não há cadastro, senha, chave de API, saque, carteira nem endpoint autenticado de corretora. Os sinais e o P&L são simulação. Um número que a mesa não conseguiu ler aparece como dado indisponível, não como estimativa.

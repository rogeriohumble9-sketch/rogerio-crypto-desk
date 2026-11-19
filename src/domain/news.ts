export interface NewsClass {
  sentiment: "positivo" | "negativo" | "neutro";
  relevance: "alta" | "media" | "baixa";
  confirmation: "confirmado" | "rumor" | "indeterminado";
}

const POSITIVE = [
  /aprova/,
  /aprovad/,
  /alta(?! da infla)/,
  /rally/,
  /recorde/,
  /ado[cç][aã]o/,
  /corte de juros/,
  /corta os juros/,
  /rate cut/,
  /cuts rates/,
  /inflow/,
  /entrada de capital/,
  /parceria/,
  /supera/,
  /bullish/,
  /easing/,
  /compra de bitcoin/,
  /acumula/,
  /recupera/,
  /sobe/,
];

const NEGATIVE = [
  /hack/,
  /exploit/,
  /golpe/,
  /processo/,
  /lawsuit/,
  /proib/,
  /baniu/,
  /banned/,
  /queda/,
  /despenca/,
  /crash/,
  /bearish/,
  /infla[cç][aã]o/,
  /inflation/,
  /sobe os juros/,
  /alta dos juros/,
  /rate hike/,
  /hike/,
  /outflow/,
  /sa[ií]da de capital/,
  /guerra/,
  /war\b/,
  /san[cç][aã]o/,
  /sanction/,
  /fal[eê]ncia/,
  /insolv/,
  /liquida[cç][aã]o/,
  /recession/,
  /recess[aã]o/,
  /fraude/,
  /investiga/,
  /roubo/,
];

const RUMOR = [
  /rumou?r/,
  /rumor/,
  /fontes dizem/,
  /sources say/,
  /n[aã]o confirmad/,
  /unconfirmed/,
  /especula/,
  /speculation/,
  /segundo rumores/,
  /reportedly/,
  /dizem que/,
  /pode estar/,
];

const CONFIRMED = [
  /anunci/,
  /announc/,
  /oficial/,
  /official/,
  /comunicado/,
  /publicou/,
  /aprovou/,
  /approved/,
  /\bfomc\b/,
  /\bcpi\b/,
  /payroll/,
  /dados de/,
  /relat[oó]rio/,
  /comunicou/,
];

const HIGH = [
  /bitcoin/,
  /\bbtc\b/,
  /ethereum/,
  /\beth\b/,
  /\bfed\b/,
  /federal reserve/,
  /juros/,
  /interest rate/,
  /infla/,
  /\betf\b/,
  /\bsec\b/,
  /regula/,
  /stablecoin/,
  /binance/,
  /blackrock/,
  /guerra/,
  /geopol/,
];

function hits(text: string, rules: RegExp[]): number {
  return rules.reduce((n, rule) => n + (rule.test(text) ? 1 : 0), 0);
}

/** Classificação por palavras-chave. É heurística e deve ser exibida como tal. */
export function classifyText(title: string, summary = ""): NewsClass {
  const text = `${title} ${summary}`.toLowerCase();
  const pos = hits(text, POSITIVE);
  const neg = hits(text, NEGATIVE);
  let sentiment: NewsClass["sentiment"] = "neutro";
  if (pos > neg && pos > 0) sentiment = "positivo";
  else if (neg > pos && neg > 0) sentiment = "negativo";
  const rumor = hits(text, RUMOR) > 0;
  const confirmed = hits(text, CONFIRMED) > 0;
  const confirmation: NewsClass["confirmation"] = rumor ? "rumor" : confirmed ? "confirmado" : "indeterminado";
  const high = hits(text, HIGH) > 0;
  const relevance: NewsClass["relevance"] = high ? "alta" : sentiment === "neutro" ? "baixa" : "media";
  return { sentiment, relevance, confirmation };
}

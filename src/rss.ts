import { XMLParser } from "fast-xml-parser";

export interface RssItem {
  title: string;
  link: string | null;
  summary: string;
  ts: number | null;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

export function parseFeed(xml: string): RssItem[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const root = doc as { rss?: { channel?: { item?: unknown } }; feed?: { entry?: unknown } };
  const raw = root.rss?.channel?.item ?? root.feed?.entry ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: RssItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = textOf(row.title);
    if (!title) continue;
    out.push({
      title,
      link: linkOf(row.link) ?? linkOf(row.id),
      summary: strip(textOf(row.description) || textOf(row.summary) || textOf(row.content) || "").slice(0, 280),
      ts: timeOf(row.pubDate ?? row.published ?? row.updated ?? row.date),
    });
  }
  return out;
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row["#text"] === "string") return row["#text"].trim();
    if (typeof row.text === "string") return row.text.trim();
  }
  return "";
}

function linkOf(value: unknown): string | null {
  if (typeof value === "string" && value.startsWith("http")) return value;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.href === "string") return row.href;
    const text = textOf(value);
    if (text.startsWith("http")) return text;
  }
  return null;
}

function timeOf(value: unknown): number | null {
  const text = textOf(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function strip(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

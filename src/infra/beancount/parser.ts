export type MetaValue = string | number | boolean;

export type Metadata = Record<string, MetaValue>;

export type ParsedOpen = {
  date: string;
  account: string;
  currencies: string[];
  booking?: string;
  metadata: Metadata;
};

export type ParsedClose = {
  date: string;
  account: string;
};

export type ParsedPosting = {
  account: string;
  amount?: number;
  currency?: string;
  flag?: string;
  metadata: Metadata;
};

export type ParsedTransaction = {
  date: string;
  flag: "*" | "!";
  payee?: string;
  narration?: string;
  tags: string[];
  links: string[];
  metadata: Metadata;
  postings: ParsedPosting[];
};

export type BeancountDocument = {
  preamble: string[];
  opens: ParsedOpen[];
  closes: ParsedClose[];
  transactions: ParsedTransaction[];
  epilogue: string[];
};

const OPEN_RE = /^(\d{4}-\d{2}-\d{2})\s+open\s+([^\s]+)(?:\s+(.*))?$/;
const CLOSE_RE = /^(\d{4}-\d{2}-\d{2})\s+close\s+([^\s]+)\s*$/;
const TXN_RE = /^(\d{4}-\d{2}-\d{2})\s+([*!])\s*(.*)$/;
const POSTING_RE = /^(\s*)([!*]?)\s*([^\s]+)(?:\s+([-+]?\d[\d,]*(?:\.\d+)?)\s+([A-Z][A-Z0-9_]*))?/;
const META_RE = /^(\s*)([\w-]+):\s*(.+)$/;

function parseMetaValue(raw: string): MetaValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed === "TRUE") return true;
  if (trimmed === "FALSE") return false;
  const num = Number.parseFloat(trimmed);
  if (!Number.isNaN(num) && /^-?\d/.test(trimmed)) {
    return num;
  }
  return trimmed;
}

function parseMetadataBlock(lines: string[], startIndex: number): { metadata: Metadata; nextIndex: number } {
  const metadata: Metadata = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const metaMatch = META_RE.exec(line);
    if (!metaMatch || metaMatch[1].length < 2) {
      break;
    }
    metadata[metaMatch[2]] = parseMetaValue(metaMatch[3]);
    index += 1;
  }
  return { metadata, nextIndex: index };
}

function parseTransactionHeader(rest: string): {
  payee?: string;
  narration?: string;
  tags: string[];
  links: string[];
} {
  const tags = [...rest.matchAll(/#([\w-]+)/g)].map((match) => match[1]);
  const links = [...rest.matchAll(/\^([\w-]+)/g)].map((match) => match[1]);
  let cleaned = rest.replace(/#[\w-]+/g, "").replace(/\^[\w-]+/g, "").trim();
  const strings: string[] = [];
  while (cleaned.length > 0) {
    if (cleaned.startsWith('"')) {
      let end = 1;
      while (end < cleaned.length) {
        if (cleaned[end] === '"' && cleaned[end - 1] !== "\\") break;
        end += 1;
      }
      strings.push(cleaned.slice(1, end).replace(/\\"/g, '"'));
      cleaned = cleaned.slice(end + 1).trim();
    } else {
      break;
    }
  }
  return {
    payee: strings[0],
    narration: strings[1],
    tags,
    links
  };
}

function parseOpenTail(tail: string): { currencies: string[]; booking?: string } {
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { currencies: [] };
  }
  const last = tokens[tokens.length - 1];
  if (last === "FIFO" || last === "LIFO" || last === "NONE" || last === "STRICT" || last === "HIFO") {
    return { currencies: tokens.slice(0, -1), booking: last };
  }
  return { currencies: tokens };
}

export function parseBeancount(source: string): BeancountDocument {
  const lines = source.split(/\r?\n/);
  const preamble: string[] = [];
  const opens: ParsedOpen[] = [];
  const closes: ParsedClose[] = [];
  const transactions: ParsedTransaction[] = [];
  const epilogue: string[] = [];

  let index = 0;
  let section: "preamble" | "accounts" | "body" | "epilogue" = "preamble";

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith(";;")) {
      if (section === "preamble") preamble.push(line);
      else if (section === "epilogue") epilogue.push(line);
      index += 1;
      continue;
    }

    const openMatch = OPEN_RE.exec(trimmed);
    if (openMatch) {
      section = "accounts";
      const { metadata, nextIndex } = parseMetadataBlock(lines, index + 1);
      const tail = parseOpenTail(openMatch[3] ?? "");
      opens.push({
        date: openMatch[1],
        account: openMatch[2],
        currencies: tail.currencies,
        booking: tail.booking,
        metadata
      });
      index = nextIndex;
      continue;
    }

    const closeMatch = CLOSE_RE.exec(trimmed);
    if (closeMatch) {
      section = "body";
      closes.push({ date: closeMatch[1], account: closeMatch[2] });
      index += 1;
      continue;
    }

    const txnMatch = TXN_RE.exec(trimmed);
    if (txnMatch) {
      section = "body";
      const header = parseTransactionHeader(txnMatch[3] ?? "");
      const { metadata, nextIndex: metaEnd } = parseMetadataBlock(lines, index + 1);
      index = metaEnd;
      const postings: ParsedPosting[] = [];
      while (index < lines.length) {
        const postingLine = lines[index];
        if (!postingLine.trim()) {
          index += 1;
          break;
        }
        const metaOnly = META_RE.exec(postingLine);
        if (metaOnly && metaOnly[1].length >= 2 && !POSTING_RE.test(postingLine)) {
          break;
        }
        const postingMatch = POSTING_RE.exec(postingLine);
        if (!postingMatch || postingMatch[1].length < 2) {
          break;
        }
        const amountRaw = postingMatch[4]?.replace(/,/g, "");
        const { metadata: postingMeta, nextIndex: postingMetaEnd } = parseMetadataBlock(
          lines,
          index + 1
        );
        postings.push({
          flag: postingMatch[2] || undefined,
          account: postingMatch[3],
          amount: amountRaw ? Number.parseFloat(amountRaw) : undefined,
          currency: postingMatch[5],
          metadata: postingMeta
        });
        index = postingMetaEnd;
      }
      transactions.push({
        date: txnMatch[1],
        flag: txnMatch[2] as "*" | "!",
        payee: header.payee,
        narration: header.narration,
        tags: header.tags,
        links: header.links,
        metadata,
        postings
      });
      continue;
    }

    if (section === "preamble") {
      preamble.push(line);
    } else {
      section = "epilogue";
      epilogue.push(line);
    }
    index += 1;
  }

  return { preamble, opens, closes, transactions, epilogue };
}

export function serializeBeancount(document: BeancountDocument): string {
  const chunks: string[] = [];
  chunks.push(...document.preamble);
  if (document.preamble.length > 0) chunks.push("");

  if (document.opens.length > 0) {
    chunks.push(";; ---- Chart of accounts ----");
    for (const open of document.opens) {
      const currencies = open.currencies.join(" ");
      const booking = open.booking ? ` ${open.booking}` : "";
      chunks.push(`${open.date} open ${open.account}${currencies ? ` ${currencies}` : ""}${booking}`);
      for (const [key, value] of Object.entries(open.metadata)) {
        chunks.push(`  ${key}: ${formatMetaValue(value)}`);
      }
    }
    chunks.push("");
  }

  if (document.transactions.length > 0) {
    chunks.push(";; ---- Transactions ----");
    for (const txn of document.transactions) {
      const payee = txn.payee ? `${escapeQuoted(txn.payee)} ` : "";
      const narration = txn.narration ? `${escapeQuoted(txn.narration)} ` : "";
      const links = txn.links.map((link) => `^${link}`).join(" ");
      const tags = txn.tags.map((tag) => `#${tag}`).join(" ");
      chunks.push(
        `${txn.date} ${txn.flag} ${payee}${narration}${links} ${tags}`.trimEnd()
      );
      for (const [key, value] of Object.entries(txn.metadata)) {
        chunks.push(`  ${key}: ${formatMetaValue(value)}`);
      }
      for (const posting of txn.postings) {
        const flag = posting.flag ? `${posting.flag} ` : "";
        const amount =
          posting.amount !== undefined && posting.currency
            ? ` ${formatAmount(posting.amount)} ${posting.currency}`
            : "";
        chunks.push(`  ${flag}${posting.account}${amount}`);
        for (const [key, value] of Object.entries(posting.metadata)) {
          chunks.push(`    ${key}: ${formatMetaValue(value)}`);
        }
      }
      chunks.push("");
    }
  }

  for (const close of document.closes) {
    chunks.push(`${close.date} close ${close.account}`);
  }

  if (document.epilogue.length > 0) {
    chunks.push("");
    chunks.push(...document.epilogue);
  }

  return `${chunks.join("\n").trimEnd()}\n`;
}

function formatMetaValue(value: MetaValue): string {
  if (typeof value === "string") return escapeQuoted(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function escapeQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatAmount(value: number): string {
  const fixed = value.toFixed(2);
  return value >= 0 ? fixed : fixed;
}

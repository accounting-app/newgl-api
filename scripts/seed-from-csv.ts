import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "../src/config";
import {
  accountPathFromName,
  qboCategoryFromCsvAccountType
} from "../src/infra/beancount/account-paths";
import { serializeBeancount, type BeancountDocument } from "../src/infra/beancount/parser";
import { createId } from "../src/shared/utils/id";

type CsvRow = {
  name: string;
  accountType: string;
  detailType: string;
};

function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const match = /^("(?:[^"]|"")*"|[^,]*),(.*),(.*)$/.exec(line);
    if (!match) {
      const parts = line.split(",");
      return {
        name: parts[0]?.trim() ?? "",
        accountType: parts[1]?.trim() ?? "",
        detailType: parts[2]?.trim() ?? ""
      };
    }
    const name = match[1].replace(/^"|"$/g, "").replace(/""/g, '"');
    return {
      name,
      accountType: match[2].trim(),
      detailType: match[3].trim()
    };
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const csvPath = resolve(process.cwd(), "../data_stucture/imported_chart_of_accounts.csv");
  const csv = await readFile(csvPath, "utf8");
  const rows = parseCsv(csv);
  const openDate = "2024-01-01";

  const document: BeancountDocument = {
    preamble: [
      ";; -*- mode: beancount; -*-",
      `option "title" "${config.company}"`,
      'option "operating_currency" "USD"',
      "",
      `${openDate} commodity USD`,
      '  name: "US Dollar"'
    ],
    opens: rows.map((row, index) => {
      const category = qboCategoryFromCsvAccountType(row.accountType);
      return {
        date: openDate,
        account: accountPathFromName(category, row.name),
        currencies: ["USD"],
        metadata: {
          id: createId(),
          name: row.name,
          "qbo-category": category,
          "qbo-subtype": row.detailType,
          "account-number": String(1000 + index * 10),
          status: "ACTIVE",
          "created-at": `${openDate}T00:00:00.000Z`
        }
      };
    }),
    closes: [],
    transactions: [],
    epilogue: []
  };

  const output = serializeBeancount(document);
  await mkdir(dirname(config.ledgerFile), { recursive: true });
  await writeFile(config.ledgerFile, output, "utf8");
  console.log(`Seeded ${rows.length} accounts into ${config.ledgerFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

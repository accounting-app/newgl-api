import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { LedgerRepository } from "@/application/contracts";
import type { LedgerStore } from "@/domain/models";
import { documentToStore, storeToDocument } from "@/infra/beancount/mapper";
import {
  parseBeancount,
  serializeBeancount,
  type BeancountDocument
} from "@/infra/beancount/parser";

class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.locked = true;
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

function defaultDocument(company: string): BeancountDocument {
  return {
    preamble: [
      ";; -*- mode: beancount; -*-",
      `option "title" "${company}"`,
      'option "operating_currency" "USD"',
      "",
      "2024-01-01 commodity USD",
      '  name: "US Dollar"'
    ],
    opens: [],
    closes: [],
    transactions: [],
    epilogue: []
  };
}

export class BeancountLedgerRepository implements LedgerRepository {
  private store: LedgerStore = {
    accounts: [],
    chartAccounts: [],
    transactions: [],
    ledgerPostings: [],
    registerEntries: []
  };

  private document: BeancountDocument = defaultDocument("Company");
  private readonly mutex = new AsyncMutex();

  constructor(
    private readonly ledgerFile: string,
    private readonly company: string
  ) {}

  async load(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const file = Bun.file(this.ledgerFile);
      if (!(await file.exists())) {
        await mkdir(dirname(this.ledgerFile), { recursive: true });
        this.document = defaultDocument(this.company);
        this.store = documentToStore(this.document);
        await this.persistLocked();
        return;
      }
      const source = await file.text();
      this.document = parseBeancount(source);
      this.store = documentToStore(this.document);
    } finally {
      release();
    }
  }

  getStore(): LedgerStore {
    return this.store;
  }

  async mutate<T>(fn: (store: LedgerStore) => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      const result = await fn(this.store);
      this.document = storeToDocument(this.store, this.document);
      await this.persistLocked();
      return result;
    } finally {
      release();
    }
  }

  private async persistLocked(): Promise<void> {
    const serialized = serializeBeancount(this.document);
    const tempFile = `${this.ledgerFile}.tmp`;
    await Bun.write(tempFile, serialized);
    await Bun.write(this.ledgerFile, serialized);
    try {
      await Bun.file(tempFile).writer().end();
    } catch {
      // temp cleanup best-effort
    }
  }
}

export function createLedgerRepository(ledgerFile: string, company: string): LedgerRepository {
  return new BeancountLedgerRepository(ledgerFile, company);
}

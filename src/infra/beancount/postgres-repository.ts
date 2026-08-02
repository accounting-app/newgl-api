import type { SQL } from "bun";

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

async function sha256(text: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Stores .bean content as rows in Postgres instead of on disk. Interface-compatible
 * with BeancountLedgerRepository (file-based) -- same load()/getStore()/mutate()
 * contract, so no service class needs to change.
 *
 * tenant_id is null until Phase 1 introduces the tenants table. This repository
 * still holds the parsed store in memory for the life of the process (same
 * single-instance-at-boot model as today) -- Phase 1's per-request container
 * design is a separate change, not bundled into this Phase 0 storage swap.
 */
export class PostgresLedgerRepository implements LedgerRepository {
  private store: LedgerStore = {
    accounts: [],
    chartAccounts: [],
    transactions: [],
    ledgerPostings: [],
    registerEntries: []
  };

  private document: BeancountDocument = defaultDocument("Company");
  private ledgerId: string | null = null;
  private version = 0;
  private readonly mutex = new AsyncMutex();

  constructor(
    private readonly sql: SQL,
    private readonly name: string,
    private readonly company: string,
    private readonly tenantId: string | null = null
  ) {}

  async load(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const rows = await this.sql`
        select id, content, version
        from ledgers
        where name = ${this.name}
          and tenant_id is not distinct from ${this.tenantId}
        limit 1
      `;

      if (rows.length === 0) {
        this.document = defaultDocument(this.company);
        this.store = documentToStore(this.document);
        await this.insertLocked("bootstrap");
        return;
      }

      const row = rows[0] as { id: string; content: string; version: number };
      this.ledgerId = row.id;
      this.version = row.version;
      this.document = parseBeancount(row.content);
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
      await this.updateLocked("app");
      return result;
    } finally {
      release();
    }
  }

  private async insertLocked(source: "bootstrap" | "app" | "upload"): Promise<void> {
    const content = serializeBeancount(this.document);
    const hash = await sha256(content);

    const rows = await this.sql`
      insert into ledgers (tenant_id, name, is_primary, content, content_hash, version)
      values (${this.tenantId}, ${this.name}, true, ${content}, ${hash}, 1)
      returning id
    `;
    this.ledgerId = (rows[0] as { id: string }).id;
    this.version = 1;

    await this.sql`
      insert into ledger_versions (ledger_id, version, content, content_hash, source)
      values (${this.ledgerId}, 1, ${content}, ${hash}, ${source})
    `;
  }

  private async updateLocked(source: "app" | "upload"): Promise<void> {
    if (!this.ledgerId) {
      throw new Error("PostgresLedgerRepository.mutate() called before load()");
    }

    const content = serializeBeancount(this.document);
    const hash = await sha256(content);
    const nextVersion = this.version + 1;

    await this.sql.begin(async (tx) => {
      // FOR UPDATE serializes concurrent writers across every process talking
      // to this row -- the in-process mutex above only protects this instance.
      await tx`select id from ledgers where id = ${this.ledgerId} for update`;

      await tx`
        update ledgers
        set content = ${content}, content_hash = ${hash}, version = ${nextVersion}, updated_at = now()
        where id = ${this.ledgerId}
      `;

      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source)
        values (${this.ledgerId}, ${nextVersion}, ${content}, ${hash}, ${source})
      `;
    });

    this.version = nextVersion;
  }
}

export function createPostgresLedgerRepository(
  sql: SQL,
  name: string,
  company: string,
  tenantId: string | null = null
): LedgerRepository {
  return new PostgresLedgerRepository(sql, name, company, tenantId);
}

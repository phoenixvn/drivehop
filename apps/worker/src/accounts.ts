// Accounts and OAuth state in the Durable Object's SQLite (the engine owns its own tables).
import type { Account, AccountStatus, ProviderId } from '@multicloud/shared';

/** Append-only migrations of the Worker's own tables. Never edit one that has shipped. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     email TEXT NOT NULL,
     display_name TEXT NOT NULL,
     avatar_url TEXT,
     status TEXT NOT NULL DEFAULT 'connected',
     refresh_token_enc BLOB,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (provider, email)
   );
   CREATE TABLE oauth_states (
     state TEXT PRIMARY KEY,
     binding_hash TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
];

export function migrateWorkerTables(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS worker_schema_version (version INTEGER NOT NULL)');
    const row = sql.exec<{ version: number | null }>('SELECT MAX(version) AS version FROM worker_schema_version').toArray()[0];
    const current = row?.version ?? 0;
    for (let index = current; index < MIGRATIONS.length; index++) {
      const statement = MIGRATIONS[index];
      if (statement === undefined) continue;
      sql.exec(statement);
      sql.exec('INSERT INTO worker_schema_version (version) VALUES (?)', index + 1);
    }
  });
}

interface AccountRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
}

const PUBLIC_COLUMNS = 'id, provider, email, display_name, avatar_url, status';

function toAccount(row: AccountRow): Account {
  const account: Account = {
    id: row.id,
    provider: row.provider as ProviderId,
    email: row.email,
    displayName: row.display_name,
    status: row.status === 'connected' ? 'connected' : 'needs_reconnect',
  };
  if (row.avatar_url !== null) account.avatarUrl = row.avatar_url;
  return account;
}

function toBytes(value: SqlStorageValue | undefined): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export interface UpsertAccountInput {
  provider: ProviderId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  /** Encrypted refresh token, or null to keep what is stored. */
  refreshTokenEnc: Uint8Array | null;
}

/** Same behaviour as apps/server/src/db/accounts.ts; `Account` objects never carry token data. */
export class AccountsRepo {
  private readonly storage: DurableObjectStorage;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(storage: DurableObjectStorage, now: () => number = Date.now, newId: () => string = () => crypto.randomUUID()) {
    this.storage = storage;
    this.now = now;
    this.newId = newId;
  }

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  list(): Account[] {
    return this.sql
      .exec<AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts ORDER BY created_at, email`)
      .toArray()
      .map(toAccount);
  }

  get(id: string): Account | undefined {
    const row = this.sql.exec<AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE id = ?`, id).toArray()[0];
    return row === undefined ? undefined : toAccount(row);
  }

  exists(id: string): boolean {
    return this.get(id) !== undefined;
  }

  findByEmail(provider: ProviderId, email: string): Account | undefined {
    const row = this.sql
      .exec<AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE provider = ? AND email = ?`, provider, email.trim().toLowerCase())
      .toArray()[0];
    return row === undefined ? undefined : toAccount(row);
  }

  getRefreshTokenEnc(id: string): Uint8Array | null {
    const row = this.sql.exec('SELECT refresh_token_enc FROM accounts WHERE id = ?', id).toArray()[0];
    return toBytes(row?.refresh_token_enc);
  }

  setRefreshTokenEnc(id: string, blob: Uint8Array): void {
    this.sql.exec('UPDATE accounts SET refresh_token_enc = ?, updated_at = ? WHERE id = ?', blob, this.iso(), id);
  }

  setStatus(id: string, status: AccountStatus): void {
    this.sql.exec('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?', status, this.iso(), id);
  }

  delete(id: string): boolean {
    const exists = this.exists(id);
    this.sql.exec('DELETE FROM accounts WHERE id = ?', id);
    return exists;
  }

  upsert(input: UpsertAccountInput): Account {
    return this.storage.transactionSync(() => {
      const email = input.email.trim().toLowerCase();
      const timestamp = this.iso();
      const existing = this.findByEmail(input.provider, email);
      let id: string;
      if (existing === undefined) {
        id = this.newId();
        this.sql.exec(
          `INSERT INTO accounts (id, provider, email, display_name, avatar_url, status, refresh_token_enc, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.provider,
          email,
          input.displayName,
          input.avatarUrl ?? null,
          input.refreshTokenEnc === null ? 'needs_reconnect' : 'connected',
          input.refreshTokenEnc,
          timestamp,
          timestamp,
        );
      } else {
        id = existing.id;
        if (input.refreshTokenEnc === null) {
          this.sql.exec(
            'UPDATE accounts SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?',
            input.displayName,
            input.avatarUrl ?? null,
            timestamp,
            id,
          );
        } else {
          this.sql.exec(
            `UPDATE accounts SET display_name = ?, avatar_url = ?, refresh_token_enc = ?, status = 'connected', updated_at = ?
              WHERE id = ?`,
            input.displayName,
            input.avatarUrl ?? null,
            input.refreshTokenEnc,
            timestamp,
            id,
          );
        }
      }
      const account = this.get(id);
      if (account === undefined) throw new Error('account row disappeared during upsert');
      return account;
    });
  }
}

/** OAuth CSRF state, 10 minutes, single use, bound to a cookie value (stored only as SHA-256). */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares two equal-length hex digests without an early exit. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class OAuthStateStore {
  private readonly storage: DurableObjectStorage;
  private readonly now: () => number;

  constructor(storage: DurableObjectStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  /** Creates a state and the cookie value bound to it. */
  async issue(): Promise<{ state: string; binding: string }> {
    const state = randomToken();
    const binding = randomToken();
    const hash = await sha256Hex(binding);
    const now = this.now();
    this.storage.sql.exec('DELETE FROM oauth_states WHERE expires_at <= ?', now);
    this.storage.sql.exec(
      'INSERT INTO oauth_states (state, binding_hash, expires_at) VALUES (?, ?, ?)',
      state,
      hash,
      now + OAUTH_STATE_TTL_MS,
    );
    return { state, binding };
  }

  /**
   * Consumes the state (it is deleted on the first lookup, whatever the outcome, so it can never be
   * used twice) and returns true only when it existed, was unexpired and `binding` matches.
   */
  async consume(state: string | undefined, binding: string | undefined): Promise<boolean> {
    if (state === undefined || state === '' || state.length > 256) return false;
    const row = this.storage.sql
      .exec<{ binding_hash: string; expires_at: number }>('SELECT binding_hash, expires_at FROM oauth_states WHERE state = ?', state)
      .toArray()[0];
    this.storage.sql.exec('DELETE FROM oauth_states WHERE state = ?', state);
    if (row === undefined) return false;
    if (row.expires_at <= this.now()) return false;
    if (binding === undefined || binding === '' || binding.length > 256) return false;
    return sameDigest(await sha256Hex(binding), row.binding_hash);
  }
}

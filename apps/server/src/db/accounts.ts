import { randomUUID } from 'node:crypto';
import type { Account, AccountStatus, ProviderId } from '@multicloud/shared';
import type { Db } from './index.ts';

interface AccountRow {
  id: string;
  provider: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
}

export interface UpsertAccountInput {
  provider: ProviderId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  /** Encrypted refresh token, or `null` to keep whatever is already stored. */
  refreshTokenEnc: Buffer | null;
}

export interface UpsertAccountResult {
  account: Account;
  /** True when the row holds an encrypted refresh token after the upsert. */
  hasRefreshToken: boolean;
}

/** Data access for the `accounts` table. Public `Account` objects never contain token data. */
export interface AccountsRepo {
  list(): Account[];
  get(id: string): Account | undefined;
  exists(id: string): boolean;
  findByEmail(provider: ProviderId, email: string): Account | undefined;
  /**
   * Inserts or updates the account keyed by provider + email (email is lower-cased). The id of an
   * existing account is kept. The status becomes 'connected' only when a new token is supplied.
   */
  upsert(input: UpsertAccountInput): UpsertAccountResult;
  getRefreshTokenEnc(id: string): Buffer | null;
  setRefreshTokenEnc(id: string, refreshTokenEnc: Buffer): void;
  setStatus(id: string, status: AccountStatus): void;
  /** Deletes only the local row. Returns false when the id is unknown. */
  delete(id: string): boolean;
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

export function createAccountsRepo(db: Db, now: () => Date = () => new Date()): AccountsRepo {
  const selectAll = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM accounts ORDER BY created_at, email`);
  const selectById = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE id = ?`);
  const selectByEmail = db.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE provider = ? AND email = ?`,
  );
  const selectToken = db.prepare('SELECT refresh_token_enc FROM accounts WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO accounts (id, provider, email, display_name, avatar_url, status, refresh_token_enc, created_at, updated_at)
     VALUES (@id, @provider, @email, @displayName, @avatarUrl, @status, @refreshTokenEnc, @now, @now)`,
  );
  const update = db.prepare(
    `UPDATE accounts
        SET display_name = @displayName,
            avatar_url = @avatarUrl,
            refresh_token_enc = COALESCE(@refreshTokenEnc, refresh_token_enc),
            status = CASE WHEN @refreshTokenEnc IS NULL THEN status ELSE 'connected' END,
            updated_at = @now
      WHERE id = @id`,
  );
  const updateToken = db.prepare(
    'UPDATE accounts SET refresh_token_enc = ?, updated_at = ? WHERE id = ?',
  );
  const updateStatus = db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM accounts WHERE id = ?');

  const get = (id: string): Account | undefined => {
    const row = selectById.get(id) as AccountRow | undefined;
    return row === undefined ? undefined : toAccount(row);
  };

  const getRefreshTokenEnc = (id: string): Buffer | null => {
    const row = selectToken.get(id) as { refresh_token_enc: Buffer | null } | undefined;
    return row?.refresh_token_enc ?? null;
  };

  const upsert = db.transaction((input: UpsertAccountInput): UpsertAccountResult => {
    const email = input.email.trim().toLowerCase();
    const timestamp = now().toISOString();
    const existing = selectByEmail.get(input.provider, email) as AccountRow | undefined;
    const params = {
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      refreshTokenEnc: input.refreshTokenEnc,
      now: timestamp,
    };
    let id: string;
    if (existing === undefined) {
      id = randomUUID();
      insert.run({
        ...params,
        id,
        provider: input.provider,
        email,
        status: input.refreshTokenEnc === null ? 'needs_reconnect' : 'connected',
      });
    } else {
      id = existing.id;
      update.run({ ...params, id });
    }
    const account = get(id);
    if (account === undefined) throw new Error('account row disappeared during upsert');
    return { account, hasRefreshToken: getRefreshTokenEnc(id) !== null };
  });

  return {
    list: () => (selectAll.all() as AccountRow[]).map(toAccount),
    get,
    exists: (id) => selectById.get(id) !== undefined,
    findByEmail: (provider, email) => {
      const row = selectByEmail.get(provider, email.trim().toLowerCase()) as AccountRow | undefined;
      return row === undefined ? undefined : toAccount(row);
    },
    upsert: (input) => upsert(input),
    getRefreshTokenEnc,
    setRefreshTokenEnc: (id, refreshTokenEnc) => {
      updateToken.run(refreshTokenEnc, now().toISOString(), id);
    },
    setStatus: (id, status) => {
      updateStatus.run(status, now().toISOString(), id);
    },
    delete: (id) => remove.run(id).changes > 0,
  };
}

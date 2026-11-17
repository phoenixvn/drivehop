import { API_PATHS, ROOT_FOLDER_ID, isProviderError } from '@multicloud/shared';
import type {
  Breadcrumb,
  CloudProvider,
  DeleteAccountResponse,
  FileEntry,
  FolderPathResponse,
  ListAccountsResponse,
  ListFilesResponse,
  QuotaResponse,
} from '@multicloud/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  accountParamsSchema as accountParams,
  folderPathParamsSchema as folderPathParams,
  listFilesQuerySchema as listFilesQuery,
} from '@multicloud/core';
import { parseOrBadRequest, requireAccount } from './deps.ts';
import type { RouteDeps } from './deps.ts';

/** Maximum number of folders walked upwards when building breadcrumbs. */
export const MAX_BREADCRUMB_DEPTH = 50;

/**
 * Path from the account root down to `folderId` (root first, requested folder last).
 * The root crumb always carries the id 'root'. For folders outside "My Drive" (shared with the
 * account) the path starts at the topmost folder the account can see.
 */
export async function buildBreadcrumbs(provider: CloudProvider, folderId: string): Promise<Breadcrumb[]> {
  const root = await provider.getFile(ROOT_FOLDER_ID);
  const rootCrumb: Breadcrumb = { id: ROOT_FOLDER_ID, name: root.name };
  if (folderId === ROOT_FOLDER_ID || folderId === root.id) return [rootCrumb];

  const chain: Breadcrumb[] = [];
  const seen = new Set<string>();
  let current: FileEntry | undefined = await provider.getFile(folderId);
  while (current !== undefined && chain.length < MAX_BREADCRUMB_DEPTH) {
    if (current.id === root.id) {
      chain.push(rootCrumb);
      break;
    }
    chain.push({ id: current.id, name: current.name });
    seen.add(current.id);
    const parentId: string | undefined = current.parents[0];
    if (parentId === undefined || seen.has(parentId)) break;
    if (parentId === root.id) {
      chain.push(rootCrumb);
      break;
    }
    try {
      current = await provider.getFile(parentId);
    } catch (err) {
      // A parent the account cannot see ends the visible path.
      if (isProviderError(err) && (err.kind === 'not_found' || err.kind === 'forbidden')) break;
      throw err;
    }
  }
  return chain.reverse();
}

/** Account list / removal and the read-only browsing routes. */
export const accountRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  const { accounts, cipher, oauth } = deps;

  app.get(API_PATHS.accounts, async (): Promise<ListAccountsResponse> => {
    // `Account` objects are built from an explicit column list and never contain token data.
    return { accounts: accounts.list() };
  });

  app.delete(API_PATHS.account, async (request): Promise<DeleteAccountResponse> => {
    const { id } = parseOrBadRequest(accountParams, request.params);
    requireAccount(accounts, id);

    let refreshToken: string | null = null;
    const encrypted = accounts.getRefreshTokenEnc(id);
    if (encrypted !== null) {
      try {
        refreshToken = await cipher.decryptToken(encrypted);
      } catch {
        refreshToken = null;
      }
    }

    // Local disconnect only: the row is removed, nothing in Google Drive is deleted or trashed.
    accounts.delete(id);
    deps.invalidateProvider(id);

    if (refreshToken !== null && oauth !== null) {
      // Best effort and not awaited: a failed revocation must not block the disconnect.
      const log = request.log;
      void oauth.revokeToken(refreshToken).then(
        () => log.info({ accountId: id }, 'revoked the Google token of a removed account'),
        () => log.warn({ accountId: id }, 'could not revoke the Google token of a removed account'),
      );
    }
    return { ok: true };
  });

  app.get(API_PATHS.accountQuota, async (request): Promise<QuotaResponse> => {
    const { id } = parseOrBadRequest(accountParams, request.params);
    requireAccount(accounts, id);
    const provider = await deps.resolveProvider(id);
    return { quota: await provider.getQuota() };
  });

  app.get(API_PATHS.accountFiles, async (request): Promise<ListFilesResponse> => {
    const { id } = parseOrBadRequest(accountParams, request.params);
    requireAccount(accounts, id);
    const query = parseOrBadRequest(listFilesQuery, request.query);
    const provider = await deps.resolveProvider(id);
    return provider.listFolder(query.folderId ?? ROOT_FOLDER_ID, query.pageToken);
  });

  app.get(API_PATHS.accountFolderPath, async (request): Promise<FolderPathResponse> => {
    const { id, folderId } = parseOrBadRequest(folderPathParams, request.params);
    requireAccount(accounts, id);
    const provider = await deps.resolveProvider(id);
    return { breadcrumbs: await buildBreadcrumbs(provider, folderId) };
  });
};

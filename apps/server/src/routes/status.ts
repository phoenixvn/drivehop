import { API_PATHS } from '@multicloud/shared';
import type { StatusResponse } from '@multicloud/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteDeps } from './deps.ts';

/** GET /api/status */
export const statusRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  app.get(API_PATHS.status, async (): Promise<StatusResponse> => deps.getStatus());
};

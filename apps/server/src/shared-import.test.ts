import { describe, expect, it } from 'vitest';
import { API_PATHS, ProviderError } from '@multicloud/shared';

describe('@multicloud/shared runtime import', () => {
  it('exposes ProviderError as a real class', () => {
    const err = new ProviderError('rate limited', {
      kind: 'rate_limit',
      retryable: true,
      status: 429,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe('ProviderError');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it('exposes API path constants', () => {
    expect(API_PATHS.status).toBe('/api/status');
  });
});

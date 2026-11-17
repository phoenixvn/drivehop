import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiContext } from './api/ApiContext.ts';
import type { ApiContextValue } from './api/ApiContext.ts';
import { createHttpApiClient } from './api/client.ts';
import { withApiSignals } from './api/signals.ts';
import { App } from './App.tsx';
import './styles.css';

async function createApi(): Promise<ApiContextValue> {
  // Mock mode exists only in development: `import.meta.env.DEV` is a compile-time constant, so
  // this branch (and the whole src/mock chunk) is removed from production builds.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1') {
    const { createMockApi } = await import('./mock/mockApi.ts');
    return { ...withApiSignals(createMockApi(window.location.search)), isMock: true };
  }
  return { ...withApiSignals(createHttpApiClient()), isMock: false };
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const root = createRoot(container);

createApi().then(
  (value) => {
    root.render(
      <StrictMode>
        <ApiContext value={value}>
          <App />
        </ApiContext>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    console.error(error);
    container.textContent = 'Không khởi động được DriveHop. Hãy tải lại trang.';
  },
);

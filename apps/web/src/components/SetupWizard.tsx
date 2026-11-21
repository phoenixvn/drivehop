import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SetupInfo } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import { apiErrorText } from '../lib/format.ts';

interface SetupWizardProps {
  setup: SetupInfo;
  /** Called once the server is back with the new configuration. */
  onDone: () => void;
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 20_000;

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="setup__copy">
      <code>{value}</code>
      <button
        type="button"
        className="button button--small"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? 'Đã chép' : 'Chép'}
      </button>
    </span>
  );
}

/**
 * First-run screen of the local app: explains how to create a Google OAuth client (each user
 * brings their own, so nothing needs Google's verification) and saves it on the server.
 */
export function SetupWizard({ setup, onDone }: SetupWizardProps) {
  const api = useApi();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'restarting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const waitForServer = async (): Promise<void> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const status = await api.getStatus();
        if (status.configured) return;
      } catch {
        // The server is restarting: keep polling.
      }
    }
    throw new Error('DriveHop chưa khởi động lại kịp. Hãy tải lại trang.');
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setPhase('saving');
    try {
      await api.saveSetup({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      setClientSecret('');
      setPhase('restarting');
      await waitForServer();
      onDone();
    } catch (err) {
      setError(err instanceof Error && !('code' in err) ? err.message : apiErrorText(err));
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';

  return (
    <section className="setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Thiết lập lần đầu: kết nối DriveHop với Google</h2>
      <p className="setup__lead">
        DriveHop chạy hoàn toàn trên máy bạn. Để đọc Google Drive, bạn tạo một <strong>OAuth client của
        riêng bạn</strong> trên Google Cloud (miễn phí, khoảng 10 phút, chỉ làm một lần). Không ai khác
        giữ quyền truy cập Drive của bạn.
      </p>

      <ol className="setup__steps">
        <li>
          Mở{' '}
          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </a>{' '}
          và tạo một project (tên tùy ý, ví dụ <em>DriveHop</em>).
        </li>
        <li>
          Bật{' '}
          <a
            href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
            target="_blank"
            rel="noreferrer"
          >
            Google Drive API
          </a>{' '}
          cho project đó.
        </li>
        <li>
          Vào{' '}
          <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">
            Google Auth Platform
          </a>
          , bấm <em>Get started</em>, chọn <em>External</em>. Ở mục <em>Audience</em>, bấm{' '}
          <strong>Publish app</strong> (không cần gửi xác minh) để không phải đăng nhập lại mỗi 7 ngày.
        </li>
        <li>
          Ở mục <em>Data access</em>, thêm scope <code>https://www.googleapis.com/auth/drive</code>.
        </li>
        <li>
          Ở mục <em>Clients</em>, tạo client loại <strong>Web application</strong>. Trong{' '}
          <em>Authorized redirect URIs</em>, thêm đúng địa chỉ này:
          <CopyValue value={setup.redirectUri} />
        </li>
        <li>Chép Client ID và Client secret vừa tạo vào ô bên dưới.</li>
      </ol>

      <form className="setup__form" onSubmit={(event) => void submit(event)}>
        <label className="setup__field">
          <span>Client ID</span>
          <input
            type="text"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="1234567890-abc….apps.googleusercontent.com"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
        </label>
        <label className="setup__field">
          <span>Client secret</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder="GOCSPX-…"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
        </label>
        {error !== null && (
          <p className="setup__error" role="alert">
            {error}
          </p>
        )}
        <div className="setup__actions">
          <button type="submit" className="button button--primary" disabled={busy}>
            {phase === 'saving' ? 'Đang lưu…' : phase === 'restarting' ? 'Đang khởi động lại…' : 'Lưu và tiếp tục'}
          </button>
        </div>
        <p className="setup__note">
          Khi đăng nhập Google, bạn sẽ thấy cảnh báo “Google chưa xác minh ứng dụng này”. Đó là app của
          chính bạn: bấm <em>Advanced</em> → <em>Go to … (unsafe)</em> để tiếp tục.
        </p>
      </form>
    </section>
  );
}

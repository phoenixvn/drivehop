import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SetupInfo } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import { apiErrorText } from '../lib/format.ts';
import { strings } from '../lib/i18n.ts';

// Google Cloud console labels (Get started, External, Audience, ...) stay in English in both
// languages: that is how the console shows them.
const S = strings({
  en: {
    copied: 'Copied',
    copy: 'Copy',
    restartTimeout: "DriveHop didn't restart in time. Reload the page.",
    title: 'First-time setup: connect DriveHop to Google',
    leadBefore: 'DriveHop runs entirely on your computer. To read Google Drive, you create',
    leadStrong: 'your own OAuth client',
    leadAfter:
      'on Google Cloud (free, about 10 minutes, one time only). Nobody else holds access to your Drive.',
    step1Before: 'Open',
    step1After: 'and create a project (any name, for example',
    step1End: ').',
    step2Before: 'Enable',
    step2After: 'for that project.',
    step3Before: 'Go to',
    step3Click: ', click',
    step3Choose: ', choose',
    step3Under: '. Under',
    step3Click2: ', click',
    step3After: "(no verification needed) so you don't have to sign in again every 7 days.",
    step4Before: 'Under',
    step4After: ', add the scope',
    step5Before: 'Under',
    step5Create: ', create a client of type',
    step5In: '. In',
    step5After: ', add exactly this address:',
    step6: 'Copy the new Client ID and Client secret into the fields below.',
    saving: 'Saving…',
    restarting: 'Restarting…',
    save: 'Save and continue',
    noteBefore:
      'When you sign in to Google, you will see the warning “Google hasn’t verified this app”. It’s your own app: click',
    noteAfter: 'to continue.',
  },
  vi: {
    copied: 'Đã chép',
    copy: 'Chép',
    restartTimeout: 'DriveHop chưa khởi động lại kịp. Hãy tải lại trang.',
    title: 'Thiết lập lần đầu: kết nối DriveHop với Google',
    leadBefore: 'DriveHop chạy hoàn toàn trên máy bạn. Để đọc Google Drive, bạn tạo một',
    leadStrong: 'OAuth client của riêng bạn',
    leadAfter:
      'trên Google Cloud (miễn phí, khoảng 10 phút, chỉ làm một lần). Không ai khác giữ quyền truy cập Drive của bạn.',
    step1Before: 'Mở',
    step1After: 'và tạo một project (tên tùy ý, ví dụ',
    step1End: ').',
    step2Before: 'Bật',
    step2After: 'cho project đó.',
    step3Before: 'Vào',
    step3Click: ', bấm',
    step3Choose: ', chọn',
    step3Under: '. Ở mục',
    step3Click2: ', bấm',
    step3After: '(không cần gửi xác minh) để không phải đăng nhập lại mỗi 7 ngày.',
    step4Before: 'Ở mục',
    step4After: ', thêm scope',
    step5Before: 'Ở mục',
    step5Create: ', tạo client loại',
    step5In: '. Trong',
    step5After: ', thêm đúng địa chỉ này:',
    step6: 'Chép Client ID và Client secret vừa tạo vào ô bên dưới.',
    saving: 'Đang lưu…',
    restarting: 'Đang khởi động lại…',
    save: 'Lưu và tiếp tục',
    noteBefore:
      'Khi đăng nhập Google, bạn sẽ thấy cảnh báo “Google chưa xác minh ứng dụng này”. Đó là app của chính bạn: bấm',
    noteAfter: 'để tiếp tục.',
  },
});

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
        {copied ? S.copied : S.copy}
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
    throw new Error(S.restartTimeout);
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
      <h2 id="setup-title">{S.title}</h2>
      <p className="setup__lead">
        {S.leadBefore} <strong>{S.leadStrong}</strong> {S.leadAfter}
      </p>

      <ol className="setup__steps">
        <li>
          {S.step1Before}{' '}
          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </a>{' '}
          {S.step1After} <em>DriveHop</em>
          {S.step1End}
        </li>
        <li>
          {S.step2Before}{' '}
          <a
            href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
            target="_blank"
            rel="noreferrer"
          >
            Google Drive API
          </a>{' '}
          {S.step2After}
        </li>
        <li>
          {S.step3Before}{' '}
          <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">
            Google Auth Platform
          </a>
          {S.step3Click} <em>Get started</em>
          {S.step3Choose} <em>External</em>
          {S.step3Under} <em>Audience</em>
          {S.step3Click2} <strong>Publish app</strong> {S.step3After}
        </li>
        <li>
          {S.step4Before} <em>Data access</em>
          {S.step4After} <code>https://www.googleapis.com/auth/drive</code>.
        </li>
        <li>
          {S.step5Before} <em>Clients</em>
          {S.step5Create} <strong>Web application</strong>
          {S.step5In} <em>Authorized redirect URIs</em>
          {S.step5After}
          <CopyValue value={setup.redirectUri} />
        </li>
        <li>{S.step6}</li>
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
            {phase === 'saving' ? S.saving : phase === 'restarting' ? S.restarting : S.save}
          </button>
        </div>
        <p className="setup__note">
          {S.noteBefore} <em>Advanced</em> → <em>Go to … (unsafe)</em> {S.noteAfter}
        </p>
      </form>
    </section>
  );
}

import { SetupWizard } from './SetupWizard.tsx';
import type { ServerState } from '../hooks/useServer.ts';
import { strings } from '../lib/i18n.ts';

const S = strings({
  en: {
    sessionExpiredTitle: 'Your session expired.',
    sessionExpiredBody:
      "The DriveHop server rejected the request because your session expired or you don't have access. Reload the page to sign in again.",
    reload: 'Reload page',
    unreachableTitle: "Can't reach the DriveHop server.",
    unreachableBefore:
      'The page got no response from the DriveHop server at this address. Check your network connection and make sure the server is running (see',
    unreachableAfter: ') then try again. If your session may have expired, reload the page.',
    retry: 'Retry',
    errorTitle: 'The DriveHop server reported an error.',
    notSetUpTitle: "DriveHop isn't fully set up yet.",
    notSetUpBody: "The server has no Google OAuth credentials yet, so accounts can't be added.",
    missingVars: ' Missing environment variables:',
    followBefore: 'Follow the setup steps in',
    followMiddle: '(create an OAuth client in Google Cloud, put the variables in the',
    followAfter: ' file), restart the server, then click “Check again”.',
    checkAgain: 'Check again',
    keyringTitle: "The operating system's keyring isn't available.",
    keyringBefore: 'The server is encrypting sign-in data with the fallback key',
    keyringMiddle: '. See',
    keyringAfter: 'for details.',
  },
  vi: {
    sessionExpiredTitle: 'Phiên đăng nhập đã hết hạn.',
    sessionExpiredBody:
      'Máy chủ DriveHop từ chối yêu cầu vì phiên đăng nhập đã hết hạn hoặc bạn không có quyền truy cập. Hãy tải lại trang để đăng nhập lại.',
    reload: 'Tải lại trang',
    unreachableTitle: 'Không kết nối được máy chủ DriveHop.',
    unreachableBefore:
      'Giao diện không nhận được phản hồi từ máy chủ DriveHop tại địa chỉ đang mở trang này. Hãy kiểm tra kết nối mạng và rằng máy chủ đang chạy (xem',
    unreachableAfter: ') rồi thử lại. Nếu phiên đăng nhập có thể đã hết hạn, hãy tải lại trang.',
    retry: 'Thử lại',
    errorTitle: 'Máy chủ DriveHop báo lỗi.',
    notSetUpTitle: 'DriveHop chưa được thiết lập xong.',
    notSetUpBody: 'Máy chủ chưa có thông tin Google OAuth nên chưa thể thêm tài khoản.',
    missingVars: ' Các biến môi trường còn thiếu:',
    followBefore: 'Làm theo phần thiết lập trong',
    followMiddle: '(tạo OAuth client trên Google Cloud, điền các biến vào tệp',
    followAfter: '), khởi động lại máy chủ rồi bấm “Kiểm tra lại”.',
    checkAgain: 'Kiểm tra lại',
    keyringTitle: 'Không dùng được kho khóa của hệ điều hành.',
    keyringBefore: 'Máy chủ đang mã hóa thông tin đăng nhập bằng khóa dự phòng',
    keyringMiddle: '. Xem',
    keyringAfter: 'để biết chi tiết.',
  },
});

interface SetupBannerProps {
  server: ServerState;
  onRetry: () => void;
}

/** Top-of-page notices about the backend: unreachable, misconfigured, or keyring fallback. */
export function SetupBanner({ server, onRetry }: SetupBannerProps) {
  if (server.kind === 'loading') return null;

  if (server.kind === 'session_expired') {
    return (
      <div className="banner banner--error" role="alert">
        <div>
          <strong>{S.sessionExpiredTitle}</strong>
          <p>{S.sessionExpiredBody}</p>
        </div>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          {S.reload}
        </button>
      </div>
    );
  }

  if (server.kind === 'unreachable') {
    return (
      <div className="banner banner--error" role="alert">
        <div>
          <strong>{S.unreachableTitle}</strong>
          <p>
            {S.unreachableBefore} <code>README.md</code>
            {S.unreachableAfter}
          </p>
        </div>
        <div className="banner__actions">
          <button type="button" className="button" onClick={onRetry}>
            {S.retry}
          </button>
          <button type="button" className="button" onClick={() => window.location.reload()}>
            {S.reload}
          </button>
        </div>
      </div>
    );
  }

  if (server.kind === 'error') {
    return (
      <div className="banner banner--error" role="alert">
        <div>
          <strong>{S.errorTitle}</strong>
          <p>{server.message}</p>
        </div>
        <button type="button" className="button" onClick={onRetry}>
          {S.retry}
        </button>
      </div>
    );
  }

  const { configured, missing, keyringAvailable, setup } = server.status;
  if (configured && keyringAvailable) return null;

  if (!configured && setup?.allowed) {
    return (
      <>
        <SetupWizard setup={setup} onDone={onRetry} />
        {!keyringAvailable && <KeyringNotice />}
      </>
    );
  }

  return (
    <>
      {!configured && (
        <div className="banner banner--warning" role="status">
          <div>
            <strong>{S.notSetUpTitle}</strong>
            <p>
              {S.notSetUpBody}
              {missing.length > 0 ? S.missingVars : ''}
            </p>
            {missing.length > 0 && (
              <ul className="banner__list">
                {missing.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            )}
            <p>
              {S.followBefore} <code>README.md</code> {S.followMiddle} <code>.env</code>
              {S.followAfter}
            </p>
          </div>
          <button type="button" className="button" onClick={onRetry}>
            {S.checkAgain}
          </button>
        </div>
      )}
      {!keyringAvailable && <KeyringNotice />}
    </>
  );
}

function KeyringNotice() {
  return (
    <div className="banner banner--info" role="status">
      <div>
        <strong>{S.keyringTitle}</strong>
        <p>
          {S.keyringBefore} <code>MULTICLOUD_MASTER_KEY</code>
          {S.keyringMiddle} <code>README.md</code> {S.keyringAfter}
        </p>
      </div>
    </div>
  );
}

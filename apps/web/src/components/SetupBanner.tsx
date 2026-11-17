import type { ServerState } from '../hooks/useServer.ts';

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
          <strong>Phiên đăng nhập đã hết hạn.</strong>
          <p>
            Máy chủ DriveHop từ chối yêu cầu vì phiên đăng nhập đã hết hạn hoặc bạn không có quyền
            truy cập. Hãy tải lại trang để đăng nhập lại.
          </p>
        </div>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Tải lại trang
        </button>
      </div>
    );
  }

  if (server.kind === 'unreachable') {
    return (
      <div className="banner banner--error" role="alert">
        <div>
          <strong>Không kết nối được máy chủ DriveHop.</strong>
          <p>
            Giao diện không nhận được phản hồi từ máy chủ DriveHop tại địa chỉ đang mở trang này.
            Hãy kiểm tra kết nối mạng và rằng máy chủ đang chạy (xem <code>README.md</code>) rồi thử
            lại. Nếu phiên đăng nhập có thể đã hết hạn, hãy tải lại trang.
          </p>
        </div>
        <div className="banner__actions">
          <button type="button" className="button" onClick={onRetry}>
            Thử lại
          </button>
          <button type="button" className="button" onClick={() => window.location.reload()}>
            Tải lại trang
          </button>
        </div>
      </div>
    );
  }

  if (server.kind === 'error') {
    return (
      <div className="banner banner--error" role="alert">
        <div>
          <strong>Máy chủ DriveHop báo lỗi.</strong>
          <p>{server.message}</p>
        </div>
        <button type="button" className="button" onClick={onRetry}>
          Thử lại
        </button>
      </div>
    );
  }

  const { configured, missing, keyringAvailable } = server.status;
  if (configured && keyringAvailable) return null;

  return (
    <>
      {!configured && (
        <div className="banner banner--warning" role="status">
          <div>
            <strong>DriveHop chưa được thiết lập xong.</strong>
            <p>
              Máy chủ chưa có thông tin Google OAuth nên chưa thể thêm tài khoản.
              {missing.length > 0 ? ' Các biến môi trường còn thiếu:' : ''}
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
              Làm theo phần thiết lập trong <code>README.md</code> (tạo OAuth client trên Google
              Cloud, điền các biến vào tệp <code>.env</code>), khởi động lại máy chủ rồi bấm “Kiểm
              tra lại”.
            </p>
          </div>
          <button type="button" className="button" onClick={onRetry}>
            Kiểm tra lại
          </button>
        </div>
      )}
      {!keyringAvailable && (
        <div className="banner banner--info" role="status">
          <div>
            <strong>Không dùng được kho khóa của hệ điều hành.</strong>
            <p>
              Máy chủ đang mã hóa thông tin đăng nhập bằng khóa dự phòng{' '}
              <code>MULTICLOUD_MASTER_KEY</code>. Xem <code>README.md</code> để biết chi tiết.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

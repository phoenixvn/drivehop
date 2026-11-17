import { useEffect, useId, useRef } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons row. Put `data-autofocus` on the button that gets the initial focus. */
  actions: ReactNode;
  /** When true, Esc and the backdrop do not close the dialog (e.g. while submitting). */
  busy?: boolean;
}

/** Modal built on the native <dialog>: focus trapping and Esc handling come from the browser. */
export function Dialog({ title, onClose, children, actions, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Guarded: showModal() throws when the dialog is already open (StrictMode runs this twice).
    if (!dialog.open) dialog.showModal();
    // React's `autoFocus` runs before the dialog is open (when nothing inside is focusable), so
    // the initial focus is requested with a data attribute instead.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    // Keep React in charge of unmounting; never let the browser close it behind our back.
    event.preventDefault();
    if (!busy) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClick={(event) => {
        if (event.target === ref.current && !busy) onClose();
      }}
    >
      <div className="dialog__body">
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__content">{children}</div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </dialog>
  );
}

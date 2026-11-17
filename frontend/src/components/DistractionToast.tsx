import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { DistractionAlertPayload } from '../types';

interface DistractionToastProps {
  alert: DistractionAlertPayload;
  onSnooze: (minutes: number) => void;
  onDismiss: () => void;
}

export function DistractionToast({ alert, onSnooze, onDismiss }: DistractionToastProps) {
  const dwellMins = Math.max(1, Math.round(alert.dwell_seconds / 60));
  const resumeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the primary action button on appear for fast keyboard response
    resumeBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  return (
    <aside
      role="alert"
      aria-live="polite"
      className="distraction-toast-card"
    >
      <div className="distraction-toast-body" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div className="distraction-toast-icon" aria-hidden="true">
          <Icon name="bell" size={18} />
        </div>

        <div className="distraction-toast-content" style={{ flex: 1, minWidth: 0 }}>
          <div
            className="distraction-toast-title"
            style={{
              fontWeight: 700,
              fontSize: 13.5,
              color: 'var(--text-primary)',
              lineHeight: 1.3,
              marginBottom: 4,
              letterSpacing: '-0.01em',
              overflowWrap: 'anywhere',
            }}
          >
            Time Check: <span style={{ color: 'var(--accent-amber)', fontWeight: 700 }}>{dwellMins}m</span> on{' '}
            <span style={{ color: 'var(--text-primary)' }}>{alert.app_name}</span>
          </div>
          <div
            className="distraction-toast-desc"
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              lineHeight: 1.45,
            }}
          >
            {alert.active_task ? (
              <>
                Target: <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>&ldquo;{alert.active_task}&rdquo;</strong>. Ready to return to flow?
              </>
            ) : (
              'You have been in this window for a while. Take a mindful pause or return to work.'
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="distraction-toast-close"
          aria-label="Dismiss distraction alert (Escape)"
          title="Dismiss (Esc)"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div
        className="distraction-toast-actions"
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          alignItems: 'center',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 10,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm distraction-toast-btn"
          onClick={() => onSnooze(10)}
        >
          Snooze 10m
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm distraction-toast-btn"
          onClick={() => onSnooze(30)}
        >
          Snooze 30m
        </button>
        <button
          ref={resumeBtnRef}
          type="button"
          className="btn btn-primary btn-sm distraction-toast-btn distraction-toast-btn-primary"
          onClick={onDismiss}
        >
          Resume Work
        </button>
      </div>
    </aside>
  );
}

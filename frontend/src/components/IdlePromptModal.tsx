import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, IconName } from './Icon';
import { IdleBlock } from '../types';

interface IdlePromptModalProps {
  isOpen: boolean;
  block: IdleBlock | null;
  currentTask: string;
  onResolve: (params: {
    action: 'meeting' | 'break' | 'discard';
    category: string;
    taskTag: string;
    isProductive: boolean;
    score: number;
  }) => void;
  onDismiss: () => void;
}

interface QuickOption {
  key: string;
  icon: IconName;
  title: string;
  desc: string;
  action: 'meeting' | 'break' | 'discard';
  category: string;
  isProductive: boolean;
  score: number;
  badgeColor: string;
}

const QUICK_OPTIONS: QuickOption[] = [
  {
    key: '1',
    icon: 'briefcase',
    title: 'Offline Meeting / Call',
    desc: 'Client call, standup, team sync',
    action: 'meeting',
    category: 'Meeting',
    isProductive: true,
    score: 90,
    badgeColor: 'var(--accent-green)',
  },
  {
    key: '2',
    icon: 'target',
    title: 'Planning & Architecture',
    desc: 'Whiteboarding, design, offline review',
    action: 'meeting',
    category: 'Planning',
    isProductive: true,
    score: 95,
    badgeColor: 'var(--accent-purple)',
  },
  {
    key: '3',
    icon: 'coffee',
    title: 'Coffee / Short Break',
    desc: 'Stretch, hydration, quick pause',
    action: 'break',
    category: 'Break',
    isProductive: false,
    score: 30,
    badgeColor: 'var(--accent-amber)',
  },
  {
    key: '4',
    icon: 'clock',
    title: 'Lunch / Meal Time',
    desc: 'Non-work personal break',
    action: 'break',
    category: 'Break',
    isProductive: false,
    score: 0,
    badgeColor: 'var(--accent-cyan)',
  },
  {
    key: '5',
    icon: 'trash',
    title: 'Discard Time Block',
    desc: 'Do not log this interval on the clock',
    action: 'discard',
    category: 'Discarded',
    isProductive: false,
    score: 0,
    badgeColor: 'var(--accent-red)',
  },
];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function IdlePromptModal({
  isOpen,
  block,
  currentTask,
  onResolve,
  onDismiss,
}: IdlePromptModalProps) {
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [taskTag, setTaskTag] = useState<string>(currentTask || '');
  const cardRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (currentTask) setTaskTag(currentTask);
  }, [currentTask]);

  // Body scroll lock
  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  // Focus restoration & keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const card = cardRef.current;
    if (card) {
      // Focus the currently selected option or the card itself
      const selectedOption = card.querySelector<HTMLElement>('.idle-modal-option.selected');
      if (selectedOption) {
        selectedOption.focus();
      } else {
        card.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }

      // Tab trap
      if (e.key === 'Tab') {
        const modalEl = cardRef.current;
        if (!modalEl) return;
        const focusables = Array.from(
          modalEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);

        if (focusables.length === 0) {
          e.preventDefault();
          modalEl.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const outside = !modalEl.contains(active);

        if (e.shiftKey) {
          if (outside || active === modalEl || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (outside || active === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      if (isInput) return;

      if (e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key, 10) - 1;
        setSelectedIdx(idx);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % QUICK_OPTIONS.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + QUICK_OPTIONS.length) % QUICK_OPTIONS.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit(QUICK_OPTIONS[selectedIdx]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && document.contains(prev) && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [isOpen, selectedIdx, taskTag, onDismiss]);

  if (!isOpen || !block) return null;

  const durationMin = Math.max(1, Math.round(block.duration_seconds / 60));
  const startTimeStr = new Date(block.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTimeStr = new Date(block.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const handleSubmit = (opt: QuickOption) => {
    onResolve({
      action: opt.action,
      category: opt.category,
      taskTag: opt.action === 'discard' ? '' : (taskTag.trim() || opt.title),
      isProductive: opt.isProductive,
      score: opt.score,
    });
  };

  const content = (
    <div
      className="modal-backdrop idle-modal-backdrop"
      onClick={onDismiss}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="idle-modal-title"
        tabIndex={-1}
        className="modal-card idle-modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 540,
        }}
      >
        {/* Header */}
        <header className="modal-header idle-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 auto' }}>
            <div
              className="modal-icon-chip"
              aria-hidden="true"
              style={{
                color: 'var(--accent-purple)',
                background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
                borderColor: 'color-mix(in srgb, var(--accent-purple) 28%, transparent)',
              }}
            >
              <Icon name="clock" size={18} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2 id="idle-modal-title" className="modal-title" style={{ margin: 0, fontSize: 16 }}>
                Welcome Back!
              </h2>
              <p className="modal-description" style={{ margin: '2px 0 0' }}>
                Away for <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{durationMin} minutes</strong>{' '}
                <span style={{ color: 'var(--text-muted)' }}>({startTimeStr} &mdash; {endTimeStr})</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-hit"
            onClick={onDismiss}
            aria-label="Dismiss and decide later (Escape)"
            title="Dismiss / Decide Later (Esc)"
          >
            <span className="modal-close" aria-hidden="true">
              <Icon name="x" size={16} />
            </span>
          </button>
        </header>

        {/* Body Content */}
        <div className="modal-body idle-modal-body" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Quick Allocation Options */}
          <div
            role="radiogroup"
            aria-label="Away interval allocation categories"
            className="idle-modal-options-list"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {QUICK_OPTIONS.map((opt, i) => {
              const isSelected = selectedIdx === i;
              return (
                <div
                  key={opt.key}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  className={`idle-modal-option ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedIdx(i);
                    handleSubmit(opt);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setSelectedIdx(i);
                      handleSubmit(opt);
                    }
                  }}
                >
                  <span className="idle-modal-kbd" aria-hidden="true">
                    {opt.key}
                  </span>

                  <div
                    className="idle-modal-option-icon"
                    aria-hidden="true"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 'var(--radius-sm)',
                      background: `color-mix(in srgb, ${opt.badgeColor} 14%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${opt.badgeColor} 28%, transparent)`,
                      color: opt.badgeColor,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon name={opt.icon} size={15} />
                  </div>

                  <div className="idle-modal-option-text" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {opt.title}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {opt.desc}
                    </div>
                  </div>

                  <span
                    className="idle-modal-option-badge"
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-sm)',
                      background: `color-mix(in srgb, ${opt.badgeColor} 14%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${opt.badgeColor} 26%, transparent)`,
                      color: opt.badgeColor,
                      flexShrink: 0,
                    }}
                  >
                    {opt.isProductive ? '+Productive' : opt.action === 'discard' ? 'Prune' : 'Neutral'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Optional Task Tag */}
          <div>
            <label
              htmlFor="idle-task-tag-input"
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: 6,
              }}
            >
              Topic / Task Tag <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(Optional)</span>
            </label>
            <input
              id="idle-task-tag-input"
              type="text"
              className="form-input"
              value={taskTag}
              onChange={(e) => setTaskTag(e.target.value)}
              placeholder="e.g. Sprint Sync, Architecture Review, or Break"
            />
          </div>
        </div>

        {/* Footer */}
        <footer
          className="modal-footer idle-modal-footer"
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'color-mix(in srgb, var(--text-primary) 2%, transparent)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div
            className="idle-modal-footer-shortcuts"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            <span>Press</span>
            <span className="kbd-shortcut">1</span>-
            <span className="kbd-shortcut">5</span>
            <span>or</span>
            <span className="kbd-shortcut">↵ Enter</span>
            <span>•</span>
            <span className="kbd-shortcut">Esc</span>
          </div>

          <div className="idle-modal-footer-actions" style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onDismiss}
            >
              Decide Later
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleSubmit(QUICK_OPTIONS[selectedIdx])}
            >
              Apply Allocation
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

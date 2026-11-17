import React, { useState, useEffect, useRef } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';

interface TaskGoalModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTask: string;
  onSave: (task: string) => void;
}

export function TaskGoalModal({ isOpen, onClose, currentTask, onSave }: TaskGoalModalProps) {
  const [taskInput, setTaskInput] = useState(currentTask);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTaskInput(currentTask);
    }
  }, [isOpen, currentTask]);

  const wordCount = taskInput.trim().split(/\s+/).filter(Boolean).length;
  const isOverLimit = wordCount > 20;

  const handleSave = () => {
    onSave(taskInput.trim());
    onClose();
  };

  const handleClear = () => {
    onSave('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!isOverLimit) {
        handleSave();
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Set Target Work Task"
      description="Define your current objective for contextual productivity scoring"
      icon={<Icon name="target" size={18} />}
      initialFocusRef={textareaRef}
      maxWidth={480}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Press <span className="kbd-shortcut">Ctrl+Enter</span> to save
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isOverLimit}
              className="btn btn-primary btn-sm"
              style={{ opacity: isOverLimit ? 0.6 : undefined, cursor: isOverLimit ? 'not-allowed' : undefined }}
            >
              Save & Align AI Analytics
            </button>
          </div>
        </div>
      }
    >
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 14, lineHeight: 1.5 }}>
        Describe what you are currently working on. AI analytics will evaluate your window titles, keypresses, and activity specifically against this goal.
      </p>

      <textarea
        ref={textareaRef}
        rows={3}
        className="form-input"
        value={taskInput}
        onChange={(e) => setTaskInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="e.g. Fixing database migration bug and optimizing mouse event loop performance..."
        style={{
          resize: 'none',
          marginBottom: 8,
          width: '100%',
          display: 'block',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: isOverLimit ? 600 : 400,
            color: isOverLimit ? 'var(--danger-text)' : 'var(--text-muted)',
          }}
        >
          Word count: {wordCount} / 20 words max
        </span>
        {currentTask && (
          <button
            type="button"
            onClick={handleClear}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--danger-text)',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Clear Task
          </button>
        )}
      </div>
    </Modal>
  );
}

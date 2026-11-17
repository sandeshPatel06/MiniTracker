import React, { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  minHeight?: number | string;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  minHeight,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`empty-state ${className}`.trim()}
      style={minHeight ? { minHeight } : undefined}
      role="status"
    >
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc">{description}</div>}
      {action && <div className="empty-state-actions" style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

import React, { ReactNode } from 'react';
import { Icon, IconName } from './Icon';

export type AlertType = 'error' | 'success' | 'warning' | 'info';

interface AlertProps {
  type?: AlertType;
  message?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  hideIcon?: boolean;
  onRetry?: () => void;
  retryText?: string;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_ICONS: Record<AlertType, IconName> = {
  error: 'x',
  warning: 'info',
  success: 'check',
  info: 'info',
};

export function Alert({
  type = 'error',
  message,
  children,
  icon,
  hideIcon = false,
  onRetry,
  retryText = 'Retry',
  className = '',
  style,
}: AlertProps) {
  const content = children || message;
  if (!content) return null;

  const renderedIcon = hideIcon ? null : icon || (
    <Icon name={DEFAULT_ICONS[type] || 'alert-circle'} size={16} />
  );

  return (
    <div
      className={`alert alert-${type} ${className}`.trim()}
      role="alert"
      style={style}
    >
      {renderedIcon && (
        <span className="alert-icon" aria-hidden="true">
          {renderedIcon}
        </span>
      )}
      <div className="alert-content">{content}</div>
      {onRetry && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onRetry}
          style={{ flexShrink: 0 }}
        >
          {retryText}
        </button>
      )}
    </div>
  );
}

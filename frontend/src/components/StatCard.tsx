import React, { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  valueTitle?: string;
  sub?: string;
  valueClass?: string;
  valueColor?: string;
  leading?: ReactNode;
  trend?: {
    direction: 'up' | 'down' | 'neutral';
    value: string;
  };
}

export function StatCard({
  label,
  value,
  valueTitle,
  sub,
  valueClass,
  valueColor,
  leading,
  trend,
}: StatCardProps) {
  return (
    <article className="stat-card">
      <header className="stat-header">
        <span className="stat-label">{label}</span>
        {trend && (
          <span
            className={`stat-trend stat-trend-${trend.direction}`}
            aria-label={`Trend: ${trend.direction} ${trend.value}`}
          >
            <span className="stat-trend-arrow" aria-hidden="true">
              {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}
            </span>
            <span className="stat-trend-val">{trend.value}</span>
          </span>
        )}
      </header>
      <div
        className={`stat-value${valueClass ? ` ${valueClass}` : ''}`}
        title={valueTitle}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {leading && <div className="stat-leading-icon">{leading}</div>}
        <span className="stat-value-text">{value}</span>
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </article>
  );
}

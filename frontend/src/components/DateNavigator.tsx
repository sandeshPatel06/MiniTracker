import React from 'react';
import { Icon } from './Icon';
import { localISODate } from '../utils';

interface DateNavigatorProps {
  currentDate: string;
  onDateChange: (date: string) => void;
  maxDate?: string;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function DateNavigator({
  currentDate,
  onDateChange,
  maxDate,
  label,
  className = '',
  style = {},
}: DateNavigatorProps) {
  const shiftDate = (days: number) => {
    const d = new Date(`${currentDate}T00:00:00`);
    d.setDate(d.getDate() + days);
    return localISODate(d);
  };

  const handlePrevDay = () => {
    onDateChange(shiftDate(-1));
  };

  const handleNextDay = () => {
    const nextDate = shiftDate(1);
    if (!maxDate || nextDate <= maxDate) {
      onDateChange(nextDate);
    }
  };

  const handleToday = () => {
    const today = localISODate();
    onDateChange(!maxDate || today <= maxDate ? today : maxDate);
  };

  const isToday = !maxDate ? false : currentDate >= maxDate;

  return (
    <div
      className={`date-navigator ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--bg-card)',
        padding: '4px 8px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-sm)',
        maxWidth: '100%',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {label && (
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginRight: 4, flexShrink: 0 }}>
          {label}
        </span>
      )}
      <button
        type="button"
        className="date-nav-btn btn-icon"
        onClick={handlePrevDay}
        title="Previous Day"
        aria-label="Previous Day"
      >
        <Icon name="chevron-left" size={14} />
      </button>

      <input
        type="date"
        className="date-nav-input date-input"
        aria-label={label || 'Select date'}
        value={currentDate}
        max={maxDate}
        onChange={(e) => e.target.value && onDateChange(e.target.value)}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          colorScheme: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
          minWidth: 0,
          maxWidth: '100%',
        }}
      />

      <button
        type="button"
        className="date-nav-btn btn-icon"
        onClick={handleNextDay}
        disabled={isToday}
        title="Next Day"
        aria-label="Next Day"
      >
        <Icon name="chevron-right" size={14} />
      </button>

      {(!maxDate || currentDate !== maxDate) && (
        <button
          type="button"
          onClick={handleToday}
          className="btn btn-secondary btn-sm date-nav-today"
          style={{ padding: '3px 8px', fontSize: 12, marginLeft: 2, height: 28, flexShrink: 0 }}
        >
          Today
        </button>
      )}
    </div>
  );
}

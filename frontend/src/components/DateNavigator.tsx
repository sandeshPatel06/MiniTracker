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
        ...style,
      }}
    >
      {label && (
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginRight: 4 }}>
          {label}
        </span>
      )}
      <button
        type="button"
        className="btn-icon"
        onClick={handlePrevDay}
        title="Previous Day"
        aria-label="Previous Day"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '6px',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="chevron-left" size={14} />
      </button>

      <input
        type="date"
        value={currentDate}
        max={maxDate}
        onChange={(e) => e.target.value && onDateChange(e.target.value)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      />

      <button
        type="button"
        className="btn-icon"
        onClick={handleNextDay}
        disabled={isToday}
        title="Next Day"
        aria-label="Next Day"
        style={{
          background: 'none',
          border: 'none',
          cursor: isToday ? 'not-allowed' : 'pointer',
          opacity: isToday ? 0.4 : 1,
          padding: '6px',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="chevron-right" size={14} />
      </button>

      {(!maxDate || currentDate !== maxDate) && (
        <button
          type="button"
          onClick={handleToday}
          className="btn btn-secondary btn-sm"
          style={{ padding: '3px 8px', fontSize: 12, marginLeft: 2 }}
        >
          Today
        </button>
      )}
    </div>
  );
}

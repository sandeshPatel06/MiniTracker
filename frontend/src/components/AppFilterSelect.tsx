import { AppIcon } from './AppIcon';
import { CustomSelect } from './CustomSelect';
import type { SelectOption } from './CustomSelect';
import { Icon } from './Icon';

export interface AppFilterSelectProps {
  apps: string[];
  value: string;
  onChange: (value: string) => void;
  align?: 'left' | 'right';
  className?: string;
  compact?: boolean;
  fullWidth?: boolean;
  id?: string;
}

export function AppFilterSelect({
  apps,
  value,
  onChange,
  align = 'left',
  className = '',
  compact = false,
  fullWidth = false,
  id,
}: AppFilterSelectProps) {
  const options: SelectOption[] = [
    {
      value: 'ALL',
      label: 'All Applications',
      triggerLabel: `All Applications (${apps.length})`,
      leading: <Icon name="desktop" size={14} />,
      meta: String(apps.length),
    },
    ...apps.map((app) => ({
      value: app,
      label: app,
      leading: <AppIcon name={app} size={16} />,
    })),
  ];

  const classes = ['app-filter', className].filter(Boolean).join(' ');

  return (
    <CustomSelect
      id={id}
      className={classes}
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel="Filter by application"
      align={align}
      compact={compact}
      fullWidth={fullWidth}
    />
  );
}

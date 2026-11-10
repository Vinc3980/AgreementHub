/** Ruled data table: no outer card, sticky header, row hover. */
import type { CSSProperties, ReactNode } from 'react';

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`sticky top-0 z-10 border-b border-rule-strong bg-paper px-3 py-2.5 text-left text-caps text-ink-3 ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <td className={`border-b border-rule px-3 py-3 align-top text-ink ${className}`}>
      {children}
    </td>
  );
}

export function Tr({
  children,
  onClick,
  className = '',
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <tr
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={[
        'border-b border-rule transition-colors last:border-b-0',
        onClick
          ? 'cursor-pointer hover:bg-vellum/70 focus-visible:bg-vellum/70'
          : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      {children}
    </tr>
  );
}

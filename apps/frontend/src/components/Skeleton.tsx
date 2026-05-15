import type { CSSProperties } from 'react';

type SkeletonProps = {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({ width, height, radius, className, style }: SkeletonProps) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{
        width: width ?? '100%',
        height: height ?? 12,
        borderRadius: radius ?? 6,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

type TableSkeletonProps = {
  rows?: number;
  cols?: number;
  withCheckbox?: boolean;
};

export function TableSkeleton({ rows = 8, cols = 6, withCheckbox = false }: TableSkeletonProps) {
  const totalCols = withCheckbox ? cols + 1 : cols;
  return (
    <div className="skeleton-table" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div className="skeleton-tr" key={r}>
          {Array.from({ length: totalCols }).map((_, c) => {
            if (withCheckbox && c === 0) {
              return (
                <span className="skeleton-td" key={c} style={{ flex: '0 0 36px' }}>
                  <Skeleton width={14} height={14} radius={3} />
                </span>
              );
            }
            // Vary widths so it doesn't look mechanical.
            const widths = ['72%', '60%', '50%', '80%', '40%', '66%', '55%', '70%'];
            const w = widths[c % widths.length];
            return (
              <span className="skeleton-td" key={c}>
                <Skeleton width={w} height={12} />
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type FormSkeletonProps = {
  fields?: number;
  withHeader?: boolean;
};

export function FormSkeleton({ fields = 6, withHeader = true }: FormSkeletonProps) {
  return (
    <div className="skeleton-form" role="status" aria-label="Loading">
      {withHeader && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 8 }}>
          <Skeleton width={180} height={20} radius={6} />
          <Skeleton width={260} height={12} />
        </div>
      )}
      {Array.from({ length: fields }).map((_, i) => (
        <div className="skeleton-field" key={i}>
          <Skeleton width={90} height={11} />
          <Skeleton width="100%" height={36} radius={8} />
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="skeleton-dashboard" role="status" aria-label="Loading">
      <div className="skeleton-tiles">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="skeleton-tile" key={i}>
            <Skeleton width={70} height={11} />
            <Skeleton width={120} height={26} radius={6} />
            <Skeleton width={90} height={10} />
          </div>
        ))}
      </div>
      <div className="skeleton-grid">
        <div className="skeleton-card">
          <Skeleton width={140} height={14} />
          <div style={{ height: 12 }} />
          <Skeleton width="100%" height={180} radius={10} />
        </div>
        <div className="skeleton-card">
          <Skeleton width={140} height={14} />
          <div style={{ height: 12 }} />
          {Array.from({ length: 5 }).map((_, i) => (
            <div className="skeleton-lb-row" key={i}>
              <Skeleton width={20} height={20} radius={999} />
              <Skeleton width="55%" height={12} />
              <Skeleton width={48} height={12} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type PhoneListSkeletonProps = {
  rows?: number;
  variant?: 'row' | 'order';
};

export function PhoneListSkeleton({ rows = 5, variant = 'row' }: PhoneListSkeletonProps) {
  if (variant === 'order') {
    return (
      <div className="skeleton-phone-orders" role="status" aria-label="Loading">
        {Array.from({ length: rows }).map((_, i) => (
          <div className="skeleton-phone-order" key={i}>
            <div className="skeleton-phone-order-head">
              <Skeleton width={32} height={32} radius={999} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Skeleton width="65%" height={13} />
                <Skeleton width="40%" height={11} />
              </div>
              <Skeleton width={56} height={20} radius={999} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="skeleton-phone-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-phone-row" key={i}>
          <Skeleton width={36} height={36} radius={10} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="70%" height={13} />
            <Skeleton width="45%" height={11} />
          </div>
          <Skeleton width={52} height={14} />
        </div>
      ))}
    </div>
  );
}

export function PhoneKpiSkeleton({ tiles = 2 }: { tiles?: number }) {
  return (
    <div className="skeleton-phone-kpis" role="status" aria-label="Loading">
      {Array.from({ length: tiles }).map((_, i) => (
        <div className="skeleton-phone-kpi" key={i}>
          <Skeleton width={70} height={10} />
          <Skeleton width={90} height={22} radius={6} />
          <Skeleton width={60} height={9} />
        </div>
      ))}
    </div>
  );
}

type ListSkeletonProps = {
  rows?: number;
};

export function ListSkeleton({ rows = 6 }: ListSkeletonProps) {
  return (
    <div className="skeleton-list" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-list-row" key={i}>
          <Skeleton width={28} height={28} radius={999} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="55%" height={12} />
            <Skeleton width="35%" height={10} />
          </div>
          <Skeleton width={48} height={10} />
        </div>
      ))}
    </div>
  );
}

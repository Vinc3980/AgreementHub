/**
 * The Hash Rosette, a deterministic guilloche generated from a document's
 * SHA-256. Same content ⇒ same rosette; any tampering ⇒ a visibly different
 * one. Pure, cached, monochrome (currentColor), hairline strokes only.
 * Geometry is shared with the API document renderer via @agreementhub/domain.
 */
import { fingerprintLabel, rosetteGeometry } from '@agreementhub/domain';

export { fingerprintLabel, rosetteGeometry };
export type { RosetteGeometry } from '@agreementhub/domain';

export function Rosette({
  hash,
  size = 120,
  className = '',
  withSignature = false,
  decorative = false,
  drawing = false,
}: {
  hash: string | null | undefined;
  size?: number;
  className?: string;
  /** Draw a signature line through the mark (used by the logo). */
  withSignature?: boolean;
  decorative?: boolean;
  /** Animate the mark drawing itself (calm branded loading). */
  drawing?: boolean;
}) {
  const g = rosetteGeometry(hash ?? 'unsealed');
  const petalLength = g.outer * 0.92;
  const petalWidth = g.outer * 0.16;
  const innerLength = g.inner * 0.95;
  const innerWidth = g.inner * 0.2;
  const part = drawing ? { pathLength: 1, 'data-rosette-part': 'stroke' as const } : {};

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`${drawing ? 'rosette-draw ' : ''}${className}`.trim()}
      fill="none"
      stroke="currentColor"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : fingerprintLabel(hash)}
    >
      <g transform={`rotate(${g.spin} 50 50)`}>
        <circle cx="50" cy="50" r={g.outer} strokeWidth={g.stroke} {...part} />
        <circle
          cx="50"
          cy="50"
          r={g.outer - 2.4}
          strokeWidth={g.stroke * 0.7}
          strokeDasharray={drawing ? undefined : '1.1 2.4'}
          {...part}
        />
        <circle cx="50" cy="50" r={g.outer - 5} strokeWidth={g.stroke * 0.5} {...part} />
        {Array.from({ length: g.petals }).map((_, i) => {
          const angle = (360 / g.petals) * i + (g.phase * 180) / Math.PI;
          return (
            <g key={`p-${i}`} transform={`rotate(${angle} 50 50)`}>
              <ellipse
                cx="50"
                cy={50 - petalLength / 2 + 4}
                rx={petalWidth}
                ry={petalLength / 2}
                strokeWidth={g.stroke}
                {...part}
              />
              <line x1="50" y1="50" x2="50" y2={50 - g.outer + 1} strokeWidth={g.stroke * 0.45} {...part} />
            </g>
          );
        })}
        <circle cx="50" cy="50" r={g.inner} strokeWidth={g.stroke} {...part} />
        {Array.from({ length: g.innerPetals }).map((_, i) => {
          const angle = (360 / g.innerPetals) * i - (g.phase * 180) / Math.PI;
          return (
            <ellipse
              key={`i-${i}`}
              cx="50"
              cy={50 - innerLength / 2 + 1.5}
              rx={innerWidth}
              ry={innerLength / 2}
              strokeWidth={g.stroke * 0.8}
              transform={`rotate(${angle} 50 50)`}
              {...part}
            />
          );
        })}
        <circle cx="50" cy="50" r={g.inner * 0.34} strokeWidth={g.stroke * 0.7} {...part} />
        <circle cx="50" cy="50" r="0.9" fill="currentColor" stroke="none" data-rosette-part={drawing ? 'fill' : undefined} />
      </g>
      {withSignature ? (
        <path
          d="M18 62c7-1 9-9 14-9s3 10 9 10 6-7 11-7 5 6 10 6 5-4 10-3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="square"
          {...part}
        />
      ) : null}
    </svg>
  );
}

/** Logo mark: rosette with a signature line through it. */
export function RosetteMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <Rosette
      hash="agreementhub-instrument-v1"
      size={size}
      className={className}
      withSignature
      decorative
    />
  );
}

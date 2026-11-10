'use client';

/**
 * Public verification QR code (SPEC §14): encodes the verification URL
 * (/verify/AGR-…). Scanning it opens the public page, which shows safe
 * metadata only, never document contents.
 */
import { QRCodeSVG } from 'qrcode.react';

export function VerifyQr({
  url,
  size = 132,
  caption,
}: {
  url: string;
  size?: number;
  caption?: string;
}) {
  if (!url) return null;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-none border border-rule bg-sheet p-2.5">
        <QRCodeSVG
          value={url}
          size={size}
          marginSize={0}
          level="M"
          aria-label={`QR code for ${url}`}
        />
      </div>
      {caption ? (
        <p className="max-w-[16rem] text-center text-xs text-ink-2">{caption}</p>
      ) : null}
    </div>
  );
}

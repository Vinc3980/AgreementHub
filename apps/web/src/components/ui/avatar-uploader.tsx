'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Minus, Plus, Save, Trash2 } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ApiError, del, upload } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import type { PublicUser, SessionResponse } from '@/lib/types';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);
const INVALID_MESSAGE = 'Use a PNG, JPG or WebP under 2 MB.';
const VIEWPORT = 224;
const STEP = 14;
const ZOOM_STEP = 0.08;

interface CropState {
  zoom: number;
  x: number;
  y: number;
}

function clampCrop(
  image: HTMLImageElement,
  crop: CropState,
): CropState {
  const base = Math.max(VIEWPORT / image.naturalWidth, VIEWPORT / image.naturalHeight);
  const scale = base * crop.zoom;
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  const maxX = Math.max(0, (drawW - VIEWPORT) / 2);
  const maxY = Math.max(0, (drawH - VIEWPORT) / 2);
  return {
    zoom: Math.min(4, Math.max(1, crop.zoom)),
    x: Math.min(maxX, Math.max(-maxX, crop.x)),
    y: Math.min(maxY, Math.max(-maxY, crop.y)),
  };
}

function drawCrop(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  crop: CropState,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const base = Math.max(VIEWPORT / image.naturalWidth, VIEWPORT / image.naturalHeight);
  const scale = base * crop.zoom;
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  const dx = (VIEWPORT - drawW) / 2 + crop.x;
  const dy = (VIEWPORT - drawH) / 2 + crop.y;
  ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
  ctx.fillStyle = '#ede8dc';
  ctx.fillRect(0, 0, VIEWPORT, VIEWPORT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, dx, dy, drawW, drawH);
}

async function croppedBlob(
  image: HTMLImageElement,
  crop: CropState,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = VIEWPORT;
  canvas.height = VIEWPORT;
  drawCrop(canvas, image, crop);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not prepare the image.'));
    }, 'image/webp', 0.92);
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_AVATAR' || err.code === 'FILE_TOO_LARGE') return INVALID_MESSAGE;
    return err.message || INVALID_MESSAGE;
  }
  return INVALID_MESSAGE;
}

export function AvatarUploader() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropState>({ zoom: 1, x: 0, y: 0 });
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    drawCrop(canvas, image, crop);
  }, [crop, sourceName]);

  const ready = Boolean(sourceName && imageRef.current);

  function resetCropper() {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    imageRef.current = null;
    setSourceName(null);
    setSourceUrl(null);
    setCrop({ zoom: 1, x: 0, y: 0 });
    setProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function adjust(next: Partial<CropState>) {
    const image = imageRef.current;
    if (!image) return;
    setCrop((current) => clampCrop(image, { ...current, ...next }));
  }

  function onChoose(file: File | null) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES || !ALLOWED.has(file.type)) {
      setError(INVALID_MESSAGE);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setSourceName(file.name);
      setSourceUrl(url);
      setCrop({ zoom: 1, x: 0, y: 0 });
      // Draw once the state settles.
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (canvas) drawCrop(canvas, img, { zoom: 1, x: 0, y: 0 });
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError(INVALID_MESSAGE);
    };
    img.src = url;
  }

  async function onSave() {
    const image = imageRef.current;
    if (!image || !user) return;
    setBusy('save');
    setError(null);
    setProgress(0);
    try {
      const blob = await croppedBlob(image, crop);
      const form = new FormData();
      form.append('file', new File([blob], 'avatar.webp', { type: 'image/webp' }));
      await upload<{ user: PublicUser }>('/users/me/avatar', form, (fraction) => {
        setProgress(fraction);
      });
      await refresh();
      toast.success('Profile picture updated.');
      resetCropper();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function onRemove() {
    if (!user?.avatarUrl) return;
    setBusy('remove');
    setError(null);
    try {
      await del<SessionResponse>('/users/me/avatar');
      await refresh();
      toast.success('Profile picture removed.');
      resetCropper();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  function onCropKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!ready) return;
    let handled = true;
    if (event.key === 'ArrowLeft') adjust({ x: crop.x - STEP });
    else if (event.key === 'ArrowRight') adjust({ x: crop.x + STEP });
    else if (event.key === 'ArrowUp') adjust({ y: crop.y - STEP });
    else if (event.key === 'ArrowDown') adjust({ y: crop.y + STEP });
    else if (event.key === '+' || event.key === '=') adjust({ zoom: crop.zoom + ZOOM_STEP });
    else if (event.key === '-' || event.key === '_') adjust({ zoom: crop.zoom - ZOOM_STEP });
    else handled = false;
    if (handled) event.preventDefault();
  }

  const status = useMemo(() => {
    if (busy === 'save' && progress != null) {
      return `Uploading ${Math.round(progress * 100)}%`;
    }
    if (busy === 'remove') return 'Removing…';
    return null;
  }, [busy, progress]);

  return (
    <div className="border-b border-rule pb-5">
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex flex-col items-center gap-2">
          <Avatar
            name={user?.displayName ?? user?.email ?? ''}
            userId={user?.id}
            src={ready ? null : user?.avatarUrl}
            size={96}
          />
          <p className="text-xs text-ink-3">Current picture</p>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium text-ink">Profile picture</p>
            <p className="mt-0.5 text-sm text-ink-2">
              Choose a PNG, JPG or WebP under 2 MB. You can crop it before saving.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Choose profile picture"
              onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
            />
            <Button
              type="button"
              variant="secondary"
              icon={<ImagePlus className="h-4 w-4" />}
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
            >
              Choose file
            </Button>
            {user?.avatarUrl ? (
              <Button
                type="button"
                variant="ghost"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => void onRemove()}
                loading={busy === 'remove'}
                disabled={busy !== null}
              >
                Remove
              </Button>
            ) : null}
          </div>

          {ready ? (
            <div className="flex flex-wrap items-start gap-4 border border-rule bg-paper p-3">
              <div
                role="application"
                tabIndex={0}
                aria-label="Crop profile picture. Use arrow keys to move, plus or minus to zoom."
                onKeyDown={onCropKeyDown}
                className="outline-none ring-navy focus:ring-2"
              >
                <canvas
                  ref={canvasRef}
                  width={VIEWPORT}
                  height={VIEWPORT}
                  aria-label={`${user?.displayName ?? 'User'} profile picture crop preview`}
                  className="block border border-rule-strong bg-vellum"
                />
              </div>
              <div className="min-w-[12rem] flex-1 space-y-3">
                <p className="text-xs text-ink-2">
                  Drag not required. Focus the preview and use arrow keys to move, +/− to zoom.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Minus className="h-3.5 w-3.5" />}
                    onClick={() => adjust({ zoom: crop.zoom - ZOOM_STEP })}
                    disabled={busy !== null}
                    aria-label="Zoom out"
                  >
                    Zoom out
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => adjust({ zoom: crop.zoom + ZOOM_STEP })}
                    disabled={busy !== null}
                    aria-label="Zoom in"
                  >
                    Zoom in
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    icon={<Save className="h-4 w-4" />}
                    onClick={() => void onSave()}
                    loading={busy === 'save'}
                    disabled={busy !== null}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resetCropper}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                </div>
                {status ? <p className="text-xs text-ink-2">{status}</p> : null}
                {sourceName ? <p className="text-xs text-ink-3">Selected: {sourceName}</p> : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

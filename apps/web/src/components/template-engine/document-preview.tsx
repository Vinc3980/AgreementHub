'use client';

/**
 * Structured preview of a composed agreement document. Renders the engine's
 * plain-text output (placeholders already interpolated); conversion to
 * styled HTML/PDF happens in the download renderer, never here.
 */
import type { RenderedTemplateSection } from '@/lib/types';

export function DocumentPreview({
  title,
  publicId,
  sections,
}: {
  title: string;
  publicId: string;
  sections: RenderedTemplateSection[];
}) {
  const visible = sections.filter((s) => s.visible);
  const excluded = sections.filter((s) => !s.visible);

  return (
    <div>
      <article className="mx-auto max-w-2xl rounded-none border border-rule bg-sheet px-8 py-10">
        <header className="border-b border-rule pb-5 text-center">
          <p className="text-caps text-ink-3">Draft instrument</p>
          <p className="mt-2 font-mono text-xs text-ink-2">{publicId}</p>
          <h2 className="mt-2 font-serif text-xl text-ink">{title}</h2>
        </header>
        <div className="mt-6 space-y-6">
          {visible.length === 0 ? (
            <p className="text-sm text-ink-2">This document has no included sections yet.</p>
          ) : (
            visible.map((section, i) => (
              <section key={section.code}>
                <h3 className="flex items-baseline gap-2 border-b border-rule pb-1.5 text-caps text-ink">
                  <span className="font-mono text-2xs text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                  {section.title}
                </h3>
                <p className="doc-prose mt-2 whitespace-pre-wrap text-ink">
                  {section.body}
                </p>
              </section>
            ))
          )}
        </div>
      </article>
      {excluded.length > 0 ? (
        <p className="mt-3 text-center text-xs text-ink-2">
          Hidden by conditions:{' '}
          {excluded.map((s) => s.title).join(', ')}. They appear when their condition matches.
        </p>
      ) : null}
    </div>
  );
}

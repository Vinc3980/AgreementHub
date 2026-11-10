import Link from 'next/link';
import { RosetteMark, Rosette } from '@/components/ui/rosette';
import { VerifyLookup } from '@/components/verify-lookup';

const FEATURES = [
  {
    n: '01',
    title: 'Draft to signature',
    body: 'Templates, structured drafting, approvals, and ordered or parallel signing in one flow.',
  },
  {
    n: '02',
    title: 'Immutable history',
    body: 'Every change becomes a hashed version with an append-only, tamper-evident audit chain.',
  },
  {
    n: '03',
    title: 'Public verification',
    body: 'Anyone can confirm a sealed document’s integrity from its Agreement ID. No content is revealed.',
  },
  {
    n: '04',
    title: 'Clear states',
    body: 'Draft, in review, awaiting signatures, active, expired: always visible, never ambiguous.',
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="AgreementHub home">
            <RosetteMark size={26} className="text-ink" />
            <span className="flex flex-col leading-none">
              <span className="font-serif text-[1.05rem] font-medium text-ink">AgreementHub</span>
              <span className="mt-1 text-caps text-ink-3">The instrument</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center px-3 text-sm text-ink-2 hover:text-ink"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex min-h-11 items-center border border-navy bg-navy px-4 text-sm font-medium text-sheet hover:bg-navy-hover"
            >
              Create account
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <p className="text-caps text-seal">Digital agreements, end to end</p>
            <h1 className="mt-4 max-w-3xl font-serif text-2xl leading-[1.08] text-ink sm:text-3xl">
              Agreements you can draft, sign, and independently verify.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-ink-2">
              AgreementHub helps you create and manage agreements in Ghana: drafting, review,
              approvals, and electronic signatures, with every finalized document sealed by a
              public integrity check backed by a tamper-evident audit trail.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/register"
                className="inline-flex min-h-11 items-center border border-navy bg-navy px-5 text-sm font-medium text-sheet hover:bg-navy-hover"
              >
                Get started
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center border border-rule-strong bg-sheet px-5 text-sm font-medium text-ink hover:border-ink hover:bg-vellum"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-6 max-w-lg border-l-2 border-rule-strong pl-3 text-xs text-ink-3">
              Signing is bound to the exact content at that moment. Any later change creates a new
              version and a new hash. The sealed record never moves.
            </p>
          </div>

          <div className="hidden items-center justify-center lg:flex">
            <div className="relative flex flex-col items-center border border-rule bg-sheet px-8 py-10">
              <Rosette hash="agreementhub-home" size={220} className="text-seal" decorative />
              <p className="mt-6 text-caps text-ink-3">Specimen of the seal</p>
              <p className="mt-1 text-center font-serif text-sm text-ink-2">
                Deterministic. Monochrome. Generated from the document hash.
              </p>
            </div>
          </div>
        </section>

        <section className="border-y border-rule bg-sheet">
          <div className="mx-auto grid w-full max-w-6xl sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <article
                key={f.n}
                className={[
                  'px-5 py-6',
                  i > 0 ? 'border-t border-rule sm:border-t-0 sm:border-l' : '',
                  i === 2 ? 'sm:border-t lg:border-t-0' : '',
                ].join(' ')}
              >
                <p className="font-mono text-2xs text-ink-3">{f.n}</p>
                <h2 className="mt-3 font-serif text-lg text-ink">{f.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-caps text-ink-3">Public register</p>
            <h2 className="mt-2 font-serif text-xl text-ink">Verify an agreement</h2>
            <p className="mt-1.5 text-sm text-ink-2">
              Enter an Agreement ID (for example{' '}
              <code className="font-mono text-xs text-ink">AGR-GH-2026-000001</code>) to check a
              document’s integrity. Verification never reveals document contents.
            </p>
            <div className="mt-5">
              <VerifyLookup />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-ink-2 sm:px-6">
          <span>AgreementHub: electronic acceptance, signature, and verification.</span>
          <span className="text-ink-3">Not a legal advice service.</span>
        </div>
      </footer>
    </div>
  );
}

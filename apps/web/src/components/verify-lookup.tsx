'use client';

/** Public Agreement ID lookup → verification page. */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';

const PUBLIC_ID_RE = /^[A-Z]{2,4}-[A-Z]{2,4}-\d{4}-\d{6}$/;

export function VerifyLookup() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = value.trim().toUpperCase();
    if (!PUBLIC_ID_RE.test(id)) {
      setError('Enter a valid Agreement ID, e.g. AGR-GH-2026-000001.');
      return;
    }
    setError(null);
    router.push(`/verify/${id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="AGR-GH-2026-000001"
          aria-label="Agreement ID"
          className="font-mono"
          error={error}
        />
      </div>
      <Button type="submit" icon={<Search className="h-4 w-4" />} className="sm:h-10">
        Verify
      </Button>
    </form>
  );
}

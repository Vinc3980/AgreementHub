import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findDefinitionProblems, parseTemplateDefinition } from '@agreementhub/domain/template';

const here = dirname(fileURLToPath(import.meta.url));

function loadSeed(): string {
  // tests run from apps/api; repo root is ../..
  return readFileSync(join(here, '..', '..', '..', 'db', 'seeds', '0001_templates.sql'), 'utf8');
}

function extractDefinitions(sql: string) {
  const re = /'(\{\s*"definitionVersion"[\s\S]*?\n\s*\})'::jsonb/g;
  const defs: Array<Record<string, any>> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) defs.push(JSON.parse(m[1]!.replace(/''/g, "'")));
  return defs;
}

describe('Ghana template seeds (v2/location)', () => {
  it('parses every seeded template definition with no engine problems', () => {
    const defs = extractDefinitions(loadSeed());
    expect(defs.length).toBeGreaterThanOrEqual(10);
    for (const raw of defs) {
      const def = parseTemplateDefinition(raw);
      expect(def).not.toBeNull();
      expect(findDefinitionProblems(def!)).toEqual([]);
    }
  });

  it('offers GHS (first/default) on current v2+ money templates that have a currency select', () => {
    const defs = extractDefinitions(loadSeed());
    // v2+ definitions in this seed include payment_method/mobile money or GHS-era options; v1 rows remain unchanged.
    const v2Defs = defs.filter((d) => (d.fields ?? []).some((f: any) => f.code === 'payment_method' || f.options?.includes?.('GHS')));
    expect(v2Defs.length).toBeGreaterThanOrEqual(4);
    const currencyFields = v2Defs.flatMap((d) => (d.fields ?? []).filter((f: any) => /currency/i.test(f.code) && f.type === 'select'));
    expect(currencyFields.length).toBeGreaterThan(0);
    for (const f of currencyFields) {
      expect(f.options?.[0]).toBe('GHS');
      expect(f.options).toContain('GHS');
      expect(f.default).toBe('GHS');
    }
  });

  it('includes location/legal fields and NDA v2 in seeded definitions', () => {
    const sql = loadSeed();
    expect(sql).toContain('/* 4b. Non-Disclosure Agreement (v2) */');
    const defs = extractDefinitions(sql);
    const allCodes = new Set(defs.flatMap((d) => (d.fields ?? []).map((f: any) => f.code)));
    for (const code of ['governing_law', 'dispute_resolution', 'place_of_signing', 'property_digital_address', 'property_region']) {
      expect(allCodes.has(code)).toBe(true);
    }
  });
});

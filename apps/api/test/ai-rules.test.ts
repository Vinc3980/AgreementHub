import { describe, expect, it } from 'vitest';
import { extractFromDescription } from '../src/ai/rules.js';

const fields = [
  { code: 'project_fee', label: 'Project fee', type: 'money', required: true, options: [] as string[] },
  { code: 'currency', label: 'Currency', type: 'select', required: true, options: ['GHS', 'USD', 'GBP', 'EUR', 'NGN'] },
  { code: 'payment_schedule', label: 'Payment schedule', type: 'select', required: true, options: ['Per milestone', 'Monthly', 'On delivery', 'Custom'] },
];

describe('AI rules currency detection', () => {
  it('detects cedis and accepts GHS when the template offers it', async () => {
    const out = await extractFromDescription({ description: 'I will pay 3,500 cedis for the work.', fields });
    expect(out.fields.find((f) => f.fieldCode === 'currency')?.value).toBe('GHS');
  });

  it('detects GH₵ and GHS tokens', async () => {
    const ghc = await extractFromDescription({ description: 'The fee is GH₵ 1,200.', fields });
    expect(ghc.fields.find((f) => f.fieldCode === 'currency')?.value).toBe('GHS');
    const ghs = await extractFromDescription({ description: 'Total cost is GHS 5000.', fields });
    expect(ghs.fields.find((f) => f.fieldCode === 'currency')?.value).toBe('GHS');
  });

  it('keeps "$" and dollars as USD (not GHS)', async () => {
    const out = await extractFromDescription({ description: 'The project costs $500 dollars.', fields });
    expect(out.fields.find((f) => f.fieldCode === 'currency')?.value).toBe('USD');
  });
});

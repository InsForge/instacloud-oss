// The platform's category list against the two things here that depend on it.
import { describe, it, expect } from 'vitest';
import { categoryProblems, readCategories } from './categories.mjs';

const listed = [
  { slug: 'automation', label: 'Automation' },
  { slug: 'ecommerce', label: 'E-commerce' },
  { slug: 'other', label: 'Other' },
];
const snapshot = { categories: listed };

describe('readCategories', () => {
  it('takes the envelope and keeps only slug and label', () => {
    expect(readCategories({ categories: [{ slug: 'cms', label: 'CMS', extra: 1 }] })).toEqual([{ slug: 'cms', label: 'CMS' }]);
  });

  it('refuses anything that is not the envelope, so an outage never reads as an empty list', () => {
    expect(readCategories({ error: 'not found' })).toBeNull();
    expect(readCategories({ categories: [{ slug: 'cms' }] })).toBeNull();
    expect(readCategories(null)).toBeNull();
  });

  it('refuses a list the snapshot must never hold: empty, a bad or repeated slug, a blank label', () => {
    expect(readCategories({ categories: [] })).toBeNull();
    expect(readCategories({ categories: [{ slug: 'CMS', label: 'CMS' }] })).toBeNull();
    expect(readCategories({ categories: [{ slug: '', label: 'CMS' }] })).toBeNull();
    expect(readCategories({ categories: [{ slug: 'cms', label: '  ' }] })).toBeNull();
    expect(readCategories({ categories: [{ slug: 'cms', label: 'CMS' }, { slug: 'cms', label: 'Blogs' }] })).toBeNull();
  });
});

describe('categoryProblems', () => {
  it('passes when every manifest names a listed category and the snapshot matches', () => {
    expect(categoryProblems(listed, [{ dir: 'n8n', category: 'automation' }], snapshot)).toEqual([]);
  });

  it('names a manifest whose category the platform does not list', () => {
    expect(categoryProblems(listed, [{ dir: 'odd', category: 'games' }], snapshot)).toEqual([
      "odd: meta.category 'games' is not one of the platform's categories",
    ]);
  });

  it('leaves a missing category to lint, which already reports it', () => {
    expect(categoryProblems(listed, [{ dir: 'bare', category: undefined }], snapshot)).toEqual([]);
  });

  it('flags a snapshot that lags the platform, a relabel or a reorder included', () => {
    const stale = [
      { categories: listed.slice(0, 2) },
      { categories: [listed[0], { slug: 'ecommerce', label: 'Ecommerce' }, listed[2]] },
      { categories: [listed[1], listed[0], listed[2]] },
    ];
    for (const s of stale) {
      expect(categoryProblems(listed, [], s)).toEqual([
        'ui/src/lib/template-categories.json differs from the platform: npm run check-categories -- --write',
      ]);
    }
  });
});

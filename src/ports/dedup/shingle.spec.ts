import { jaccard, normalize, shingles, similarity } from './shingle';

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalize('  Solar-Kiosks, for LAGOS!!  ')).toBe('solar kiosks for lagos');
  });
});

describe('shingles', () => {
  it('produces word trigrams', () => {
    expect([...shingles('a b c d')]).toEqual(['a b c', 'b c d']);
  });
  it('falls back to words for short text', () => {
    expect([...shingles('two words')]).toEqual(['two', 'words']);
  });
  it('empty text yields no shingles', () => {
    expect(shingles('').size).toBe(0);
  });
});

describe('jaccard', () => {
  it('is intersection over union', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5); // 2/4
  });
  it('is 0 for disjoint or empty sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('similarity', () => {
  const original = 'Solar cold chain lockers for kilishi producers rented per tray';

  it('is 1.0 for identical text (ignoring case/punctuation)', () => {
    expect(similarity(original, 'SOLAR COLD-CHAIN lockers for kilishi producers, rented per tray!')).toBe(1);
  });
  it('is substantial for a near-duplicate (a reworded tail is only moderate)', () => {
    expect(similarity(original, 'Solar cold chain lockers for kilishi producers rented by the tray')).toBeGreaterThan(0.5);
  });
  it('is low for an unrelated pitch', () => {
    expect(similarity(original, 'A mobile app that teaches children to code with games')).toBeLessThan(0.1);
  });
});

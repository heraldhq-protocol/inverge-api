import { parseBoolean } from './boolean-query';

describe('parseBoolean', () => {
  it.each(['true', 'TRUE', ' true ', '1'])('parses %p as true', (value) => {
    expect(parseBoolean(value)).toBe(true);
  });

  it.each(['false', 'FALSE', ' false ', '0'])('parses %p as false', (value) => {
    expect(parseBoolean(value)).toBe(false);
  });

  it.each([undefined, null, ''])('treats %p as absent', (value) => {
    expect(parseBoolean(value)).toBeUndefined();
  });

  it('keeps real booleans', () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
  });

  it.each(['yes', 'no', 'maybe', '2'])(
    'returns %p unchanged so validation rejects it',
    (value) => {
      expect(parseBoolean(value)).toBe(value);
    },
  );
});

import { expect, it } from 'vitest';
import { breakdown } from './ChipStack';

it('breaks an amount into the fewest chips', () => {
  expect(breakdown(1606)).toEqual([
    { value: 1000, count: 1 },
    { value: 500, count: 1 },
    { value: 100, count: 1 },
    { value: 5, count: 1 },
    { value: 1, count: 1 },
  ]);
  expect(breakdown(85)).toEqual([
    { value: 25, count: 3 },
    { value: 5, count: 2 },
  ]);
  expect(breakdown(0)).toEqual([]);
});

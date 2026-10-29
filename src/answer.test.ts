import { expect, it } from 'vitest';
import { parseAnswer } from './answer';

it('reads percentages, probabilities and arithmetic', () => {
  expect(parseAnswer('35')).toBeCloseTo(0.35);
  expect(parseAnswer('35%')).toBeCloseTo(0.35);
  // A plain number is a percentage, however small.
  expect(parseAnswer('0.35')).toBeCloseTo(0.0035);
  expect(parseAnswer('1')).toBeCloseTo(0.01);
  expect(parseAnswer('0.8')).toBeCloseTo(0.008);
  expect(parseAnswer('35.')).toBeCloseTo(0.35);
  expect(parseAnswer('9/47')).toBeCloseTo(9 / 47);
  expect(parseAnswer('1 - 38/47 × 37/46')).toBeCloseTo(1 - (38 / 47) * (37 / 46));
  expect(parseAnswer('9x4')).toBeCloseTo(0.36);
  expect(parseAnswer('(2+3)*2%')).toBeCloseTo(0.1);
  expect(parseAnswer('abc')).toBeNull();
  expect(parseAnswer('150')).toBeNull();
});

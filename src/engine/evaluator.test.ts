import { describe as suite, expect, it } from 'vitest';
import { parseCards } from './cards';
import { categoryOf, describe, evaluate } from './evaluator';

const score = (s: string) => evaluate(parseCards(s));
const cat = (s: string) => categoryOf(score(s));

suite('evaluate', () => {
  it('ranks each category', () => {
    expect(cat('As Kd 7h 4c 2s 9d 3h')).toBe(0);
    expect(cat('As Ad 7h 4c 2s 9d Jh')).toBe(1);
    expect(cat('As Ad 7h 7c 2s 9d Jh')).toBe(2);
    expect(cat('As Ad Ah 7c 2s 9d Jh')).toBe(3);
    expect(cat('5s 6d 7h 8c 9s Kd Kh')).toBe(4);
    expect(cat('As 2d 3h 4c 5s Kd Kh')).toBe(4);
    expect(cat('As Ks 7s 4s 2s 9d Jh')).toBe(5);
    expect(cat('As Ad Ah 7c 7s 9d Jh')).toBe(6);
    expect(cat('As Ad Ah Ac 7s 9d Jh')).toBe(7);
    expect(cat('5s 6s 7s 8s 9s Kd Kh')).toBe(8);
  });

  it('breaks ties on kickers and straight height', () => {
    expect(score('As Ad Kh 7c 2s')).toBeGreaterThan(score('As Ad Qh 7c 2s'));
    expect(score('6s 2d 3h 4c 5s')).toBeGreaterThan(score('As 2d 3h 4c 5s'));
    expect(score('Ts Td Th 9c 9s 9d 2h')).toBe(score('Ts Td Th 9c 9s 2d 2h'));
  });

  it('describes hands', () => {
    expect(describe(score('As Ks Qs Js Ts 2d 3h'))).toBe('Royal flush');
    expect(describe(score('Ks Kd Kh 7c 7s'))).toBe('Full house, Kings full of Sevens');
  });
});

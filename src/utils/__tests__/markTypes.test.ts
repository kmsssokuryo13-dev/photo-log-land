import { describe, expect, it } from 'vitest';
import { addNewDefaults, DEFAULT_MARK_TYPES } from '../markTypes';

describe('addNewDefaults', () => {
  it('前の版の保存リストにマンホール中心を足す', () => {
    expect(addNewDefaults(['金属標', '独自杭'], null)).toEqual(['金属標', '独自杭', 'マンホール中心']);
  });
  it('配り済みの既定は、ユーザーが消していても戻さない', () => {
    expect(addNewDefaults(['金属標'], DEFAULT_MARK_TYPES)).toEqual(['金属標']);
  });
  it('既にあれば重複させない', () => {
    expect(addNewDefaults(['マンホール中心'], null)).toEqual(['マンホール中心']);
  });
});

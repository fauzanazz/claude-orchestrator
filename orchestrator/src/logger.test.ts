import { describe, test, expect } from 'bun:test';
import { errorMsg } from './logger.ts';

describe('errorMsg', () => {
  test('extracts message from Error instance', () => {
    expect(errorMsg(new Error('something broke'))).toBe('something broke');
  });

  test('converts string to string', () => {
    expect(errorMsg('plain string error')).toBe('plain string error');
  });

  test('converts number to string', () => {
    expect(errorMsg(42)).toBe('42');
  });

  test('converts null to string', () => {
    expect(errorMsg(null)).toBe('null');
  });

  test('converts undefined to string', () => {
    expect(errorMsg(undefined)).toBe('undefined');
  });

  test('converts object to string', () => {
    expect(errorMsg({ code: 'ENOENT' })).toBe('[object Object]');
  });

  test('handles Error subclasses', () => {
    expect(errorMsg(new TypeError('type mismatch'))).toBe('type mismatch');
    expect(errorMsg(new RangeError('out of range'))).toBe('out of range');
  });
});

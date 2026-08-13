import { describe, it, expect } from 'vitest';
import {
  shExp2RegExp,
  escapeSlash,
  safeRegExp,
  MAX_REGEXP_SOURCE_LENGTH,
  MAX_SHEXP_LENGTH,
} from '../src/shexp.js';

describe('ShexpUtils', () => {
  describe('#escapeSlash', () => {
    it('should escape all forward slashes', () => {
      const regex = escapeSlash('/test/');
      expect(regex).toBe('\\/test\\/');
    });
    it('should not escape slashes that are already escaped', () => {
      const regex = escapeSlash('\\/test\\/');
      expect(regex).toBe('\\/test\\/');
    });
    it('should know the difference between escaped and unescaped slashes', () => {
      const regex = escapeSlash('\\\\/\\/test\\/');
      expect(regex).toBe('\\\\\\/\\/test\\/');
    });
  });
  describe('#shExp2RegExp', () => {
    it('should escape regex meta chars and back slashes', () => {
      const regex = shExp2RegExp('this.is|a\\test+');
      expect(regex).toBe('^this\\.is\\|a\\\\test\\+$');
    });
    it('should linearize interior stars so they do not backtrack', () => {
      expect(shExp2RegExp('foo*bar')).toBe('^foo(?:(?!bar).)*bar$');
      expect(shExp2RegExp('*foo*bar*', { trimAsterisk: true })).toBe('foo(?:(?!bar).)*bar');
    });
    it('should keep trailing stars as .* so host-wildcard stripping still works', () => {
      expect(shExp2RegExp('foo*')).toBe('^foo.*$');
    });
    it('should reject over-long wildcard patterns', () => {
      expect(shExp2RegExp('a'.repeat(MAX_SHEXP_LENGTH + 1))).toBe('^(?!)');
      expect(shExp2RegExp('a'.repeat(MAX_SHEXP_LENGTH + 1), { trimAsterisk: true })).toBe('(?!)');
    });
  });
  describe('#safeRegExp', () => {
    it('should compile a valid pattern', () => {
      const re = safeRegExp('example\\.com');
      expect(re.test('www.example.com')).toBe(true);
      expect(re.test('www.example.net')).toBe(false);
    });
    it('should fallback to never-match if the pattern is invalid', () => {
      expect(safeRegExp(')Invalid(').source).toBe('(?!)');
      expect(safeRegExp(')Invalid(').test('anything')).toBe(false);
    });
    it('should reject over-long patterns', () => {
      const re = safeRegExp('a'.repeat(MAX_REGEXP_SOURCE_LENGTH + 1));
      expect(re.source).toBe('(?!)');
      expect(re.test('a')).toBe(false);
    });
    it('should reject nested unbounded quantifiers', () => {
      expect(safeRegExp('^(a+)+$').source).toBe('(?!)');
      expect(safeRegExp('(a*)*').source).toBe('(?!)');
      expect(safeRegExp('(.+)+').source).toBe('(?!)');
      expect(safeRegExp('((a)+)+').source).toBe('(?!)');
    });
    it('should reject quantified overlapping or empty alternatives', () => {
      expect(safeRegExp('(a|ab)+').source).toBe('(?!)');
      expect(safeRegExp('(a|)*').source).toBe('(?!)');
    });
    it('should still compile bounded groups and non-overlapping alts', () => {
      expect(safeRegExp('(abc)+').test('abcabc')).toBe(true);
      expect(safeRegExp('(a|b)+').test('abab')).toBe(true);
      expect(safeRegExp('(a+)')).not.toHaveProperty('source', '(?!)');
    });
    it('should not hang on a classic nested-quantifier ReDoS pattern', () => {
      const started = Date.now();
      expect(safeRegExp('^(a+)+$').test('a'.repeat(31) + 'x')).toBe(false);
      expect(Date.now() - started).toBeLessThan(100);
    });
    it('should not hang on a multi-star wildcard translation', () => {
      const source = shExp2RegExp('*a*a*a*a*a*b', { trimAsterisk: true });
      const started = Date.now();
      expect(safeRegExp(source).test('a'.repeat(40))).toBe(false);
      expect(Date.now() - started).toBeLessThan(100);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { shExp2RegExp, escapeSlash } from '../src/shexp.js';

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
  });
});

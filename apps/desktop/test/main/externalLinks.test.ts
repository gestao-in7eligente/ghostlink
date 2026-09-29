import { describe, expect, it, vi } from 'vitest';
import { linkDialog, openExternalWithConfirm, safeExternalUrl } from '../../src/main/externalLinks.js';

describe('safeExternalUrl (spec §12: only http/https leave the app)', () => {
  it.each([
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.COM/x', 'https://example.com/x'],
  ])('accepts %s', (raw, normalized) => {
    expect(safeExternalUrl(raw)).toBe(normalized);
  });

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'ghostlink://join?h=1.2.3.4',
    'data:text/html,<script>',
    'smb://server/share',
    'ms-settings:privacy',
    'https://bank.com@evil.example/',
    'https://user:pass@example.com/',
    'not a url',
    '',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('refuses %s', (raw) => {
    expect(safeExternalUrl(raw)).toBeNull();
  });
});

describe('openExternalWithConfirm', () => {
  const deps = (choice: number) => ({ locale: () => 'pt-BR' as const, confirm: vi.fn(async () => choice), open: vi.fn(async () => {}) });

  it('opens only after the user confirms, showing the normalized URL', async () => {
    const d = deps(0);
    expect(await openExternalWithConfirm('HTTPS://Example.com/x', d)).toBe(true);
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: 'https://example.com/x' }));
    expect(d.open).toHaveBeenCalledWith('https://example.com/x');
  });

  it('does nothing when cancelled or when the URL is unsafe', async () => {
    const cancelled = deps(1);
    expect(await openExternalWithConfirm('https://example.com', cancelled)).toBe(false);
    expect(cancelled.open).not.toHaveBeenCalled();
    const unsafe = deps(0);
    expect(await openExternalWithConfirm('file:///etc/passwd', unsafe)).toBe(false);
    expect(unsafe.confirm).not.toHaveBeenCalled();
  });

  it('speaks the app language', () => {
    expect(linkDialog('pt-BR', 'https://x/').buttons).toEqual(['Abrir link', 'Cancelar']);
    expect(linkDialog('en', 'https://x/').buttons).toEqual(['Open link', 'Cancel']);
  });
});

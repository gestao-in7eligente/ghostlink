import { describe, expect, it } from 'vitest';
import { normalizeSiteDomain, siteCreateSchema, siteUpdateSchema } from '../src/index.js';

describe('site addresses (spec 2026-10-03-aba-api-e-sites §2 "Endereço")', () => {
  it.each([
    ['es.profetacristao.com', 'es.profetacristao.com'],
    ['  https://Es.ProfetaCristao.com/ ', 'es.profetacristao.com'],
    ['http://loja.tcflag.com.br', 'loja.tcflag.com.br'],
    ['tcflag.com.br.', 'tcflag.com.br'],
    ['café.com', 'xn--caf-dma.com'],
    ['https://Café.COM/', 'xn--caf-dma.com'],
  ])('%j is the domain %s', (raw, domain) => {
    expect(normalizeSiteDomain(raw)).toBe(domain);
  });

  it.each([
    'es.profetacristao.com/blog', 'https://user:senha@site.com', 'site.com:8080', 'site.com?token=x', 'localhost',
    '127.0.0.1', 'site..com', '-site.com', 'site-.com', 'meu site.com', 'ftp://site.com', '', 'café.com/blog', 'café.com:80', 'user@café.com',
  ])('%j is not a bare domain', (raw) => {
    expect(normalizeSiteDomain(raw)).toBeNull();
  });

  it('the server takes only the bare form', () => {
    const id = 'A'.repeat(26);
    expect(siteCreateSchema.safeParse({ name: 'Profeta Cristão ES', domain: 'es.profetacristao.com', channelId: null }).success).toBe(true);
    expect(siteCreateSchema.safeParse({ name: 'Loja', domain: 'loja.tcflag.com.br', channelId: id }).success).toBe(true);
    expect(siteCreateSchema.safeParse({ name: 'X', domain: 'https://es.profetacristao.com', channelId: null }).success).toBe(false);
    expect(siteUpdateSchema.safeParse({ id }).success).toBe(false);
    expect(siteUpdateSchema.safeParse({ id, domain: 'Es.Site.com' }).success).toBe(false);
  });
});

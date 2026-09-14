/**
 * A política de conteúdo da tela (GAP-PRD-156) — o que ela fecha e o que ela
 * precisa deixar aberto para as telas de hoje funcionarem.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injetarPoliticaNoHtml, origensDaApi, politicaDeConteudoDaTela } from '../politicaDeConteudo';

function diretiva(politica: string, nome: string): string[] {
  const achada = politica.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${nome} `));
  return achada ? achada.split(/\s+/).slice(1) : [];
}

describe('o que a política fecha', () => {
  const politica = politicaDeConteudoDaTela('https://api.gruposampaio.com.br');

  it('só o JavaScript do próprio pacote executa: nada inline, nada de eval, nada de fora', () => {
    expect(diretiva(politica, 'script-src')).toEqual(["'self'"]);
    expect(politica).not.toContain("'unsafe-eval'");
  });

  it('fetch só fala com a própria origem e com a API — um script que escapasse não teria para onde mandar o token', () => {
    expect(diretiva(politica, 'connect-src')).toEqual(["'self'", 'https://api.gruposampaio.com.br']);
  });

  it('plugin, <base> e formulário para fora ficam fechados', () => {
    expect(diretiva(politica, 'object-src')).toEqual(["'none'"]);
    expect(diretiva(politica, 'base-uri')).toEqual(["'self'"]);
    expect(diretiva(politica, 'form-action')).toEqual(["'self'"]);
  });
});

describe('o que ela precisa deixar aberto', () => {
  const politica = politicaDeConteudoDaTela('https://api.gruposampaio.com.br/');

  it('estilo inline — as janelas de impressão herdam a política e são feitas de <style>', () => {
    expect(diretiva(politica, 'style-src')).toContain("'unsafe-inline'");
  });

  it('foto de /uploads da API, QR em data: e prévia em blob:', () => {
    const img = diretiva(politica, 'img-src');
    expect(img).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:', 'https://api.gruposampaio.com.br']));
  });
});

describe('a origem da API', () => {
  it('com VITE_API_BASE_URL: exatamente aquela origem (o caminho não entra)', () => {
    expect(origensDaApi('https://loja.com.br/erp')).toEqual(['https://loja.com.br']);
    expect(origensDaApi('http://192.168.0.10:8787')).toEqual(['http://192.168.0.10:8787']);
  });

  it('sem a variável: a porta padrão de qualquer host — o balcão abre pelo IP da LAN, que o build não conhece', () => {
    expect(origensDaApi(undefined)).toEqual(['http://*:8787', 'https://*:8787']);
    expect(diretiva(politicaDeConteudoDaTela(''), 'connect-src')).toEqual(["'self'", 'http://*:8787', 'https://*:8787']);
  });

  it('API relativa (mesma origem, atrás do mesmo proxy): só self', () => {
    expect(origensDaApi('/api')).toEqual([]);
    expect(diretiva(politicaDeConteudoDaTela('/api'), 'connect-src')).toEqual(["'self'"]);
  });
});

describe('a <meta> no index.html', () => {
  const html = readFileSync(resolve(__dirname, '../../../../index.html'), 'utf8');
  const politica = politicaDeConteudoDaTela('https://api.gruposampaio.com.br');
  const saida = injetarPoliticaNoHtml(html, politica);

  it('entra uma vez, depois do charset e ANTES de qualquer <link> ou <script> — a meta só vale para o que vem depois', () => {
    const posMeta = saida.indexOf('http-equiv="Content-Security-Policy"');
    expect(posMeta).toBeGreaterThan(saida.indexOf('<meta charset'));
    expect(posMeta).toBeLessThan(saida.indexOf('<link'));
    expect(posMeta).toBeLessThan(saida.indexOf('<script'));
    expect(saida.split('Content-Security-Policy').length - 1).toBe(1);
  });

  it('o conteúdo vai inteiro e escapado', () => {
    expect(saida).toContain(`content="${politica}"`);
  });
});

/**
 * ============================================================================
 * `NODE_ENV=production` TAMBÉM É PRODUÇÃO — para as variáveis aposentadas do
 * acesso sem senha
 * ============================================================================
 *
 * O atalho que entrava sem senha saiu do sistema. As três variáveis que um dia
 * ligaram um caminho assim — `DEVORA_DEV_QUICK_LOGIN` (a do atalho de
 * desenvolvimento), `VITE_DEV_QUICK_LOGIN` (a flag de build da tela) e
 * `GRUPO_SAMPAIO_QUICK_LOGIN` (o acesso por card, removido antes) — ficaram
 * aposentadas: nada as lê para ligar coisa alguma.
 *
 * Ligadas num processo de produção, o servidor RECUSA SUBIR. E produção é
 * produção por qualquer um dos dois nomes: `DEVORA_API_ENV` tem padrão
 * `development`, e `NODE_ENV` é a variável que hospedagem, container e
 * gerenciador de processo definem SOZINHOS. Quem sobe
 *
 *     NODE_ENV=production node dist/index.js
 *
 * sem declarar `DEVORA_API_ENV` e com a linha antiga no `.env` não pode subir
 * em silêncio.
 *
 * O caminho contrário não vale: `NODE_ENV=production` NÃO transforma o resto
 * do sistema em produção. Decide só esta trava, e para o lado seguro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadEnv, resetEnvCacheForTests } = await import('../src/config/env.js');

const VARIAVEIS = ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN'] as const;
const ORIGINAL = { ...process.env };

function ambiente(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  // Segredos fortes, para a recusa medida ser a da variável e não a deles.
  process.env.DEVORA_JWT_SECRET = 'jwt-secreto-longo-o-bastante-para-producao';
  process.env.DEVORA_ENCRYPTION_KEY = 'chave-de-cifra-longa-o-bastante-para-producao';
  for (const nome of VARIAVEIS) delete process.env[nome];
  resetEnvCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

// ============================================================================

describe('as variáveis do acesso sem senha não sobrevivem a produção, por qualquer nome dela', () => {
  for (const variavel of VARIAVEIS) {
    it(`NODE_ENV=production com ${variavel}=true RECUSA subir — e diz qual variável tirar`, () => {
      ambiente({ NODE_ENV: 'production', DEVORA_API_ENV: undefined, [variavel]: 'true' });
      let erro: Error | null = null;
      try {
        loadEnv();
      } catch (e) {
        erro = e as Error;
      }
      expect(erro?.message).toContain(variavel);
      expect(erro?.message).toMatch(/NODE_ENV=production/);
    });

    it(`DEVORA_API_ENV=production com ${variavel}=true recusa, sem NODE_ENV`, () => {
      ambiente({ NODE_ENV: undefined, DEVORA_API_ENV: 'production', [variavel]: 'true' });
      expect(() => loadEnv()).toThrow(new RegExp(variavel));
    });
  }

  it('os dois nomes juntos também recusam', () => {
    ambiente({ NODE_ENV: 'production', DEVORA_API_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
  });

  it('várias ligadas: a mensagem nomeia todas — ninguém volta para achar a segunda', () => {
    ambiente({ NODE_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'true', VITE_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).toThrow(/DEVORA_DEV_QUICK_LOGIN[\s\S]*VITE_DEV_QUICK_LOGIN/);
  });
});

// ============================================================================

describe('e não estraga o que já funcionava', () => {
  it('NODE_ENV=production sem nenhuma delas sobe normalmente', () => {
    ambiente({ NODE_ENV: 'production', DEVORA_API_ENV: undefined });
    expect(() => loadEnv()).not.toThrow();
  });

  it('desenvolvimento com a variável ligada sobe — e ela não chega a lugar nenhum', () => {
    ambiente({ NODE_ENV: 'development', DEVORA_API_ENV: 'development', DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).not.toThrow();
    expect((loadEnv() as unknown as Record<string, unknown>).DEVORA_DEV_QUICK_LOGIN).toBeUndefined();
  });

  it('a suíte (test) com a variável ligada sobe', () => {
    ambiente({ NODE_ENV: 'test', DEVORA_API_ENV: 'test', DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).not.toThrow();
  });

  it('NODE_ENV=production NÃO vira DEVORA_API_ENV=production', () => {
    /*
      A trava é estreita de propósito. `DEVORA_API_ENV` decide dezenas de
      outras coisas — quais integrações ligam, qual base fiscal responde, o
      que o log mostra —, e herdá-lo de `NODE_ENV` mudaria tudo isso sem
      ninguém ter pedido.
    */
    ambiente({ NODE_ENV: 'production', DEVORA_API_ENV: undefined });
    expect(loadEnv().DEVORA_API_ENV).toBe('development');
  });
});

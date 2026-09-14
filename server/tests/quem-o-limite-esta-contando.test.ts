/**
 * ATRÁS DO PROXY, TODO MUNDO VIRA A MESMA PESSOA.
 *
 * ============================================================================
 * O DEFEITO, E POR QUE ELE SÓ APARECE DEPOIS DE PUBLICADO
 * ============================================================================
 *
 * O limite de 300 requisições por minuto e o controle de força bruta do login
 * contam por `req.ip`. Servido direto, `req.ip` é o cliente e está certo.
 *
 * Atrás de um proxy reverso — que é como este ERP vai ser publicado — `req.ip`
 * é o IP DO PROXY. As seis operações, todos os caixas e todo visitante da
 * vitrine passam a dividir o MESMO balde de 300: um robô varrendo a loja
 * online derruba a venda do balcão com 429, e quem estiver no PDV vê "não foi
 * possível conectar" sem nenhuma explicação.
 *
 * ============================================================================
 * POR QUE NÃO SE LIGA E PRONTO
 * ============================================================================
 *
 * `trust proxy` conserta isso e abre outro buraco: o Express passa a acreditar
 * no `X-Forwarded-For`, que é a coisa mais barata de forjar. Quem mandar um IP
 * diferente a cada tentativa some do controle de força bruta — e o próprio
 * `routes/v1/auth.ts` já registra esse risco por escrito.
 *
 * Ligar por padrão trocaria um problema por outro. Por isso o valor é do dono:
 * só quem sabe a topologia da publicação pode decidir quantos saltos confiar.
 * Zero — o padrão — mantém o comportamento de hoje.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, describe, expect, it } from 'vitest';

const { resetEnvCacheForTests, loadEnv } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');

const original = process.env.DEVORA_TRUST_PROXY;

afterEach(() => {
  if (original === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = original;
  resetEnvCacheForTests();
});

function comTrustProxy(valor: string | undefined) {
  if (valor === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = valor;
  resetEnvCacheForTests();
  return createApp();
}

// ============================================================================

describe('o padrão não confia em ninguém', () => {
  it('sem configuração, o Express ignora o X-Forwarded-For', () => {
    const app = comTrustProxy(undefined);
    // `false` é o padrão do Express, e é o que mantém `req.ip` sendo o socket.
    expect(app.get('trust proxy')).toBe(false);
  });

  it('e zero explícito também não confia', () => {
    expect(comTrustProxy('0').get('trust proxy')).toBe(false);
  });
});

// ============================================================================

describe('publicado atrás de um proxy, o dono declara quantos saltos', () => {
  it('um salto confiável é o caso normal de um proxy reverso', () => {
    expect(comTrustProxy('1').get('trust proxy')).toBe(1);
  });

  it('dois, para quem tem CDN na frente do proxy', () => {
    expect(comTrustProxy('2').get('trust proxy')).toBe(2);
  });

  it('o valor é um número, e o ambiente o valida', () => {
    process.env.DEVORA_TRUST_PROXY = '1';
    resetEnvCacheForTests();
    expect(loadEnv().DEVORA_TRUST_PROXY).toBe(1);
  });

  it('valor absurdo é recusado na subida, e não engolido', () => {
    /*
      Um número solto aqui decide em quem o servidor acredita. Recusar na
      partida é o que impede a instalação de subir confiando em vinte saltos
      porque alguém digitou o CEP no lugar errado.
    */
    process.env.DEVORA_TRUST_PROXY = '99';
    resetEnvCacheForTests();
    expect(() => loadEnv()).toThrow();
  });
});

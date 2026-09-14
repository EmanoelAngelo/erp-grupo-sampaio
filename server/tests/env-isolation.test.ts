/**
 * Isolamento do cache de configuração.
 *
 * `loadEnv()` guarda o resultado em memória — o que é correto em produção, mas
 * significa que um teste pode ler o valor que OUTRO teste populou. Um gate que
 * depende da ordem dos arquivos não é gate: passa ou falha conforme o worker
 * que calhou de executá-lo.
 *
 * Estes testes provam o contrário: depois do reset, nada do valor anterior
 * sobrevive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCacheForTests } from '../src/config/env.js';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
});

afterEach(() => {
  // Restaura o ambiente para não contaminar os arquivos seguintes — é
  // exatamente o vazamento que este arquivo existe para impedir.
  for (const chave of Object.keys(process.env)) {
    if (!(chave in ORIGINAL)) delete process.env[chave];
  }
  Object.assign(process.env, ORIGINAL);
  resetEnvCacheForTests();
});

describe('cache de env não vaza entre leituras', () => {
  it('TESTE A: com a flag ligada, lê ligada', () => {
    process.env.NFE_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    expect(loadEnv().nfeProductionEnabled).toBe(true);
  });

  it('TESTE B: com a flag desligada, lê desligada — sem resquício do A', () => {
    process.env.NFE_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();
    expect(loadEnv().nfeProductionEnabled).toBe(false);
  });

  it('sem o reset, o valor antigo PERSISTE — é este o risco', () => {
    process.env.NFE_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    expect(loadEnv().nfeProductionEnabled).toBe(true);

    // Muda a variável mas NÃO reseta: o cache continua valendo.
    process.env.NFE_PRODUCTION_ENABLED = 'false';
    expect(loadEnv().nfeProductionEnabled).toBe(true);

    // Com o reset, acompanha.
    resetEnvCacheForTests();
    expect(loadEnv().nfeProductionEnabled).toBe(false);
  });

  it('vale para todas as flags de produção, não só a da NF-e', () => {
    const flags: [string, keyof ReturnType<typeof loadEnv>][] = [
      ['NFCE_PRODUCTION_ENABLED', 'nfceProductionEnabled'],
      ['LOGISTICS_PRODUCTION_ENABLED', 'logisticsProductionEnabled'],
      ['ASAAS_PRODUCTION_ENABLED', 'asaasProductionEnabled'],
      ['PAYMENT_TERMINAL_PRODUCTION_ENABLED', 'paymentTerminalProductionEnabled'],
      ['ECOMMERCE_PRODUCTION_ENABLED', 'ecommerceProductionEnabled'],
    ];

    for (const [variavel, campo] of flags) {
      process.env[variavel] = 'true';
      resetEnvCacheForTests();
      expect(loadEnv()[campo], `${variavel} ligada`).toBe(true);

      process.env[variavel] = 'false';
      resetEnvCacheForTests();
      expect(loadEnv()[campo], `${variavel} desligada`).toBe(false);
    }
  });

  it('ausente equivale a desligada — produção nunca liga por omissão', () => {
    delete process.env.NFE_PRODUCTION_ENABLED;
    delete process.env.NFCE_PRODUCTION_ENABLED;
    resetEnvCacheForTests();

    const env = loadEnv();
    expect(env.nfeProductionEnabled).toBe(false);
    expect(env.nfceProductionEnabled).toBe(false);
  });
});

/**
 * O ENDEREÇO PÚBLICO DA PLAQUINHA ENTROU NO SCHEMA — e por que ele valida.
 *
 * `GRUPO_SAMPAIO_PUBLIC_URL` era lida por `PrintRenderer.publicBaseUrl()` e não
 * existia em arquivo de ambiente nenhum: quem instala o sistema lê o
 * `.env.example`, e o que não está lá ninguém preenche.
 *
 * A validação não é capricho de formato. O leitor faz `.replace(/\/+$/, '')` e
 * concatena "/equipamento/TOKEN". Um valor sem esquema vira
 * "loja.com.br/equipamento/xxx", que o celular abre como caminho relativo e não
 * chega a lugar nenhum — e a plaquinha já está COLADA no equipamento quando
 * alguém descobre. Falhar na subida é a única hora em que o erro ainda é
 * barato.
 */
describe('endereço público do QR', () => {
  it('vazio é válido: cai no endereço de reserva e a tela avisa', () => {
    delete process.env.GRUPO_SAMPAIO_PUBLIC_URL;
    resetEnvCacheForTests();
    expect(loadEnv().GRUPO_SAMPAIO_PUBLIC_URL).toBe('');
  });

  it('endereço com esquema passa', () => {
    process.env.GRUPO_SAMPAIO_PUBLIC_URL = 'https://grupossampaio.com.br';
    resetEnvCacheForTests();
    expect(loadEnv().GRUPO_SAMPAIO_PUBLIC_URL).toBe('https://grupossampaio.com.br');
  });

  it('http do servidor da loja também passa — nem toda loja tem TLS', () => {
    process.env.GRUPO_SAMPAIO_PUBLIC_URL = 'http://sampaio.local:3000';
    resetEnvCacheForTests();
    expect(loadEnv().GRUPO_SAMPAIO_PUBLIC_URL).toBe('http://sampaio.local:3000');
  });

  it('sem esquema, o servidor NÃO sobe', () => {
    process.env.GRUPO_SAMPAIO_PUBLIC_URL = 'grupossampaio.com.br';
    resetEnvCacheForTests();
    expect(() => loadEnv()).toThrowError(/http/i);
  });
});

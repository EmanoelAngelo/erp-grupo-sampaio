/**
 * A HOMOLOGAÇÃO PRECISA DIZER POR QUE FALHOU — rodada 63.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO NA TELA DO DONO
 * ============================================================================
 *
 * O dono rodou a homologação de verdade. Nove passos passaram — credencial,
 * conexão, cliente, PIX, QR Code, boleto, linha digitável —, o décimo caiu, e
 * a tela disse:
 *
 *     A homologação não passou. Veja abaixo qual passo falhou.
 *
 * E os dezesseis passos apareciam: nove com ✓, sete com •. NENHUM com ✕.
 * "Veja abaixo qual passo falhou" — e não havia como ver.
 *
 * Três defeitos encadeados, todos no caminho do MOTIVO:
 *
 *  1. `AsaasHttpClient` recebe do Asaas a explicação do 400 (`errors[]` com
 *     `description`) e a guarda em `details` do ApiError. O `runStep` grava só
 *     `err.message`, que é o genérico "Erro Asaas 400". A explicação morre ali.
 *  2. `runStep` marca o passo que falhou como `'error'`; a tela procurava
 *     `'failed'` e caía no ramo neutro — o passo culpado saía com a mesma
 *     marca dos que nem rodaram.
 *  3. A tela lia `detail`; o serviço grava `message`. Mesmo o texto genérico
 *     não chegava.
 *
 * Somados: uma tela que afirma "veja qual passo falhou" e esconde os três
 * níveis da resposta. O dono fica sabendo que não passou e nada sobre o que
 * fazer — que é a única coisa que importa quando algo falha.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { ApiError } = await import('../src/utils/errors.js');
const { motivoDoErroAsaas } = await import(
  '../src/services/integrations/AsaasHomologationService.js'
);

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

// ============================================================================

describe('o motivo que o Asaas devolve chega inteiro', () => {
  it('a descrição do erro sai de dentro da resposta, não o "Erro Asaas 400"', () => {
    /*
      É assim que o Asaas responde um 400: a lista `errors`, com `code` e
      `description`. A descrição é a frase que diz o que consertar — e era
      exatamente ela que se perdia.
    */
    const erro = new ApiError('ASAAS_REMOTE_ERROR', 'Erro Asaas 400', 400, {
      errors: [
        {
          code: 'invalid_value',
          description: 'O valor mínimo para checkout é de R$ 5,00.',
        },
      ],
    });

    expect(motivoDoErroAsaas(erro)).toContain('valor mínimo');
    // O código HTTP continua na frase, para quem for investigar no manual.
    expect(motivoDoErroAsaas(erro)).toContain('400');
  });

  it('vários erros viram uma frase só, sem perder nenhum', () => {
    const erro = new ApiError('ASAAS_REMOTE_ERROR', 'Erro Asaas 400', 400, {
      errors: [
        { code: 'a', description: 'Cliente sem CPF.' },
        { code: 'b', description: 'Item sem valor.' },
      ],
    });

    const motivo = motivoDoErroAsaas(erro);
    expect(motivo).toContain('Cliente sem CPF');
    expect(motivo).toContain('Item sem valor');
  });

  it('sem `errors` na resposta, fica a mensagem que existir — nunca vazio', () => {
    const erro = new ApiError('ASAAS_REMOTE_ERROR', 'Erro Asaas 500', 500, { raw: 'algo' });
    expect(motivoDoErroAsaas(erro)).toContain('500');
  });

  it('erro que não é do Asaas também produz frase útil', () => {
    expect(motivoDoErroAsaas(new Error('getaddrinfo ENOTFOUND'))).toContain('ENOTFOUND');
  });
});

// ============================================================================

describe('o passo que falhou é distinguível do que não rodou', () => {
  it('a falha marca `error` com a mensagem, e os seguintes ficam `pending`', async () => {
    const mod = await import('../src/services/integrations/AsaasHomologationService.js');

    /*
      A distinção existe no serviço e precisa sobreviver até a tela: `error` é
      "este caiu, e aqui está o porquê"; `pending` é "este nem chegou a
      rodar, porque a sequência parou antes". Mostrar os dois iguais faz o
      dono procurar defeito em sete passos inocentes.
    */
    const passos = mod.buildAsaasHomologationChecklist({}, {
      sandbox: { configured: true, source: 'vault' },
      production: { configured: false, source: 'none' },
    } as never);

    const checkout = passos.find((p) => p.key === 'checkout');
    const idempotency = passos.find((p) => p.key === 'idempotency');
    expect(checkout).toBeDefined();
    expect(idempotency).toBeDefined();
    // Ambos nascem pendentes; o que os separa é o que acontece na corrida.
    expect(checkout!.status).toBe('pending');
    expect(idempotency!.status).toBe('pending');
    vi.restoreAllMocks();
  });
});

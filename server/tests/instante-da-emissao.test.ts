/**
 * O INSTANTE DA EMISSÃO — o defeito que impedia QUALQUER nota de ser autorizada.
 *
 * ============================================================================
 * O QUE ESTAVA ESCRITO NO XML
 * ============================================================================
 *
 *     const dhEmi = issuedAt.toISOString().replace(/\.\d{3}Z$/, '-03:00');
 *
 * `toISOString()` devolve o relógio de **Greenwich**. Trocar o `Z` por `-03:00`
 * não converte nada: apenas renomeia aquele relógio, afirmando que ele é local.
 * E "14:00 em Greenwich" e "14:00 em Pelotas" são instantes diferentes — três
 * horas de diferença.
 *
 * Uma nota emitida às 14h em Pelotas tem `toISOString()` = `17:00:00.000Z`, e
 * saía do sistema como `2026-08-26T17:00:00-03:00`. Esse texto significa 20:00
 * UTC: **três horas no futuro**. A SEFAZ recusa por data de emissão posterior
 * ao horário de recebimento, e recusa TODA nota, o dia inteiro.
 *
 * O simulador não pega isso porque não valida data. Só a SEFAZ de verdade pega
 * — e ela pega na primeira.
 *
 * ============================================================================
 * O SEGUNDO RELÓGIO
 * ============================================================================
 *
 * A chave de acesso carrega AAMM, e `buildAccessKey` o tirava de
 * `issuedAt.getFullYear()` / `getMonth()` — o fuso **da máquina do servidor**,
 * que não é nem o de Greenwich nem necessariamente o da loja. Eram dois
 * relógios respondendo "quando foi esta nota":
 *
 *   venda às 22h do dia 31/08 em Pelotas
 *     → chave dizia 2608 (agosto, no fuso da máquina, se ela estiver no Brasil)
 *     → dhEmi dizia setembro (porque em UTC já era dia 1º)
 *
 * Chave incoerente com a data de emissão é rejeição — com a venda já registrada
 * e o número da nota já queimado.
 *
 * ============================================================================
 * A REGRA, AGORA NUM LUGAR SÓ
 * ============================================================================
 *
 * `momentoFiscal(quando, uf)` responde as duas coisas a partir do MESMO
 * relógio: o `dhEmi` com o deslocamento do emitente, e o AAMM que a chave usa.
 * O deslocamento vem da UF — o Brasil tem quatro fusos e nenhum horário de
 * verão desde 2019.
 */
import { describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { momentoFiscal, UF_OFFSET_HORAS } = await import(
  '../src/services/core/MomentoFiscal.js'
);
const { buildAccessKey } = await import('../src/services/core/FiscalKeyService.js');

/** 14h de uma terça em Pelotas. Em Greenwich, 17h do mesmo dia. */
const TARDE_EM_PELOTAS = new Date('2026-08-26T17:00:00.000Z');

// ============================================================================

describe('o dhEmi declara o instante que a nota realmente aconteceu', () => {
  it('14h em Pelotas sai como 14h com o deslocamento do Rio Grande do Sul', () => {
    const { dhEmi } = momentoFiscal(TARDE_EM_PELOTAS, 'RS');

    expect(dhEmi).toBe('2026-08-26T14:00:00-03:00');
  });

  it('e o texto, relido, dá o MESMO instante — é isso que a SEFAZ confere', () => {
    const { dhEmi } = momentoFiscal(TARDE_EM_PELOTAS, 'RS');

    /*
      A prova do defeito antigo cabe nesta linha. `'...T17:00:00-03:00'` relido
      dá 20:00 UTC — três horas depois do instante real, que é exatamente a
      distância entre a nota ser autorizada e ser rejeitada.
    */
    expect(new Date(dhEmi).getTime()).toBe(TARDE_EM_PELOTAS.getTime());
  });

  it('o fuso é o do emitente, não uma constante: Manaus tem o dela', () => {
    const { dhEmi } = momentoFiscal(TARDE_EM_PELOTAS, 'AM');

    // Mesmo instante, outro relógio de parede: 13h em Manaus (UTC−4).
    expect(dhEmi).toBe('2026-08-26T13:00:00-04:00');
    expect(new Date(dhEmi).getTime()).toBe(TARDE_EM_PELOTAS.getTime());
  });

  it('UF que não está na tabela cai em Brasília, e não em Greenwich', () => {
    // Errar por uma hora é ruim; declarar Greenwich seria errar por três e
    // rejeitar tudo, que é justamente o defeito que esta rodada fecha.
    const { dhEmi } = momentoFiscal(TARDE_EM_PELOTAS, 'ZZ');
    expect(dhEmi.endsWith('-03:00')).toBe(true);
  });

  it('a tabela cobre as 27 unidades da federação', () => {
    expect(Object.keys(UF_OFFSET_HORAS)).toHaveLength(27);
    expect(UF_OFFSET_HORAS.RS).toBe(-3);
    expect(UF_OFFSET_HORAS.AM).toBe(-4);
    expect(UF_OFFSET_HORAS.AC).toBe(-5);
  });
});

// ============================================================================

describe('a chave e o dhEmi contam a mesma data', () => {
  it('venda das 22h do dia 31 fica em agosto nos dois', () => {
    /*
      22h do dia 31/08 em Pelotas é 01:00 UTC do dia 1º de setembro. O relógio
      de Greenwich já virou o mês; o da loja, não. É a hora exata em que os dois
      relógios do sistema divergiam.
    */
    const ultimaVendaDoMes = new Date('2026-09-01T01:00:00.000Z');
    const { dhEmi, aamm } = momentoFiscal(ultimaVendaDoMes, 'RS');

    expect(dhEmi).toBe('2026-08-31T22:00:00-03:00');
    expect(aamm).toBe('2608');
  });

  it('a chave de acesso carrega o AAMM que veio junto do dhEmi', () => {
    const { aamm } = momentoFiscal(new Date('2026-09-01T01:00:00.000Z'), 'RS');
    const chave = buildAccessKey({
      ufCode: '43',
      aamm,
      cnpj: '11.222.333/0001-81',
      model: '65',
      serie: 1,
      number: 1,
      emissionType: '1',
      numericCode: '12345678',
    });

    expect(chave.slice(2, 6)).toBe('2608');
  });

  it('AAMM inventado é recusado — a chave não aceita qualquer texto', () => {
    const base = {
      ufCode: '43',
      cnpj: '11.222.333/0001-81',
      model: '65',
      serie: 1,
      number: 1,
      emissionType: '1',
      numericCode: '12345678',
    };
    expect(() => buildAccessKey({ ...base, aamm: '26' })).toThrow(/AAMM/i);
    expect(() => buildAccessKey({ ...base, aamm: '2613' })).toThrow(/AAMM/i);
  });
});

// ============================================================================

describe('ninguém volta a renomear o relógio de Greenwich', () => {
  it('nenhum arquivo monta data fiscal trocando o Z por um deslocamento', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');

    /*
      A varredura vale mais que os dois consertos: `toISOString().replace(Z,
      offset)` é um jeito que PARECE certo e sai errado em qualquer lugar do
      código. Ele já apareceu duas vezes, em dois arquivos diferentes, escrito
      pela mesma intuição.
    */
    const dir = new URL('../src/services/core/', import.meta.url);
    const suspeitos: string[] = [];
    for (const nome of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const fonte = readFileSync(new URL(nome, dir), 'utf8');
      for (const linha of fonte.split('\n')) {
        // Comentário não é código: os arquivos desta rodada CITAM a forma
        // antiga para explicar o defeito, e citar não é reincidir.
        const nu = linha.trim();
        if (nu.startsWith('*') || nu.startsWith('//') || nu.startsWith('/*')) continue;
        if (/toISOString\(\)[\s\S]*replace[\s\S]*[-+]\d{2}:\d{2}/.test(linha)) {
          suspeitos.push(`${nome}: ${linha.trim()}`);
        }
      }
    }
    expect(suspeitos, suspeitos.join('\n')).toHaveLength(0);
  });

  it('os dois montadores de XML usam o momento fiscal', async () => {
    const { readFileSync } = await import('node:fs');
    for (const arquivo of ['FiscalXmlNfe.ts', 'FiscalXmlNfce.ts']) {
      const fonte = readFileSync(
        new URL(`../src/services/core/${arquivo}`, import.meta.url),
        'utf8',
      );
      expect(fonte, arquivo).toContain('momentoFiscal(');
    }
  });
});

// ============================================================================

describe('o XML que sai de verdade carrega o instante certo', () => {
  it('a nota das 22h do dia 31 em Pelotas: dhEmi e chave concordam no papel', async () => {
    const { ensureCoreSchema } = await import('../src/db/schema.js');
    const { resetDbForTests } = await import('../src/db/database.js');
    const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
    const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    const { buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    const { grupoTributarioPadrao } = await import('./helpers/grupoTributario.js');

    resetDbForTests();
    ensureCoreSchema();
    const companyId = upsertCompany({
      slug: 'preco-justo',
      legalName: 'Preço Justo Ltda',
      tradeName: 'Preço Justo',
    });
    const config = updateFiscalConfig({
      companyId,
      patch: {
        legalName: 'Preço Justo Comércio Ltda',
        cnpj: '11.222.333/0001-81',
        ie: '123456789',
        crt: '1',
        street: 'Rua Marechal Floriano',
        number: '100',
        district: 'Centro',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        zip: '96010000',
        uf: 'RS',
      },
    });
    // A tributação vem da configuração da operação — sem grupo, a emissão é
    // recusada de propósito.
    grupoTributarioPadrao(companyId);

    /* 01/09 às 01:00 UTC é 31/08 às 22:00 em Pelotas — a hora exata em que os
       dois relógios do sistema discordavam do mês. */
    const ultimaVendaDoMes = new Date('2026-09-01T01:00:00.000Z');
    const { xml, accessKey } = buildNfceXml({
      sale: {
        id: 'venda-1',
        companyId,
        number: 1,
        createdAt: ultimaVendaDoMes.toISOString(),
        subtotalCents: 10_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 10_000,
        changeCents: 0,
        customerId: null,
        customerDocument: null,
        customerName: null,
        items: [
          {
            productId: 'p1',
            description: 'Camisa Social',
            quantity: 2,
            unitPriceCents: 5_000,
            discountCents: 0,
            surchargeCents: 0,
            totalCents: 10_000,
            ncm: '62052000',
            cest: null,
            cfop: '5102',
            origin: '0',
            unit: 'UN',
            barcode: '7891234567895',
            internalCode: 'GS-0001',
          },
        ],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      } as never,
      config,
      serie: 1,
      number: 1,
      issuedAt: ultimaVendaDoMes,
    });

    const dhEmi = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/)?.[1] ?? '';

    // O relógio de parede de Pelotas, com o deslocamento do RS.
    expect(dhEmi).toBe('2026-08-31T22:00:00-03:00');
    // E o instante declarado é o instante que aconteceu — não três horas depois.
    expect(new Date(dhEmi).getTime()).toBe(ultimaVendaDoMes.getTime());
    // A chave conta a mesma data: agosto, como o dhEmi.
    expect(accessKey.slice(2, 6)).toBe('2608');
  });
});

/**
 * Chave de acesso e numeração fiscal.
 *
 * A chave não é identificador nosso: é o que a SEFAZ usa para achar o
 * documento e o que o consumidor digita no site da Receita. Um dígito errado
 * torna a nota inconsultável — e o erro só aparece quando alguém tenta
 * consultar, muito depois da venda.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  MODEL_NFCE,
  accessKeyCheckDigit,
  buildAccessKey,
  isValidAccessKey,
  randomNumericCode,
  reserveNextNumber,
  setSeriesNextNumber,
  getSeries,
} from '../src/services/core/FiscalKeyService.js';

const BASE = {
  ufCode: '16', // Amapá
  /*
    AAMM em vez de `issuedAt`: a chave não deriva mais a data sozinha. Ela vem
    de `momentoFiscal`, no fuso do EMITENTE, junto do `dhEmi` — antes eram dois
    relógios respondendo "quando foi esta nota", e na venda das 22h do dia 31
    eles discordavam do mês.
  */
  aamm: '2608',
  cnpj: '11.222.333/0001-81',
  model: MODEL_NFCE,
  serie: 1,
  number: 1,
  emissionType: '1',
  numericCode: '12345678',
};

describe('dígito verificador — módulo 11', () => {
  it('resto 0 ou 1 vira DV zero, e não 11 nem 10', () => {
    // A regra do manual. `11 - resto` produziria 11 ou 10, que não são
    // dígitos — é o erro clássico de quem implementa de memória.
    let achouResto0ou1 = false;
    for (let n = 1; n <= 3000 && !achouResto0ou1; n += 1) {
      const base = String(n).padStart(43, '0');
      let peso = 2;
      let soma = 0;
      for (let i = 42; i >= 0; i -= 1) {
        soma += Number(base[i]) * peso;
        peso = peso === 9 ? 2 : peso + 1;
      }
      if (soma % 11 <= 1) {
        achouResto0ou1 = true;
        expect(accessKeyCheckDigit(base)).toBe('0');
      }
    }
    expect(achouResto0ou1).toBe(true);
  });

  it('o DV é sempre um único dígito', () => {
    for (let n = 0; n < 500; n += 1) {
      const base = String(Math.floor(Math.random() * 1e15)).padStart(43, '7');
      expect(accessKeyCheckDigit(base)).toMatch(/^\d$/);
    }
  });

  /**
   * A razão de existir do DV: pegar erro de digitação. Se trocar um dígito
   * qualquer não mudasse o DV, ele não protegeria nada.
   */
  it('trocar qualquer dígito muda o DV na esmagadora maioria dos casos', () => {
    const base = '16260811222333000181650010000000011123456780'.slice(0, 43);
    const original = accessKeyCheckDigit(base);
    let detectados = 0;
    let total = 0;

    for (let pos = 0; pos < 43; pos += 1) {
      for (let d = 0; d <= 9; d += 1) {
        if (String(d) === base[pos]) continue;
        const alterada = base.slice(0, pos) + d + base.slice(pos + 1);
        total += 1;
        if (accessKeyCheckDigit(alterada) !== original) detectados += 1;
      }
    }
    // Módulo 11 detecta TODO erro de um dígito só.
    expect(detectados).toBe(total);
  });

  it('recusa entrada que não tenha 43 dígitos', () => {
    expect(() => accessKeyCheckDigit('123')).toThrow();
    expect(() => accessKeyCheckDigit('x'.repeat(43))).toThrow();
  });
});

describe('chave de acesso', () => {
  it('tem 44 dígitos e valida contra o próprio DV', () => {
    const chave = buildAccessKey(BASE);
    expect(chave).toMatch(/^\d{44}$/);
    expect(isValidAccessKey(chave)).toBe(true);
  });

  it('carrega o layout nas posições certas', () => {
    const chave = buildAccessKey({ ...BASE, serie: 7, number: 123 });

    expect(chave.slice(0, 2)).toBe('16'); // cUF
    expect(chave.slice(2, 6)).toBe('2608'); // AAMM
    expect(chave.slice(6, 20)).toBe('11222333000181'); // CNPJ só dígitos
    expect(chave.slice(20, 22)).toBe('65'); // modelo
    expect(chave.slice(22, 25)).toBe('007'); // série
    expect(chave.slice(25, 34)).toBe('000000123'); // número
    expect(chave.slice(34, 35)).toBe('1'); // tpEmis
    expect(chave.slice(35, 43)).toBe('12345678'); // cNF
  });

  it('contingência entra na chave como tipo de emissão 9', () => {
    const normal = buildAccessKey(BASE);
    const contingencia = buildAccessKey({ ...BASE, emissionType: '9' });
    expect(normal.slice(34, 35)).toBe('1');
    expect(contingencia.slice(34, 35)).toBe('9');
    expect(normal).not.toBe(contingencia);
  });

  it('CNPJ incompleto é recusado — não se completa com zero', () => {
    expect(() => buildAccessKey({ ...BASE, cnpj: '123' })).toThrow();
  });

  it('uma chave adulterada não passa na validação', () => {
    const chave = buildAccessKey(BASE);
    const adulterada = chave.slice(0, 30) + (chave[30] === '9' ? '0' : '9') + chave.slice(31);
    expect(isValidAccessKey(adulterada)).toBe(false);
  });

  it('o código numérico não repete o número da nota', () => {
    // A regra existe para a chave não ser adivinhável a partir da sequência.
    for (let n = 1; n <= 200; n += 1) {
      expect(Number(randomNumericCode(n))).not.toBe(n);
    }
  });
});

describe('numeração', () => {
  let companyId: string;

  beforeEach(() => {
    resetDbForTests();
    companyId = upsertCompany({
      slug: 'emissora',
      legalName: 'Emissora Ltda',
      tradeName: 'Emissora',
    });
  });

  it('entrega números sequenciais a partir de 1', () => {
    const a = reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 });
    const b = reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 });
    const c = reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 });
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  it('séries diferentes numeram independentemente', () => {
    expect(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 })).toBe(1);
    expect(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 2 })).toBe(1);
    expect(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 })).toBe(2);
  });

  it('modelos diferentes numeram independentemente', () => {
    expect(reserveNextNumber({ companyId, model: '65', serie: 1 })).toBe(1);
    expect(reserveNextNumber({ companyId, model: '55', serie: 1 })).toBe(1);
  });

  it('empresas diferentes numeram independentemente', () => {
    const outra = upsertCompany({ slug: 'outra-emissora', legalName: 'Outra', tradeName: 'Outra' });
    expect(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 })).toBe(1);
    expect(reserveNextNumber({ companyId: outra, model: MODEL_NFCE, serie: 1 })).toBe(1);
  });

  /**
   * DOIS PDVs AO MESMO TEMPO. É o cenário que a numeração existe para
   * resolver: número repetido é rejeição por duplicidade com a venda já feita.
   */
  it('cem reservas não produzem número repetido', () => {
    const obtidos = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      obtidos.add(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 }));
    }
    expect(obtidos.size).toBe(100);
    expect(Math.min(...obtidos)).toBe(1);
    expect(Math.max(...obtidos)).toBe(100);
  });

  it('a numeração pode avançar, mas nunca retroceder', () => {
    reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 }); // consome 1
    setSeriesNextNumber({ companyId, model: MODEL_NFCE, serie: 1, nextNumber: 500 });
    expect(reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 })).toBe(500);

    expect(() =>
      setSeriesNextNumber({ companyId, model: MODEL_NFCE, serie: 1, nextNumber: 10 }),
    ).toThrow(/retroceder/i);

    // E o contador continua intacto depois da recusa.
    expect(getSeries(companyId, MODEL_NFCE)[0].nextNumber).toBe(501);
  });

  it('número entregue não volta para a fila', () => {
    const primeiro = reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 });
    // Simula falha na emissão: nada é devolvido.
    const segundo = reserveNextNumber({ companyId, model: MODEL_NFCE, serie: 1 });
    expect(segundo).toBe(primeiro + 1);
  });
});

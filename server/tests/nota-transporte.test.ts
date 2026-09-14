/**
 * O transporte da nota, que o sistema jogava fora.
 *
 * A NF-e carrega um grupo <transp> inteiro — quem transportou, quem pagou o
 * frete, placa, quantos volumes e quanto pesava. O parser lia `ide`, `emit` e
 * `det` e descartava o resto.
 *
 * Quem confere na doca precisa saber quantos volumes esperar e quanto deveriam
 * pesar; quem cobra falta precisa saber para quem ligar. As duas respostas
 * estavam no arquivo o tempo todo.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { importNfe, parseNfeXml } = await import('../src/services/core/NfeImportService.js');

let empresa: string;
let sequencia = 0;

/** Chave de 44 dígitos, diferente a cada nota. */
function chave(): string {
  sequencia += 1;
  return `3526081420016600018755001000001${String(sequencia).padStart(4, '0')}1000010248`.slice(
    0,
    44,
  );
}

/**
 * NF-e com o bloco de transporte que o teste pedir.
 *
 * O grupo <transp> entra entre <total> e o fim de infNFe, que é onde ele mora
 * de verdade: irmão de <total>, e não filho de <det>.
 */
function nfeXml(transporte: string, k = chave()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${k}" versao="4.00">
      <ide><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Teste Ltda</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>FORN-001</cProd><cEAN>7891234567895</cEAN>
          <xProd>Filtro de oleo</xProd><NCM>84212300</NCM><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>10</qCom><vUnCom>25.00</vUnCom><vProd>250.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>250.00</vNF><vFrete>35.90</vFrete></ICMSTot></total>
      ${transporte}
    </infNFe>
  </NFe>
</nfeProc>`;
}

const TRANSPORTE_COMPLETO = `<transp>
        <modFrete>1</modFrete>
        <transporta>
          <CNPJ>05423963000111</CNPJ>
          <xNome>Rapido Sampaio Transportes</xNome>
          <IE>112233445</IE>
          <xMun>Macapa</xMun>
          <UF>AP</UF>
        </transporta>
        <veicTransp><placa>ABC1D23</placa><UF>AP</UF><RNTC>987654</RNTC></veicTransp>
        <vol><qVol>3</qVol><esp>CAIXA</esp><pesoL>12.500</pesoL><pesoB>13.250</pesoB></vol>
      </transp>`;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  sequencia = 0;
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
});

describe('o grupo <transp> é lido', () => {
  it('a nota completa entrega transportadora, veículo e volumes', () => {
    const t = parseNfeXml(nfeXml(TRANSPORTE_COMPLETO)).transport;

    expect(t.carrierName).toBe('Rapido Sampaio Transportes');
    expect(t.carrierDocument).toBe('05423963000111');
    expect(t.carrierStateRegistration).toBe('112233445');
    expect(t.carrierCity).toBe('Macapa');
    expect(t.carrierState).toBe('AP');
    expect(t.freightMode).toBe('1');
    expect(t.vehiclePlate).toBe('ABC1D23');
    expect(t.vehicleUf).toBe('AP');
    expect(t.volumesQty).toBe(3);
  });

  /**
   * O caso mais fácil de errar em silêncio: passar o peso pelo helper de
   * DINHEIRO. 12,500 kg viraria 1250 e ninguém nota até a balança discordar.
   */
  it('12,500 kg viram 12500 gramas, e não 1250', () => {
    const t = parseNfeXml(nfeXml(TRANSPORTE_COMPLETO)).transport;
    expect(t.netWeightGrams).toBe(12_500);
    expect(t.grossWeightGrams).toBe(13_250);
  });

  /** O frete nunca morou em <transp>: ele vem do total da nota. */
  it('o valor do frete sai de ICMSTot, em centavos', () => {
    expect(parseNfeXml(nfeXml(TRANSPORTE_COMPLETO)).freightCents).toBe(3_590);
  });

  /**
   * Retirada no balcão não declara transporte. Isso é normal — nota sem o
   * grupo tem de importar como sempre importou.
   */
  it('nota SEM o grupo não quebra e devolve tudo nulo', () => {
    const t = parseNfeXml(nfeXml('')).transport;
    expect(t.carrierName).toBeNull();
    expect(t.freightMode).toBeNull();
    expect(t.volumesQty).toBeNull();
    expect(t.grossWeightGrams).toBeNull();
  });

  /**
   * O transportador autônomo do interior vem com CPF, não CNPJ. Ler só CNPJ
   * perderia exatamente o caso mais comum fora da capital.
   */
  it('transportador autônomo é lido pelo CPF', () => {
    const t = parseNfeXml(
      nfeXml(`<transp><modFrete>0</modFrete>
        <transporta><CPF>12345678901</CPF><xNome>Jose da Silva</xNome></transporta>
      </transp>`),
    ).transport;

    expect(t.carrierDocument).toBe('12345678901');
    expect(t.carrierName).toBe('Jose da Silva');
  });

  /**
   * <vol> repete por espécie: um chega como objeto, dois como array. É o
   * clássico "funciona no teste com um volume e quebra na nota com três".
   */
  it('vários volumes são somados', () => {
    const t = parseNfeXml(
      nfeXml(`<transp><modFrete>1</modFrete>
        <vol><qVol>2</qVol><pesoB>10.000</pesoB><pesoL>9.000</pesoL></vol>
        <vol><qVol>5</qVol><pesoB>2.500</pesoB><pesoL>2.000</pesoL></vol>
      </transp>`),
    ).transport;

    expect(t.volumesQty).toBe(7);
    expect(t.grossWeightGrams).toBe(12_500);
    expect(t.netWeightGrams).toBe(11_000);
  });

  /**
   * O layout 4.00 tem {0,1,2,3,4,9}. 5, 6, 7 e 8 NÃO existem — guardar um "7"
   * só empurraria para a tela um valor que a SEFAZ recusa.
   */
  it('modalidade de frete fora do domínio é descartada', () => {
    for (const invalido of ['5', '6', '7', '8', 'X']) {
      const t = parseNfeXml(
        nfeXml(`<transp><modFrete>${invalido}</modFrete></transp>`),
      ).transport;
      expect(t.freightMode).toBeNull();
    }
  });

  it('as seis modalidades reais passam', () => {
    for (const valido of ['0', '1', '2', '3', '4', '9']) {
      const t = parseNfeXml(
        nfeXml(`<transp><modFrete>${valido}</modFrete></transp>`),
      ).transport;
      expect(t.freightMode).toBe(valido);
    }
  });

  /**
   * `String(nó)` devolve "[object Object]" — texto que passa em qualquer
   * verificação de "não é nulo" e polui o banco com lixo silencioso.
   */
  it('grupo com filhos nunca vira a string "[object Object]"', () => {
    const t = parseNfeXml(
      nfeXml(`<transp><transporta><xNome>Transportes X</xNome></transporta></transp>`),
    ).transport;

    expect(t.carrierName).toBe('Transportes X');
    for (const v of Object.values(t)) {
      expect(String(v)).not.toContain('[object');
    }
  });
});

describe('a transportadora vira cadastro', () => {
  function carregar(id: string | null) {
    if (!id) return null;
    return getConnection()
      .prepare('SELECT * FROM core_carriers WHERE id = ?')
      .get(id) as Record<string, unknown>;
  }

  function notaGravada(noteId: string) {
    return getConnection()
      .prepare('SELECT * FROM core_inbound_notes WHERE id = ?')
      .get(noteId) as Record<string, unknown>;
  }

  it('a importação cria a transportadora e liga à nota', () => {
    const r = importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO) });
    const nota = notaGravada(r.noteId);
    const t = carregar(nota.carrier_id as string);

    expect(t?.name).toBe('Rapido Sampaio Transportes');
    expect(t?.document).toBe('05423963000111');
    expect(t?.city).toBe('Macapa');
    expect(nota.freight_mode).toBe('1');
    expect(nota.vehicle_plate).toBe('ABC1D23');
    expect(nota.gross_weight_grams).toBe(13_250);
    expect(nota.freight_cents).toBe(3_590);
  });

  it('a segunda nota da mesma transportadora reaproveita o cadastro', () => {
    const a = importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO) });
    const b = importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO) });

    expect(notaGravada(a.noteId).carrier_id).toBe(notaGravada(b.noteId).carrier_id);
    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_carriers WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(1);
  });

  /**
   * O mesmo CNPJ com e sem máscara é a MESMA transportadora. O fornecedor tem
   * esta assimetria — grava cru na importação e normaliza no cadastro — e ela
   * produz duplicata; a transportadora nasce sem herdá-la.
   */
  it('CNPJ com máscara casa com o mesmo sem máscara', () => {
    importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO) });
    importNfe({
      companyId: empresa,
      userId: 'u1',
      xml: nfeXml(`<transp><modFrete>1</modFrete>
        <transporta><CNPJ>05.423.963/0001-11</CNPJ><xNome>Rapido Sampaio</xNome></transporta>
      </transp>`),
    });

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_carriers WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(1);
  });

  /**
   * Sem documento, casa por nome. É heurística e é o mal menor: o autônomo
   * costuma vir sem CNPJ, e sem isso cada nota criaria uma linha nova.
   */
  it('sem documento, a mesma transportadora não duplica', () => {
    const sem = `<transp><modFrete>1</modFrete>
      <transporta><xNome>Fretes do Amapa</xNome></transporta></transp>`;
    importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(sem) });
    importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(sem) });

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_carriers WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(1);
  });

  it('nota sem transportadora não cria cadastro nenhum', () => {
    const r = importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml('') });
    expect(notaGravada(r.noteId).carrier_id).toBeNull();

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_carriers WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(0);
  });

  /** <transporta> só com CNPJ, sem nome, não tem cadastro para criar. */
  it('transportadora sem nome não vira cadastro', () => {
    const r = importNfe({
      companyId: empresa,
      userId: 'u1',
      xml: nfeXml(`<transp><modFrete>1</modFrete>
        <transporta><CNPJ>05423963000111</CNPJ></transporta></transp>`),
    });
    expect(notaGravada(r.noteId).carrier_id).toBeNull();
  });

  it('a transportadora não atravessa a fronteira da empresa', () => {
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
      kind: 'store',
    });
    importNfe({ companyId: empresa, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO, chave()) });
    importNfe({ companyId: outra, userId: 'u1', xml: nfeXml(TRANSPORTE_COMPLETO, chave()) });

    const porEmpresa = getConnection()
      .prepare('SELECT company_id, COUNT(*) AS n FROM core_carriers GROUP BY company_id')
      .all() as unknown as { company_id: string; n: number }[];
    expect(porEmpresa).toHaveLength(2);
    expect(porEmpresa.every((l) => l.n === 1)).toBe(true);
  });
});

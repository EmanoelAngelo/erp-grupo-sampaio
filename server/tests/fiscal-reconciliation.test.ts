/**
 * Reconciliação fiscal.
 *
 * O que estes testes garantem é que a reconciliação ENCONTRA sem CONSERTAR:
 * corrigir um documento fiscal sem evidência externa significa decidir o que a
 * SEFAZ respondeu — exatamente o que o autorizador falso fazia.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  DB_ENFORCED_INVARIANTS,
  reconciliationReport,
  runReconciliation,
} from '../src/services/core/FiscalReconciliation.js';

let companyId: string;
let seq = 0;

/** Insere um documento fiscal direto, para montar o cenário incoerente. */
function doc(patch: Record<string, unknown> = {}): string {
  ensureCoreSchema();
  seq += 1;
  const id = `doc-${seq}`;
  const now = new Date().toISOString();
  const campos = {
    id,
    company_id: companyId,
    model: '65',
    serie: 1,
    number: seq,
    access_key: String(seq).padStart(44, '9'),
    environment: 'homologation',
    status: 'DRAFT',
    created_at: now,
    updated_at: now,
    ...patch,
  };

  const colunas = Object.keys(campos).join(', ');
  const marcas = Object.keys(campos).map(() => '?').join(', ');
  getConnection()
    .prepare(`INSERT INTO core_fiscal_documents (${colunas}) VALUES (${marcas})`)
    .run(...(Object.values(campos) as never[]));
  return id;
}

function achado(check: string) {
  return runReconciliation(companyId).find((i) => i.check === check);
}

beforeEach(() => {
  resetDbForTests();
  seq = 0;
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
});

describe('base saudável', () => {
  it('sem documentos, nada é reportado', () => {
    const r = reconciliationReport(companyId);
    expect(r.healthy).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.critical).toBe(0);
  });
});

describe('checagens críticas', () => {
  it('autorizado sem protocolo', () => {
    doc({ status: 'AUTHORIZED', protocol: null });
    const i = achado('AUTHORIZED_WITHOUT_PROTOCOL')!;
    expect(i.severity).toBe('CRITICAL');
    expect(i.count).toBe(1);
    expect(i.impact).toMatch(/não é autorização/i);
    expect(i.action).toMatch(/consultar/i);
  });

  it('rejeitado carregando protocolo', () => {
    doc({ status: 'REJECTED', protocol: '135000000000001', c_stat: '539' });
    expect(achado('REJECTED_WITH_PROTOCOL')?.severity).toBe('CRITICAL');
  });

  /*
    E-venda-servidor-05: `cancelSale` passou a recusar venda com nota autorizada;
    esta checagem acha o que ficou de antes da trava — a venda cancelada no ERP
    com a nota ainda válida na SEFAZ. A venda VÁLIDA com nota autorizada não
    aparece: é o caso normal.
  */
  it('venda cancelada no sistema com a NFC-e ainda autorizada', () => {
    const vendaCom = (id: string, status: string) => {
      const db = getConnection();
      const cols = db.prepare('PRAGMA table_info(core_sales)').all() as unknown as {
        name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }[];
      const now = new Date().toISOString();
      const valores: Record<string, unknown> = {};
      for (const c of cols) {
        if (c.name === 'id') valores.id = id;
        else if (c.name === 'company_id') valores.company_id = companyId;
        else if (c.name === 'status') valores.status = status;
        else if (c.name === 'number') valores.number = Number(id.replace(/\D/g, '')) || 1;
        else if (/_at$/.test(c.name) && c.notnull && c.dflt_value === null) valores[c.name] = now;
        // Texto obrigatório ganha valor ÚNICO por venda: há colunas com UNIQUE (a chave de idempotência).
        else if (c.notnull && c.dflt_value === null && !c.pk) valores[c.name] = /INT/i.test(c.type) ? 0 : `${c.name}-${id}`;
      }
      db.prepare(`INSERT INTO core_sales (${Object.keys(valores).join(', ')}) VALUES (${Object.keys(valores).map(() => '?').join(', ')})`)
        .run(...(Object.values(valores) as never[]));
    };
    vendaCom('venda-1', 'cancelled');
    vendaCom('venda-2', 'completed');
    const cancelada = doc({ status: 'AUTHORIZED', protocol: '135000000000011', sale_id: 'venda-1' });
    doc({ status: 'AUTHORIZED', protocol: '135000000000012', sale_id: 'venda-2' });
    const i = achado('SALE_CANCELLED_WITH_AUTHORIZED_DOCUMENT')!;
    expect(i.severity).toBe('CRITICAL');
    expect(i.documentIds).toEqual([cancelada]);
    expect(i.action).toMatch(/cancelar a nota/i);
  });

  /**
   * O BANCO já impede chave repetida — garantia mais forte que qualquer
   * relatório, porque age antes de o dado existir. A checagem permanece como
   * defesa para bases antigas que possam ter sido migradas sem a constraint.
   */
  it('chave de acesso repetida é impedida pelo próprio banco', () => {
    const chave = '1'.repeat(44);
    doc({ access_key: chave, number: 1 });
    expect(() => doc({ access_key: chave, number: 2 })).toThrow(/UNIQUE/i);

    // E a base continua íntegra: nada de duplicidade a reportar.
    expect(achado('DUPLICATE_ACCESS_KEY')).toBeUndefined();
  });

  it('numeração repetida no mesmo modelo e série também é impedida pelo banco', () => {
    doc({ model: '65', serie: 1, number: 500 });
    expect(() => doc({ model: '65', serie: 1, number: 500 })).toThrow(/UNIQUE/i);
  });

  it('parado em envio há tempo demais', () => {
    const antigo = new Date(Date.now() - 60 * 60_000).toISOString();
    doc({ status: 'SENDING', updated_at: antigo });
    const i = achado('SENDING_TOO_LONG')!;
    expect(i.severity).toBe('CRITICAL');
    // A instrução mais importante: NÃO reenviar antes de consultar.
    expect(i.action).toMatch(/não reenviar/i);
  });

  it('envio recente NÃO é reportado', () => {
    doc({ status: 'SENDING', updated_at: new Date().toISOString() });
    expect(achado('SENDING_TOO_LONG')).toBeUndefined();
  });

  /** O pior cenário possível: cupom de teste circulando como nota real. */
  it('protocolo de teste num documento de produção', () => {
    doc({ status: 'AUTHORIZED', environment: 'production', protocol: 'TEST-abc123' });
    const i = achado('TEST_PROVIDER_IN_PRODUCTION')!;
    expect(i.severity).toBe('CRITICAL');
    expect(i.impact).toMatch(/não existem para o fisco/i);
  });

  it('protocolo de teste em homologação NÃO é reportado como produção', () => {
    doc({ status: 'AUTHORIZED', environment: 'homologation', protocol: 'TEST-abc123' });
    expect(achado('TEST_PROVIDER_IN_PRODUCTION')).toBeUndefined();
  });
});

describe('checagens de aviso', () => {
  it('autorizado sem XML guardado', () => {
    doc({ status: 'AUTHORIZED', protocol: '135000000000001', xml_authorized: null });
    expect(achado('AUTHORIZED_WITHOUT_XML')?.severity).toBe('WARNING');
  });

  it('documento em fila sem item na fila', () => {
    doc({ status: 'QUEUED' });
    expect(achado('DOCUMENT_WITHOUT_QUEUE')?.severity).toBe('WARNING');
  });

  /** Idem: a chave estrangeira impede o item órfão antes de ele existir. */
  it('item de fila órfão é impedido pela chave estrangeira', () => {
    const now = new Date().toISOString();
    expect(() =>
      getConnection()
        .prepare(
          `INSERT INTO core_fiscal_queue (id, company_id, document_id, operation, status,
                                          attempts, idempotency_key, created_at, updated_at)
           VALUES ('q1', ?, 'fantasma', 'authorize', 'pending', 0, 'k1', ?, ?)`,
        )
        .run(companyId, now, now),
    ).toThrow(/FOREIGN KEY/i);

    expect(achado('QUEUE_WITHOUT_DOCUMENT')).toBeUndefined();
  });

  it('contingência pendente de transmissão', () => {
    doc({ status: 'QUEUED', contingency_mode: 'OFFLINE' });
    const i = achado('CONTINGENCY_PENDING')!;
    expect(i.impact).toMatch(/prazo/i);
  });

  it('cStat que não é de autorização num documento autorizado', () => {
    doc({ status: 'AUTHORIZED', protocol: '135000000000001', c_stat: '204' });
    expect(achado('LOCAL_REMOTE_STATUS_MISMATCH')?.severity).toBe('WARNING');
  });
});

describe('ordenação e escopo', () => {
  it('crítico vem antes de aviso', () => {
    doc({ status: 'AUTHORIZED', protocol: null }); // crítico
    doc({ status: 'QUEUED' }); // aviso
    const issues = runReconciliation(companyId);
    expect(issues[0].severity).toBe('CRITICAL');
    expect(issues[issues.length - 1].severity).toBe('WARNING');
  });

  it('cada achado explica o que é, por que importa e o que fazer', () => {
    doc({ status: 'AUTHORIZED', protocol: null });
    for (const i of runReconciliation(companyId)) {
      expect(i.summary.length).toBeGreaterThan(10);
      expect(i.impact.length).toBeGreaterThan(20);
      expect(i.action.length).toBeGreaterThan(10);
    }
  });

  it('incoerência de outra operação não aparece', () => {
    doc({ status: 'AUTHORIZED', protocol: null });
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(reconciliationReport(outra).healthy).toBe(true);
  });
});

/** Insere um evento fiscal direto, para montar o cenário incoerente. */
function evento(patch: Record<string, unknown>): void {
  ensureCoreSchema();
  const campos = {
    id: `ev-${Math.random().toString(36).slice(2, 10)}`,
    company_id: companyId,
    event_type: 'cancelled',
    sequence: 1,
    created_at: new Date().toISOString(),
    ...patch,
  };
  const colunas = Object.keys(campos).join(', ');
  const marcas = Object.keys(campos).map(() => '?').join(', ');
  getConnection()
    .prepare(`INSERT INTO core_fiscal_events (${colunas}) VALUES (${marcas})`)
    .run(...(Object.values(campos) as never[]));
}

describe('eventos fiscais', () => {
  it('cancelado sem protocolo do evento é crítico', () => {
    const id = doc({ status: 'CANCELLED', protocol: '135000000000001' });
    void id;
    expect(achado('CANCELLED_WITHOUT_PROTOCOL')?.severity).toBe('CRITICAL');
  });

  it('cancelado COM protocolo do evento não é reportado', () => {
    const id = doc({ status: 'CANCELLED', protocol: '135000000000001' });
    evento({ document_id: id, event_type: 'cancelled', protocol: 'TEST-abc' });
    expect(achado('CANCELLED_WITHOUT_PROTOCOL')).toBeUndefined();
  });

  /** O fisco recusou, o sistema aplicou. A nota vale e não está sendo tratada assim. */
  it('cancelamento recusado com documento cancelado é crítico', () => {
    const id = doc({ status: 'CANCELLED' });
    evento({ document_id: id, event_type: 'cancel_rejected', c_stat: '573' });
    expect(achado('CANCEL_REJECTED_BUT_DOCUMENT_CANCELLED')?.severity).toBe('CRITICAL');
  });

  it('carta aceita sem protocolo é crítica', () => {
    const id = doc({ status: 'AUTHORIZED', protocol: '135000000000001' });
    evento({ document_id: id, event_type: 'cce_authorized', protocol: null });
    expect(achado('CCE_AUTHORIZED_WITHOUT_PROTOCOL')?.severity).toBe('CRITICAL');
  });

  it('sequência de carta repetida é crítica', () => {
    const id = doc({ status: 'AUTHORIZED', protocol: '135000000000001' });
    evento({ document_id: id, event_type: 'cce_authorized', sequence: 1, protocol: 'TEST-a' });
    evento({ document_id: id, event_type: 'cce_authorized', sequence: 1, protocol: 'TEST-b' });
    expect(achado('CCE_SEQUENCE_DUPLICATE')?.severity).toBe('CRITICAL');
  });

  it('carta em documento não autorizado é aviso', () => {
    const id = doc({ status: 'REJECTED' });
    evento({ document_id: id, event_type: 'cce_authorized', protocol: 'TEST-a' });
    expect(achado('CCE_WITHOUT_AUTHORIZED_NFE')?.severity).toBe('WARNING');
  });

  it('inutilização aceita sem protocolo é aviso', () => {
    evento({
      document_id: null, event_type: 'void_authorized', model: '55', serie: 1,
      number_from: 10, number_to: 15, protocol: null,
    });
    expect(achado('VOID_WITHOUT_PROTOCOL')?.severity).toBe('WARNING');
  });

  it('faixa inutilizada contendo número emitido é crítica', () => {
    doc({ model: '55', serie: 1, number: 12, status: 'AUTHORIZED', protocol: '135' });
    evento({
      document_id: null, event_type: 'void_authorized', model: '55', serie: 1,
      number_from: 10, number_to: 15, protocol: 'TEST-a',
    });
    expect(achado('VOID_AUTHORIZED_NUMBER')?.severity).toBe('CRITICAL');
  });

  it('faixas sobrepostas são críticas', () => {
    evento({
      document_id: null, event_type: 'void_authorized', model: '55', serie: 1,
      number_from: 10, number_to: 20, protocol: 'TEST-a',
    });
    evento({
      document_id: null, event_type: 'void_authorized', model: '55', serie: 1,
      number_from: 15, number_to: 25, protocol: 'TEST-b',
    });
    expect(achado('VOID_RANGE_OVERLAP')?.severity).toBe('CRITICAL');
  });

  it('inutilização pedida e sem desfecho há tempo demais é aviso', () => {
    evento({
      document_id: null, event_type: 'void_requested', model: '55', serie: 1,
      number_from: 30, number_to: 35,
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(achado('VOID_PENDING_TOO_LONG')?.severity).toBe('WARNING');
  });

  it('pedido recente sem desfecho NÃO é reportado', () => {
    evento({
      document_id: null, event_type: 'void_requested', model: '55', serie: 1,
      number_from: 40, number_to: 45,
    });
    expect(achado('VOID_PENDING_TOO_LONG')).toBeUndefined();
  });

  it('pedido já resolvido não conta como pendente', () => {
    const antigo = new Date(Date.now() - 60 * 60_000).toISOString();
    evento({
      document_id: null, event_type: 'void_requested', model: '55', serie: 1,
      number_from: 50, number_to: 55, created_at: antigo,
    });
    evento({
      document_id: null, event_type: 'void_authorized', model: '55', serie: 1,
      number_from: 50, number_to: 55, protocol: 'TEST-a', created_at: antigo,
    });
    expect(achado('VOID_PENDING_TOO_LONG')).toBeUndefined();
  });
});

describe('o que o banco já impede não vira checagem', () => {
  /**
   * Verificação que nunca dispara dá falsa cobertura e custa uma consulta a
   * cada abertura da tela.
   */
  it('as invariantes garantidas pelo banco estão documentadas', () => {
    expect(DB_ENFORCED_INVARIANTS.length).toBeGreaterThan(0);
    const texto = DB_ENFORCED_INVARIANTS.join(' ');
    expect(texto).toMatch(/CANCEL_EVENT_WITHOUT_DOCUMENT/);
    expect(texto).toMatch(/chave estrangeira/i);
  });

  it('evento órfão é impedido pela chave estrangeira', () => {
    expect(() => evento({ document_id: 'fantasma', event_type: 'cancelled' })).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe('não conserta sozinha', () => {
  /**
   * A garantia central: rodar a reconciliação não altera dado nenhum. Se
   * alterasse, estaria decidindo o que a SEFAZ respondeu.
   */
  it('rodar a reconciliação não muda o estado de nenhum documento', () => {
    const id = doc({ status: 'AUTHORIZED', protocol: null });
    const antes = getConnection()
      .prepare('SELECT * FROM core_fiscal_documents WHERE id = ?')
      .get(id);

    runReconciliation(companyId);
    runReconciliation(companyId);

    const depois = getConnection()
      .prepare('SELECT * FROM core_fiscal_documents WHERE id = ?')
      .get(id);
    expect(depois).toEqual(antes);
  });
});

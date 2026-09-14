/**
 * Entrada de NF-e por e-mail.
 *
 * É outra PORTA para o `NfeImportService` — nada do parser ou da conferência é
 * reimplementado. Os testes cobrem o que é próprio desta porta:
 *
 *   receber não é dar entrada  — a nota vira conferência, o estoque não anda;
 *   nada de duplicidade        — mesmo XML por upload e por e-mail = uma nota;
 *   anexo que não é XML        — registrado e ignorado;
 *   segredo no cofre           — a senha nunca sai pela API.
 *
 * A conexão IMAP fica de fora de propósito: `processIncomingMail` recebe a
 * mensagem já baixada, então a regra é testável sem servidor de e-mail.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { importNfe, listNotes } = await import('../src/services/core/NfeImportService.js');
const {
  getInboxStatus,
  listMailMessages,
  processIncomingMail,
  removeInbox,
  upsertInbox,
} = await import('../src/services/core/MailInboxService.js');

const SENHA = 'senha-de-aplicativo-do-provedor';
let companyId: string;
let userId: string;
let inboxId: string;

/** NF-e mínima, com chave de acesso de 44 dígitos. */
function nfeXml(chave: string, produto = 'CAMISETA POLO', quantidade = 10): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe${chave}" versao="4.00">
    <ide><nNF>1234</nNF><dhEmi>2026-08-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome></emit>
    <det nItem="1">
      <prod>
        <cProd>F-001</cProd>
        <cEAN>7891234567895</cEAN>
        <xProd>${produto}</xProd>
        <uCom>UN</uCom>
        <qCom>${quantidade}</qCom>
        <vUnCom>32.90</vUnCom>
        <vProd>${(quantidade * 32.9).toFixed(2)}</vProd>
      </prod>
    </det>
  </infNFe></NFe>
</nfeProc>`;
}

const CHAVE_A = '3'.repeat(44);
const CHAVE_B = '4'.repeat(44);

function email(overrides: Record<string, unknown> = {}) {
  return processIncomingMail({
    companyId,
    userId,
    inboxId,
    mail: {
      uid: 'uid-1',
      subject: 'NF-e 1234',
      from: 'fornecedor@exemplo.com.br',
      date: new Date().toISOString(),
      attachments: [{ filename: 'nfe.xml', content: nfeXml(CHAVE_A), contentType: 'text/xml' }],
      ...(overrides.mail as object),
    },
  } as Parameters<typeof processIncomingMail>[0]);
}

function movimentos(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_stock_movements').get() as { n: number }
  ).n;
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  userId = await upsertUser({
    login: 'GERENTE',
    displayName: 'Gerente',
    password: 'senha-teste-123',
  });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);

  const status = upsertInbox({
    companyId,
    address: 'notas@grupossampaio.com.br',
    host: 'imap.exemplo.com',
    password: SENHA,
  });
  inboxId = status.inbox!.id;
});

describe('configuração da caixa', () => {
  it('sem caixa, o estado é honesto', () => {
    removeInbox(companyId);
    const s = getInboxStatus(companyId);
    expect(s.configured).toBe(false);
    expect(s.readiness).toBe('READY_FOR_CREDENTIAL');
  });

  it('com senha, fica configurada — mas nunca "homologada"', () => {
    const s = getInboxStatus(companyId);
    expect(s.configured).toBe(true);
    expect(s.readiness).toBe('CONFIGURED');
    expect(s.readiness).not.toBe('HOMOLOGATED');
  });

  it('a senha NUNCA sai pela API', () => {
    const serializado = JSON.stringify(getInboxStatus(companyId));
    expect(serializado).not.toContain(SENHA);
    expect(getInboxStatus(companyId).inbox).not.toHaveProperty('secret_cipher');
  });

  it('a senha é guardada cifrada, não em claro', () => {
    const row = getConnection()
      .prepare('SELECT secret_cipher FROM core_mail_inboxes WHERE company_id = ?')
      .get(companyId) as { secret_cipher: string };
    expect(row.secret_cipher).toBeTruthy();
    expect(row.secret_cipher).not.toContain(SENHA);
  });

  it('salvar sem redigitar a senha não apaga a credencial', () => {
    upsertInbox({
      companyId,
      address: 'notas@grupossampaio.com.br',
      host: 'imap.outro.com',
    });
    expect(getInboxStatus(companyId).configured).toBe(true);
    expect(getInboxStatus(companyId).inbox?.host).toBe('imap.outro.com');
  });

  it('endereço e servidor são obrigatórios', () => {
    expect(() => upsertInbox({ companyId, address: '', host: 'imap.x.com' })).toThrowError(
      /e-mail e o servidor/i,
    );
  });
});

describe('receber não é dar entrada', () => {
  it('o XML vira nota em conferência, sem mover estoque', () => {
    const antes = movimentos();
    const r = email();

    expect(r.outcome).toBe('importado');
    expect(r.note_id).toBeTruthy();
    expect(r.access_key).toBe(CHAVE_A);
    // O estoque só se move na CONFIRMAÇÃO, como no upload manual.
    expect(movimentos()).toBe(antes);

    const notas = listNotes(companyId);
    expect(notas).toHaveLength(1);
    expect(String(notas[0].status)).not.toBe('confirmada');
  });

  it('a mensagem fica registrada com remetente e assunto', () => {
    email();
    const [msg] = listMailMessages(companyId);
    expect(msg.sender).toBe('fornecedor@exemplo.com.br');
    expect(msg.subject).toBe('NF-e 1234');
  });
});

describe('duplicidade', () => {
  it('o mesmo e-mail lido de novo não é reprocessado', () => {
    const primeira = email();
    const segunda = email();
    expect(segunda.id).toBe(primeira.id);
    expect(listMailMessages(companyId)).toHaveLength(1);
  });

  it('o mesmo XML por upload manual e por e-mail dá UMA nota só', () => {
    // Upload manual primeiro.
    importNfe({ companyId, userId, xml: nfeXml(CHAVE_A) });
    expect(listNotes(companyId)).toHaveLength(1);

    // Depois o fornecedor manda por e-mail.
    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-outro',
        attachments: [{ filename: 'nfe.xml', content: nfeXml(CHAVE_A) }],
      },
    });

    expect(r.outcome).toBe('duplicado');
    expect(r.detail).toMatch(/já havia sido importada/i);
    // A chave da NF-e é a defesa: continua UMA nota.
    expect(listNotes(companyId)).toHaveLength(1);
  });

  it('notas diferentes entram normalmente', () => {
    email();
    processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: { uid: 'uid-2', attachments: [{ filename: 'b.xml', content: nfeXml(CHAVE_B) }] },
    });
    expect(listNotes(companyId)).toHaveLength(2);
  });
});

describe('anexos que não são NF-e', () => {
  it('mensagem sem anexo é registrada e ignorada', () => {
    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: { uid: 'uid-vazio', attachments: [] },
    });
    expect(r.outcome).toBe('sem_xml');
    expect(listNotes(companyId)).toHaveLength(0);
  });

  it('boleto em PDF não vira nota fiscal', () => {
    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-pdf',
        attachments: [
          { filename: 'boleto.pdf', content: '%PDF-1.4', contentType: 'application/pdf' },
          { filename: 'logo.png', content: 'x', contentType: 'image/png' },
        ],
      },
    });
    expect(r.outcome).toBe('sem_xml');
    expect(r.detail).toContain('boleto.pdf');
    expect(listNotes(companyId)).toHaveLength(0);
  });

  it('XML corrompido é registrado como inválido, sem derrubar a leitura', () => {
    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-ruim',
        attachments: [{ filename: 'quebrado.xml', content: '<nfeProc>sem nada' }],
      },
    });
    expect(r.outcome).toBe('invalido');
    expect(listNotes(companyId)).toHaveLength(0);
  });

  it('anexo reconhecido pelo tipo, mesmo com nome sem extensão', () => {
    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-sem-ext',
        attachments: [{ filename: 'anexo', content: nfeXml(CHAVE_B), contentType: 'application/xml' }],
      },
    });
    expect(r.outcome).toBe('importado');
  });
});

/*
  PED-ent-02: as travas do funil que nasceram depois do conjunto de recusas —
  o destinatário de outra empresa (B-estoque-entrada-02) e o XML sem protocolo
  de autorização na produção (M02) — são RECUSA com motivo, não "XML inválido".
  Tire os dois códigos de RECUSAS_DO_FUNIL e os dois casos voltam a 'invalido'.
*/
describe('recusas do funil que não são defeito do arquivo', () => {
  const CNPJ_DA_EMPRESA = '11444777000161';
  const CNPJ_DA_GRINGA = '99999999000191';

  function nfeCom(chave: string, opcoes: { dest?: string; tpAmb?: '1' | '2' }): string {
    return nfeXml(chave)
      .replace('<ide><nNF>1234</nNF>', `<ide><nNF>1234</nNF>${opcoes.tpAmb ? `<tpAmb>${opcoes.tpAmb}</tpAmb>` : ''}`)
      .replace(
        '</emit>',
        `</emit>${opcoes.dest ? `<dest><CNPJ>${opcoes.dest}</CNPJ><xNome>Gringa Ltda</xNome></dest>` : ''}`,
      );
  }

  it('NF-e emitida para outra empresa do grupo: "recusado" com o motivo, e nenhuma nota', async () => {
    const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    updateFiscalConfig({ companyId, patch: { cnpj: CNPJ_DA_EMPRESA } });

    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-gringa',
        attachments: [{ filename: 'gringa.xml', content: nfeCom(CHAVE_A, { dest: CNPJ_DA_GRINGA }) }],
      },
    });

    expect(r.outcome).toBe('recusado');
    expect(r.detail).toMatch(/gringa\.xml: Esta NF-e foi emitida para Gringa Ltda/);
    expect(r.detail).toMatch(/1 recusada\(s\)/);
    expect(r.detail).toMatch(/0 inválida\(s\)/);
    expect(listNotes(companyId)).toHaveLength(0);
  });

  it('XML sem protocolo de autorização numa empresa em produção: "recusado", não "inválido"', async () => {
    const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    updateFiscalConfig({ companyId, patch: { cnpj: CNPJ_DA_EMPRESA } });
    getConnection()
      .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
      .run(companyId);

    const r = processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: {
        uid: 'uid-sem-protocolo',
        attachments: [{ filename: 'previa.xml', content: nfeCom(CHAVE_A, { tpAmb: '1', dest: CNPJ_DA_EMPRESA }) }],
      },
    });

    expect(r.outcome).toBe('recusado');
    expect(r.detail).toMatch(/previa\.xml: .*protocolo de autorização/);
    expect(listNotes(companyId)).toHaveLength(0);
  });
});

describe('isolamento por operação', () => {
  it('a caixa de uma empresa não aparece na outra', () => {
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    expect(getInboxStatus(outra).configured).toBe(false);
    expect(getInboxStatus(companyId).configured).toBe(true);
  });

  it('mensagens não vazam entre operações', () => {
    email();
    const outra = upsertCompany({
      slug: 'conceito',
      legalName: 'Conceito Ltda',
      tradeName: 'Conceito',
    });
    expect(listMailMessages(outra)).toHaveLength(0);
    expect(listMailMessages(companyId)).toHaveLength(1);
  });
});

/**
 * O CFOP do cadastro é o com que a LOJA VENDE.
 *
 * ## O erro fiscal silencioso
 *
 * Quando a entrada de nota cria um produto que ainda não existia, ela copiava
 * o CFOP do ITEM DA NOTA para o cadastro. Esse CFOP é o do FORNECEDOR, escrito
 * na ótica dele: comprando de outro estado a nota traz 6102 — venda
 * interestadual —, e o produto da loja nascia 6102.
 *
 * Depois a loja vende no balcão, e `FiscalXmlNfce` lê `p.cfop` e o joga direto
 * no XML da NFC-e. A venda local sai declarada como operação interestadual.
 *
 * Nada denuncia: o produto tem CFOP, o cupom emite, a SEFAZ autoriza (6102 é
 * um código válido). O erro só aparece meses depois, na apuração.
 *
 * ## Por que nulo não bloqueia
 *
 * Empresa que não configurou mantém o comportamento antigo. A alternativa —
 * recusar a entrada por falta de um campo de compras — pararia o recebimento
 * de mercadoria, e nota que não entra é muito pior que CFOP a corrigir.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { confirmNfe, importNfe } = await import('../src/services/core/NfeImportService.js');
const { getInboundConfig, setInboundConfig } = await import(
  '../src/services/core/InboundConfigService.js'
);

let empresa: string;
let usuario: string;

/** Nota de fornecedor de OUTRO estado: o item vem com 6102. */
function notaInterestadual(k = '35260814200166000187550010000010241000010248'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${k}" versao="4.00">
      <ide><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora de Sao Paulo</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>SP-9001</cProd><cEAN>7890000000017</cEAN>
          <xProd>Pastilha de freio</xProd><NCM>87083090</NCM><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>4</qCom><vUnCom>50.00</vUnCom><vProd>200.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>200.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

/** Importa e confirma, autorizando o cadastro do que não existe. */
function receber(): void {
  const r = importNfe({ companyId: empresa, userId: usuario, xml: notaInterestadual() });
  confirmNfe({
    companyId: empresa,
    noteId: r.noteId,
    userId: usuario,
    createMissing: true,
  });
}

function cfopDoProdutoCriado(): string | null {
  const linha = getConnection()
    .prepare('SELECT cfop FROM core_products WHERE company_id = ? AND name = ?')
    .get(empresa, 'Pastilha de freio') as { cfop?: string | null } | undefined;
  return linha?.cfop ?? null;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'ENTRADA_CFOP',
    displayName: 'Compras',
    password: 'Teste@Cfp2026',
  });
  linkUserToCompany(usuario, empresa, 'gestor', true);
});

describe('o produto criado pela entrada', () => {
  /**
   * O DEFEITO ERA: sem configuração, o 6102 do fornecedor de SP vinha junto.
   *
   * Herdar era a única alternativa a recusar a entrada enquanto o grupo
   * tributário não supria o CFOP na emissão. Agora supre (GAP-PRD-129): o
   * produto nasce sem CFOP, a nota de entrada entra do mesmo jeito, e o CFOP
   * interno do grupo vale para ele na venda — o checklist o conta como
   * classificado quando o grupo tem CFOP, e pendente quando não tem.
   */
  it('sem configuração, o produto nasce SEM CFOP — nunca com a saída do fornecedor', () => {
    receber();
    expect(cfopDoProdutoCriado()).toBeNull();
  });

  /**
   * O CONSERTO. A loja do Amapá vende dentro do estado: 5102. Sem isto, o
   * cupom de uma venda de balcão sairia com código interestadual.
   */
  it('com o CFOP de venda configurado, é ele que vai para o cadastro', () => {
    setInboundConfig(empresa, { defaultSaleCfop: '5102' });
    receber();
    expect(cfopDoProdutoCriado()).toBe('5102');
  });

  /**
   * O CFOP do ITEM da nota NUNCA é reescrito: aquele é o que o fornecedor
   * declarou, e mexer nele seria falsificar o documento dele.
   */
  it('o CFOP do item da nota continua sendo o do fornecedor', () => {
    setInboundConfig(empresa, { defaultSaleCfop: '5102' });
    receber();

    const item = getConnection()
      .prepare('SELECT cfop FROM core_inbound_note_items WHERE company_id = ?')
      .get(empresa) as { cfop: string };
    expect(item.cfop).toBe('6102');
  });
});

describe('a configuração da entrada', () => {
  it('empresa que nunca configurou responde com o padrão vazio', () => {
    // Sem isto, todo chamador precisaria tratar "não existe linha".
    expect(getInboundConfig(empresa).defaultSaleCfop).toBeNull();
  });

  it('gravar duas vezes atualiza em vez de duplicar', () => {
    setInboundConfig(empresa, { defaultSaleCfop: '5102' });
    setInboundConfig(empresa, { defaultSaleCfop: '5405' });

    expect(getInboundConfig(empresa).defaultSaleCfop).toBe('5405');
    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_configs WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(1);
  });

  it('campo apagado na tela limpa a configuração', () => {
    setInboundConfig(empresa, { defaultSaleCfop: '5102' });
    setInboundConfig(empresa, { defaultSaleCfop: '' });
    expect(getInboundConfig(empresa).defaultSaleCfop).toBeNull();
  });

  it('aceita máscara e guarda só os dígitos', () => {
    setInboundConfig(empresa, { defaultSaleCfop: '5.102' });
    expect(getInboundConfig(empresa).defaultSaleCfop).toBe('5102');
  });

  /**
   * A série 1/2/3 é de ENTRADA. Gravá-la no produto faria a VENDA sair
   * declarando que a loja está comprando — o erro inverso do que a rodada
   * conserta, e igualmente invisível.
   */
  it('recusa CFOP de entrada, que é a série 1, 2 e 3', () => {
    for (const entrada of ['1102', '2102', '3102']) {
      expect(() => setInboundConfig(empresa, { defaultSaleCfop: entrada })).toThrow(/inválido/i);
    }
  });

  it('recusa o que não tem quatro dígitos', () => {
    for (const ruim of ['51', '51023', 'abcd']) {
      expect(() => setInboundConfig(empresa, { defaultSaleCfop: ruim })).toThrow(/inválido/i);
    }
  });

  it('as séries de saída 5, 6 e 7 passam', () => {
    for (const bom of ['5102', '6108', '7101']) {
      expect(setInboundConfig(empresa, { defaultSaleCfop: bom }).defaultSaleCfop).toBe(bom);
    }
  });

  it('a configuração não atravessa a fronteira da empresa', () => {
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
      kind: 'store',
    });
    setInboundConfig(empresa, { defaultSaleCfop: '5102' });
    expect(getInboundConfig(outra).defaultSaleCfop).toBeNull();
  });
});

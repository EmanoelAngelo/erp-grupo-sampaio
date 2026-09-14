/**
 * ============================================================================
 * O GRUPO TRIBUTÁRIO É CAMPO DO PRODUTO — e o IPI sai do literal (V01 e V08)
 * ============================================================================
 *
 * ## O defeito (GAP-V01)
 *
 * `TributacaoDoItem` recusa a emissão de todo produto sem perfil quando a
 * operação tem DOIS grupos ativos, com a frase "Escolha o perfil no cadastro do
 * produto". Esse campo não existia em tela nenhuma: nem no `ProdutoFormPage`,
 * nem no rascunho da pendência fiscal. `core_products.tax_profile` estava
 * preenchido em 0 dos 19 produtos do banco real, e a rota `PUT /products/:id`
 * já aceitava `taxProfile` desde sempre.
 *
 * Só não doía porque o banco real tem UM grupo. O dia em que o contador
 * pedisse um segundo — monofásico de bebida, ST de autopeça —, a emissão
 * inteira travaria apontando um lugar que não existe.
 *
 * ## O defeito (GAP-V08)
 *
 * O XML levava `<vIPI>0.00</vIPI>` cravado no total e NENHUM bloco `<IPI>` nos
 * itens, enquanto `core_tax_rates` aceitava `kind = 'ipi'` sem nenhum leitor na
 * emissão: cadastro com escritor e sem leitor. O zero era uma promessa, não um
 * resultado.
 *
 * ## O QUE ESTE ARQUIVO NÃO FINGE
 *
 * O destaque de IPI COM VALOR (CST 50 e 99) é RECUSADO, e a recusa tem razão
 * escrita: imposto por fora soma ao `vNF`, e o total desta nota sai do que o
 * cliente pagou — a nota seria rejeitada pela SEFAZ com a venda já feita.
 * Emitir `<IPINT>` (alíquota zero, isento, imune, não-tributado, suspensão) é
 * emissão de IPI de verdade e não mexe em total nenhum.
 *
 * ## COMO CADA GUARDA FALHA
 *
 *  - tire o `taxProfile` do mapa de `atualizarProduto` e o caso da gravação
 *    fica vermelho (foi assim que `kind` e `workshop_id` ficaram decorativos);
 *  - faça o vazio PRESERVAR em vez de limpar e o caso do "padrão da operação"
 *    fica vermelho: escolher um grupo por engano viraria irreversível;
 *  - devolva `<vIPI>0.00</vIPI>` ao literal e o caso do total fica vermelho;
 *  - tire a recusa do CST com valor e o XML sai com um total que não fecha.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { loginForTest } = await import('./helpers/auth.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { getProduct } = await import('../src/services/core/CatalogService.js');
const { upsertTaxGroup, upsertTaxRate } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { impostoXml, tributacaoDoItem } = await import(
  '../src/services/core/TributacaoDoItem.js'
);

const app = createApp();
const LOJA = 'loja-fiscal';

let gerente: Record<string, string>;
let produtoId: string;

const CAMISA = {
  id: 'p-camisa',
  description: 'Camisa Social',
  origin: '0',
  cfop: null as string | null,
  ncm: '61051000',
  cest: null as string | null,
  totalCents: 10000,
};

/** O grupo que toda empresa do grupo tem: Simples, CSOSN 102, PIS/COFINS 49. */
function grupoPadrao(extras: Record<string, unknown> = {}) {
  return upsertTaxGroup(LOJA, {
    code: 'PADRAO',
    name: 'Padrão da loja',
    regime: 'simples',
    csosn: '102',
    cfopInternal: '5102',
    cstPis: '49',
    cstCofins: '49',
    ...extras,
  });
}

function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava recusa, e passou');
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };

  updateFiscalConfig({
    companyId: LOJA,
    patch: {
      cnpj: '11222333000181',
      legalName: 'Loja Fiscal Ltda',
      ie: '1234567',
      crt: '1',
      uf: 'RS',
    },
  });

  const criado = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: 'Camisa Social', priceCents: 10000 })
    .expect(201);
  produtoId = String(criado.body.id);
});

describe('a lista de grupos chega à tela (GAP-V01)', () => {
  it('GET /catalog/tax-groups devolve os grupos da operação', async () => {
    grupoPadrao();
    upsertTaxGroup(LOJA, {
      code: 'MONOFASICO',
      name: 'Bebida monofásica',
      regime: 'simples',
      csosn: '500',
      cstPis: '04',
      cstCofins: '04',
    });

    const res = await request(app).get('/api/v1/core/catalog/tax-groups').set(gerente).expect(200);
    expect(res.body.taxGroups.map((g: { code: string }) => g.code).sort()).toEqual([
      'MONOFASICO',
      'PADRAO',
    ]);
  });

  it('e a lista NÃO vaza para outra empresa', async () => {
    grupoPadrao();
    const outra = await loginForTest(app, {
      userId: 'gerente-gringa',
      companyId: 'gringa-co',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/catalog/tax-groups')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .expect(200);
    expect(res.body.taxGroups).toHaveLength(0);
  });
});

describe('o produto guarda o grupo escolhido', () => {
  it('PUT /products/:id grava o taxProfile — o campo que a tela nunca mandava', async () => {
    grupoPadrao();
    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ name: 'Camisa Social', taxProfile: 'PADRAO' })
      .expect(200);

    expect(getProduct(LOJA, produtoId)?.tax_profile).toBe('PADRAO');
  });

  it('o código é gravado em MAIÚSCULAS, que é como o grupo é buscado', async () => {
    grupoPadrao();
    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ taxProfile: 'padrao' })
      .expect(200);
    expect(getProduct(LOJA, produtoId)?.tax_profile).toBe('PADRAO');
  });

  it('VAZIO limpa: "usar o padrão da operação" precisa ser possível', async () => {
    grupoPadrao();
    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ taxProfile: 'PADRAO' })
      .expect(200);

    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ taxProfile: '' })
      .expect(200);

    // Nulo, e não a string "null" nem string vazia: `tributacaoDoItem`
    // procuraria um grupo com esse código e travaria a emissão.
    expect(getProduct(LOJA, produtoId)?.tax_profile).toBeNull();
  });

  it('AUSENTE preserva: salvar o preço não pode apagar a tributação', async () => {
    grupoPadrao();
    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ taxProfile: 'PADRAO' })
      .expect(200);

    await request(app)
      .put(`/api/v1/core/products/${produtoId}`)
      .set(gerente)
      .send({ priceCents: 9900 })
      .expect(200);

    expect(getProduct(LOJA, produtoId)?.tax_profile).toBe('PADRAO');
  });
});

describe('COM DOIS GRUPOS, o perfil escolhido desempata a emissão', () => {
  it('sem perfil, a emissão recusa e manda escolher no cadastro do produto', () => {
    grupoPadrao();
    upsertTaxGroup(LOJA, {
      code: 'MONOFASICO',
      name: 'Bebida monofásica',
      regime: 'simples',
      csosn: '103',
      cfopInternal: '5405',
      cstPis: '04',
      cstCofins: '04',
    });

    const erro = erroDe(() =>
      tributacaoDoItem({ companyId: LOJA, produto: { ...CAMISA, taxProfile: null } }),
    );
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('Escolha o perfil no cadastro do produto');
  });

  it('COM o perfil escolhido, a mesma operação emite — e pelo grupo certo', () => {
    grupoPadrao();
    upsertTaxGroup(LOJA, {
      code: 'MONOFASICO',
      name: 'Bebida monofásica',
      regime: 'simples',
      csosn: '103',
      cfopInternal: '5405',
      cstPis: '04',
      cstCofins: '04',
    });

    const t = tributacaoDoItem({
      companyId: LOJA,
      produto: { ...CAMISA, taxProfile: 'MONOFASICO' },
    });
    expect(t.origemDoGrupo).toBe('MONOFASICO');
    expect(t.csosn).toBe('103');
    expect(t.cfop).toBe('5405');
  });
});

describe('IPI: o zero deixa de ser literal (GAP-V08)', () => {
  it('grupo SEM IPI não emite bloco nenhum, e o item sai como sempre saiu', () => {
    grupoPadrao();
    const t = tributacaoDoItem({ companyId: LOJA, produto: CAMISA });
    expect(t.cstIpi).toBeNull();
    expect(t.vIpiCents).toBe(0);

    const xml = impostoXml(t, CAMISA);
    // Ausência é a tributação correta de quem não industrializa. Emitir um
    // IPINT inventado mudaria a forma de toda nota já emitida.
    expect(xml).not.toContain('<IPI>');
  });

  it('grupo com CST SEM VALOR emite <IPINT> de verdade — e não soma nada', () => {
    grupoPadrao({ cstIpi: '53' });
    const t = tributacaoDoItem({ companyId: LOJA, produto: CAMISA });

    expect(t.cstIpi).toBe('53');
    expect(t.vIpiCents).toBe(0);

    const xml = impostoXml(t, CAMISA);
    expect(xml).toContain('<IPI>');
    expect(xml).toContain('<cEnq>999</cEnq>');
    expect(xml).toContain('<CST>53</CST>');
    expect(xml).toContain('</IPINT>');
  });

  it('CST COM VALOR sem alíquota é recusado no CADASTRO, antes da emissão', () => {
    const erro = erroDe(() => grupoPadrao({ cstIpi: '50' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_IPI_RATE_REQUIRED');
    expect(erro.message).toContain('51 a 55');
  });

  it('CST de ENTRADA num grupo de SAÍDA é recusado, dizendo quais valem', () => {
    const erro = erroDe(() => grupoPadrao({ cstIpi: '01' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_CST_IPI');
    expect(erro.message).toContain('50, 51, 52, 53, 54, 55 e 99');
  });

  it('alíquota de IPI inexistente é recusada — o código não é texto livre', () => {
    const erro = erroDe(() => grupoPadrao({ cstIpi: '50', ipiRateCode: 'NAOEXISTE' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_IPI_RATE_NOT_FOUND');
  });

  it('a alíquota kind=ipi ganha o PRIMEIRO leitor da emissão', () => {
    upsertTaxRate(LOJA, { code: 'IPI5', name: 'IPI 5%', kind: 'ipi', percent: 5 });
    grupoPadrao({ cstIpi: '50', ipiRateCode: 'IPI5' });

    /*
      E AQUI O SISTEMA PARA, DE PROPÓSITO.

      O IPI destacado é cobrado POR FORA: o layout soma `vIPI` ao `vNF`. O
      total desta nota, porém, sai do que o cliente PAGOU, e `<pag>` sai da
      lista de pagamentos — somar o imposto faria vNF divergir dos pagamentos e
      a SEFAZ rejeitaria a nota com a venda já feita. Embutir no preço seria
      inventar tributação.

      A recusa acontece ANTES de reservar o número fiscal (é a mesma função que
      `conferirExigenciasDaMontagem` executa), então erro de configuração não
      queima numeração.
    */
    const erro = erroDe(() => tributacaoDoItem({ companyId: LOJA, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('5.00%');
    expect(erro.message).toContain('não cobra imposto por fora');
    expect(erro.message).toContain('51 a 55');
  });

  it('a alíquota DESATIVADA depois de escolhida é dita com o nome do dado', () => {
    upsertTaxRate(LOJA, { code: 'IPI5', name: 'IPI 5%', kind: 'ipi', percent: 5 });
    grupoPadrao({ cstIpi: '99', ipiRateCode: 'IPI5' });
    // Desativada DEPOIS de já estar escolhida no grupo — o caminho por onde a
    // configuração fica incoerente sem ninguém mexer no grupo.
    getConnection()
      .prepare("UPDATE core_tax_rates SET active = 0 WHERE company_id = ? AND code = 'IPI5'")
      .run(LOJA);

    const erro = erroDe(() => tributacaoDoItem({ companyId: LOJA, produto: CAMISA }));
    expect(erro.message).toContain('não tem alíquota de IPI');
  });
});

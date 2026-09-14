/**
 * O XML DO FORNECEDOR SUGERE A CLASSIFICAÇÃO — E NUNCA A DECIDE.
 *
 * ## O defeito
 *
 * O NCM, o CEST e a origem de cada item chegam ESCRITOS no XML de entrada, e o
 * sistema os jogava fora: `parseNfeXml` lia NCM e CFOP e ignorava `<CEST>` e o
 * `<orig>` do grupo de ICMS; nada disso alcançava o produto casado. O resultado
 * é o trabalho manual que o contador refaz nota a nota — digitar num formulário
 * o que o fornecedor já declarou no arquivo.
 *
 * A regra mestre desta missão é: se o sistema consegue descobrir com segurança,
 * ele não pergunta. Descobrir NÃO é decidir — e a fronteira entre as duas é o
 * assunto inteiro deste arquivo.
 *
 * ## As três linhas que este teste crava
 *
 * 1. o XML SUGERE. A sugestão nasce com procedência (qual nota, qual
 *    fornecedor, quando) e com contagem: dois fornecedores que dizem o mesmo
 *    NCM valem mais que um;
 * 2. a sugestão NUNCA vira confirmação sozinha, e NUNCA toca produto já
 *    confirmado. Quem confirma é gente;
 * 3. o CFOP do XML do fornecedor É A SAÍDA DELE, e não a nossa. Sugeri-lo
 *    produziria nota autorizada com tributação errada — que é pior que nota
 *    recusada, porque a recusa aparece na hora e o imposto errado aparece na
 *    fiscalização.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { parseNfeXml } from '../src/services/core/NfeImportService.js';

const app = createApp();

interface ItemDoXml {
  cProd: string;
  ean: string;
  nome: string;
  ncm: string;
  cest?: string;
  orig?: string;
  cfop?: string;
}

const PASTILHA: ItemDoXml = {
  cProd: 'FORN-001',
  ean: '7891234567895',
  nome: 'Pastilha de Freio Dianteira',
  ncm: '87141000',
  cest: '0100100',
  orig: '0',
};

function nfeXml(options: {
  chave: string;
  itens?: ItemDoXml[];
  emitente?: string;
  cnpj?: string;
}): string {
  const itens = options.itens ?? [PASTILHA];
  const dets = itens
    .map(
      (item, i) => `
      <det nItem="${i + 1}">
        <prod>
          <cProd>${item.cProd}</cProd>
          <cEAN>${item.ean}</cEAN>
          <xProd>${item.nome}</xProd>
          <NCM>${item.ncm}</NCM>
          ${item.cest ? `<CEST>${item.cest}</CEST>` : ''}
          <CFOP>${item.cfop ?? '6102'}</CFOP>
          <uCom>UN</uCom>
          <qCom>10.0000</qCom>
          <vUnCom>45.5000</vUnCom>
          <vProd>455.00</vProd>
        </prod>
        <imposto>
          <ICMS>
            <ICMSSN102>
              <orig>${item.orig ?? '0'}</orig>
              <CSOSN>102</CSOSN>
            </ICMSSN102>
          </ICMS>
        </imposto>
      </det>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${options.chave}" versao="4.00">
      <ide><cUF>35</cUF><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit>
        <CNPJ>${options.cnpj ?? '14200166000187'}</CNPJ>
        <xNome>${options.emitente ?? 'Distribuidora de Pecas Ltda'}</xNome>
      </emit>
      ${dets}
      <total><ICMSTot><vNF>455.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe><infProt><nProt>135240000000001</nProt></infProt></protNFe>
</nfeProc>`;
}

const CHAVE_A = '35240114200166000187550010000000015123456789';
const CHAVE_B = '35240114200166000187550010000000025123456789';

let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: 'loja-xml',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

/** Cadastra um produto que casa com a PASTILHA pelo código de barras. */
async function produtoSemClassificacao(nome = 'Pastilha (cadastro antigo)') {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, barcode: PASTILHA.ean, priceCents: 9900 });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

/** Importa e CONFIRMA a nota — o momento em que a mercadoria virou fato. */
async function entrar(xml: string) {
  const imp = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({ xml });
  expect([200, 201]).toContain(imp.status);
  const noteId = String(imp.body.noteId);
  const conf = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({ createMissing: true });
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  return noteId;
}

/**
 * O catálogo INTEIRO (`all=1`).
 *
 * O padrão da rota devolve só quem tem algo a resolver — que é o que a tela
 * quer —, e por isso um produto já confirmado some dela. Aqui se quer olhar
 * também para quem já foi resolvido, para provar que ele ficou CONFIRMADO.
 */
async function classificacao(productId: string) {
  const res = await request(app).get('/api/v1/core/fiscal/classification?all=1').set(auth);
  expect(res.status).toBe(200);
  return (res.body.items as Record<string, unknown>[]).find(
    (p) => p.productId === productId,
  ) as Record<string, unknown> | undefined;
}

describe('o arquivo já dizia — o parser é que não lia', () => {
  it('extrai CEST do produto e a origem do grupo de ICMS', () => {
    const parsed = parseNfeXml(nfeXml({ chave: CHAVE_A }));
    expect(parsed.items[0].ncm).toBe('87141000');
    expect(parsed.items[0].cest).toBe('0100100');
    expect(parsed.items[0].origin).toBe('0');
  });

  it('nota sem CEST e sem grupo de ICMS devolve nulo — não zero', () => {
    const parsed = parseNfeXml(
      nfeXml({ chave: CHAVE_A, itens: [{ ...PASTILHA, cest: undefined }] }).replace(
        /<imposto>[\s\S]*?<\/imposto>/g,
        '',
      ),
    );
    expect(parsed.items[0].cest).toBeNull();
    expect(parsed.items[0].origin).toBeNull();
  });
});

describe('a sugestão nasce da nota, com procedência', () => {
  it('produto sem NCM ganha SUGESTÃO — e o cadastro continua vazio', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));

    const p = await classificacao(productId);
    expect(p, 'o produto tem de aparecer no painel de classificação').toBeTruthy();

    const ncm = (p!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.state).toBe('AUTO_DETECTADO');
    expect(ncm.current).toBeNull();
    expect((ncm.best as { value: string }).value).toBe('87141000');
    expect((ncm.best as { occurrences: number }).occurrences).toBe(1);
    expect((ncm.best as { suppliers: string[] }).suppliers).toContain(
      'Distribuidora de Pecas Ltda',
    );

    // A ESCRITA SILENCIOSA É O DEFEITO QUE ESTE TESTE IMPEDE.
    const linha = getConnection()
      .prepare('SELECT ncm, cest, origin FROM core_products WHERE id = ?')
      .get(productId) as { ncm: string | null; cest: string | null; origin: string | null };
    expect(linha.ncm).toBeNull();
    expect(linha.cest).toBeNull();
    expect(linha.origin).toBeNull();
  });

  it('CEST e origem viajam junto — os três campos do item', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));

    const p = await classificacao(productId);
    const campos = Object.fromEntries(
      (p!.fields as Record<string, unknown>[]).map((f) => [
        f.field,
        (f.best as { value: string } | null)?.value ?? null,
      ]),
    );
    expect(campos.ncm).toBe('87141000');
    expect(campos.cest).toBe('0100100');
    expect(campos.origin).toBe('0');
  });

  it('O CFOP DO FORNECEDOR NÃO É SUGERIDO — ele é a saída DELE', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));

    const p = await classificacao(productId);
    const chaves = (p!.fields as Record<string, unknown>[]).map((f) => f.field);
    expect(chaves).not.toContain('cfop');
  });

  it('dois fornecedores que concordam sobem a confiança; o mesmo arquivo duas vezes, não', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));
    await entrar(
      nfeXml({ chave: CHAVE_B, emitente: 'Outra Distribuidora SA', cnpj: '14200166000268' }),
    );

    const p = await classificacao(productId);
    const ncm = (p!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect((ncm.best as { occurrences: number }).occurrences).toBe(2);
    expect((ncm.best as { suppliers: string[] }).suppliers).toHaveLength(2);

    // Reimportar/reconfirmar a MESMA nota não pode inflar a contagem: seria
    // fabricar confiança a partir de um clique repetido.
    await entrar(nfeXml({ chave: CHAVE_A }));
    const depois = await classificacao(productId);
    const ncmDepois = (depois!.fields as Record<string, unknown>[]).find(
      (f) => f.field === 'ncm',
    )!;
    expect((ncmDepois.best as { occurrences: number }).occurrences).toBe(2);
  });

  it('fornecedores que DISCORDAM viram DIVERGÊNCIA, e ninguém escolhe por ninguém', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));
    await entrar(
      nfeXml({
        chave: CHAVE_B,
        emitente: 'Outra Distribuidora SA',
        cnpj: '14200166000268',
        itens: [{ ...PASTILHA, ncm: '87082990' }],
      }),
    );

    const p = await classificacao(productId);
    const ncm = (p!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.state).toBe('DIVERGENTE');
    expect((ncm.evidence as unknown[]).length).toBe(2);

    /*
      A DIVERGÊNCIA NÃO ENTRA NO LOTE — e os campos em que as duas notas
      CONCORDAM continuam entrando. Barrar o produto inteiro por causa de um
      campo em conflito seria jogar fora a resposta certa do CEST e da origem
      por causa de uma dúvida sobre o NCM.
    */
    expect(p!.applicable).not.toContainEqual(
      expect.objectContaining({ field: 'ncm' }),
    );
    expect(p!.applicable).toContainEqual({ field: 'cest', value: '0100100' });
  });
});

describe('confirmar é ato humano — em lote, mas humano', () => {
  it('o lote aplica o que é inequívoco e carimba quem confirmou', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));

    const res = await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(3);

    const linha = getConnection()
      .prepare(
        `SELECT ncm, cest, origin, fiscal_confirmed_at, fiscal_confirmed_by,
                fiscal_classification_source
           FROM core_products WHERE id = ?`,
      )
      .get(productId) as Record<string, unknown>;
    expect(linha.ncm).toBe('87141000');
    expect(linha.cest).toBe('0100100');
    expect(linha.origin).toBe('0');
    expect(linha.fiscal_confirmed_at).toBeTruthy();
    expect(linha.fiscal_confirmed_by).toBeTruthy();
    expect(linha.fiscal_classification_source).toBe('xml_fornecedor');

    const depois = await classificacao(productId);
    const ncm = (depois!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.state).toBe('CONFIRMADO');
  });

  it('confirmar duas vezes não muda nada nem duplica a trilha — idempotente', async () => {
    await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));

    const um = await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({});
    const dois = await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({});
    expect(um.body.confirmed).toBe(3);
    expect(dois.body.confirmed).toBe(0);

    const trilha = getConnection()
      .prepare(
        `SELECT COUNT(*) AS c FROM core_audit_log WHERE action = 'fiscal.classification_confirmed'`,
      )
      .get() as { c: number };
    expect(Number(trilha.c)).toBe(1);
  });

  it('produto JÁ CONFIRMADO não é reescrito em silêncio: a divergência aparece', async () => {
    const productId = await produtoSemClassificacao();
    await request(app)
      .patch(`/api/v1/core/fiscal/product-pendencies/${productId}`)
      .set(auth)
      .send({ ncm: '87082990', cfop: '5102', origin: '0' });

    // A nota do fornecedor diz OUTRO NCM. Ela não pode vencer a decisão humana.
    await entrar(nfeXml({ chave: CHAVE_A }));

    const p = await classificacao(productId);
    const ncm = (p!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.current).toBe('87082990');
    expect(ncm.state).toBe('DIVERGENTE');

    await request(app).post('/api/v1/core/fiscal/classification/confirm').set(auth).send({});
    const linha = getConnection()
      .prepare('SELECT ncm FROM core_products WHERE id = ?')
      .get(productId) as { ncm: string };
    expect(linha.ncm, 'o lote não pode ter reescrito a decisão humana').toBe('87082990');
  });

  it('a escolha explícita da divergência é aceita — e só ela', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));
    await entrar(
      nfeXml({
        chave: CHAVE_B,
        emitente: 'Outra Distribuidora SA',
        cnpj: '14200166000268',
        itens: [{ ...PASTILHA, ncm: '87082990' }],
      }),
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({ items: [{ productId, field: 'ncm', value: '87082990' }] });
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(1);

    const linha = getConnection()
      .prepare('SELECT ncm FROM core_products WHERE id = ?')
      .get(productId) as { ncm: string };
    expect(linha.ncm).toBe('87082990');
  });

  it('a divergência já pesada por gente para de gritar — mas a nota NOVA a reabre', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));
    await entrar(
      nfeXml({
        chave: CHAVE_B,
        emitente: 'Outra Distribuidora SA',
        cnpj: '14200166000268',
        itens: [{ ...PASTILHA, ncm: '87082990' }],
      }),
    );

    // A pessoa olha as duas notas e escolhe. A decisão está tomada.
    await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({ items: [{ productId, field: 'ncm', value: '87082990' }] });

    const depois = await classificacao(productId);
    const ncm = (depois!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(
      ncm.state,
      'cobrar de novo uma decisão já tomada ensina a ignorar o vermelho',
    ).toBe('CONFIRMADO');

    /*
      NOTA NOVA É INFORMAÇÃO NOVA. Um terceiro fornecedor que chega depois
      dizendo outra coisa reabre a pergunta — silenciá-lo seria transformar a
      janela num botão de "nunca mais me avise".
    */
    await entrar(
      nfeXml({
        chave: '35240114200166000187550010000000035123456789',
        emitente: 'Terceira Distribuidora ME',
        cnpj: '14200166000349',
        itens: [{ ...PASTILHA, ncm: '40169990' }],
      }),
    );

    const reaberto = await classificacao(productId);
    const ncmReaberto = (reaberto!.fields as Record<string, unknown>[]).find(
      (f) => f.field === 'ncm',
    )!;
    expect(ncmReaberto.state).toBe('DIVERGENTE');
  });

  it('confirmar UM campo não cala o conflito de OUTRO — o carimbo é do produto', async () => {
    const productId = await produtoSemClassificacao();
    await entrar(nfeXml({ chave: CHAVE_A }));
    await entrar(
      nfeXml({
        chave: CHAVE_B,
        emitente: 'Outra Distribuidora SA',
        cnpj: '14200166000268',
        itens: [{ ...PASTILHA, cest: '2800100' }],
      }),
    );

    // Confirma só o NCM (em que as duas notas concordam). O CEST, em que elas
    // discordam, ninguém olhou.
    await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({ items: [{ productId, field: 'ncm', value: '87141000' }] });

    const p = await classificacao(productId);
    const campos = Object.fromEntries(
      (p!.fields as Record<string, unknown>[]).map((f) => [f.field, f.state]),
    );
    expect(campos.ncm).toBe('CONFIRMADO');
    expect(campos.cest, 'o carimbo do NCM não decide sobre o CEST').toBe('DIVERGENTE');
  });

  it('valor fora do formato é recusado — 8 dígitos de NCM continuam sendo 8', async () => {
    const productId = await produtoSemClassificacao();
    const res = await request(app)
      .post('/api/v1/core/fiscal/classification/confirm')
      .set(auth)
      .send({ items: [{ productId, field: 'ncm', value: '1234' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_NCM_INVALID');
  });
});

describe('a nota estornada para de sustentar a classificação', () => {
  it('o apoio some com o estorno — confiança não se conta com papel devolvido', async () => {
    const productId = await produtoSemClassificacao();
    const noteId = await entrar(nfeXml({ chave: CHAVE_A }));

    const antes = await classificacao(productId);
    expect(
      ((antes!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!
        .evidence as unknown[]).length,
    ).toBe(1);

    const est = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/estornar`)
      .set(auth)
      .send({ reason: 'Nota do irmão da outra empresa, importada por engano' });
    expect(est.status, JSON.stringify(est.body)).toBe(200);

    const depois = await classificacao(productId);
    const ncm = (depois!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.evidence).toEqual([]);
    expect(ncm.state).toBe('PENDENTE');
  });

  it('o que a nota JÁ classificou não é revogado pelo estorno', async () => {
    const productId = await produtoSemClassificacao();
    const noteId = await entrar(nfeXml({ chave: CHAVE_A }));
    await request(app).post('/api/v1/core/fiscal/classification/confirm').set(auth).send({});

    await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/estornar`)
      .set(auth)
      .send({ reason: 'Arquivo duplicado com chave diferente, entrou duas vezes' });

    /*
      Some o APOIO, não a DECISÃO. O valor confirmado tem autor e data;
      desfazê-lo por causa de um estorno de estoque seria revogar decisão
      humana sem que ninguém tivesse pedido.
    */
    const linha = getConnection()
      .prepare('SELECT ncm, fiscal_confirmed_at FROM core_products WHERE id = ?')
      .get(productId) as { ncm: string; fiscal_confirmed_at: string | null };
    expect(linha.ncm).toBe('87141000');
    expect(linha.fiscal_confirmed_at).toBeTruthy();
  });
});

describe('o produto que a nota CRIOU nasce auto-detectado, não confirmado', () => {
  it('o NCM veio do arquivo do fornecedor, e a tela diz isso', async () => {
    await entrar(nfeXml({ chave: CHAVE_A }));

    const criado = getConnection()
      .prepare('SELECT id, ncm, fiscal_confirmed_at FROM core_products WHERE barcode = ?')
      .get(PASTILHA.ean) as { id: string; ncm: string; fiscal_confirmed_at: string | null };
    expect(criado.ncm).toBe('87141000');
    expect(
      criado.fiscal_confirmed_at,
      'ninguém confirmou nada: o arquivo do fornecedor não é decisão da casa',
    ).toBeNull();

    const p = await classificacao(criado.id);
    const ncm = (p!.fields as Record<string, unknown>[]).find((f) => f.field === 'ncm')!;
    expect(ncm.state).toBe('AUTO_DETECTADO');
    expect(ncm.current).toBe('87141000');
  });
});

describe('o mecânico não classifica catálogo', () => {
  it('a leitura e o lote recusam quem não responde pelo cadastro', async () => {
    const mec = await loginForTest(app, {
      userId: 'mecanico',
      companyId: 'loja-xml',
      profileCodes: ['mecanico'],
    });
    const cabecalho = { Authorization: `Bearer ${mec.body.accessToken}` };

    expect((await request(app).get('/api/v1/core/fiscal/classification').set(cabecalho)).status)
      .toBe(403);
    expect(
      (await request(app)
        .post('/api/v1/core/fiscal/classification/confirm')
        .set(cabecalho)
        .send({})).status,
    ).toBe(403);
  });
});

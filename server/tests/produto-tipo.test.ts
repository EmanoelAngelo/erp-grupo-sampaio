/**
 * O TIPO DO PRODUTO — mercadoria de revenda ou peça de bancada.
 *
 * O QUE ESTES TESTES PROVAM, E POR QUE ELES SÃO ASSIM
 *
 * O defeito central desta rodada não era uma regra errada: era uma gravação que
 * NÃO ACONTECIA. O PUT do produto devolvia 200 OK com `kind: "part"` no corpo e
 * o banco continuava igual, porque o mapa de campos do `atualizarProduto` não
 * tinha `kind` nem `workshop_id`. Um teste que só olhasse o status da resposta
 * teria passado o tempo todo — passava mesmo, em outros arquivos.
 *
 * Por isso todo teste daqui cobra o ESTADO DEPOIS, lido do banco ou relido pela
 * API, e não o que a rota devolveu.
 *
 * O conserto, porém, não foi passar a gravar o tipo no PUT: isso abriria uma
 * SEGUNDA PORTA de conversão, mais larga que a primeira (o PUT do cadastro é
 * liberado também aos dois `operador_caixa_*`, que a conversão recusa com 403) e
 * sem efeitos contados nem auditoria. O PUT RECUSA alto, apontando a rota certa
 * — e aceita, sem escrever nada, o mesmo valor que já está gravado, porque é
 * assim que o formulário salva.
 *
 * E cada recusa é cobrada com o CENÁRIO QUE ELA IMPEDE montado de verdade: a
 * peça pesável, a peça sem oficina, a bancada de outra empresa, o kit, o clone.
 * Tirar qualquer um dos guardas faz o teste correspondente falhar dizendo
 * exatamente qual estado proibido passou a ser possível.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let caixa: { Authorization: string };
let gerenteLoja: { Authorization: string };
let empresa: string;
let bancada: string;
let bancadaDeOutraEmpresa: string;

async function criarProduto(corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/products').set(gerente).send(corpo);
}

function noBanco(id: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_products WHERE id = ?')
    .get(id) as Record<string, unknown>;
}

beforeEach(async () => {
  resetDbForTests();

  const g = await loginForTest(app, {
    userId: 'ger-tipo',
    companyId: 'oficina-tipo',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  empresa = g.body.company.id;

  // O operador de caixa NÃO alcança nem o cadastro de produto nem a entrada de
  // notas pelo roteador do front: os dois perfis de caixa vivem no ambiente
  // `pdv`, e as duas telas são `ROTA_GESTAO`.
  const c = await loginForTest(app, {
    userId: 'caixa-tipo',
    companyId: 'oficina-tipo',
    profileCodes: ['operador_caixa_loja'],
  });
  caixa = { Authorization: `Bearer ${c.body.accessToken}` };

  // A publicação em massa é do gerente de LOJA: a vitrine é dele.
  const gl = await loginForTest(app, {
    userId: 'ger-loja-tipo',
    companyId: 'oficina-tipo',
    profileCodes: ['gerente_loja'],
  });
  gerenteLoja = { Authorization: `Bearer ${gl.body.accessToken}` };

  const outra = await loginForTest(app, {
    userId: 'ger-outra',
    companyId: 'loja-vizinha',
    profileCodes: ['gerente_loja'],
  });

  const db = getConnection();
  const agora = new Date().toISOString();
  bancada = 'wk-tipo';
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'celulares', 'Oficina de Celulares', 'phones', 1, ?)`,
  ).run(bancada, empresa, agora);

  bancadaDeOutraEmpresa = 'wk-vizinha';
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'vizinha', 'Bancada da Vizinha', 'mobility', 1, ?)`,
  ).run(bancadaDeOutraEmpresa, outra.body.company.id, agora);
});

/**
 * A CONVERSÃO TEM UMA PORTA SÓ — e a outra recusa ALTO.
 *
 * O defeito original era o PUT que devolvia 200 e não gravava o tipo. O conserto
 * ingênuo (gravar) abriria a segunda porta: o PUT do cadastro é liberado também
 * para os dois `operador_caixa_*`, que a rota de conversão recusa com 403, e o
 * que passasse por ele não teria efeitos contados nem auditoria.
 *
 * Estes testes cobram as três metades da regra: o valor diferente é recusado, o
 * valor IGUAL passa (senão nenhuma peça existente poderia mais ser editada), e
 * nada é gravado na recusa.
 */
describe('mudar o tipo pelo PUT do cadastro é recusado, e apontando a porta certa', () => {
  it('o PUT não converte revenda em peça — 409, e o banco não muda', async () => {
    const p = await criarProduto({ name: 'Bateria', priceCents: 12000 });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Bateria', kind: 'part', workshopId: bancada });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_KIND_BY_ROUTE');
    // O ESTADO, não a resposta: era exatamente aqui que o sistema mentia.
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('retail');
    expect(linha.workshop_id).toBeNull();
  });

  /**
   * A SEGUNDA PORTA, medida com a pessoa que ela deixava passar.
   *
   * O caixa recebe 403 na rota de conversão. Se o PUT convertesse, ele faria
   * exatamente a mesma coisa por outro endereço — e sem rastro. É esta a prova
   * de que a porta fechou, e não só a de que existe uma mensagem nova.
   *
   * Desde o GAP-PRD-052 o caixa nem chega ao corpo do PUT: a rota de cadastro
   * deixou de aceitá-lo (403 antes de ler o tipo). O que este caso cobra
   * continua valendo — o tipo não muda por ele.
   */
  it('nem pelo operador de caixa, que é justamente quem a conversão recusa', async () => {
    const p = await criarProduto({ name: 'Fonte', priceCents: 4000 });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(caixa)
      .send({ name: 'Fonte', kind: 'part', workshopId: bancada });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
    expect(noBanco(p.body.id).kind).toBe('retail');
  });

  it('o PUT também não devolve a peça à loja', async () => {
    const p = await criarProduto({ name: 'Capa', priceCents: 4000, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Capa', kind: 'retail' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_KIND_BY_ROUTE');
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
  });

  it('o PUT não muda a peça de bancada: o saldo mudaria de gaveta calado', async () => {
    const outra = 'wk-mobilidade';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'motos', 'Oficina de Motos', 'mobility', 1, ?)`,
      )
      .run(outra, empresa, new Date().toISOString());
    const p = await criarProduto({ name: 'Parafuso', priceCents: 300, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Parafuso', kind: 'part', workshopId: outra });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_KIND_BY_ROUTE');
    expect(noBanco(p.body.id).workshop_id).toBe(bancada);
  });

  /**
   * O MESMO VALOR NÃO É MUDANÇA.
   *
   * Este é o teste que impede o conserto de virar outra travação: o formulário
   * manda o objeto INTEIRO toda vez que salva. Se a presença do campo bastasse
   * para recusar, trocar o preço de uma bateria devolveria 409 e nenhuma peça já
   * existente poderia mais ser editada.
   */
  it('mandar o tipo que já está gravado passa e edita o resto', async () => {
    const p = await criarProduto({ name: 'Tela', priceCents: 30000, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Tela', priceCents: 35000, kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
    expect(linha.price_cents).toBe(35000);
  });

  it('e para a mercadoria também, que é como o formulário dela salva', async () => {
    const p = await criarProduto({ name: 'Capa de silicone', priceCents: 4000 });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Capa de silicone', priceCents: 4500, kind: 'retail', workshopId: null });

    expect(res.status).toBe(200);
    expect(noBanco(p.body.id).price_cents).toBe(4500);
  });

  it('campo ausente PRESERVA o tipo: um PUT de preço não devolve a peça à loja', async () => {
    const p = await criarProduto({ name: 'Tela', priceCents: 30000, kind: 'part', workshopId: bancada });

    await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Tela', priceCents: 35000 });

    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
    expect(linha.price_cents).toBe(35000);
  });

  /**
   * A MERCADORIA SUJA CONTINUA EDITÁVEL.
   *
   * Linha antiga: revenda carregando `workshop_id` de um cadastro anterior. Para
   * ela o campo não significa nada, e o formulário manda `workshopId: null`.
   * Comparar a bancada de uma mercadoria transformaria a limpeza desse estado
   * numa recusa — e o produto ficaria impossível de salvar, sem que ninguém
   * tivesse pedido conversão nenhuma.
   */
  it('revenda com oficina de cadastro antigo é limpa, não recusada', async () => {
    const p = await criarProduto({ name: 'Cabo', priceCents: 900 });
    getConnection()
      .prepare('UPDATE core_products SET workshop_id = ? WHERE id = ?')
      .run(bancada, p.body.id);

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Cabo', kind: 'retail', workshopId: null });

    expect(res.status).toBe(200);
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('retail');
    expect(linha.workshop_id).toBeNull();
  });

  it('a rota de conversão continua sendo a que converte, e grava', async () => {
    const p = await criarProduto({ name: 'Bateria', priceCents: 12000 });
    expect(noBanco(p.body.id).kind).toBe('retail');

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
  });

  /**
   * TIPO INVENTADO NA ROTA DE CONVERSÃO É RECUSADO — e não vira "volta".
   *
   * A rota escolhe o caminho por um `kind === 'part' ? converter : desconverter`.
   * Sem a recusa do valor desconhecido ANTES dessa escolha, qualquer coisa que
   * não seja exatamente `"part"` cai no `else` e roda `converterParaRevenda` —
   * que não valida nada, porque recebe `'retail'` fixo por dentro.
   *
   * O estrago é silencioso e é o pior dos dois lados: um `kind` com erro de
   * digitação vindo de integração DEVOLVE a peça à loja, o saldo da bancada
   * passa a contar como mercadoria, e a auditoria registra `product.kind.to_retail`
   * como se alguém tivesse pedido isso. Ninguém pediu.
   *
   * A peça é montada de propósito ANTES: com um produto de revenda o defeito
   * seria invisível (converter revenda em revenda não muda nada), e o teste
   * passaria mesmo com o guarda arrancado.
   */
  it('tipo inventado na rota de conversão não devolve a peça à loja pela porta dos fundos', async () => {
    const p = await criarProduto({
      name: 'Bateria',
      priceCents: 12000,
      kind: 'part',
      workshopId: bancada,
    });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'peça', workshopId: bancada });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_INVALID_PAYLOAD');
    // O estado DEPOIS é o que importa: a peça continua peça, na bancada dela.
    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
  });

  it('e a volta: revenda não fica carregando a oficina do cadastro anterior', async () => {
    const p = await criarProduto({ name: 'Capa', priceCents: 4000, kind: 'part', workshopId: bancada });

    await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'retail' });

    const linha = noBanco(p.body.id);
    expect(linha.kind).toBe('retail');
    expect(linha.workshop_id).toBeNull();
  });
});

describe('peça sem bancada não pode existir', () => {
  it('o cadastro recusa', async () => {
    const res = await criarProduto({ name: 'Parafuso', priceCents: 500, kind: 'part' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PART_WORKSHOP_REQUIRED');
    // E nada foi gravado: a recusa vem ANTES da transação.
    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(0);
  });

  it('a conversão recusa a peça sem bancada', async () => {
    const p = await criarProduto({ name: 'Flex', priceCents: 2000 });
    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PART_WORKSHOP_REQUIRED');
    expect(noBanco(p.body.id).kind).toBe('retail');
  });

  it('bancada inexistente é 404, e bancada de outra empresa é 403', async () => {
    const some = await criarProduto({
      name: 'Alto-falante',
      priceCents: 1000,
      kind: 'part',
      workshopId: 'nao-existe',
    });
    expect(some.status).toBe(404);
    expect(some.body.error.code).toBe('CORE_WORKSHOP_NOT_FOUND');

    // O saldo é por empresa: a peça não pode apontar para a bancada da vizinha.
    const vizinha = await criarProduto({
      name: 'Alto-falante',
      priceCents: 1000,
      kind: 'part',
      workshopId: bancadaDeOutraEmpresa,
    });
    expect(vizinha.status).toBe(403);
    expect(vizinha.body.error.code).toBe('CORE_WORKSHOP_OTHER_COMPANY');
  });

  /**
   * BANCADA QUE NÃO TRABALHA COM PEÇA.
   *
   * As duas oficinas do grupo têm `parts: true`, então este cenário só existe
   * pela terceira porta: uma linha de `core_workshops` com um `kind` que
   * `WorkshopCapabilities` não descreve. Isso não é hipótese de laboratório —
   * é o estado de qualquer bancada nova cadastrada antes de alguém escrever a
   * capacidade dela, e é o que uma migração produz quando o `kind` chega
   * escrito errado.
   *
   * O que o teste cobra é a doutrina que o próprio arquivo de capacidades diz
   * seguir: não se libera por omissão. Uma bancada que ninguém descreveu não
   * ganha estoque de peças de brinde — porque estoque de peça é saldo, e saldo
   * é dinheiro que sai por uma porta que ninguém abriu de propósito.
   */
  it('bancada de tipo que ninguém descreveu não recebe peça por omissão', async () => {
    const semPecas = 'wk-sem-pecas';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'estetica', 'Bancada de Estética', 'estetica', 1, ?)`,
      )
      .run(semPecas, empresa, new Date().toISOString());

    const res = await criarProduto({
      name: 'Cera de polimento',
      priceCents: 4000,
      kind: 'part',
      workshopId: semPecas,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_WITHOUT_PARTS');
    // A frase diz QUAL bancada: "a oficina não trabalha com peças" mandaria
    // quem cadastrou procurar em qual das bancadas errou.
    expect(res.body.error.message).toContain('Bancada de Estética');

    // E a recusa não é só do cadastro novo: a conversão passa pelo mesmo
    // invariante, senão bastaria criar como revenda e converter depois.
    const revenda = await criarProduto({ name: 'Cera de polimento', priceCents: 4000 });
    const convertido = await request(app)
      .post(`/api/v1/core/products/${revenda.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: semPecas });

    expect(convertido.status).toBe(409);
    expect(convertido.body.error.code).toBe('CORE_WORKSHOP_WITHOUT_PARTS');
    expect(noBanco(revenda.body.id).kind).toBe('retail');
  });
});

describe('o que uma peça não pode ser', () => {
  /**
   * `kind` FORA DOS DOIS VALORES.
   *
   * A rota de conversão confere o tipo antes de chamar o serviço; o PUT do
   * cadastro NÃO — ele repassa o corpo inteiro. Sem a recusa dentro do
   * invariante, um `kind: "peça"` vindo de uma integração mal escrita era
   * gravado como veio, e o produto sumia dos dois mundos ao mesmo tempo: a
   * tela de peças lista `kind = 'part'` e não o acharia, enquanto a vitrine e
   * a busca do PDV escondem `kind = 'part'` e o mostrariam. Um item meio
   * visível é pior que um escondido — ninguém procura o que acha que está lá.
   */
  it('tipo fora de "part" e "retail" é recusado, não gravado como veio', async () => {
    const p = await criarProduto({ name: 'Bateria', priceCents: 12000 });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Bateria', kind: 'peça' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_INVALID_PAYLOAD');
    // A frase devolve o valor recusado: quem escreveu a integração precisa ver
    // o que mandou para achar o próprio erro.
    expect(res.body.error.message).toContain('peça');
    expect(noBanco(p.body.id).kind).toBe('retail');
  });

  it('pesável — e o PLU NÃO é apagado pela recusa', async () => {
    const p = await criarProduto({
      name: 'Solda em fio',
      priceCents: 900,
      weighable: true,
      pluCode: '0042',
    });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_BE_WEIGHABLE');
    // A recusa não pode ter mexido na balança: o produto continua lá, com PLU.
    const linha = noBanco(p.body.id);
    expect(linha.weighable).toBe(1);
    expect(linha.plu_code).toBe('0042');
    expect(linha.kind).toBe('retail');
  });

  it('ganhar PLU depois, por um PUT — o invariante vale nos dois sentidos', async () => {
    const p = await criarProduto({ name: 'Cola', priceCents: 700, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Cola', pluCode: '0099' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_BE_WEIGHABLE');
    expect(noBanco(p.body.id).plu_code).toBeNull();
  });

  it('virar pesável depois, por um PUT', async () => {
    const p = await criarProduto({ name: 'Fita', priceCents: 700, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .put(`/api/v1/core/products/${p.body.id}`)
      .set(gerente)
      .send({ name: 'Fita', weighable: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_BE_WEIGHABLE');
    expect(noBanco(p.body.id).weighable).toBe(0);
  });

  it('kit — nem virando peça depois, nem virando kit depois', async () => {
    const componente = await criarProduto({ name: 'Peça avulsa', priceCents: 100 });
    const kit = await criarProduto({ name: 'Kit de reparo', priceCents: 5000 });
    await request(app)
      .put(`/api/v1/core/products/${kit.body.id}/kit`)
      .set(gerente)
      .send({ components: [{ componentId: componente.body.id, quantity: 2 }] });

    // O kit não vira peça.
    const viraPeca = await request(app)
      .post(`/api/v1/core/products/${kit.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });
    expect(viraPeca.status).toBe(409);
    expect(viraPeca.body.error.code).toBe('CORE_PART_CANNOT_BE_KIT');

    // E o componente do kit também não: o kit continuaria dando baixa nele.
    const componenteViraPeca = await request(app)
      .post(`/api/v1/core/products/${componente.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });
    expect(componenteViraPeca.status).toBe(409);
    expect(componenteViraPeca.body.error.code).toBe('CORE_PART_IS_KIT_COMPONENT');
  });

  it('o contorno pelo outro lado: montar kit em cima de uma peça', async () => {
    const peca = await criarProduto({ name: 'Bateria', priceCents: 9000, kind: 'part', workshopId: bancada });
    const outro = await criarProduto({ name: 'Cabo', priceCents: 900 });

    // Peça como kit.
    const comoKit = await request(app)
      .put(`/api/v1/core/products/${peca.body.id}/kit`)
      .set(gerente)
      .send({ components: [{ componentId: outro.body.id, quantity: 1 }] });
    expect(comoKit.status).toBe(409);
    expect(comoKit.body.error.code).toBe('CORE_PART_CANNOT_BE_KIT');

    // Peça como componente de kit.
    const kit = await criarProduto({ name: 'Kit', priceCents: 12000 });
    const comoComponente = await request(app)
      .put(`/api/v1/core/products/${kit.body.id}/kit`)
      .set(gerente)
      .send({ components: [{ componentId: peca.body.id, quantity: 1 }] });
    expect(comoComponente.status).toBe(409);
    expect(comoComponente.body.error.code).toBe('CORE_PART_IS_KIT_COMPONENT');
  });

  it('grade — a geração de variantes de uma peça é recusada', async () => {
    const peca = await criarProduto({ name: 'Tela', priceCents: 30000, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .post(`/api/v1/core/products/${peca.body.id}/variants`)
      .set(gerente)
      .send({ axes: { cor: ['Preto', 'Branco'] } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_HAVE_VARIANTS');
    // Nenhum filho ficou para trás.
    const filhos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE parent_id = ?')
      .get(peca.body.id) as { n: number };
    expect(filhos.n).toBe(0);
  });

  /**
   * PRODUTO COM GRADE NÃO VIRA PEÇA — nos dois papéis.
   *
   * O sentido oposto (peça não gera grade) mora em `generateVariants` e tem o
   * teste logo acima. Este é o da conversão: o modelo que JÁ tem variantes, e a
   * variante que já tem modelo. Sem a recusa, converter o modelo deixaria
   * filhos de revenda pendurados numa peça de bancada, e converter a variante
   * criaria uma peça cujo pai é mercadoria de loja — meia grade na oficina,
   * meia na vitrine.
   *
   * A recusa vive em `exigirTipoCoerente`, e não dentro de `converterParaPeca`:
   * dentro da conversão ela valeria só para quem entrasse por aquela porta.
   */
  it('grade — converter o modelo OU uma variante em peça é recusado', async () => {
    const modelo = await criarProduto({ name: 'Camiseta Polo', priceCents: 5000 });
    const grade = await request(app)
      .post(`/api/v1/core/products/${modelo.body.id}/variants`)
      .set(gerente)
      .send({ axes: { tamanho: ['P', 'M'] } });
    expect(grade.status).toBe(201);

    const oModelo = await request(app)
      .post(`/api/v1/core/products/${modelo.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });
    expect(oModelo.status).toBe(409);
    expect(oModelo.body.error.code).toBe('CORE_PART_CANNOT_HAVE_VARIANTS');
    // A frase distingue os dois papéis: quem TEM grade é mandado converter a
    // variante, quem É variante ouve o nome do modelo de que depende. Uma frase
    // só mandaria metade das pessoas procurar o que não existe.
    expect(oModelo.body.error.message).toContain('Converta a variante, não o modelo.');
    expect(noBanco(modelo.body.id).kind).toBe('retail');

    const filho = getConnection()
      .prepare('SELECT id FROM core_products WHERE parent_id = ? LIMIT 1')
      .get(modelo.body.id) as { id: string };
    const aVariante = await request(app)
      .post(`/api/v1/core/products/${filho.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });
    expect(aVariante.status).toBe(409);
    expect(aVariante.body.error.code).toBe('CORE_PART_CANNOT_HAVE_VARIANTS');
    // O nome do modelo, e não "um modelo": quem lê precisa saber qual cadastro
    // abrir para desfazer a grade.
    expect(aVariante.body.error.message).toContain('variante de "Camiseta Polo"');
    expect(noBanco(filho.id).kind).toBe('retail');
  });

  /**
   * A RECUSA DE GRADE VALE PARA O OUTRO CHAMADOR TAMBÉM.
   *
   * Enquanto morava dentro de `converterParaPeca`, ela protegia uma porta só. No
   * invariante, ela alcança o cadastro: a linha suja que o banco antigo pode ter
   * — peça COM pai, estado que nada validava até esta rodada — para de ser
   * gravada de novo a cada PUT, e a mensagem diz o que ela é.
   */
  it('grade — a peça-variante que já estava no banco é denunciada ao salvar o cadastro', async () => {
    const modelo = await criarProduto({ name: 'Camiseta Polo', priceCents: 5000 });
    await request(app)
      .post(`/api/v1/core/products/${modelo.body.id}/variants`)
      .set(gerente)
      .send({ axes: { tamanho: ['P'] } });
    const filho = getConnection()
      .prepare('SELECT id FROM core_products WHERE parent_id = ? LIMIT 1')
      .get(modelo.body.id) as { id: string };

    // O estado que só o banco produz: variante marcada como peça.
    getConnection()
      .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
      .run(bancada, filho.id);

    const res = await request(app)
      .put(`/api/v1/core/products/${filho.id}`)
      .set(gerente)
      .send({ name: 'Camiseta Polo P', priceCents: 5500, kind: 'part', workshopId: bancada });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_HAVE_VARIANTS');
    expect(res.body.error.message).toContain('Camiseta Polo');
    // E a recusa não gravou o preço novo: ela vem antes do UPDATE.
    expect(noBanco(filho.id).price_cents).toBe(5000);
  });

  /**
   * O OUTRO PAPEL DA GRADE, PELA PORTA DO CADASTRO.
   *
   * O teste acima cobre a VARIANTE suja. Falta o MODELO sujo — grade marcada
   * como peça com filhos de revenda pendurados —, e ele não é o mesmo caso: a
   * consulta que denuncia a variante olha `parent_id` do próprio produto, e a
   * que denuncia o modelo procura FILHOS. São duas consultas e duas frases
   * diferentes em `exigirQueNaoTenhaGrade`, e até aqui só uma delas era cobrada
   * na porta do PUT. Apagar a metade dos filhos deixaria este teste verde.
   */
  it('grade — o MODELO-peça que já estava no banco também é denunciado ao salvar', async () => {
    const modelo = await criarProduto({ name: 'Camiseta Polo', priceCents: 5000 });
    const grade = await request(app)
      .post(`/api/v1/core/products/${modelo.body.id}/variants`)
      .set(gerente)
      .send({ axes: { tamanho: ['P', 'M'] } });
    expect(grade.status).toBe(201);

    // O estado que só o banco antigo produz: modelo de grade marcado como peça.
    getConnection()
      .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
      .run(bancada, modelo.body.id);

    const res = await request(app)
      .put(`/api/v1/core/products/${modelo.body.id}`)
      .set(gerente)
      .send({ name: 'Camiseta Polo', priceCents: 5500, kind: 'part', workshopId: bancada });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PART_CANNOT_HAVE_VARIANTS');
    // A frase do MODELO, não a da variante: quem tem grade precisa converter a
    // variante, e a outra frase o mandaria procurar um modelo que é ele mesmo.
    expect(res.body.error.message).toContain('Converta a variante, não o modelo.');
    // E o preço novo não entrou: a recusa vem antes do UPDATE.
    expect(noBanco(modelo.body.id).price_cents).toBe(5000);
  });

  /**
   * A ORDEM DAS DUAS PORTAS, quando as duas recusariam.
   *
   * Converter uma grade pelo PUT bate em dois guardas de uma vez: o da porta
   * (`CORE_PRODUCT_KIND_BY_ROUTE`) e o da grade (`CORE_PART_CANNOT_HAVE_VARIANTS`).
   * Quem responde é o da PORTA, e isso é o certo: mandar quem tentou converter
   * pelo cadastro desfazer a grade primeiro o faria desmontar seis variantes
   * para descobrir, no fim, que a conversão nunca ia acontecer por ali.
   *
   * O teste existe para fixar a ordem: com a porta aberta, a resposta viraria a
   * outra — e o produto continuaria mudando de tipo sem efeitos e sem auditoria
   * em todos os casos que a grade não pega.
   */
  it('grade — a tentativa de converter pelo PUT é barrada na PORTA, antes da grade', async () => {
    const modelo = await criarProduto({ name: 'Camiseta Polo', priceCents: 5000 });
    await request(app)
      .post(`/api/v1/core/products/${modelo.body.id}/variants`)
      .set(gerente)
      .send({ axes: { tamanho: ['P', 'M'] } });
    const filho = getConnection()
      .prepare('SELECT id FROM core_products WHERE parent_id = ? LIMIT 1')
      .get(modelo.body.id) as { id: string };

    for (const alvo of [modelo.body.id as string, filho.id]) {
      const res = await request(app)
        .put(`/api/v1/core/products/${alvo}`)
        .set(gerente)
        .send({ name: 'Camiseta Polo', kind: 'part', workshopId: bancada });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CORE_PRODUCT_KIND_BY_ROUTE');
      expect(noBanco(alvo).kind).toBe('retail');
      expect(noBanco(alvo).workshop_id).toBeNull();
    }
  });

  it('publicada na loja online', async () => {
    const nova = await criarProduto({
      name: 'Carregador',
      priceCents: 4000,
      kind: 'part',
      workshopId: bancada,
      publishOnline: true,
    });
    expect(nova.status).toBe(409);
    expect(nova.body.error.code).toBe('CORE_PART_CANNOT_BE_PUBLISHED');

    const peca = await criarProduto({ name: 'Carregador', priceCents: 4000, kind: 'part', workshopId: bancada });
    const publicar = await request(app)
      .put(`/api/v1/core/products/${peca.body.id}`)
      .set(gerente)
      .send({ name: 'Carregador', publishOnline: true });
    expect(publicar.status).toBe(409);
    expect(publicar.body.error.code).toBe('CORE_PART_CANNOT_BE_PUBLISHED');
    expect(noBanco(peca.body.id).publish_online).toBe(0);
  });
});

describe('a publicação em massa não tropeça na peça', () => {
  it('peça não entra na prontidão online nem derruba o lote', async () => {
    // Uma peça COMPLETA — preço, saldo, foto e medidas —, que passaria por
    // "pronta para publicar" se a lista não a excluísse, e aí a publicação em
    // massa inteira morreria na recusa levando junto os produtos de loja.
    const peca = await criarProduto({
      name: 'Bateria completa',
      priceCents: 9000,
      kind: 'part',
      workshopId: bancada,
      weightGrams: 200,
      heightCm: 5,
      widthCm: 5,
      lengthCm: 2,
    });
    const loja = await criarProduto({
      name: 'Capa de silicone',
      priceCents: 4000,
      weightGrams: 50,
      heightCm: 10,
      widthCm: 8,
      lengthCm: 1,
    });
    const db = getConnection();
    const agora = new Date().toISOString();
    for (const id of [peca.body.id, loja.body.id]) {
      db.prepare(
        `INSERT INTO core_product_images (id, company_id, product_id, url, file_name, position,
                                          is_primary, created_at)
         VALUES (?, ?, ?, '/uploads/x.jpg', 'x.jpg', 0, 1, ?)`,
      ).run(`img-${id}`, empresa, id, agora);
      await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
        productId: id,
        movementType: 'in',
        quantity: 3,
        referenceType: 'entrada',
        referenceId: `nf-${id}`,
      });
    }

    const prontidao = await request(app)
      .get('/api/v1/core/products/prontidao-online')
      .set(gerente);
    expect(prontidao.body.items.map((i: { id: string }) => i.id)).toEqual([loja.body.id]);

    const lote = await request(app)
      .post('/api/v1/core/products/publicar-prontos')
      .set(gerenteLoja)
      .send({});
    expect(lote.status).toBe(200);
    expect(lote.body.published).toEqual([loja.body.id]);
    expect(noBanco(peca.body.id).publish_online).toBe(0);
  });
});

describe('o clone não é o caminho de contorno', () => {
  it('clonar peça mantém a bancada e continua sendo peça', async () => {
    const peca = await criarProduto({ name: 'Conector', priceCents: 1500, kind: 'part', workshopId: bancada });

    const res = await request(app)
      .post(`/api/v1/core/products/${peca.body.id}/clone`)
      .set(gerente)
      .send({});

    expect(res.status).toBe(201);
    const linha = noBanco(res.body.id);
    expect(linha.kind).toBe('part');
    expect(linha.workshop_id).toBe(bancada);
    // Clone nasce fora da vitrine, e peça nem poderia estar nela.
    expect(linha.publish_online).toBe(0);
  });

  it('clonar uma peça INCOERENTE que já estava no banco é recusado', async () => {
    /*
      O cenário é o das linhas antigas: até esta rodada nada validava o par, e
      o banco pode ter peça apontando para bancada de outra empresa. Clonar é o
      caminho mais curto para multiplicar esse estado — e o clone passa pelo
      mesmo invariante do cadastro justamente para não multiplicar.
    */
    const peca = await criarProduto({ name: 'Microfone', priceCents: 2500 });
    getConnection()
      .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
      .run(bancadaDeOutraEmpresa, peca.body.id);

    const res = await request(app)
      .post(`/api/v1/core/products/${peca.body.id}/clone`)
      .set(gerente)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_OTHER_COMPANY');
    // E nenhum clone ficou para trás.
    const copias = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_products WHERE name LIKE 'Microfone%'")
      .get() as { n: number };
    expect(copias.n).toBe(1);
  });
});

describe('a grade é o outro escritor, e escreve o par normalizado', () => {
  /**
   * O PAI SUJO NÃO CONTAMINA OS FILHOS.
   *
   * `generateVariants` copia `kind` e `workshop_id` do pai por INSERT cru, e é
   * o único escritor do par que MULTIPLICA: um pai produz seis filhos de uma
   * vez. O estado que o alimenta existe no banco de verdade, porque até esta
   * rodada nada validava o par — mercadoria de revenda carregando o
   * `workshop_id` de um cadastro antigo.
   *
   * Sem a normalização, cada variante nasceria com a oficina do pai. E isso
   * tem consequência: `addPart` compara `product.workshop_id` com o da OS
   * ANTES de olhar o `kind`. Seis camisetas passariam a ser aceitas ou
   * recusadas numa ordem de serviço por causa de um campo que não deveria
   * significar nada nelas.
   */
  it('variante de mercadoria não herda oficina de cadastro antigo do pai', async () => {
    const pai = await criarProduto({ name: 'Camiseta Lisa', priceCents: 5000 });
    // O estado que só o banco produz: revenda COM oficina.
    getConnection()
      .prepare('UPDATE core_products SET workshop_id = ? WHERE id = ?')
      .run(bancada, pai.body.id);
    expect(noBanco(pai.body.id).workshop_id).toBe(bancada);

    const res = await request(app)
      .post(`/api/v1/core/products/${pai.body.id}/variants`)
      .set(gerente)
      .send({ axes: { tamanho: ['P', 'M'] } });
    expect(res.status).toBe(201);

    const filhos = getConnection()
      .prepare('SELECT kind, workshop_id FROM core_products WHERE parent_id = ?')
      .all(pai.body.id) as { kind: string; workshop_id: string | null }[];
    expect(filhos).toHaveLength(2);
    for (const filho of filhos) {
      expect(filho.kind).toBe('retail');
      expect(filho.workshop_id).toBeNull();
    }
  });
});

describe('a rota de conversão conta o que fez', () => {
  async function produtoDaVitrine(nome: string, precoCents = 8000) {
    const p = await criarProduto({
      name: nome,
      priceCents: precoCents,
      publishOnline: true,
    });
    getConnection()
      .prepare('UPDATE core_products SET featured_online = 1 WHERE id = ?')
      .run(p.body.id);
    return p.body.id as string;
  }

  it('converter em peça despublica, tira o destaque e devolve os efeitos', async () => {
    const id = await produtoDaVitrine('Fonte 5V');
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: id,
      movementType: 'in',
      quantity: 7,
      referenceType: 'entrada',
      referenceId: 'nf-fonte',
    });

    const res = await request(app)
      .post(`/api/v1/core/products/${id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('part');
    expect(res.body.workshopId).toBe(bancada);
    expect(res.body.workshopName).toBe('Oficina de Celulares');
    expect(res.body.efeitos.despublicadoDaLoja).toBe(true);
    expect(res.body.efeitos.destaqueRemovido).toBe(true);
    expect(res.body.efeitos.saldoQueMudaDeLado).toBe(7);
    // Nada prometido a ninguém: os 7 estão inteiros à disposição da bancada.
    expect(res.body.efeitos.reservadoEmAberto).toBe(0);
    expect(res.body.efeitos.semPrecoDeVenda).toBe(false);
    expect(res.body.aviso).toContain('Saiu da loja online');

    // Os efeitos são o que ACONTECEU, não uma promessa.
    const linha = noBanco(id);
    expect(linha.publish_online).toBe(0);
    expect(linha.featured_online).toBe(0);
    expect(linha.kind).toBe('part');
  });

  /**
   * O NÚMERO QUE PROMETIA DEMAIS.
   *
   * `saldoNaGaveta` (o nome antigo) contava o saldo BRUTO e a tela dizia "12
   * passam a ser contadas na gaveta da bancada". Só que `addPart` cobra o
   * DISPONÍVEL — bruto menos reservado —, então uma peça com pedido da loja em
   * aberto entregava à bancada um número que o lançamento da OS recusaria, e o
   * mecânico descobria a diferença com o aparelho aberto na mesa.
   *
   * O conserto tem duas metades e as duas são cobradas aqui: o campo passou a
   * se chamar pelo que ele é, e o reservado viaja junto para o aviso poder
   * descontá-lo em palavras.
   *
   * Tirar `reservadoEmAberto` da resposta ou voltar a ler só `quantity` faz
   * este teste falhar na frase do aviso, que é onde o defeito aparecia.
   */
  it('o aviso não promete à bancada o que já está prometido', async () => {
    const id = await produtoDaVitrine('Tela AMOLED');
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: id,
      movementType: 'in',
      quantity: 12,
      referenceType: 'entrada',
      referenceId: 'nf-tela',
    });
    // Reserva tem QUATRO origens (OS aberta, pedido da loja online, pré-venda e
    // locação). O número
    // é escrito direto porque o que está sob prova é o AVISO, não quem reservou.
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 8 WHERE company_id = ? AND product_id = ?')
      .run(empresa, id);

    const res = await request(app)
      .post(`/api/v1/core/products/${id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    // O bruto é o que muda de lado: os 12 passam a ser contados na bancada.
    expect(res.body.efeitos.saldoQueMudaDeLado).toBe(12);
    // E o pedaço prometido vai junto, senão o aviso mente por omissão.
    expect(res.body.efeitos.reservadoEmAberto).toBe(8);
    expect(res.body.aviso).toContain('12 em estoque');
    expect(res.body.aviso).toContain('8 está prometido');
    /*
      MAIS DE UMA ORIGEM, e nenhuma delas falsa.

      A frase listava "orçamento", que NÃO reserva — é papel; quem reserva é a
      pré-venda. E desde a rodada 55 a oficina reserva também. Culpar a origem
      lembrada (o pedido online) descreveria o estado errado na maioria dos
      casos, e nomear uma origem impossível manda procurar onde não há nada.
    */
    expect(res.body.aviso).toContain('OS aberta');
    expect(res.body.aviso).toContain('locação');
    expect(res.body.aviso).not.toContain('orçamento');

    // E o disponível é MESMO menor do que o bruto: a OS desta bancada só
    // consegue lançar 4. Sem esta linha, o teste provaria a frase e não o fato.
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Cliente', workshopId: bancada, complaint: 'tela quebrada' });
    const lancamento = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/parts`)
      .set(gerente)
      .send({ productId: id, quantity: 5 });
    expect(lancamento.status).toBe(409);
    expect(lancamento.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
  });

  /**
   * A LINHA DO PRODUTO NÃO ATRAVESSA MAIS A RESPOSTA.
   *
   * `ResultadoDoTipo.product` carregava a linha inteira de `core_products` —
   * `cost_cents` incluído — do serviço até o cliente, e nenhuma das duas telas
   * que convertem lia um campo dela: as duas releem o produto pelo caminho
   * normal logo depois. Era escritor sem leitor, que é o defeito que esta
   * rodada inteira existe para não repetir.
   */
  it('a resposta da conversão não carrega a linha do produto que ninguém lê', async () => {
    const p = await criarProduto({ name: 'Alto-falante', priceCents: 6000, costCents: 2500 });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('product');
    // O que a tela LÊ continua vindo inteiro.
    expect(res.body.kind).toBe('part');
    expect(res.body.workshopName).toBe('Oficina de Celulares');
    expect(res.body.efeitos).toBeTruthy();
  });

  it('peça sem preço é anunciada ANTES de virar peça de graça na OS', async () => {
    // É assim que a importação de XML cria produto novo: preço zero, de
    // propósito. Como peça, `addPart` cobraria `price_cents` e a OS fecharia
    // sem custo nenhum.
    const p = await criarProduto({ name: 'Peça da nota', priceCents: 0 });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    expect(res.body.efeitos.semPrecoDeVenda).toBe(true);
    expect(res.body.aviso).toContain('R$ 0,00');
  });

  it('conta as vendas anteriores: o histórico não some, e a pessoa precisa saber', async () => {
    const p = await criarProduto({ name: 'Cabo USB', priceCents: 3000 });
    const agora = new Date().toISOString();
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               total_cents, idempotency_key, created_at)
       VALUES ('venda-1', ?, 1, 'concluida', 3000, 0, 3000, 'idem-1', ?)`,
    ).run(empresa, agora);
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description,
                                    quantity, unit_price_cents, discount_cents, total_cents)
       VALUES ('item-1', 'venda-1', ?, ?, 'Cabo USB', 1, 3000, 0, 3000)`,
    ).run(empresa, p.body.id);

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.body.efeitos.vendasAnteriores).toBe(1);
    expect(res.body.aviso).toContain('venda(s) de balcão');
  });

  it('a volta devolve o saldo da gaveta para a loja, e NÃO republica', async () => {
    const id = await produtoDaVitrine('Bateria externa');
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: id,
      movementType: 'in',
      quantity: 4,
      referenceType: 'entrada',
      referenceId: 'nf-bateria',
    });
    await request(app)
      .post(`/api/v1/core/products/${id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    const volta = await request(app)
      .post(`/api/v1/core/products/${id}/tipo`)
      .set(gerente)
      .send({ kind: 'retail' });

    expect(volta.status).toBe(200);
    expect(volta.body.kind).toBe('retail');
    expect(volta.body.workshopId).toBeNull();
    // O aviso existe para a tela dizer ANTES: o saldo volta a ser da loja.
    expect(volta.body.efeitos.saldoQueMudaDeLado).toBe(4);
    const linha = noBanco(id);
    expect(linha.workshop_id).toBeNull();
    // Republicar por herança poria à venda algo que ninguém revisou desde então.
    expect(linha.publish_online).toBe(0);
  });

  it('o rastro guarda os efeitos, não só o novo tipo', async () => {
    const id = await produtoDaVitrine('Película');
    await request(app)
      .post(`/api/v1/core/products/${id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    const linha = getConnection()
      .prepare(
        "SELECT action, detail FROM core_audit_log WHERE action = 'product.kind.to_part' LIMIT 1",
      )
      .get() as { action: string; detail: string } | undefined;
    expect(linha).toBeTruthy();
    const detalhe = JSON.parse(String(linha?.detail));
    expect(detalhe.workshopId).toBe(bancada);
    expect(detalhe.despublicadoDaLoja).toBe(true);
  });
});

describe('quem alcança a tela é quem pode converter', () => {
  it('o operador de caixa não converte — ele não chega a nenhuma das duas telas', async () => {
    const p = await criarProduto({ name: 'Bateria', priceCents: 9000 });
    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(caixa)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('o caixa da OFICINA também não converte — os dois perfis de caixa vivem no PDV', async () => {
    const c = await loginForTest(app, {
      userId: 'caixa-ofic-tipo',
      companyId: 'oficina-tipo',
      profileCodes: ['operador_caixa_oficina'],
    });
    const p = await criarProduto({ name: 'Bateria', priceCents: 9000 });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set({ Authorization: `Bearer ${c.body.accessToken}` })
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
    expect(noBanco(p.body.id).kind).toBe('retail');
  });

  /**
   * A PORTA ABERTA, e não só a fechada.
   *
   * Testes que só provam recusa ficam verdes com a permissão fechada para todo
   * mundo — inclusive para quem precisa dela, e aí a rodada entrega uma tela
   * que não funciona para ninguém. `estoquista` é quem recebe a carga e alcança
   * as DUAS telas da interseção: o cadastro do produto e a entrada de notas. É
   * ele quem descobre, com a nota na mão, que o item é peça de bancada.
   */
  it('o estoquista converte: ele alcança o cadastro E a entrada de notas', async () => {
    const e = await loginForTest(app, {
      userId: 'estoq-tipo',
      companyId: 'oficina-tipo',
      profileCodes: ['estoquista'],
    });
    const p = await criarProduto({ name: 'Conector da nota', priceCents: 1500 });

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set({ Authorization: `Bearer ${e.body.accessToken}` })
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(200);
    expect(noBanco(p.body.id).kind).toBe('part');
    expect(noBanco(p.body.id).workshop_id).toBe(bancada);
  });

  it('produto de outra empresa não é encontrado', async () => {
    const p = await criarProduto({ name: 'Bateria', priceCents: 9000 });
    getConnection()
      .prepare("UPDATE core_products SET company_id = 'loja-vizinha' WHERE id = ?")
      .run(p.body.id);

    const res = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: bancada });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');
  });
});

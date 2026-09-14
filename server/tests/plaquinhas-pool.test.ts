/**
 * O POOL DE PLAQUINHAS — o número existe antes da máquina (rodada 53).
 *
 * ## O que este arquivo prova
 *
 * A oficina imprime uma folha de adesivos, cola nas motos do pátio e só então
 * cadastra cada máquina com o número que já está nela. Isso inverte a ordem
 * que o sistema conhecia — a plaquinha nascia junto do equipamento — e a
 * inversão só é segura se três coisas valerem ao mesmo tempo:
 *
 *   1. a numeração é UMA. Os dois caminhos (com plaquinha escolhida e sem)
 *      saem da mesma sequência do grupo, e o pool registra os dois. Duas
 *      numerações vivas dariam dois adesivos com o mesmo número em duas motos;
 *   2. o estado anda numa direção só: gerada → disponível → associada. E
 *      liberar exige o PAPEL — número liberado sem folha exportada é número
 *      que o cadastro aceita e que não existe colado em lugar nenhum;
 *   3. a REGRA DE OURO do dono: plaquinha com QR é de PJ Motors e da Oficina.
 *      As outras quatro empresas identificam mercadoria por etiqueta
 *      comercial, e a recusa diz isso com todas as letras.
 *
 * ## As mordidas
 *
 *  - tire `exigirEmpresaComPlaquinha` de qualquer rota e a Gringa gera lote;
 *  - deixe `liberarPlaquinhas` ignorar `printed_at` e o caso do papel passa;
 *  - deixe `reservarPlaquinhaParaEquipamento` aceitar `gerada` e o cadastro
 *    engole um número que não foi para a folha;
 *  - tire `registrarPlaquinhaDoCadastro` e o pool passa a mentir sobre quais
 *    números existem — o teste da numeração única fica vermelho;
 *  - deixe `substituirPlaquinha` sem atualizar `core_equipment` e o QR novo
 *    aponta para o nada enquanto o velho continua respondendo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { MAX_LOTE } from '../src/services/core/EquipmentTagPoolService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let gerente: Record<string, string>;
let daLoja: Record<string, string>;

async function entrar(userId: string, companyId: string, profileCodes: string[]) {
  const res = await loginForTest(app, { userId, companyId, profileCodes });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** A empresa que USA plaquinha — como a Oficina e a PJ Motors no banco real. */
function empresaComPlaquinha(companyId: string): void {
  getConnection()
    .prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = ?')
    .run(companyId);
}

function criarBancada(id: string, companyId: string, kind: 'mobility' | 'phones'): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(id, companyId, `slug-${id}`, `Bancada ${id}`, kind, new Date().toISOString());
}

async function gerarLote(quantidade: number) {
  const res = await request(app)
    .post('/api/v1/core/equipment-tags/batches')
    .set(gerente)
    .send({ quantidade });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { batchId: string; criadas: number; primeira: number; ultima: number };
}

async function listar(status?: string) {
  const res = await request(app)
    .get(`/api/v1/core/equipment-tags${status ? `?status=${status}` : ''}`)
    .set(gerente);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    items: { id: string; public_id: number; status: string; printed_at: string | null }[];
    resumo: Record<string, number>;
  };
}

/** Imprimir a folha é o que põe o adesivo no papel — e o que libera depois. */
async function exportarFolha(tagIds: string[]) {
  const res = await request(app)
    .post('/api/v1/core/equipment-tags/sheet')
    .set(gerente)
    .send({ tagIds });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { html: string; folhas: number; plaquinhas: number };
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-of', 'oficina-co', ['gerente_oficina']);
  empresaComPlaquinha('oficina-co');
  criarBancada('ws-mob', 'oficina-co', 'mobility');
  daLoja = await entrar('gerente-gringa', 'gringa-co', ['gerente_loja']);
});

describe('o lote nasce, e o número é do grupo', () => {
  it('gera N plaquinhas em sequência, todas em "gerada" e sem papel', async () => {
    const lote = await gerarLote(5);
    expect(lote.criadas).toBe(5);
    expect(lote.ultima - lote.primeira).toBe(4);

    const { items, resumo } = await listar();
    expect(items).toHaveLength(5);
    expect(resumo.gerada).toBe(5);
    expect(resumo.disponivel).toBe(0);
    // Sem papel: é o que impede a liberação logo abaixo.
    expect(items.every((t) => t.printed_at === null)).toBe(true);
    expect(items.every((t) => t.status === 'gerada')).toBe(true);
  });

  it('lote acima do teto é recusado — número reservado não volta', async () => {
    const res = await request(app)
      .post('/api/v1/core/equipment-tags/batches')
      .set(gerente)
      .send({ quantidade: MAX_LOTE + 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_TAG_BATCH_TOO_BIG');
    // E nada foi criado: recusa que gera metade queimaria numeração à toa.
    expect((await listar()).items).toHaveLength(0);
  });

  it('lote vazio ou negativo não passa', async () => {
    for (const quantidade of [0, -3]) {
      const res = await request(app)
        .post('/api/v1/core/equipment-tags/batches')
        .set(gerente)
        .send({ quantidade });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CORE_TAG_BATCH_EMPTY');
    }
  });

  /**
   * A NUMERAÇÃO É UMA SÓ — e este é o caso que a rodada existe para garantir.
   *
   * Dois caminhos criam número: o lote e o cadastro sem plaquinha escolhida.
   * Se cada um tivesse a sua sequência, a segunda moto cadastrada receberia um
   * número que já está impresso e colado noutra máquina.
   */
  it('cadastro e lote sorteiam da MESMA sequência — nunca há número repetido', async () => {
    const primeiroLote = await gerarLote(3);

    const maquina = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Shineray', model: 'PT2' });
    expect(maquina.status, JSON.stringify(maquina.body)).toBe(201);
    expect(maquina.body.public_id).toBe(primeiroLote.ultima + 1);

    const segundoLote = await gerarLote(2);
    expect(segundoLote.primeira).toBe(maquina.body.public_id + 1);

    // E o pool conhece TODOS os números, inclusive o da máquina que nasceu sem
    // plaquinha escolhida: sem isso o pool mentiria sobre o que existe.
    const { items } = await listar();
    const numeros = items.map((t) => t.public_id).sort((a, b) => a - b);
    expect(numeros).toEqual([1, 2, 3, 4, 5, 6]);
    const daMaquina = items.find((t) => t.public_id === maquina.body.public_id)!;
    expect(daMaquina.status).toBe('associada');
  });
});

describe('liberar exige o papel', () => {
  it('sem folha exportada, a liberação é recusada e diz quais faltam', async () => {
    const lote = await gerarLote(3);
    const res = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_TAG_NOT_PRINTED');
    expect(res.body.error.details.pendentes).toHaveLength(3);
    expect((await listar('disponivel')).items).toHaveLength(0);
  });

  it('exportada a folha, a liberação passa e o estado anda', async () => {
    const lote = await gerarLote(3);
    const { items } = await listar();
    const folha = await exportarFolha(items.map((t) => t.id));
    expect(folha.plaquinhas).toBe(3);
    // A folha é HTML em milímetro, com um QR por plaquinha.
    expect(folha.html).toContain('@page');
    expect(folha.html.match(/<svg/g)).toHaveLength(3);

    const res = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.liberadas).toBe(3);

    const depois = await listar();
    expect(depois.resumo.disponivel).toBe(3);
    expect(depois.resumo.gerada).toBe(0);
  });

  it('liberar duas vezes não duplica nada — a segunda não acha o que liberar', async () => {
    const lote = await gerarLote(2);
    await exportarFolha((await listar()).items.map((t) => t.id));
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);

    const segunda = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_TAG_NOTHING_TO_RELEASE');
  });
});

describe('a plaquinha entra na máquina', () => {
  async function loteLiberado(quantidade = 2) {
    const lote = await gerarLote(quantidade);
    const { items } = await listar();
    await exportarFolha(items.map((t) => t.id));
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);
    return { lote, items };
  }

  it('cadastrar com o número colado adota a plaquinha, e ela vira associada', async () => {
    const { lote } = await loteLiberado();

    const res = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // A máquina RESPONDE pelo número que já está colado nela.
    expect(res.body.public_id).toBe(lote.primeira);

    const { items } = await listar();
    const usada = items.find((t) => t.public_id === lote.primeira)!;
    expect(usada.status).toBe('associada');
    // E o token do QR é o MESMO que foi impresso: o adesivo continua valendo.
    const tag = getConnection()
      .prepare('SELECT public_token FROM core_equipment_tags WHERE public_id = ?')
      .get(lote.primeira) as { public_token: string };
    // O token não sai na resposta de criação (GAP-PRD-106): conferido no banco.
    expect(res.body.public_token).toBeUndefined();
    const daMaquina = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get(res.body.id) as { public_token: string };
    expect(daMaquina.public_token).toBe(tag.public_token);
  });

  it('plaquinha ainda não liberada é recusada, e o motivo ensina o caminho', async () => {
    const lote = await gerarLote(1);
    const res = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_TAG_NOT_RELEASED');
    expect(res.body.error.message).toContain('Exporte a folha');
  });

  it('plaquinha já usada não entra em duas máquinas', async () => {
    const { lote } = await loteLiberado();
    const corpo = {
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'PT2',
      tagPublicId: lote.primeira,
    };
    await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send(corpo)
      .expect(201);

    const segunda = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send(corpo);
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_TAG_IN_USE');
  });

  it('número que não existe no pool é recusado — não se inventa plaquinha', async () => {
    const res = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: 9999,
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_TAG_NOT_FOUND');
  });
});

describe('adesivo perdido', () => {
  it('plaquinha livre pode ser marcada danificada, com motivo', async () => {
    const lote = await gerarLote(1);
    const { items } = await listar();
    const res = await request(app)
      .post(`/api/v1/core/equipment-tags/${items[0]!.id}/damage`)
      .set(gerente)
      .send({ motivo: 'Impressão borrada' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('danificada');
    expect(res.body.damaged_reason).toBe('Impressão borrada');
    expect(lote.criadas).toBe(1);

    // E danificada não volta ao cadastro.
    const cadastro = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'X',
        model: 'Y',
        tagPublicId: res.body.public_id,
      });
    expect(cadastro.status).toBe(409);
    expect(cadastro.body.error.code).toBe('CORE_TAG_DAMAGED');
  });

  /**
   * PLAQUINHA COLADA NUMA MÁQUINA NÃO SE APAGA — ELA SE SUBSTITUI.
   *
   * O sistema anterior deixava marcar qualquer plaquinha como danificada,
   * inclusive a associada, e não dava outra à máquina: a moto ficava sem
   * identificação para sempre.
   */
  it('a associada não vira danificada pelo caminho curto', async () => {
    const lote = await gerarLote(1);
    const { items } = await listar();
    await exportarFolha([items[0]!.id]);
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);
    await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/core/equipment-tags/${items[0]!.id}/damage`)
      .set(gerente)
      .send({ motivo: 'descascou' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_TAG_IN_USE');
    expect(res.body.error.message).toContain('substituição');
  });

  it('substituir dá outra plaquinha à máquina, aposenta a velha e registra', async () => {
    const lote = await gerarLote(2);
    const { items } = await listar();
    await exportarFolha(items.map((t) => t.id));
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);

    const maquina = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      });
    expect(maquina.status).toBe(201);
    // O token não sai na resposta de criação (GAP-PRD-106): lido do banco.
    const tokenAntigo = (
      getConnection()
        .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
        .get(maquina.body.id) as { public_token: string }
    ).public_token;

    const nova = (await listar('disponivel')).items[0]!;
    const res = await request(app)
      .post(`/api/v1/core/equipment-tags/${nova.id}/replace`)
      .set(gerente)
      .send({ equipmentId: maquina.body.id, motivo: 'Adesivo descascou no sol' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.atual).toBe(`#${String(nova.public_id).padStart(4, '0')}`);

    // A MÁQUINA passa a responder pelo número novo — as duas colunas mudam
    // juntas, senão o QR novo aponta para o nada e o velho continua valendo.
    const ficha = await request(app)
      .get(`/api/v1/core/equipment/${maquina.body.id}`)
      .set(gerente);
    expect(ficha.body.equipment.public_id).toBe(nova.public_id);
    expect(ficha.body.equipment.public_token).toBeUndefined();
    const noBanco = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get(maquina.body.id) as { public_token: string };
    expect(noBanco.public_token).not.toBe(tokenAntigo);

    // A velha vira danificada, guardando de qual máquina era.
    const todas = (await listar()).items;
    const velha = todas.find((t) => t.public_id === lote.primeira)!;
    expect(velha.status).toBe('danificada');

    // E a troca fica no histórico da máquina, que é onde alguém procura.
    const evento = ficha.body.events.find(
      (e: { event_type: string }) => e.event_type === 'plaquinha_trocada',
    );
    expect(evento, JSON.stringify(ficha.body.events)).toBeTruthy();
    expect(evento.description).toContain('descascou');
  });

  it('substituir sem motivo é recusado — o número da máquina muda', async () => {
    const lote = await gerarLote(2);
    const { items } = await listar();
    await exportarFolha(items.map((t) => t.id));
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);
    const maquina = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      });
    const nova = (await listar('disponivel')).items[0]!;

    const res = await request(app)
      .post(`/api/v1/core/equipment-tags/${nova.id}/replace`)
      .set(gerente)
      .send({ equipmentId: maquina.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TAG_REPLACE_REASON');
  });
});

/**
 * A REGRA DE OURO DO DONO.
 *
 * "O sistema de etiquetas com QR e ID é somente para PJ Motors e Oficina."
 * A Gringa é loja de roupa: identifica mercadoria por etiqueta comercial, com
 * código de barras e preço. A recusa diz isso — não é um 403 mudo.
 */
describe('a regra de ouro: plaquinha é de PJ Motors e da Oficina', () => {
  it('loja de roupa não gera lote, e a recusa explica o porquê', async () => {
    const res = await request(app)
      .post('/api/v1/core/equipment-tags/batches')
      .set(daLoja)
      .send({ quantidade: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_COMPANY_NO_TAGS');
    expect(res.body.error.message).toContain('etiqueta de produto');
  });

  it('loja de roupa não exporta folha nem libera nem edita o layout', async () => {
    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(daLoja)
      .send({ tagIds: ['qualquer'] });
    expect(folha.status).toBe(409);
    expect(folha.body.error.code).toBe('CORE_COMPANY_NO_TAGS');

    const liberar = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(daLoja)
      .send({ batchId: 'qualquer' });
    expect(liberar.status).toBe(409);
    expect(liberar.body.error.code).toBe('CORE_COMPANY_NO_TAGS');

    const layout = await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(daLoja)
      .send({ bgColor: '#000000' });
    expect(layout.status).toBe(409);
    expect(layout.body.error.code).toBe('CORE_COMPANY_NO_TAGS');
  });

  /**
   * O FURO MAIS LARGO QUE A RODADA FECHOU.
   *
   * A lista de plaquinhas adotáveis atravessa empresa de propósito — mostra a
   * plaquinha que vive na Oficina para a loja que vende a moto. O filtro
   * olhava a ORIGEM do equipamento e nunca QUEM está adotando: qualquer loja
   * do grupo via a lista e podia adotar a plaquinha da Oficina.
   */
  it('loja de roupa não vê plaquinha adotável — a lista dela é vazia', async () => {
    const lote = await gerarLote(1);
    const { items } = await listar();
    await exportarFolha([items[0]!.id]);
    await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId })
      .expect(200);
    await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        tagPublicId: lote.primeira,
      })
      .expect(201);

    const daGringa = await request(app)
      .get('/api/v1/core/units/equipment-candidates')
      .set(daLoja);
    expect(daGringa.status, JSON.stringify(daGringa.body)).toBe(200);
    expect(daGringa.body.items).toHaveLength(0);
  });

  it('a leitura do pool responde a quem não usa, dizendo que não usa', async () => {
    const res = await request(app).get('/api/v1/core/equipment-tags').set(daLoja);
    expect(res.status).toBe(200);
    expect(res.body.usaPlaquinha).toBe(false);
    expect(res.body.items).toHaveLength(0);
  });
});

/**
 * O QUE A REVISÃO ADVERSÁRIA DA RODADA ACHOU — e que a primeira versão fazia.
 */
describe('o que a folha e a lista não podem entregar', () => {
  /**
   * A CREDENCIAL NÃO VIAJA NA LISTA.
   *
   * `public_token` abre a página pública do equipamento sem sessão, não expira
   * e não se revoga — e na plaquinha associada ele É o token da máquina. A
   * lista devolvia até mil deles numa requisição, aos perfis mais largos da
   * rodada, enquanto as três rotas irmãs de equipamento podam o campo.
   */
  it('a lista de plaquinhas não devolve o token do QR', async () => {
    await gerarLote(2);
    const res = await request(app).get('/api/v1/core/equipment-tags').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    for (const t of res.body.items) expect(t.public_token).toBeUndefined();

    // E o token continua no banco: o que mudou é quem o recebe.
    const noBanco = getConnection()
      .prepare('SELECT public_token FROM core_equipment_tags LIMIT 1')
      .get() as { public_token: string };
    expect(noBanco.public_token).toBeTruthy();
  });

  /**
   * O CORTE DA LISTA É DITO, e o total é o que a BUSCA encontrou.
   *
   * A lista mostra no máximo 300, ordenadas pelo número mais novo, enquanto o
   * cabeçalho da tela mostra o total verdadeiro: com mais plaquinhas que isso,
   * quem olha conclui que as antigas sumiram. O total filtrado sai junto para
   * a tela poder dizer "mostrando 300 de 1.180".
   */
  it('a lista devolve quantas a busca encontrou, além das que couberam', async () => {
    await gerarLote(5);
    const tudo = await request(app).get('/api/v1/core/equipment-tags').set(gerente);
    expect(tudo.body.total).toBe(5);
    expect(tudo.body.items).toHaveLength(5);

    // Com teto menor que o encontrado, o total NÃO encolhe: é ele que conta a
    // verdade para a frase do corte.
    const cortada = await request(app)
      .get('/api/v1/core/equipment-tags?limite=2')
      .set(gerente);
    expect(cortada.body.items).toHaveLength(2);
    expect(cortada.body.total).toBe(5);

    // E o filtro conta o filtrado, não o pool inteiro.
    const soGeradas = await request(app)
      .get('/api/v1/core/equipment-tags?status=disponivel')
      .set(gerente);
    expect(soGeradas.body.total).toBe(0);
  });

  it('marcar danificada também não devolve o token', async () => {
    await gerarLote(1);
    const { items } = await listar();
    const res = await request(app)
      .post(`/api/v1/core/equipment-tags/${items[0]!.id}/damage`)
      .set(gerente)
      .send({ motivo: 'teste' });
    expect(res.status).toBe(200);
    expect(res.body.public_token).toBeUndefined();
  });

  /**
   * O LOTE INTEIRO VAI AO PAPEL — inclusive a plaquinha mais velha.
   *
   * A folha resolvia a seleção filtrando uma lista ordenada por número
   * DESCENDENTE, com teto de mil: num lote cheio, a plaquinha mais velha saía
   * da janela assim que outra nascia. O que a folha não desenha não recebe
   * `printed_at`, e sem `printed_at` não há liberação — o lote ficava preso em
   * `gerada` para sempre, com a numeração queimada.
   */
  it('a plaquinha mais velha continua imprimível depois de outro lote nascer', async () => {
    const primeiro = await gerarLote(3);
    const maisVelha = (await listar()).items.find((t) => t.public_id === primeiro.primeira)!;
    await gerarLote(3);

    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ tagIds: [maisVelha.id] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.plaquinhas).toBe(1);

    const depois = (await listar()).items.find((t) => t.id === maisVelha.id)!;
    expect(depois.printed_at).toBeTruthy();
  });

  it('a folha aceita o LOTE inteiro de uma vez, sem passar por lista', async () => {
    const lote = await gerarLote(5);
    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ batchId: lote.batchId });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.plaquinhas).toBe(5);

    const liberar = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(gerente)
      .send({ batchId: lote.batchId });
    expect(liberar.status, JSON.stringify(liberar.body)).toBe(200);
    expect(liberar.body.liberadas).toBe(5);
  });

  it('id que não existe não some calado — a resposta diz quais ficaram de fora', async () => {
    await gerarLote(1);
    const { items } = await listar();
    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ tagIds: [items[0]!.id, 'nao-existe'] });
    expect(folha.status).toBe(200);
    expect(folha.body.plaquinhas).toBe(1);
    expect(folha.body.naoAchados).toEqual(['nao-existe']);
  });

  /**
   * A LOGO ENTRA UMA VEZ NA FOLHA.
   *
   * Como `<img src="data:...">` por célula, uma marca de 500 KB viraria 10 MB
   * de HTML numa folha de 21 — e o documento inteiro trafega dentro de JSON.
   */
  it('a logo aparece uma vez só, por mais plaquinhas que a folha tenha', async () => {
    const logo =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ logoUrl: logo })
      .expect(200);

    const lote = await gerarLote(6);
    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ batchId: lote.batchId });

    const vezes = (folha.body.html as string).split('iVBORw0KGgo').length - 1;
    expect(vezes).toBe(1);
    // E as seis células continuam apontando para a marca.
    expect((folha.body.html as string).split('class="logo"').length - 1).toBe(6);
  });

  /**
   * O TAMANHO DO EDITOR SÓ VALE NO FORMATO QUE O SEGUE.
   *
   * O editor prometia 100 × 40 mm e o papel saía com os 63 × 33 do formato
   * escolhido: duas verdades sobre a mesma etiqueta, e a divergência só
   * aparecia na impressora.
   */
  it('o formato personalizado desenha nos milímetros do layout', async () => {
    await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ widthMm: 90, heightMm: 45 })
      .expect(200);

    const lote = await gerarLote(2);
    const padrao = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ batchId: lote.batchId, formatId: 'plaq_a4_63x33_3col' });
    expect(padrao.body.html).toContain('width: 63mm');

    const proprio = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ batchId: lote.batchId, formatId: 'plaq_personalizado' });
    expect(proprio.body.html).toContain('width: 90mm');
    expect(proprio.body.html).toContain('height: 45mm');
    // E a conta do módulo continua valendo para o tamanho escolhido.
    expect(proprio.body.abaixoDoPiso).toBe(false);
    expect(proprio.body.moduloMm).toBeGreaterThan(0.5);
  });
});

describe('o layout da plaquinha é da empresa, não do navegador', () => {
  it('nasce com os padrões do sistema anterior', async () => {
    const res = await request(app).get('/api/v1/core/equipment-tags/layout').set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.layout).toMatchObject({
      bgColor: '#ffffff',
      textColor: '#1a1a1a',
      widthMm: 100,
      heightMm: 40,
      marginMm: 4,
      rounded: true,
      logoXmm: 8,
      logoYmm: 4,
      logoWmm: 28,
      logoHmm: 20,
    });
  });

  it('grava o que mudou e preserva o resto', async () => {
    await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ bgColor: '#101820', textColor: '#ffd700' })
      .expect(200);

    const primeiro = await request(app).get('/api/v1/core/equipment-tags/layout').set(gerente);
    expect(primeiro.body.layout.bgColor).toBe('#101820');
    expect(primeiro.body.layout.widthMm).toBe(100);

    // O editor manda só o campo que mexeu: partir do padrão apagaria em
    // silêncio o que a empresa já tinha configurado.
    await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ widthMm: 90 })
      .expect(200);
    const segundo = await request(app).get('/api/v1/core/equipment-tags/layout').set(gerente);
    expect(segundo.body.layout.bgColor).toBe('#101820');
    expect(segundo.body.layout.widthMm).toBe(90);
  });

  it('cor fora do formato e medida fora do papel são recusadas', async () => {
    const cor = await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ bgColor: 'azul' });
    expect(cor.status).toBe(400);
    expect(cor.body.error.code).toBe('CORE_TAG_LAYOUT_COLOR');

    const medida = await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ widthMm: 500 });
    expect(medida.status).toBe(400);
    expect(medida.body.error.code).toBe('CORE_TAG_LAYOUT_INVALID');
  });

  /**
   * A LOGO TEM QUE CABER.
   *
   * O editor do sistema anterior deixava arrastar a logo até 150 mm numa
   * plaquinha de 100 — o excedente sumia sob `overflow:hidden`, sem aviso, e a
   * folha saía com metade da marca cortada.
   */
  it('logo que passa da plaquinha é recusada antes do papel', async () => {
    const res = await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ logoXmm: 80, logoWmm: 40, widthMm: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TAG_LOGO_OUT');
  });

  it('a folha sai com as cores e a logo da empresa', async () => {
    const logo =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await request(app)
      .put('/api/v1/core/equipment-tags/layout')
      .set(gerente)
      .send({ bgColor: '#101820', textColor: '#ffd700', logoUrl: logo })
      .expect(200);

    await gerarLote(1);
    const { items } = await listar();
    const folha = await exportarFolha([items[0]!.id]);
    expect(folha.html).toContain('#101820');
    expect(folha.html).toContain('#ffd700');
    expect(folha.html).toContain('class="logo"');
  });

  it('a pré-visualização usa o MESMO desenho, sem gravar nada', async () => {
    const res = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(gerente)
      .send({ preview: true, layout: { bgColor: '#123456' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.html).toContain('#123456');

    // O preview não gravou: o layout da empresa continua o padrão.
    const layout = await request(app).get('/api/v1/core/equipment-tags/layout').set(gerente);
    expect(layout.body.layout.bgColor).toBe('#ffffff');
  });
});

describe('a migração 68 leva o pool junto', () => {
  it('banco v67: cada máquina existente vira plaquinha associada, com o próprio número', () => {
    /*
      O número da armadilha é de propósito: passo novo derruba este teste e
      obriga quem o escreveu a conferir que a carga do pool continua valendo.
      Um pool que começa pela metade faria a primeira plaquinha gerada repetir
      um número que já está colado numa moto no pátio.
    */
    /*
      Rodada 54 (passo 69, a marca de quem assina o papel da bancada):
      conferido que o passo so acrescenta `core_workshops.brand_company_id` e
      regrava as duas bancadas oficiais — nao toca em plaquinha, em
      equipamento nem na sequencia do grupo. A carga do pool segue valendo.
    */
    /*
      Rodada 73 (passo 73, a conversão de unidade na entrada de nota):
      conferido que o passo só acrescenta três colunas NULLABLE a
      `core_inbound_note_items` — unit_trib, quantity_trib e
      conversion_factor. Não reconstrói tabela, não regrava linha, e não
      toca em equipamento, plaquinha, OS, quadro da oficina, marca de
      bancada nem tabela de preço. Os casos abaixo seguem valendo.

      E o passo NASCEU errado, com o alvo ainda em 72: o passo rodava e
      `haPassoPendente` não o via, então a migração entrava sem o snapshot.
      `schema-drift` ganhou o caso que cobra os dois sentidos.
    */
    /*
      ESTE GUARDA FICOU PARA TRÁS EM 73 — e a suíte estava vermelha por isso
      antes desta rodada, com o alvo já em 77.

      A lista de "guardas do número" que as rodadas seguintes atualizaram tinha
      três nomes; este é o quinto, e ninguém o incluiu. O efeito é o pior tipo
      de vermelho: um arquivo reprovando por um número desatualizado, sem
      relação nenhuma com o que ele testa — e que a pessoa aprende a ignorar.
      Conferidos, um a um, os passos 74 a 79: rastro de item removido (74),
      pacote do contador (75), cópia de arquivamento do evento fiscal (76),
      espécie/estorno da nota de entrada (77), liberação com terminal/IP e
      reabertura de turno (78) e a razão de crédito de loja (79 — tabela nova
      `core_customer_credits` mais o índice dela). Nenhum reconstrói tabela nem
      toca em equipamento, plaquinha, OS ou sequência do grupo: a carga do pool
      segue valendo.
    */
    /*
      Passo 80 (o catálogo ganha serviço, faixa, embalagem, campo próprio, dia
      da semana e IPI — GAP-V01/V08): ALTER de coluna nova em `core_products`,
      `core_promotions` e `core_tax_groups`, mais três tabelas novas pela DDL
      canônica. Não reconstrói tabela nem toca em equipamento, plaquinha, OS ou
      sequência do grupo: a carga do pool segue valendo.
    */
    /*
      Passo 84 (o anexo do e-mail sai da fila e vai para o cofre — GAP-V30,
      conserto): UM ALTER, `core_email_queue.anexo_id`, nullable e sem
      backfill, mais a tabela NOVA `core_email_attachments`, que nasce na DDL
      canônica. Não toca em equipamento, plaquinha, OS nem garantia — os casos
      abaixo seguem valendo, como no passo 83 (`core_sale_items.cost_cents`).
    */
    /*
      Passo 86 (RBAC granular): cinco colunas em `core_user_companies` e o
      escopo de bancada de cada vínculo gravado. Não toca em plaquinha nem na
      sequência do grupo: a carga do pool segue valendo.
    */
    expect(CORE_TARGET_VERSION).toBe(86);

    const db = getConnection();
    for (let passo = 2; passo <= 67; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_68');
    db.prepare('DELETE FROM core_equipment_tags').run();

    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_companies (id, slug, legal_name, trade_name, kind, active, created_at, updated_at)
       VALUES ('emp-68', 'oficina', 'Oficina 68', 'Oficina 68', 'workshop', 1, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
    ).run(agora, agora);
    db.prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES ('ws-68', 'emp-68', 'ws-68', 'Bancada 68', 'mobility', 1, ?)`,
    ).run(agora);
    db.prepare(
      `INSERT INTO core_equipment
         (id, company_id, workshop_id, public_id, public_token, origin, sale_status,
          status, created_at, updated_at)
       VALUES ('eq-68', 'emp-68', 'ws-68', 4242, 'token-antigo', 'INTERNAL_PJ_MOTORS',
               'NOT_SOLD', 'ativo', ?, ?)`,
    ).run(agora, agora);

    migrateCoreSchema();

    const tag = db
      .prepare('SELECT * FROM core_equipment_tags WHERE public_id = 4242')
      .get() as { status: string; equipment_id: string; public_token: string; printed_at: string | null };
    expect(tag).toBeTruthy();
    expect(tag.status).toBe('associada');
    expect(tag.equipment_id).toBe('eq-68');
    expect(tag.public_token).toBe('token-antigo');
    // Impressa pelo caminho antigo, uma a uma: o sistema não sabe quando.
    expect(tag.printed_at).toBeNull();

    // E a regra de ouro entrou como DADO: a Oficina usa plaquinha.
    const empresa = db
      .prepare("SELECT uses_equipment_tags FROM core_companies WHERE slug = 'oficina'")
      .get() as { uses_equipment_tags: number };
    expect(empresa.uses_equipment_tags).toBe(1);

    /*
      A SEQUÊNCIA DO GRUPO NÃO PODE FICAR ATRÁS DO QUE JÁ ESTÁ COLADO.

      A máquina acima tem o número 4242 e a sequência do banco antigo pode
      estar em qualquer valor menor — basta o número ter vindo de um caminho
      que não a consumiu, ou de uma restauração parcial. Sem este empurrão, o
      primeiro lote depois da migração pediria #0005, o índice único bateria
      com a plaquinha 4242 só lá na frente, e antes disso o sistema estaria
      entregando números que já existem colados no pátio.
    */
    const sequencia = db
      .prepare(
        `SELECT current FROM core_sequences
          WHERE company_id = '__grupo__' AND name = 'equipment_public_id'`,
      )
      .get() as { current: number } | undefined;
    expect(sequencia?.current ?? 0).toBeGreaterThanOrEqual(4242);
  });
});

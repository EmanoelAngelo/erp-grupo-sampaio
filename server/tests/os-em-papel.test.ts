/**
 * ============================================================================
 * A ORDEM DE SERVIÇO EM PAPEL — A4, desde a abertura (rodada 54)
 * ============================================================================
 *
 * ## O buraco que este arquivo fecha
 *
 * `renderWorkshopOrder` existia desde a rodada da fila de impressão, estava no
 * catálogo de tipos de documento, tinha teste de fumaça — e **nenhuma tela
 * jamais o chamou**. Documento escrito, registrado e inalcançável: quem
 * precisava entregar um papel ao cliente não tinha por onde.
 *
 * E o desenho estava errado em silêncio: lia `parts_total_cents` e
 * `labor_total_cents`, colunas que não existem. `Number(undefined) > 0` é
 * falso, então as linhas de peças e de mão de obra nunca eram impressas — o
 * papel mostrava só o total. O teste antigo não pegava porque só conferia que
 * o HTML continha o número da OS.
 *
 * ## O que este arquivo cobra
 *
 *  1. os VALORES saem quebrados em peças e mão de obra (o defeito das colunas);
 *  2. a MARCA é a de quem assina a bancada, não a da empresa que a hospeda —
 *     a de mobilidade é da Oficina e assina como PJ Motors;
 *  3. o papel serve DESDE A ABERTURA: sem diagnóstico, sem peça e sem valor,
 *     ele sai com a conferência de entrada e as assinaturas;
 *  4. a conferência de entrada, o prazo prometido e a prioridade — tudo o que
 *     as rodadas 51 e 52 acrescentaram e o papel ignorava;
 *  5. a OS sem custo diz POR QUE não tem custo (garantia, cortesia, retrabalho);
 *  6. o estado sai em português, não como código do banco;
 *  7. a fronteira: OS de outra empresa e de outra bancada não vira papel.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *  - voltando a ler `parts_total_cents`, o caso dos valores fica vermelho;
 *  - tirando `brand_company_id` do seed, o cabeçalho volta a dizer "Oficina";
 *  - tirando o `getOrderDetail` da rota, a OS da outra bancada imprime.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  CORE_TARGET_VERSION,
  ensureOfficialTagCompanies,
  ensureOfficialWorkshops,
  migrateCoreSchema,
} from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();

let gerente: Record<string, string>;
let mecanico: Record<string, string>;
let oficinaCo: string;
let precoJustoCo: string;
let pjMotorsCo: string;
let mobilidade: string;
let celulares: string;

/*
  O login é montado à mão porque as empresas deste arquivo são as de VERDADE.

  `loginForTest` trata o `companyId` que recebe como id E como slug — ele
  provisiona a empresa junto. Aqui as três já existem, com slug 'oficina',
  'preco-justo' e 'pj-motors', porque é por esses slugs que
  `ensureOfficialWorkshops` acha as bancadas e grava a marca de quem assina.
*/
const SENHA = 'Teste@GrupoSampaio2026';

async function entrar(userId: string, companyId: string, profileCodes: string[]) {
  const login = `${userId}@papel`;
  const realUserId = await upsertUser({ login, displayName: userId, password: SENHA });
  linkUserToCompany(realUserId, companyId, profileCodes[0] ?? 'gerente_oficina', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function workshopIdOf(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

async function abrirOs(auth: Record<string, string>, workshopId: string, corpo: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/v1/core/workshop/orders?workshopId=${workshopId}`)
    .set(auth)
    .send({ customerName: 'Dona da Moto', complaint: 'Não carrega a bateria', ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number };
}

async function papelDa(auth: Record<string, string>, orderId: string) {
  const res = await request(app)
    .get(`/api/v1/core/workshop/orders/${orderId}/impressao`)
    .set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { html: string; numero: number; marca: string };
}

beforeEach(async () => {
  resetDbForTests();

  // O grupo de verdade, em miniatura: as duas bancadas nascem em empresas
  // diferentes, e a de mobilidade assina como PJ Motors.
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  precoJustoCo = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
  });
  pjMotorsCo = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = workshopIdOf('oficina-mobilidade');
  celulares = workshopIdOf('oficina-celulares');

  gerente = await entrar('gerente-of', oficinaCo, ['gerente_oficina']);
  mecanico = await entrar('mec-54', oficinaCo, ['mecanico']);
});

describe('quem assina o papel', () => {
  /**
   * ESTE TESTE FOI INVERTIDO, e a inversão é decisão do dono.
   *
   * Ele exigia o contrário: "a OS da mobilidade sai com a marca da PJ Motors,
   * não da Oficina", com a justificativa de que quem o cliente conhece é a loja
   * de motos. O raciocínio é legítimo. O dono viu a OS impressa com o nome PJ
   * MOTORS e decidiu que a Oficina assina como Oficina.
   *
   * O que mudou não foi a capacidade — ela continua, e o teste seguinte a
   * exercita. Mudou de quem é a escolha: era de uma migração que a reimpunha a
   * cada subida do servidor, e passou a ser de quem opera.
   */
  it('a OS da mobilidade sai com a marca da OFICINA', async () => {
    const os = await abrirOs(gerente, mobilidade);
    const papel = await papelDa(gerente, os.id);

    expect(papel.marca).toBe('Oficina');
    expect(papel.html).not.toContain('PJ Motors');
  });

  it('e assina como PJ Motors quando o dono escolhe isso na tela', async () => {
    await request(app)
      .put(`/api/v1/core/workshops/${mobilidade}/brand`)
      .set(gerente)
      .send({ brandCompanyId: pjMotorsCo })
      .expect(200);

    const os = await abrirOs(gerente, mobilidade);
    const papel = await papelDa(gerente, os.id);

    expect(papel.marca).toBe('PJ Motors');
    expect(papel.html).toContain('PJ Motors');
  });

  it('a segunda via é o MESMO papel — sem efeito de estoque, dinheiro ou estado', async () => {
    /*
      AUDITORIA DE ENTREGA: imprimir é LER. O cliente perde a via, o balcão
      imprime de novo — e a segunda via não pode criar venda, mexer em saldo
      nem andar com a OS. A prova compara o banco inteiro que importa antes e
      depois de imprimir DUAS vezes: se qualquer contagem mudar, imprimir
      virou operação de negócio por acidente.
    */
    const os = await abrirOs(gerente, mobilidade);
    const db = getConnection();
    const fotografia = () =>
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM core_sales)              AS vendas,
                  (SELECT COUNT(*) FROM core_stock_movements)    AS movimentos,
                  (SELECT COUNT(*) FROM core_service_orders)    AS ordens,
                  (SELECT status FROM core_service_orders WHERE id = ?) AS estadoDaOs`,
        )
        .get(os.id) as Record<string, unknown>;

    const antes = fotografia();
    const primeira = await papelDa(gerente, os.id);
    const segunda = await papelDa(gerente, os.id);
    const depois = fotografia();

    expect(depois).toEqual(antes);
    // E as duas vias são o MESMO documento — número e marca idênticos.
    expect(segunda.numero).toBe(primeira.numero);
    expect(segunda.marca).toBe(primeira.marca);
  });

  it('a bancada de celulares assina em nome próprio', async () => {
    const daPrecoJusto = await entrar('gerente-pj', precoJustoCo, ['gerente_oficina']);
    const os = await abrirOs(daPrecoJusto, celulares);
    const papel = await papelDa(daPrecoJusto, os.id);

    expect(papel.marca).toBe('Preço Justo');
  });

  /**
   * O CABEÇALHO JUNTA TRÊS CADASTROS.
   *
   * Nome e CNPJ vêm da empresa, o endereço e o telefone do cadastro fiscal (o
   * único que alguém preenche de verdade, porque a NF-e exige) e a logo da
   * vitrine. O que faltar não é impresso: "CNPJ null" no papel é pior que
   * cabeçalho curto.
   */
  it('endereço e telefone vêm do cadastro fiscal da marca', async () => {
    // A bancada assina como PJ Motors: é o cadastro DELA que o papel usa, e
    // não o da Oficina, que é a dona da bancada. É esse o ponto do teste.
    await request(app)
      .put(`/api/v1/core/workshops/${mobilidade}/brand`)
      .set(gerente)
      .send({ brandCompanyId: pjMotorsCo })
      .expect(200);

    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_configs
           (company_id, legal_name, trade_name, cnpj, street, number, district,
            city_name, uf, zip, phone, updated_at)
         VALUES (?, 'PJ MOTORS LTDA', 'PJ Motors', '48.025.052/0001-49',
                 'Rua Marechal Floriano', '38', 'Centro', 'Pelotas', 'RS',
                 '96015-440', '(53) 3222-1000', ?)`,
      )
      .run(pjMotorsCo, agora);

    const os = await abrirOs(gerente, mobilidade);
    const papel = await papelDa(gerente, os.id);

    expect(papel.html).toContain('48.025.052/0001-49');
    expect(papel.html).toContain('Rua Marechal Floriano, 38');
    expect(papel.html).toContain('Pelotas/RS');
    expect(papel.html).toContain('(53) 3222-1000');
  });

  it('marca sem cadastro nenhum sai com o nome e mais nada — sem "null" no papel', async () => {
    const os = await abrirOs(gerente, mobilidade);
    const papel = await papelDa(gerente, os.id);

    expect(papel.html).toContain('Oficina');
    expect(papel.html).not.toContain('null');
    expect(papel.html).not.toContain('undefined');
  });
});

describe('o papel serve desde a abertura', () => {
  it('OS recém-aberta já vira documento, com relato e assinaturas', async () => {
    const os = await abrirOs(gerente, mobilidade, { complaint: 'Não carrega a bateria' });
    const papel = await papelDa(gerente, os.id);

    expect(papel.numero).toBe(os.number);
    expect(papel.html).toContain('Não carrega a bateria');
    expect(papel.html).toContain('Ordem de serviço');
    // As duas assinaturas: quem leva o equipamento e quem responde por ele.
    expect(papel.html).toContain('Entrega do equipamento');
    expect(papel.html).toContain('Responsável técnico');
    // Sem peça e sem diagnóstico, as seções nem aparecem — folha limpa.
    expect(papel.html).not.toContain('Peças aplicadas');
    expect(papel.html).not.toContain('Diagnóstico e serviço executado');
  });

  it('a conferência de entrada vai para o papel, item a item', async () => {
    const os = await abrirOs(gerente, mobilidade);
    const itens = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(gerente);
    const primeiro = (itens.body.items as { id: string; item: string }[])[0]!;
    await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${primeiro.id}`)
      .set(gerente)
      .send({ answer: 'nao' })
      .expect(200);

    const papel = await papelDa(gerente, os.id);
    expect(papel.html).toContain('Conferência de entrada');
    expect(papel.html).toContain(primeiro.item);
    // "Não veio" é a resposta que segura discussão no balcão depois.
    expect(papel.html).toContain('Não veio');
  });

  it('prioridade e prazo prometido aparecem — são a promessa ao cliente', async () => {
    const os = await abrirOs(gerente, mobilidade, {
      priority: 'urgente',
      dueDate: '2026-09-30',
    });
    const papel = await papelDa(gerente, os.id);

    expect(papel.html).toContain('Urgente');
    // Dia de calendário sai como foi combinado: `new Date` recuaria um dia.
    expect(papel.html).toContain('30/09/2026');
  });

  it('o estado sai em português, não como código do banco', async () => {
    const os = await abrirOs(gerente, mobilidade);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);

    const papel = await papelDa(gerente, os.id);
    expect(papel.html).toContain('Em andamento');
    expect(papel.html).not.toContain('em_andamento');
  });
});

/**
 * OS VALORES — o defeito que ninguém via.
 *
 * O desenho lia `parts_total_cents` e `labor_total_cents`, colunas que não
 * existem: as duas linhas nunca saíam, e o cliente recebia um total sem saber
 * quanto foi peça e quanto foi serviço.
 */
describe('os valores saem quebrados, não só o total', () => {
  it('peças e mão de obra aparecem separadas, com o total', async () => {
    const os = await abrirOs(gerente, mobilidade);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/labor`)
      .set(mecanico)
      .send({ laborCents: 15000 })
      .expect(200);

    const papel = await papelDa(gerente, os.id);

    /*
      A asserção é na LINHA, não no documento.

      Procurar "150,00" no HTML inteiro passa mesmo com o defeito: o TOTAL sai
      de `total_cents`, que está certo, e a linha de mão de obra sairia zerada
      ao lado sem ninguém notar. É preciso perguntar quanto diz a linha da mão
      de obra.
    */
    const linhaDaMaoDeObra = /<span>Mão de obra<\/span><span>([^<]+)<\/span>/.exec(papel.html);
    expect(linhaDaMaoDeObra, 'a linha de mão de obra não saiu no papel').toBeTruthy();
    expect(linhaDaMaoDeObra![1]).toContain('150,00');

    const linhaDePecas = /<span>Peças<\/span><span>([^<]+)<\/span>/.exec(papel.html);
    expect(linhaDePecas, 'a linha de peças não saiu no papel').toBeTruthy();
    expect(linhaDePecas![1]).toContain('0,00');
  });

  it('a OS sem custo diz POR QUE não tem custo', async () => {
    const os = await abrirOs(gerente, mobilidade);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({
        diagnosis: 'Bateria substituída em garantia',
        hasCost: false,
        noCostReason: 'garantia',
        forcarChecklist: true,
      })
      .expect(200);

    const papel = await papelDa(gerente, os.id);
    expect(papel.html).toContain('Serviço sem custo');
    expect(papel.html).toContain('garantia');
  });
});

describe('a fronteira do papel', () => {
  it('OS de outra empresa não vira papel', async () => {
    const os = await abrirOs(gerente, mobilidade);
    const daPrecoJusto = await entrar('gerente-pj2', precoJustoCo, ['gerente_oficina']);

    const res = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/impressao`)
      .set(daPrecoJusto);
    expect(res.status).toBe(404);
  });

  /**
   * A BANCADA É FRONTEIRA TAMBÉM NO PAPEL.
   *
   * O mecânico que atende só a bancada de celulares não vê a OS da mobilidade
   * no quadro; imprimir seria a mesma leitura por outra porta. É a lição da
   * rodada 51, que achou o buraco na escrita.
   */
  it('mecânico de outra bancada não imprime a OS que não vê', async () => {
    /*
      AS DUAS BANCADAS SÃO DA MESMA EMPRESA, e isso é o teste.

      A primeira versão usava o mecânico da bancada de celulares — que vive em
      OUTRA empresa. O 404 vinha do `company_id`, e o caso ficava verde mesmo
      com o guarda de bancada apagado da rota: ele não provava nada. Aqui a
      segunda bancada nasce na MESMA empresa, e o mecânico é vinculado só a
      ela: o 404 só pode vir de `resolveWorkshopScope`.
    */
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('ws-vizinha', ?, 'ws-vizinha', 'Bancada vizinha', 'mobility', 1, ?)`,
      )
      .run(oficinaCo, agora);

    const os = await abrirOs(gerente, mobilidade);

    const daVizinha = await entrar('mec-vizinho', oficinaCo, ['mecanico']);
    getConnection()
      .prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
         SELECT 'wm-vizinha', 'ws-vizinha', id, ? FROM core_users WHERE login = 'mec-vizinho@papel'`,
      )
      .run(agora);

    const res = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/impressao`)
      .set(daVizinha);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    void celulares;
  });

  /**
   * O MECÂNICO IMPRIME.
   *
   * Pela fila de impressão ele não conseguia: `POST /core/print/jobs` não
   * aceita o perfil `mecanico`, e a rota que entrega o documento não declara o
   * ambiente `bancada`. Quem está com a moto na mão levava 403 nos dois
   * passos. Esta rota tem o mesmo alcance da leitura da OS.
   */
  it('quem está com a máquina na mão consegue imprimir', async () => {
    const os = await abrirOs(gerente, mobilidade);
    const papel = await papelDa(mecanico, os.id);
    expect(papel.html).toContain('Ordem de serviço');
  });
});

describe('a migração 69', () => {
  it('banco v68: a bancada nasce assinando em NOME PRÓPRIO', () => {
    /*
      Este teste exigia o contrário: que a bancada de mobilidade nascesse com a
      marca da PJ Motors. O raciocínio de negócio era legítimo — quem vendeu a
      moto responde pela garantia dela —, e o dono decidiu o contrário depois
      de ver a Ordem de Serviço da Oficina sair impressa com o nome PJ MOTORS.

      A capacidade continua: `WorkshopBrandService` é a autoridade da marca, e
      tem tela. O que a semeadura perdeu foi o direito de IMPOR — e de reimpor
      a cada subida do servidor, que era o que fazia a correção não durar.

      O número é armadilha: passo novo derruba este teste e obriga quem o
      escreveu a conferir que a marca das bancadas continua tendo dono.
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
      três nomes; este é o quarto, e ninguém o incluiu. O efeito é o pior tipo
      de vermelho: um arquivo reprovando por um número desatualizado, sem
      relação nenhuma com o que ele testa — e que a pessoa aprende a ignorar.
      Conferidos, um a um, os passos 74 a 79: rastro de item removido (74),
      pacote do contador (75), cópia de arquivamento do evento fiscal (76),
      espécie/estorno da nota de entrada (77), liberação com terminal/IP e
      reabertura de turno (78) e a razão de crédito de loja (79 — tabela nova
      `core_customer_credits` mais o índice dela). Nenhum reconstrói tabela nem
      toca em equipamento, plaquinha, OS, quadro da oficina, marca de bancada
      ou tabela de preço: os casos abaixo seguem valendo.
    */
    /*
      Passo 80 (o catálogo ganha serviço, faixa, embalagem, campo próprio, dia
      da semana e IPI — GAP-V01/V08): ALTER de coluna nova em `core_products`,
      `core_promotions` e `core_tax_groups`, mais três tabelas novas pela DDL
      canônica. Não reconstrói tabela, não regrava linha e não toca em
      equipamento, plaquinha, OS, quadro da oficina, marca de bancada ou tabela
      de preço: os casos abaixo seguem valendo.
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
      escopo de bancada de cada vínculo gravado. Não toca em OS, bancada nem
      marca de bancada: os casos abaixo seguem valendo.
    */
    expect(CORE_TARGET_VERSION).toBe(86);

    const db = getConnection();
    for (let passo = 2; passo <= 68; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_69');
    db.prepare('UPDATE core_workshops SET brand_company_id = NULL').run();

    migrateCoreSchema();

    const bancada = db
      .prepare("SELECT brand_company_id FROM core_workshops WHERE slug = 'oficina-mobilidade'")
      .get() as { brand_company_id: string | null };
    expect(bancada.brand_company_id).toBeNull();
    void pjMotorsCo;

    // A de celulares assina em nome próprio: nulo é a resposta certa.
    const celularesRow = db
      .prepare("SELECT brand_company_id FROM core_workshops WHERE slug = 'oficina-celulares'")
      .get() as { brand_company_id: string | null };
    expect(celularesRow.brand_company_id).toBeNull();
  });
});

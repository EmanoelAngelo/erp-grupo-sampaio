/**
 * ============================================================================
 * A MÁQUINA GANHA FICHA, E A OS GANHA PROVA — rodada 52
 * ============================================================================
 *
 * Três coisas que o sistema anterior tinha (ou deveria ter) e que aqui nascem
 * consertadas:
 *
 *  1. GARANTIA DERIVADA. Lá o `warrantyStatus` era escrito à mão no cadastro
 *     e nunca recalculado: a venda não o atualizava, o tempo não o movia, e a
 *     moto seguia "em garantia" na tela anos depois de vencer — os filtros e
 *     os números do painel liam essa mentira congelada. Aqui o banco guarda
 *     só o COMBINADO (meses) e a data-base; o estado é calculado toda vez.
 *
 *  2. FOTO EM ARQUIVO. Lá a foto era base64 dentro do MESMO blob de todas as
 *     ordens, no localStorage: duas fotos estouravam a cota e derrubavam a
 *     persistência de TODAS as OS. Aqui os bytes vão para o disco e o banco
 *     guarda o endereço.
 *
 *  3. CONFERÊNCIA DE ENTRADA. Lá NÃO existia — só um checklist de tarefas
 *     digitado à mão. Esta lista nasce com a OS, a partir do modelo da
 *     BANCADA (moto tem chave e retrovisor; celular tem chip e senha), e
 *     segura a conclusão enquanto ninguém conferiu.
 *
 * E o histórico do equipamento, que era WRITE-ONLY desde que nasceu (seis
 * escritores, zero leitores — auditoria da rodada 14), ganha o leitor.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *  - gravando um status de garantia em coluna em vez de derivar, o caso do
 *    "vence com o tempo" fica verde para sempre;
 *  - tirando o backfill de `entered_at`, o caso da migração 67 fica nulo;
 *  - tirando o gate do checklist, o caso da conclusão bloqueada passa;
 *  - tirando o `writeFileSync`, o caso da foto no disco não acha o arquivo.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { warrantyOf, type WarrantyView } from '../src/services/core/EquipmentService.js';
import { photosDir } from '../src/services/core/WorkshopPhotoService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

/** Um PNG de 1x1 de verdade — bytes, não texto que finge ser imagem. */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let gerente: Record<string, string>;
let mecanico: Record<string, string>;

async function entrar(userId: string, profileCodes: string[]) {
  const res = await loginForTest(app, { userId, companyId: 'oficina-co', profileCodes });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function criarBancada(id: string, kind: 'mobility' | 'phones'): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, 'oficina-co', ?, ?, ?, 1, ?)`,
    )
    .run(id, `slug-${id}`, `Bancada ${id}`, kind, new Date().toISOString());
}

async function cadastrarMaquina(corpo: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/core/equipment?workshopId=ws-mob')
    .set(gerente)
    .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Shineray', model: 'PT2', ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Record<string, unknown>;
}

async function abrirOs(workshopId = 'ws-mob', corpo: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/v1/core/workshop/orders?workshopId=${workshopId}`)
    .set(gerente)
    .send({ customerName: 'Dona da Moto', complaint: 'Não liga', ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number };
}

/*
  AS FOTOS DO TESTE NÃO SUJAM A PASTA DE PRODUÇÃO.

  O banco da suíte é temporário, mas os ARQUIVOS iam para
  `server/data/uploads/os` e ficavam lá: cada rodada deixava 21 imagens de 1x1
  órfãs — órfãs porque o banco que as conhecia era descartado no fim. É o
  defeito do banco temporário vazado, na outra ponta.
*/
let pastaDeFotos: string;

beforeAll(() => {
  pastaDeFotos = mkdtempSync(join(tmpdir(), 'gs-fotos-os-'));
  process.env.DEVORA_UPLOADS_DIR = pastaDeFotos;
});

afterAll(() => {
  delete process.env.DEVORA_UPLOADS_DIR;
  rmSync(pastaDeFotos, { recursive: true, force: true });
});

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-of', ['gerente_oficina']);
  criarBancada('ws-mob', 'mobility');
  mecanico = await entrar('mec-52', ['mecanico']);
});

describe('a garantia é derivada — nunca um estado gravado', () => {
  it('o cadastro guarda os MESES, e a ficha calcula o estado', async () => {
    const maquina = await cadastrarMaquina({ warrantyMonths: 12, enteredAt: '2026-01-10' });
    expect(maquina.warranty_months).toBe(12);

    const ficha = await request(app)
      .get(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.warranty.months).toBe(12);
    expect(ficha.body.warranty.baseKind).toBe('entrada');
    expect(ficha.body.warranty.expiresAt.slice(0, 10)).toBe('2027-01-10');
    expect(ficha.body.warranty.status).toBe('vigente');
  });

  it('o tempo vence a garantia sozinho — sem ninguém tocar no banco', () => {
    /*
      O defeito do sistema anterior em uma linha: lá o status era um valor
      gravado, e envelhecer não mudava valor gravado nenhum. Aqui a MESMA
      linha do banco responde três coisas diferentes conforme o dia.
    */
    const maquina = { warranty_months: 12, sold_at: '2026-01-10', entered_at: '2025-01-01' };
    expect(warrantyOf(maquina, new Date('2026-06-01')).status).toBe('vigente');
    expect(warrantyOf(maquina, new Date('2026-12-20')).status).toBe('vence_em_breve');
    expect(warrantyOf(maquina, new Date('2027-02-01')).status).toBe('vencida');
  });

  it('a VENDA manda na data-base: o relógio do cliente começa quando ele leva', () => {
    const so_entrada = warrantyOf({ warranty_months: 6, entered_at: '2026-01-01' });
    expect(so_entrada.baseKind).toBe('entrada');

    const vendida = warrantyOf({
      warranty_months: 6,
      entered_at: '2026-01-01',
      sold_at: '2026-06-01',
    });
    expect(vendida.baseKind).toBe('venda');
    expect(vendida.expiresAt!.slice(0, 10)).toBe('2026-12-01');
  });

  it('meses de CALENDÁRIO, não 30 dias: 31 de janeiro + 1 mês vence em 28 de fevereiro', () => {
    const v = warrantyOf({ warranty_months: 1, sold_at: '2026-01-31' });
    expect(v.expiresAt!.slice(0, 10)).toBe('2026-02-28');
  });

  /**
   * O VENCIMENTO SAI COMO DIA DE CALENDÁRIO, não como instante.
   *
   * Vencimento de garantia é um DIA — "vence em 12 de fevereiro" —, não um
   * ponto no tempo. Devolver `2027-02-12T00:00:00.000Z` convida a tela a
   * imprimi-lo no fuso de quem lê, e no Brasil (UTC−3) meia-noite UTC é o dia
   * ANTERIOR às 21h: a ficha dizia "vence em 11/02/2027" para uma garantia que
   * vence em 12. O mesmo vale para a data-base, que a ficha imprime ao lado.
   *
   * Foi visto na tela, não no teste: a máquina com entrada em 12/08 aparecia
   * "Entrou em 11/08".
   */
  it('vencimento e data-base saem em AAAA-MM-DD — dia de calendário, sem hora', () => {
    const v = warrantyOf({ warranty_months: 6, entered_at: '2026-08-12' });
    expect(v.expiresAt).toBe('2027-02-12');
    expect(v.baseDate).toBe('2026-08-12');

    // Mesmo quando a origem é um INSTANTE (a venda grava data e hora), o que
    // sai é o dia: quem lê a ficha quer o dia, e o dia é o do registro.
    const vendida = warrantyOf({ warranty_months: 6, sold_at: '2026-08-12T16:55:04.000Z' });
    expect(vendida.expiresAt).toBe('2027-02-12');
    expect(vendida.baseDate).toBe('2026-08-12');
  });

  /**
   * A CREDENCIAL DA PLAQUINHA NÃO VIAJA NA RESPOSTA DO PATCH.
   *
   * `public_token` abre `/equipamento/:token` SEM sessão, não expira e não se
   * revoga. O GET da lista projeta o campo fora com quinze linhas de comentário
   * explicando por quê, e a ficha faz o mesmo — a rota nova da rodada 52
   * respondia `SELECT *` inteiro, token junto, para o navegador guardar.
   */
  it('o PATCH da ficha não devolve o token da plaquinha', async () => {
    const maquina = await cadastrarMaquina({});
    const patch = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ warrantyMonths: 6 });

    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.warranty_months).toBe(6);
    expect(patch.body.public_token).toBeUndefined();
    // E o token continua existindo no banco: o que mudou é quem o recebe.
    const noBanco = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get(maquina.id) as { public_token: string };
    expect(noBanco.public_token).toBeTruthy();
  });

  /**
   * A GARANTIA COMBINADA NÃO PODE FICAR SEM DATA-BASE.
   *
   * Sem `sold_at` nem `entered_at` a conta não tem de onde partir, e o
   * resultado era a ficha dizendo duas coisas ao mesmo tempo: o selo "Sem
   * garantia" e, embaixo, "12 meses · vence em —". Um backspace no campo
   * "Entrou em" bastava, na MESMA tela em que a garantia é combinada.
   */
  it('apagar a data de entrada com garantia viva é recusado', async () => {
    const maquina = await cadastrarMaquina({ warrantyMonths: 12, enteredAt: '2026-01-10' });

    const recusa = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ enteredAt: null });

    expect(recusa.status, JSON.stringify(recusa.body)).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_WARRANTY_NEEDS_BASE');

    // A saída existe e é honesta: quem quer mesmo apagar a data tira a
    // garantia junto, na mesma requisição.
    const ok = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ enteredAt: null, warrantyMonths: 0 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(gerente);
    expect(ficha.body.warranty.status).toBe('sem_garantia');
    expect(ficha.body.warranty.months).toBeFalsy();
  });

  /**
   * QUEM MONTA É QUEM PÕE A MÃO NA MÁQUINA.
   *
   * O primeiro guarda pedia só vínculo com a EMPRESA — e a tela oferecia a
   * lista inteira de quem atende a oficina, caixa incluído. "Montada por: PDV
   * Oficina" é registro falso sobre trabalho de bancada, e é o tipo de linha
   * que ninguém confere depois: aparece na ficha da máquina como se fosse
   * fato. Vale mecânico e gerente de oficina, que também monta.
   */
  it('caixa da oficina não vira montador — trabalho de bancada é de quem monta', async () => {
    const maquina = await cadastrarMaquina({});
    // O caixa da oficina É da empresa: o guarda de vínculo o deixa passar, e é
    // por isso que faltava o segundo.
    const login = await loginForTest(app, {
      userId: 'caixa-of',
      companyId: 'oficina-co',
      profileCodes: ['operador_caixa_oficina'],
    });
    const caixaId = login.body.user.id as string;

    const recusa = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ assemblyMechanicId: caixaId });

    expect(recusa.status, JSON.stringify(recusa.body)).toBe(400);
    expect(recusa.body.error.code).toBe('CORE_NOT_A_MECHANIC');
    // E a máquina continua sem montador: recusa que grava metade é pior que
    // recusa nenhuma.
    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(gerente);
    expect(ficha.body.equipment.assembly_mechanic_id).toBeNull();
  });

  /**
   * O CADASTRO FAZ A MESMA PERGUNTA QUE A FICHA.
   *
   * O PATCH conferia empresa e ofício do montador; o POST recebia o mesmo
   * campo e o enfiava no INSERT sem olhar nada — e a chave estrangeira é
   * global, não conhece empresa. Quem tem vínculo em duas empresas anotava o
   * id de um funcionário da loja e cadastrava a moto da oficina "montada" por
   * ele; a ficha nova passava a exibir o nome, porque a leitura também não
   * perguntava de que empresa era.
   */
  it('o cadastro recusa montador e dono de OUTRA empresa — como a ficha já recusava', async () => {
    const daOutra = await loginForTest(app, {
      userId: 'mec-de-fora',
      companyId: 'outra-co',
      profileCodes: ['mecanico'],
    });
    const forasteiroId = daOutra.body.user.id as string;

    const semMontador = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Shineray',
        model: 'PT2',
        assemblyMechanicId: forasteiroId,
      });
    expect(semMontador.status, JSON.stringify(semMontador.body)).toBe(400);
    expect(semMontador.body.error.code).toBe('CORE_MECHANIC_NOT_IN_COMPANY');

    // O cliente de outra empresa segue o mesmo caminho: `assignOwner` já
    // conferia, e o cadastro não.
    const clienteDeFora = 'cli-de-fora';
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
         VALUES (?, 'outra-co', 'Cliente da Outra', 1, ?, ?)`,
      )
      .run(clienteDeFora, new Date().toISOString(), new Date().toISOString());

    const semDono = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({
        origin: 'EXTERNAL_CUSTOMER',
        brand: 'Honda',
        model: 'Biz',
        ownerCustomerId: clienteDeFora,
      });
    expect(semDono.status, JSON.stringify(semDono.body)).toBe(404);
    expect(semDono.body.error.code).toBe('CORE_CUSTOMER_NOT_FOUND');
  });

  /**
   * A LISTA RECEBE A GARANTIA PRONTA — a conta é UMA.
   *
   * A primeira versão desta rodada refez a derivação no navegador para pintar
   * a coluna "Garantia" da lista. Duas contas para a mesma pergunta é o defeito
   * de família da rodada 51 outra vez: elas divergem no primeiro caso de borda
   * — e divergiram, no dia do vencimento e no fuso de quem lê. A lista passa a
   * ler o que o servidor já calculou para a ficha.
   */
  it('a lista traz a garantia derivada, igual à da ficha', async () => {
    const maquina = await cadastrarMaquina({ warrantyMonths: 6, enteredAt: '2026-08-12' });

    const lista = await request(app).get('/api/v1/core/equipment').set(gerente);
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    const naLista = (lista.body.items as { id: string; warranty?: WarrantyView }[]).find(
      (e) => e.id === maquina.id,
    )!;
    expect(naLista.warranty).toBeTruthy();
    expect(naLista.warranty!.expiresAt).toBe('2027-02-12');
    expect(naLista.warranty!.status).toBe('vigente');

    // E é a MESMA resposta da ficha: se um dia divergirem, este teste conta.
    const ficha = await request(app)
      .get(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente);
    expect(naLista.warranty).toEqual(ficha.body.warranty);
  });

  it('sem meses combinados, não há garantia — e a ficha diz isso', () => {
    expect(warrantyOf({ entered_at: '2026-01-01' }).status).toBe('sem_garantia');
    expect(warrantyOf({ warranty_months: 12 }).status).toBe('sem_garantia');
  });

  it('garantia absurda é 400 na porta', async () => {
    const res = await request(app)
      .post('/api/v1/core/equipment?workshopId=ws-mob')
      .set(gerente)
      .send({ origin: 'INTERNAL_PJ_MOTORS', warrantyMonths: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_INVALID_WARRANTY');
  });
});

describe('a ficha da máquina — o histórico que ninguém lia', () => {
  it('o histórico do equipamento aparece, com a OS que o gerou', async () => {
    /*
      `core_equipment_events` era write-only desde que nasceu: seis lugares
      gravavam e nenhuma tela lia (auditoria da rodada 14). Aqui a criação e a
      OS aberta aparecem na ficha, com o número da OS resolvido.
    */
    const maquina = await cadastrarMaquina();
    const os = await abrirOs('ws-mob', { equipmentId: maquina.id });

    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(gerente);
    const tipos = (ficha.body.events as { event_type: string }[]).map((e) => e.event_type);
    expect(tipos).toContain('created');
    expect(tipos).toContain('order_opened');

    const evtOs = (ficha.body.events as { order_number: number | null }[]).find(
      (e) => e.order_number != null,
    );
    expect(evtOs?.order_number).toBe(os.number);

    // E as OS daquela máquina vêm junto — é o histórico de manutenção.
    expect((ficha.body.orders as { id: string }[]).map((o) => o.id)).toContain(os.id);
  });

  it('o token da plaquinha NÃO sai na ficha — quem projeta o público é o portal', async () => {
    const maquina = await cadastrarMaquina();
    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(gerente);
    expect(JSON.stringify(ficha.body)).not.toContain(String(maquina.public_token));
    expect(ficha.body.equipment.public_token).toBeUndefined();
  });

  it('máquina de outra empresa é 404 — nem existe para quem pergunta', async () => {
    const maquina = await cadastrarMaquina();
    const outra = await loginForTest(app, {
      userId: 'gerente-outro',
      companyId: 'outra-oficina-co',
      profileCodes: ['gerente_oficina'],
    });
    const res = await request(app)
      .get(`/api/v1/core/equipment/${maquina.id}`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(404);
  });
});

describe('completar a ficha depois — o patch estreito', () => {
  it('garantia, montador e datas entram pelo PATCH, e o histórico registra', async () => {
    const maquina = await cadastrarMaquina();
    const quemMontou = getConnection()
      .prepare("SELECT id FROM core_users WHERE display_name = 'mec-52'")
      .get() as { id: string };

    const res = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ warrantyMonths: 6, assemblyMechanicId: quemMontou.id, assembledAt: '2026-03-15' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.warranty_months).toBe(6);
    expect(res.body.assembly_mechanic_id).toBe(quemMontou.id);
    expect(res.body.assembled_at).toBe('2026-03-15');

    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(gerente);
    expect(ficha.body.assemblyMechanicName).toBe('mec-52');
    expect(JSON.stringify(ficha.body.events)).toContain('Ficha atualizada');
  });

  it('montador que não é da empresa é recusado', async () => {
    const maquina = await cadastrarMaquina();
    const forasteiro = await loginForTest(app, {
      userId: 'de-fora',
      companyId: 'outra-oficina-co',
      profileCodes: ['mecanico'],
    });
    expect(forasteiro.status).toBe(200);
    const idDeFora = (
      getConnection()
        .prepare("SELECT id FROM core_users WHERE display_name = 'de-fora'")
        .get() as { id: string }
    ).id;

    const res = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ assemblyMechanicId: idDeFora });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_MECHANIC_NOT_IN_COMPANY');
  });

  it('o patch NÃO edita identidade — chassi e série continuam sem porta', async () => {
    const maquina = await cadastrarMaquina({ chassis: 'CH-ORIGINAL' });
    await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({ warrantyMonths: 3, chassis: 'CH-FALSIFICADO', serialNumber: 'OUTRO' })
      .expect(200);

    const linha = getConnection()
      .prepare('SELECT chassis, serial_number FROM core_equipment WHERE id = ?')
      .get(maquina.id) as { chassis: string; serial_number: string | null };
    expect(linha.chassis).toBe('CH-ORIGINAL');
  });

  it('patch vazio é 400 — não se escreve linha à toa', async () => {
    const maquina = await cadastrarMaquina();
    const res = await request(app)
      .patch(`/api/v1/core/equipment/${maquina.id}`)
      .set(gerente)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_EQUIPMENT_PATCH_EMPTY');
  });
});

describe('a foto da OS vai para o DISCO', () => {
  it('sobe, grava os bytes em arquivo e devolve o endereço — nada de base64 no banco', async () => {
    const os = await abrirOs();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1, fileName: 'entrada.png', kind: 'entrada', caption: 'Como chegou' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // O link volta ASSINADO e curto (GAP-PRD-184); o caminho cru não abre nada.
    expect(res.body.url).toMatch(/^\/uploads\/os\/[0-9a-f-]{36}\.png\?e=\d+&s=[\w-]+$/);
    expect(res.body.kind).toBe('entrada');
    expect(res.body.caption).toBe('Como chegou');

    // O arquivo existe no disco, com os bytes certos...
    const nome = String(res.body.url).split('?')[0].split('/').pop()!;
    const caminho = join(photosDir(), nome);
    expect(existsSync(caminho)).toBe(true);
    expect(readFileSync(caminho).length).toBe(Number(res.body.byte_size));

    // ...e o banco guardou o ENDEREÇO, não a imagem.
    const linha = getConnection()
      .prepare('SELECT url FROM core_service_order_photos WHERE id = ?')
      .get(res.body.id) as { url: string };
    // O banco guarda o caminho cru; a assinatura é montada na resposta.
    expect(String(res.body.url).split('?')[0]).toBe(linha.url);
    expect(linha.url).not.toContain('base64');
  });

  it('apagar tira a linha E o arquivo', async () => {
    const os = await abrirOs();
    const foto = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1 });
    const caminho = join(photosDir(), String(foto.body.url).split('?')[0].split('/').pop()!);
    expect(existsSync(caminho)).toBe(true);

    await request(app)
      .delete(`/api/v1/core/workshop/orders/${os.id}/photos/${foto.body.id}`)
      .set(gerente)
      .expect(204);

    expect(existsSync(caminho)).toBe(false);
    const lista = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente);
    expect(lista.body.items).toHaveLength(0);
  });

  it('formato não aceito e arquivo vazio são recusados', async () => {
    const os = await abrirOs();
    const pdf = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: 'data:application/pdf;base64,JVBERi0=' });
    expect(pdf.status).toBe(400);
    expect(pdf.body.error?.code).toBe('CORE_IMAGE_FORMAT_INVALID');

    const vazio = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: 'data:image/png;base64,' });
    expect(vazio.status).toBe(400);
    expect(vazio.body.error?.code).toBe('CORE_IMAGE_INVALID');
  });

  it('OS finalizada não recebe foto nova — a história do serviço não se reescreve', async () => {
    const os = await abrirOs();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);
    // Conferência respondida para a conclusão passar.
    const check = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(mecanico);
    for (const item of check.body.items as { id: string }[]) {
      await request(app)
        .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
        .set(mecanico)
        .send({ answer: 'sim' })
        .expect(200);
    }
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Garantia', hasCost: false, noCostReason: 'garantia' })
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1 });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CORE_ORDER_CLOSED');
  });

  /**
   * OS FINALIZADA TAMBÉM NÃO PERDE FOTO.
   *
   * A entrada estava fechada e a SAÍDA não: `removeOrderPhoto` não olhava o
   * status. A foto de entrada é justamente a que prova que o risco na lataria
   * já existia — e ela some para sempre, arquivo e linha, num DELETE que
   * respondia 204. A regra existia só no navegador, escondendo o botão.
   */
  it('OS finalizada não perde foto — apagar prova de serviço entregue é 409', async () => {
    const os = await abrirOs();
    const foto = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1, kind: 'entrada' })
      .expect(201);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);
    const check = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(mecanico);
    for (const item of check.body.items as { id: string }[]) {
      await request(app)
        .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
        .set(mecanico)
        .send({ answer: 'sim' })
        .expect(200);
    }
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Garantia', hasCost: false, noCostReason: 'garantia' })
      .expect(200);

    const res = await request(app)
      .delete(`/api/v1/core/workshop/orders/${os.id}/photos/${foto.body.id}`)
      .set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_ORDER_CLOSED');

    // E a prova continua onde estava — linha e arquivo.
    const ainda = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente);
    expect(ainda.body.items).toHaveLength(1);
    expect(existsSync(join(photosDir(), String(foto.body.url).split('?')[0].split('/').pop()!))).toBe(true);
  });

  it('a foto de OS de outra empresa não é listada nem apagada', async () => {
    const os = await abrirOs();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1 })
      .expect(201);

    const outra = await loginForTest(app, {
      userId: 'gerente-outro',
      companyId: 'outra-oficina-co',
      profileCodes: ['gerente_oficina'],
    });
    const res = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/photos`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(404);
  });
});

describe('a conferência de entrada', () => {
  it('nasce com a OS, e o modelo é o da BANCADA', async () => {
    criarBancada('ws-cel', 'phones');

    const daMoto = await abrirOs('ws-mob');
    const doCelular = await abrirOs('ws-cel');

    const moto = await request(app)
      .get(`/api/v1/core/workshop/orders/${daMoto.id}/checklist`)
      .set(gerente);
    const celular = await request(app)
      .get(`/api/v1/core/workshop/orders/${doCelular.id}/checklist`)
      .set(gerente);

    const itensMoto = (moto.body.items as { item: string }[]).map((i) => i.item);
    const itensCelular = (celular.body.items as { item: string }[]).map((i) => i.item);
    expect(itensMoto).toContain('Retrovisores');
    expect(itensMoto).not.toContain('Chip (SIM)');
    expect(itensCelular).toContain('Chip (SIM)');
    expect(itensCelular).not.toContain('Retrovisores');
    expect(moto.body.pendentes).toBe(itensMoto.length);
  });

  it('responder guarda QUEM conferiu; desconferir apaga o nome', async () => {
    const os = await abrirOs();
    const lista = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(gerente);
    const item = (lista.body.items as { id: string }[])[0];

    const respondido = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
      .set(mecanico)
      .send({ answer: 'nao', note: 'Cliente levou junto' });
    expect(respondido.status, JSON.stringify(respondido.body)).toBe(200);
    expect(respondido.body.answer).toBe('nao');
    expect(respondido.body.note).toBe('Cliente levou junto');
    expect(respondido.body.answered_by).toBeTruthy();
    expect(respondido.body.answered_at).toBeTruthy();

    const desfeito = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
      .set(mecanico)
      .send({ answer: 'pendente' });
    expect(desfeito.body.answered_by).toBeNull();
    expect(desfeito.body.answered_at).toBeNull();
  });

  it('item PENDENTE segura a conclusão — e "não veio" NÃO segura', async () => {
    const os = await abrirOs();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);

    const bloqueada = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Trocado', hasCost: false, noCostReason: 'garantia' });
    expect(bloqueada.status).toBe(409);
    expect(bloqueada.body.error?.code).toBe('CORE_CHECKLIST_PENDING');

    // Responder TUDO com "não veio" é resposta legítima e destrava.
    const lista = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(mecanico);
    for (const item of lista.body.items as { id: string }[]) {
      await request(app)
        .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
        .set(mecanico)
        .send({ answer: 'nao' })
        .expect(200);
    }
    const passou = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Trocado', hasCost: false, noCostReason: 'garantia' });
    expect(passou.status, JSON.stringify(passou.body)).toBe(200);
  });

  it('forçar conclui — e a decisão fica na linha do tempo com nome', async () => {
    const os = await abrirOs();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' })
      .expect(200);

    const forcada = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanico)
      .send({
        diagnosis: 'Cliente com pressa',
        hasCost: false,
        noCostReason: 'garantia',
        forcarChecklist: true,
      });
    expect(forcada.status, JSON.stringify(forcada.body)).toBe(200);

    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${os.id}`).set(gerente);
    expect(JSON.stringify(detalhe.body.comments)).toContain('conferência de entrada incompleta');
  });

  it('resposta inventada é 400', async () => {
    const os = await abrirOs();
    const lista = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(gerente);
    const item = (lista.body.items as { id: string }[])[0];
    const res = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/checklist/${item.id}`)
      .set(mecanico)
      .send({ answer: 'talvez' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_CHECKLIST_ANSWER_INVALID');
  });

  it('bancada sem modelo não ganha lista de enfeite', async () => {
    criarBancada('ws-outro', 'mobility');
    getConnection()
      .prepare("UPDATE core_workshops SET kind = 'nautica' WHERE id = 'ws-outro'")
      .run();
    const os = await abrirOs('ws-outro');
    const lista = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}/checklist`)
      .set(gerente);
    expect(lista.body.items).toEqual([]);
    expect(lista.body.pendentes).toBe(0);
  });
});

describe('a migração 67 leva a máquina velha junto', () => {
  it('banco v66: as colunas nascem e a data de entrada herda a criação', () => {
    /*
      `entered_at` existia desde o início e nunca foi lida nem escolhida: era
      sempre o instante do cadastro. Agora ela é a data em que a máquina
      entrou — e é a base da garantia quando não houve venda. Linha antiga com
      nulo herda o `created_at`: o retrato honesto do que se sabe.
    */
    const db = getConnection();
    for (let passo = 2; passo <= 66; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_67');
    db.exec('ALTER TABLE core_equipment DROP COLUMN warranty_months;');
    db.exec('ALTER TABLE core_equipment DROP COLUMN assembly_mechanic_id;');
    db.exec('ALTER TABLE core_equipment DROP COLUMN assembled_at;');
    db.prepare('UPDATE core_equipment SET entered_at = NULL').run();

    db.prepare(
      `INSERT INTO core_companies (id, slug, legal_name, trade_name, kind, active, created_at, updated_at)
       VALUES ('emp-67', 'emp-67', 'Empresa 67', 'Empresa 67', 'workshop', 1, '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES ('ws-67', 'emp-67', 'ws-67', 'Bancada 67', 'mobility', 1, '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO core_equipment
         (id, company_id, workshop_id, public_id, public_token, origin, sale_status, status,
          entered_at, created_at, updated_at)
       VALUES ('eq-antiga', 'emp-67', 'ws-67', 99999, 'tok-antigo', 'INTERNAL_PJ_MOTORS',
               'NOT_SOLD', 'ativo', NULL, '2026-02-03T10:00:00Z', '2026-02-03T10:00:00Z')`,
    ).run();

    /*
      A armadilha da rodada 52, disparada pela 53 (passo 68, o pool da
      plaquinha). Conferido: o passo 68 nao toca em `core_equipment.entered_at`
      nem nas colunas de garantia — ele acrescenta duas tabelas, a coluna da
      regra de ouro e carrega o pool a partir do que ja existe. A maquina
      velha deste caso continua herdando a data de criacao, e passa a ter
      tambem uma linha no pool, associada, com o proprio numero.
    */
    /*
      Rodada 54 (passo 69, a marca de quem assina o papel da bancada):
      conferido que o passo so acrescenta `core_workshops.brand_company_id` e
      regrava as duas bancadas oficiais. Nao toca em equipamento, em OS nem
      em tabela de preco — os casos abaixo seguem valendo.
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
      Passo 74 (o rastro do item cancelado no carrinho — GAP-V52/V63):
      conferido que o passo só marca a tabela NOVA `core_sale_removed_items`
      (criada pelo IF NOT EXISTS do ensureCoreSchema) e garante o índice por
      venda. Não toca em equipamento, plaquinha, OS nem garantia — os casos
      abaixo seguem valendo.
    */
    /*
      Passos 75-77 (rodada dos vídeos): anexo na fila de e-mail + índices do
      pacote do contador (75), cópia de arquivamento do evento fiscal (76) e
      espécie/estorno da nota de entrada (77 — doc_type com DEFAULT 'nfe' e
      três colunas nullable). Nenhum toca em equipamento, plaquinha, OS nem
      garantia — os casos abaixo seguem valendo.
    */
    /*
      Passo 78 (a liberação diz ONDE foi digitada, e o turno reabre —
      GAP-V61/V64): `terminal_id`/`ip` em `core_authorizations` e as cinco da
      trilha de reabertura em `core_cash_sessions`. Só ALTER de coluna nova —
      nenhum toca em equipamento, plaquinha, OS nem garantia; os casos abaixo
      seguem valendo.
    */
    /*
      Passo 79 (o crédito de loja ganha razão — GAP-V10/V47): a tabela
      `core_customer_credits` é nova e nasce pela DDL canônica; o passo só
      garante o índice. Não toca em equipamento, plaquinha, OS nem garantia —
      os casos abaixo seguem valendo.
    */
    /*
      Passo 80 (o catálogo ganha serviço, faixa, embalagem, campo próprio, dia
      da semana e IPI — GAP-V01/V08): seis ALTER em `core_products`,
      `core_promotions` e `core_tax_groups`, mais três tabelas novas. Nenhum
      toca em equipamento, plaquinha, OS nem garantia — os casos abaixo seguem
      valendo.
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
      escopo de bancada de cada vínculo gravado; as tabelas de modelos de
      permissão nascem na DDL canônica. Não toca em equipamento, plaquinha, OS
      nem garantia — os casos abaixo seguem valendo.
    */
    expect(CORE_TARGET_VERSION).toBe(86);
    migrateCoreSchema();

    const eq = db
      .prepare('SELECT warranty_months, entered_at FROM core_equipment WHERE id = ?')
      .get('eq-antiga') as { warranty_months: number | null; entered_at: string };
    expect(eq.warranty_months).toBeNull();
    expect(eq.entered_at).toBe('2026-02-03T10:00:00Z');
  });
});

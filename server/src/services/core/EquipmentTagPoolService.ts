/**
 * O POOL DE PLAQUINHAS — o número existe antes da máquina.
 *
 * ## O que mudou de lugar
 *
 * Até a rodada 52 a plaquinha nascia junto do equipamento: `createEquipment`
 * chamava `nextPublicId()` e o adesivo só podia ser impresso depois que a moto
 * já estava cadastrada. A oficina trabalha ao contrário — manda imprimir uma
 * folha de adesivos, cola nas máquinas do pátio, e só então senta para
 * cadastrar cada uma com o número que já está colado nela.
 *
 * Os dois caminhos continuam valendo, e o pool é o registro de todos os
 * números do grupo nos dois. Cadastrar sem escolher plaquinha continua
 * sorteando um número — e agora também cria a linha do pool, já `associada`.
 * Sem isso haveria duas numerações vivas, e a primeira colisão seria dois
 * adesivos com o mesmo número em duas motos.
 *
 * ## Os quatro estados, do sistema anterior
 *
 *   gerada     o número foi reservado; o papel ainda não existe
 *   disponivel a folha FOI exportada; o adesivo existe e pode ser colado
 *   associada  já está numa máquina (`equipment_id`) — e isso não se desfaz —
 *              OU colado numa moto do estoque da PJ Motors (`unit_id`, P0 das
 *              plaquinhas: `PlaquinhaDaPjNaUnidade.ts`). Na unidade, e só
 *              enquanto a moto está no pátio, o adesivo pode ser solto e volta
 *              a `disponivel` — é a correção da moto errada, não um desfazer
 *   danificada o adesivo se perdeu, e o número morre com ele
 *
 * `printed_at` é o que separa `gerada` de `disponivel`. Liberar plaquinha que
 * nunca foi ao papel cria número que existe no sistema e não existe no mundo:
 * alguém digita "#0042" no cadastro, o sistema aceita, e não há adesivo nenhum
 * com esse número em lugar nenhum.
 *
 * ## O que do sistema anterior NÃO veio
 *
 *  - `resetarLote` (`disponivel` de volta para `gerado`, "para testar
 *    novamente"): o adesivo já saiu na impressora. Desfazer a liberação no
 *    banco não descola nada da parede, e cria a pior divergência possível —
 *    papel que existe e sistema que diz que não;
 *  - `excluirPlaquinha` apagando linha em QUALQUER estado, inclusive
 *    `associada`: some o vínculo com a máquina e o número volta ao sorteio,
 *    para ser impresso de novo e colado noutra moto. Aqui número usado não
 *    volta: o caminho para adesivo perdido é `danificada`;
 *  - o pool no `localStorage` de cada navegador: dois computadores da mesma
 *    oficina discordavam sobre quais números existiam.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { EMPRESA_DAS_PLAQUINHAS, ehEmpresaDasPlaquinhas } from './EmpresaDasPlaquinhas.js';

export const TAG_STATUSES = ['gerada', 'disponivel', 'associada', 'danificada'] as const;
export type TagStatus = (typeof TAG_STATUSES)[number];

/**
 * Teto do lote, herdado do sistema anterior.
 *
 * Mil adesivos são ~48 folhas A4 na geometria de 21 por folha. Acima disso o
 * pedido quase sempre é erro de digitação, e o estrago é numeração do GRUPO
 * queimada: o número reservado não volta.
 */
export const MAX_LOTE = 1000;

export interface EquipmentTag {
  id: string;
  company_id: string;
  public_id: number;
  public_token: string;
  status: TagStatus;
  batch_id: string | null;
  equipment_id: string | null;
  /**
   * A unidade de estoque da PJ em que o adesivo foi colado (P0 das
   * plaquinhas). `associada` com `unit_id` e sem `equipment_id` é a plaquinha
   * da PJ na moto do pátio; na `danificada` fica guardado para a auditoria.
   */
  unit_id: string | null;
  printed_at: string | null;
  released_at: string | null;
  associated_at: string | null;
  damaged_at: string | null;
  damaged_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** `#0001` — o mesmo formato humano do equipamento. */
export function formatTagId(publicId: number): string {
  return `#${String(publicId).padStart(4, '0')}`;
}

// A constante mora num módulo sem dependências (ver o cabeçalho dele); aqui ela
// é reexportada para quem já importa o pool.
export { EMPRESA_DAS_PLAQUINHAS, ehEmpresaDasPlaquinhas };

/**
 * A REGRA DE OURO, num lugar só — e agora ela é de UMA empresa.
 *
 * ## O defeito
 *
 * A regra dizia "plaquinha com QR e número é da PJ Motors e da Oficina", e a
 * pergunta ia só ao cadastro (`uses_equipment_tags`). O dono restringiu: a
 * plaquinha existe SÓ na PJ Motors. Perguntar apenas à coluna deixava três
 * portas abertas para outra empresa enxergar e mexer no pool:
 *   - o banco que já existe tem `uses_equipment_tags = 1` na Oficina (o passo
 *     de migração 68 e a subida do servidor marcavam as duas);
 *   - a tela de Empresas ligava a marca em qualquer operação, e a criação de
 *     oficina de mobilidade nascia com ela ligada por padrão;
 *   - as leituras do pool não perguntavam nada, e respondiam com a lista.
 *
 * ## A regra, agora
 *
 * As DUAS coisas têm de ser verdade: a marca ligada no cadastro E a empresa ser
 * a PJ Motors. A marca continua mandando dentro da PJ (desligada, nem ela usa);
 * o slug garante que nenhuma outra — Preço Justo, Oficina, Gringa, Me Mimei,
 * Conceito ou a que nascer amanhã — passe, mesmo com a marca ligada num banco
 * antigo. Nada é apagado: a plaquinha que a Oficina já tinha continua no banco,
 * só deixa de ser alcançável.
 */
export function empresaUsaPlaquinha(companyId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT slug, uses_equipment_tags FROM core_companies WHERE id = ?')
    .get(companyId) as { slug?: string; uses_equipment_tags?: number } | undefined;
  return Number(row?.uses_equipment_tags ?? 0) === 1 && ehEmpresaDasPlaquinhas(row?.slug);
}

/**
 * O mesmo guarda, em forma de recusa — para TODA rota de plaquinha, leitura
 * inclusive.
 *
 * 403 e não mais 409: não é um estado que a pessoa conserta clicando em outra
 * coisa ("gere o lote antes"), é a empresa da sessão que não tem a função. O
 * código continua `CORE_COMPANY_NO_TAGS` para quem já o trata.
 */
export function exigirEmpresaComPlaquinha(companyId: string): void {
  if (empresaUsaPlaquinha(companyId)) return;
  const nome = (
    getConnection()
      .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
      .get(companyId) as { trade_name?: string } | undefined
  )?.trade_name;
  throw new ApiError(
    'CORE_COMPANY_NO_TAGS',
    `Plaquinha com QR e número é exclusiva da PJ Motors: ${nome ?? 'esta empresa'} não gera, não `
    + 'imprime, não vincula nem consulta plaquinha. Aqui a identificação é a etiqueta de produto, '
    + 'com código de barras e preço.',
    403,
  );
}

/*
 * A REGRA DA BANCADA SAIU DA PLAQUINHA (decisão do dono, depois do P0).
 *
 * ## O defeito
 *
 * Duas regras diziam coisas opostas sobre a mesma empresa. A de cima fez a
 * plaquinha EXCLUSIVA da PJ Motors; uma mais velha (GAP-PRD-110, "quem gera
 * plaquinha é quem tem bancada para colá-la") exigia bancada ativa na empresa
 * para gerar, imprimir a folha e liberar — com 409 `CORE_TAGS_NEED_WORKSHOP`.
 * A PJ Motors não tem bancada. Somadas, as duas davam: a única empresa que
 * pode ter plaquinha era justamente a que não podia gerar. NINGUÉM gerava lote
 * novo, e a tela da PJ trocava "Gerar lote" por um aviso de "sem bancada".
 *
 * ## Por que a regra velha não se sustenta mais
 *
 * Ela nasceu quando a plaquinha era da PJ E da Oficina, e protegia contra lote
 * gerado onde ninguém cola o adesivo — o de quem cola era a Oficina. Hoje a
 * Oficina não tem plaquinha nenhuma (403 em toda rota), e o dono decidiu que a
 * PJ Motors gera, imprime, libera, consulta e administra as dela. O portão é a
 * EMPRESA (`exigirEmpresaComPlaquinha`), e só ele: quem não é a PJ continua com
 * 403 `CORE_COMPANY_NO_TAGS`, exatamente como antes.
 *
 * As regras de bancada que NÃO são de plaquinha continuam onde estão: a peça
 * exige bancada que trabalhe com peça (`WorkshopPartsEntryService`), e a
 * bancada de celulares não dá QR à máquina dela (`capabilitiesFor(kind)`, nas
 * rotas por máquina e na reimpressão pela unidade).
 */

/** O token do QR: imprevisível, porque é o que protege a página pública. */
function novoToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Reserva N números do GRUPO e cria as plaquinhas em `gerada`.
 *
 * O sistema anterior pedia início e fim, e conferia colisão item a item — era
 * a única saída sem sequência no servidor. Aqui se pede QUANTAS: a sequência
 * do grupo sabe onde parou, e ninguém tem como pedir um intervalo que invada
 * números já colados numa moto.
 */
export function criarLoteDePlaquinhas(input: {
  companyId: string;
  userId: string;
  quantidade: number;
}): { batchId: string; criadas: number; primeira: number; ultima: number } {
  ensureCoreSchema();
  // Só a regra da empresa: a PJ Motors gera sem bancada (ver o bloco acima).
  exigirEmpresaComPlaquinha(input.companyId);

  const quantidade = Math.trunc(Number(input.quantidade));
  if (!Number.isFinite(quantidade) || quantidade < 1) {
    throw new ApiError('CORE_TAG_BATCH_EMPTY', 'Informe quantas plaquinhas gerar.', 400);
  }
  if (quantidade > MAX_LOTE) {
    throw new ApiError(
      'CORE_TAG_BATCH_TOO_BIG',
      `O lote máximo é de ${MAX_LOTE} plaquinhas — número reservado não volta.`,
      400,
      { max: MAX_LOTE },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const batchId = randomUUID();
    const agora = new Date().toISOString();
    const numeros: number[] = [];

    for (let i = 0; i < quantidade; i += 1) {
      const publicId = nextSequenceValue('__grupo__', 'equipment_public_id');
      numeros.push(publicId);
      db.prepare(
        `INSERT INTO core_equipment_tags
           (id, company_id, public_id, public_token, status, batch_id,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'gerada', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.companyId,
        publicId,
        novoToken(),
        batchId,
        input.userId,
        agora,
        agora,
      );
    }

    return {
      batchId,
      criadas: numeros.length,
      primeira: numeros[0]!,
      ultima: numeros[numeros.length - 1]!,
    };
  });
}

export interface PlaquinhaNaLista extends EquipmentTag {
  publicIdLabel: string;
  equipment_label: string | null;
  /** A moto do estoque da PJ em que o adesivo foi colado: marca, modelo e chassi. */
  unit_label: string | null;
}

/**
 * A CREDENCIAL NÃO VIAJA NA LISTA.
 *
 * `public_token` abre a página pública do equipamento sem sessão, não expira e
 * não se revoga — e para a plaquinha `associada` ele É o token da máquina. A
 * lista de equipamentos já poda o campo com quinze linhas de comentário
 * explicando por quê; a do pool tem que fazer igual.
 *
 * A poda é na FRONTEIRA (a rota), e não aqui dentro: quem imprime a folha
 * precisa do token para montar o endereço do QR, e é a mesma função que
 * responde às duas.
 */
export function semCredencial<T extends { public_token?: string }>(t: T): Omit<T, 'public_token'> {
  const visivel: Record<string, unknown> = { ...t };
  delete visivel.public_token;
  return visivel as Omit<T, 'public_token'>;
}

export function listarPlaquinhas(input: {
  companyId: string;
  status?: string;
  batchId?: string;
  busca?: string;
  limite?: number;
}): { itens: PlaquinhaNaLista[]; total: number } {
  ensureCoreSchema();
  const params: unknown[] = [input.companyId];
  /*
    A MOTO DO ESTOQUE TAMBÉM DÁ NOME À PLAQUINHA (P0 das plaquinhas).

    O pool só sabia dizer "na máquina tal": a plaquinha da PJ colada numa
    unidade do estoque aparecia como associada a nada. `unit_label` é marca,
    modelo e chassi da unidade — a mesma empresa da plaquinha, e só ela.

    Nenhum SELECT aninhado na lista de colunas: o total logo abaixo troca o
    trecho até o primeiro FROM por COUNT(*), e um FROM de subconsulta aqui
    quebraria a conta em silêncio.
  */
  let sql = `
    SELECT t.*,
           CASE WHEN e.id IS NULL THEN NULL
                ELSE TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')) END AS equipment_label,
           CASE WHEN u.id IS NULL THEN NULL
                ELSE TRIM(COALESCE(p.brand, '') || ' ' || COALESCE(p.name, '')
                     || CASE WHEN u.chassis IS NOT NULL THEN ' · ' || u.chassis ELSE '' END) END AS unit_label
      FROM core_equipment_tags t
      LEFT JOIN core_equipment e ON e.id = t.equipment_id
      LEFT JOIN core_product_units u ON u.id = t.unit_id AND u.company_id = t.company_id
      LEFT JOIN core_products p ON p.id = u.product_id
     WHERE t.company_id = ?`;

  if (input.status) {
    if (!(TAG_STATUSES as readonly string[]).includes(input.status)) {
      throw new ApiError('CORE_TAG_STATUS_INVALID', 'Situação de plaquinha desconhecida.', 400);
    }
    sql += ' AND t.status = ?';
    params.push(input.status);
  }
  if (input.batchId) {
    sql += ' AND t.batch_id = ?';
    params.push(input.batchId);
  }
  const busca = String(input.busca ?? '').trim();
  if (busca) {
    // "#0007", "0007" e "7" são a mesma plaquinha: é assim que o balcão a chama.
    const numero = Number(busca.replace(/^#/, '').trim());
    if (Number.isInteger(numero) && numero > 0) {
      sql += ' AND t.public_id = ?';
      params.push(numero);
    } else {
      // A busca por texto acha também a moto do estoque (nome do produto ou
      // chassi): é por ela que a PJ procura o adesivo que colou.
      sql += " AND (TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')) LIKE ?"
        + ' OR p.name LIKE ? OR u.chassis LIKE ?)';
      params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
    }
  }
  /*
    O CORTE E DITO, nao escondido.

    A tela mostra o total verdadeiro no cabecalho (que vem do resumo, e
    conta tudo) e a lista logo abaixo com as mais NOVAS: com mais de 300
    plaquinhas, quem olha conclui que as antigas sumiram. O total filtrado
    sai junto para a tela poder dizer "mostrando 300 de 1.180".
  */
  const total = Number(
    (getConnection()
      .prepare(sql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) AS n FROM'))
      .get(...(params as never[])) as { n?: number } | undefined)?.n ?? 0,
  );
  const limite = Math.min(Math.max(Math.trunc(Number(input.limite ?? 300)), 1), 1000);
  sql += ` ORDER BY t.public_id DESC LIMIT ${limite}`;

  const linhas = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as PlaquinhaNaLista[];
  return { itens: linhas.map((t) => ({ ...t, publicIdLabel: formatTagId(t.public_id) })), total };
}

/**
 * As plaquinhas ESCOLHIDAS, buscadas pelo id — sem passar por lista janelada.
 *
 * A folha resolvia a seleção filtrando `listarPlaquinhas({ limite: 1000 })`,
 * que ordena por número DESCENDENTE: num lote cheio de mil, a plaquinha mais
 * VELHA some da janela assim que qualquer outra nasce. E o que a folha não
 * desenha não recebe `printed_at` — logo não pode ser liberado, e o lote fica
 * preso em `gerada` para sempre, com a numeração queimada. Pior no meio-termo:
 * dez ids fora da janela sumiam calados e a resposta vinha 200.
 */
export function plaquinhasPorId(companyId: string, ids: string[]): EquipmentTag[] {
  ensureCoreSchema();
  if (ids.length === 0) return [];
  const marcas = ids.map(() => '?').join(', ');
  return getConnection()
    .prepare(
      `SELECT * FROM core_equipment_tags
        WHERE company_id = ? AND id IN (${marcas})
        ORDER BY public_id`,
    )
    .all(companyId, ...(ids as never[])) as unknown as EquipmentTag[];
}

/** Todas as plaquinhas de um lote, sem teto: a folha precisa do lote INTEIRO. */
export function plaquinhasDoLote(companyId: string, batchId: string): EquipmentTag[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_equipment_tags
        WHERE company_id = ? AND batch_id = ?
        ORDER BY public_id`,
    )
    .all(companyId, batchId) as unknown as EquipmentTag[];
}

/** Quantas em cada estado — é o cabeçalho da tela. */
export function resumoDoPool(companyId: string): Record<TagStatus | 'total', number> {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM core_equipment_tags
        WHERE company_id = ? GROUP BY status`,
    )
    .all(companyId) as unknown as { status: string; n: number }[];
  const resumo = { gerada: 0, disponivel: 0, associada: 0, danificada: 0, total: 0 };
  for (const l of linhas) {
    if (l.status in resumo) resumo[l.status as TagStatus] = Number(l.n);
    resumo.total += Number(l.n);
  }
  return resumo;
}

export interface LoteDePlaquinhas {
  batchId: string;
  criadoEm: string;
  total: number;
  geradas: number;
  disponiveis: number;
  associadas: number;
  danificadas: number;
  impressas: number;
  primeira: string;
  ultima: string;
}

/** Os lotes, do mais novo para o mais velho. */
export function listarLotes(companyId: string): LoteDePlaquinhas[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT batch_id,
              MIN(created_at) AS criado_em,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'gerada' THEN 1 ELSE 0 END) AS geradas,
              SUM(CASE WHEN status = 'disponivel' THEN 1 ELSE 0 END) AS disponiveis,
              SUM(CASE WHEN status = 'associada' THEN 1 ELSE 0 END) AS associadas,
              SUM(CASE WHEN status = 'danificada' THEN 1 ELSE 0 END) AS danificadas,
              SUM(CASE WHEN printed_at IS NOT NULL THEN 1 ELSE 0 END) AS impressas,
              MIN(public_id) AS primeira,
              MAX(public_id) AS ultima
         FROM core_equipment_tags
        WHERE company_id = ? AND batch_id IS NOT NULL
        GROUP BY batch_id
        ORDER BY MIN(created_at) DESC
        LIMIT 200`,
    )
    .all(companyId) as unknown as Record<string, string | number>[];

  return linhas.map((l) => ({
    batchId: String(l.batch_id),
    criadoEm: String(l.criado_em),
    total: Number(l.total),
    geradas: Number(l.geradas),
    disponiveis: Number(l.disponiveis),
    associadas: Number(l.associadas),
    danificadas: Number(l.danificadas),
    impressas: Number(l.impressas),
    primeira: formatTagId(Number(l.primeira)),
    ultima: formatTagId(Number(l.ultima)),
  }));
}

/** As plaquinhas que a folha vai desenhar — e a marca de que foram ao papel. */
export function marcarImpressas(companyId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getConnection();
  const agora = new Date().toISOString();
  const marca = db.prepare(
    `UPDATE core_equipment_tags SET printed_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  );
  for (const id of ids) marca.run(agora, agora, id, companyId);
}

/**
 * `gerada` vira `disponivel` — e só depois do papel.
 *
 * A recusa é o coração da regra: plaquinha liberada sem folha exportada é um
 * número que o cadastro aceita e que não existe colado em lugar nenhum.
 */
export function liberarPlaquinhas(input: {
  companyId: string;
  userId: string;
  ids?: string[];
  batchId?: string;
}): { liberadas: number } {
  ensureCoreSchema();
  // Liberar pedia também bancada ativa (GAP-PRD-110), e a PJ Motors — a única
  // com plaquinha — não tem: o lote impresso ficava preso em `gerada`. O que
  // decide é a empresa; o papel continua obrigatório logo abaixo.
  exigirEmpresaComPlaquinha(input.companyId);

  return withTransaction(() => {
    const db = getConnection();
    const alvo: EquipmentTag[] = input.batchId
      ? (db
          .prepare(
            `SELECT * FROM core_equipment_tags
              WHERE company_id = ? AND batch_id = ? AND status = 'gerada'`,
          )
          .all(input.companyId, input.batchId) as unknown as EquipmentTag[])
      : (input.ids ?? []).map((id) => {
          const t = db
            .prepare('SELECT * FROM core_equipment_tags WHERE id = ? AND company_id = ?')
            .get(id, input.companyId) as EquipmentTag | undefined;
          if (!t) throw new ApiError('CORE_TAG_NOT_FOUND', 'Plaquinha não encontrada.', 404);
          return t;
        });

    const paraLiberar = alvo.filter((t) => t.status === 'gerada');
    if (paraLiberar.length === 0) {
      throw new ApiError(
        'CORE_TAG_NOTHING_TO_RELEASE',
        'Nenhuma plaquinha à espera de liberação nesta seleção.',
        409,
      );
    }
    const semPapel = paraLiberar.filter((t) => !t.printed_at);
    if (semPapel.length > 0) {
      throw new ApiError(
        'CORE_TAG_NOT_PRINTED',
        `${semPapel.length} plaquinha(s) ainda não foram para o papel. Exporte a folha antes de `
        + 'liberar: número liberado sem adesivo é número que só existe no sistema.',
        409,
        { pendentes: semPapel.map((t) => formatTagId(t.public_id)) },
      );
    }

    const agora = new Date().toISOString();
    const libera = db.prepare(
      `UPDATE core_equipment_tags
          SET status = 'disponivel', released_at = ?, released_by = ?, updated_at = ?
        WHERE id = ? AND status = 'gerada'`,
    );
    for (const t of paraLiberar) libera.run(agora, input.userId, agora, t.id);
    return { liberadas: paraLiberar.length };
  });
}

/**
 * O adesivo se perdeu — e o número morre com ele.
 *
 * Plaquinha JÁ associada não passa por aqui: ela está colada numa máquina, e
 * marcá-la danificada sem mais nada deixaria a moto sem identificação e sem
 * caminho de volta. Para esse caso existe `substituirPlaquinha`, que dá outra
 * à máquina e aposenta a velha na mesma transação.
 */
export function marcarDanificada(input: {
  companyId: string;
  userId: string;
  tagId: string;
  motivo?: string | null;
}): EquipmentTag {
  ensureCoreSchema();
  exigirEmpresaComPlaquinha(input.companyId);

  return withTransaction(() => {
    const db = getConnection();
    const tag = db
      .prepare('SELECT * FROM core_equipment_tags WHERE id = ? AND company_id = ?')
      .get(input.tagId, input.companyId) as EquipmentTag | undefined;
    if (!tag) throw new ApiError('CORE_TAG_NOT_FOUND', 'Plaquinha não encontrada.', 404);
    if (tag.status === 'associada') {
      throw new ApiError(
        'CORE_TAG_IN_USE',
        `A ${formatTagId(tag.public_id)} está colada numa máquina. Para trocar o adesivo, use a `
        + 'substituição: a máquina recebe outra plaquinha e esta é aposentada junto.',
        409,
      );
    }
    if (tag.status === 'danificada') return tag;

    const agora = new Date().toISOString();
    db.prepare(
      `UPDATE core_equipment_tags
          SET status = 'danificada', damaged_at = ?, damaged_by = ?, damaged_reason = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(agora, input.userId, String(input.motivo ?? '').trim() || null, agora, tag.id);

    return db
      .prepare('SELECT * FROM core_equipment_tags WHERE id = ?')
      .get(tag.id) as unknown as EquipmentTag;
  });
}

/**
 * A plaquinha que o cadastro escolheu — e ela tem que estar disponível.
 *
 * Chamada de DENTRO da transação de `createEquipment`: a associação e o
 * nascimento da máquina são o mesmo fato, e meia associação deixaria um número
 * queimado sem dono.
 */
export function reservarPlaquinhaParaEquipamento(input: {
  companyId: string;
  publicId: number;
}): EquipmentTag {
  const db = getConnection();
  const tag = db
    .prepare('SELECT * FROM core_equipment_tags WHERE public_id = ?')
    .get(input.publicId) as EquipmentTag | undefined;

  if (!tag) {
    throw new ApiError(
      'CORE_TAG_NOT_FOUND',
      // A frase antiga ("gere um lote e exporte a folha antes de usar o número")
      // mandava a Oficina gerar lote — e fora da PJ Motors ninguém gera. A
      // plaquinha da PJ nem passa por aqui: entra na moto pela unidade.
      `A plaquinha ${formatTagId(input.publicId)} não existe no sistema. Os números saem dos lotes `
      + 'gerados em Plaquinhas; a plaquinha da PJ Motors entra na moto pela unidade, em Estoque › '
      + 'Unidades.',
      404,
    );
  }
  if (tag.company_id !== input.companyId) {
    throw new ApiError(
      'CORE_TAG_OTHER_COMPANY',
      `A plaquinha ${formatTagId(tag.public_id)} é de outra operação do grupo.`,
      409,
    );
  }
  if (tag.status === 'associada') {
    throw new ApiError(
      'CORE_TAG_IN_USE',
      // "Outra máquina" deixou de ser verdade sozinha: a plaquinha associada
      // pode estar colada numa moto do estoque da PJ (`unit_id`).
      `A plaquinha ${formatTagId(tag.public_id)} já está em outra máquina ou moto.`,
      409,
    );
  }
  if (tag.status === 'danificada') {
    throw new ApiError(
      'CORE_TAG_DAMAGED',
      `A plaquinha ${formatTagId(tag.public_id)} está marcada como danificada.`,
      409,
    );
  }
  if (tag.status === 'gerada') {
    throw new ApiError(
      'CORE_TAG_NOT_RELEASED',
      `A plaquinha ${formatTagId(tag.public_id)} ainda não foi liberada. Exporte a folha do lote e `
      + 'libere antes de colar o adesivo na máquina.',
      409,
    );
  }
  return tag;
}

/** Fecha a associação. Chamada dentro da mesma transação do cadastro. */
export function associarPlaquinha(input: { tagId: string; equipmentId: string }): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `UPDATE core_equipment_tags
          SET status = 'associada', equipment_id = ?, associated_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(input.equipmentId, agora, agora, input.tagId);
}

/**
 * O caminho do número sorteado: o pool aprende sobre a máquina que nasceu sem
 * escolher plaquinha.
 *
 * `printed_at` fica nulo: este adesivo não veio de lote nenhum — vai ser
 * impresso pela folha do equipamento, uma a uma, como sempre foi.
 */
export function registrarPlaquinhaDoCadastro(input: {
  companyId: string;
  equipmentId: string;
  publicId: number;
  publicToken: string;
}): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_equipment_tags
         (id, company_id, public_id, public_token, status, equipment_id,
          associated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'associada', ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.companyId,
      input.publicId,
      input.publicToken,
      input.equipmentId,
      agora,
      agora,
      agora,
    );
}

/**
 * TROCAR O ADESIVO DE UMA MÁQUINA.
 *
 * O sistema anterior não tinha isto, e por isso a plaquinha danificada era um
 * beco: o adesivo descascava no sol, ninguém conseguia ler o QR, e a moto
 * ficava sem identificação para sempre — a associação era permanente e a
 * marcação de danificada não dava outra à máquina.
 *
 * Aqui a substituição é UM fato: a máquina passa a responder pelo número novo,
 * a plaquinha velha é aposentada como danificada (guardando de qual máquina
 * ela era, para a auditoria) e o histórico do equipamento registra a troca. O
 * QR antigo deixa de responder no mesmo instante — quem tiver o adesivo velho
 * na mão vê que ele não vale mais, que é exatamente o que se quer de um
 * adesivo que se perdeu.
 */
export function substituirPlaquinha(input: {
  companyId: string;
  userId: string;
  equipmentId: string;
  novaTagId: string;
  motivo?: string | null;
}): { anterior: string; atual: string } {
  ensureCoreSchema();
  exigirEmpresaComPlaquinha(input.companyId);

  return withTransaction(() => {
    const db = getConnection();
    const equipamento = db
      .prepare('SELECT id, public_id FROM core_equipment WHERE id = ? AND company_id = ?')
      .get(input.equipmentId, input.companyId) as
      | { id: string; public_id: number }
      | undefined;
    if (!equipamento) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
    }

    const nova = db
      .prepare('SELECT * FROM core_equipment_tags WHERE id = ? AND company_id = ?')
      .get(input.novaTagId, input.companyId) as EquipmentTag | undefined;
    if (!nova) throw new ApiError('CORE_TAG_NOT_FOUND', 'Plaquinha não encontrada.', 404);
    if (nova.status !== 'disponivel') {
      throw new ApiError(
        'CORE_TAG_NOT_AVAILABLE',
        `A ${formatTagId(nova.public_id)} não está disponível: só plaquinha liberada e sem dono `
        + 'entra numa máquina.',
        409,
      );
    }

    const antiga = db
      .prepare(
        `SELECT * FROM core_equipment_tags
          WHERE equipment_id = ? AND status = 'associada'`,
      )
      .get(input.equipmentId) as EquipmentTag | undefined;

    const agora = new Date().toISOString();
    const motivo = String(input.motivo ?? '').trim();
    if (!motivo) {
      throw new ApiError(
        'CORE_TAG_REPLACE_REASON',
        'Diga por que a plaquinha está sendo trocada — o número da máquina muda, e quem consultar '
        + 'o histórico depois precisa saber por quê.',
        400,
      );
    }

    if (antiga) {
      db.prepare(
        `UPDATE core_equipment_tags
            SET status = 'danificada', damaged_at = ?, damaged_by = ?, damaged_reason = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(agora, input.userId, motivo, agora, antiga.id);
    }

    db.prepare(
      `UPDATE core_equipment_tags
          SET status = 'associada', equipment_id = ?, associated_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.equipmentId, agora, agora, nova.id);

    /*
      A MÁQUINA ADOTA O NÚMERO E O TOKEN DA PLAQUINHA NOVA.

      As duas colunas do equipamento continuam sendo a fonte que a página
      pública, a folha e a ficha já leem. Deixá-las com o número velho faria o
      QR novo apontar para o nada e o velho continuar respondendo — as duas
      metades erradas ao mesmo tempo.
    */
    db.prepare(
      `UPDATE core_equipment SET public_id = ?, public_token = ?, updated_at = ?
        WHERE id = ?`,
    ).run(nova.public_id, nova.public_token, agora, input.equipmentId);

    db.prepare(
      `INSERT INTO core_equipment_events
         (id, equipment_id, company_id, event_type, description, user_id, created_at)
       VALUES (?, ?, ?, 'plaquinha_trocada', ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.equipmentId,
      input.companyId,
      `Plaquinha ${antiga ? formatTagId(antiga.public_id) : '(sem registro)'} substituída por `
      + `${formatTagId(nova.public_id)}: ${motivo}`,
      input.userId,
      agora,
    );

    return {
      anterior: antiga ? formatTagId(antiga.public_id) : formatTagId(equipamento.public_id),
      atual: formatTagId(nova.public_id),
    };
  });
}

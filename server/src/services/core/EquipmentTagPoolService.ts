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
 *   associada  já está numa máquina — e isso não se desfaz
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

/**
 * A REGRA DE OURO, num lugar só.
 *
 * "O sistema de etiquetas com QR e ID é somente para PJ Motors e Oficina" —
 * são as duas operações que lidam com a máquina física que fica parada no
 * pátio. Loja de roupa, de maquiagem e de variedades usa etiqueta COMERCIAL
 * (código de barras e preço), que é outro sistema, com outra tela.
 *
 * A pergunta é feita ao CADASTRO (`uses_equipment_tags`), não a uma lista de
 * slugs escrita aqui: slug se renomeia, e empresa nova nasce toda semana. O
 * padrão da coluna é zero — quem entra depois não ganha de brinde o que
 * consome número do grupo.
 */
export function empresaUsaPlaquinha(companyId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT uses_equipment_tags FROM core_companies WHERE id = ?')
    .get(companyId) as { uses_equipment_tags?: number } | undefined;
  return Number(row?.uses_equipment_tags ?? 0) === 1;
}

/** O mesmo guarda, em forma de recusa — para as rotas que escrevem. */
export function exigirEmpresaComPlaquinha(companyId: string): void {
  if (empresaUsaPlaquinha(companyId)) return;
  const nome = (
    getConnection()
      .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
      .get(companyId) as { trade_name?: string } | undefined
  )?.trade_name;
  throw new ApiError(
    'CORE_COMPANY_NO_TAGS',
    `${nome ?? 'Esta empresa'} não usa plaquinha com QR: aqui a identificação é a etiqueta de `
    + 'produto, com código de barras e preço.',
    409,
  );
}

/**
 * QUEM GERA PLAQUINHA É QUEM TEM BANCADA PARA COLÁ-LA (GAP-PRD-110).
 *
 * `uses_equipment_tags` responde "esta operação lida com máquina de plaquinha"
 * — e a PJ Motors lida: a moto dela recebe a plaquinha da Oficina pelo vínculo
 * da unidade. Mas a PJ não tem bancada, nenhum perfil dela cadastra máquina, e
 * a Oficina recusa plaquinha de outra operação (`CORE_TAG_OTHER_COMPANY`). O
 * lote gerado na PJ queimava números do GRUPO em adesivos que jamais entrariam
 * numa máquina — e o QR impresso respondia 404 para quem o escaneasse.
 *
 * O padrão seguro, escolhido aqui: gerar, imprimir e liberar exigem bancada
 * ativa na empresa. A operação sem bancada continua ADOTANDO a plaquinha da
 * Oficina (Estoque › Unidades), que é o fluxo que sempre funcionou. Se um dia a
 * PJ ganhar bancada, esta regra passa a deixá-la gerar sem mudar uma linha.
 */
export function empresaTemBancada(companyId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT 1 AS ok FROM core_workshops WHERE company_id = ? AND active = 1 LIMIT 1')
    .get(companyId) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

/** O mesmo guarda, em forma de recusa — para gerar, imprimir e liberar. */
export function exigirBancadaQueColaPlaquinha(companyId: string): void {
  if (empresaTemBancada(companyId)) return;
  const nome = (
    getConnection()
      .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
      .get(companyId) as { trade_name?: string } | undefined
  )?.trade_name;
  throw new ApiError(
    'CORE_TAGS_NEED_WORKSHOP',
    `${nome ?? 'Esta empresa'} não tem bancada: quem gera, imprime e cola a plaquinha é a oficina que monta `
    + 'a moto. Aqui a moto recebe a plaquinha da oficina em Estoque › Unidades (Vincular plaquinha) — um lote '
    + 'gerado nesta empresa queimaria números do grupo em adesivos que nunca entrariam numa máquina.',
    409,
  );
}

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
  exigirEmpresaComPlaquinha(input.companyId);
  exigirBancadaQueColaPlaquinha(input.companyId);

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
  let sql = `
    SELECT t.*,
           CASE WHEN e.id IS NULL THEN NULL
                ELSE TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')) END AS equipment_label
      FROM core_equipment_tags t
      LEFT JOIN core_equipment e ON e.id = t.equipment_id
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
      sql += " AND TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')) LIKE ?";
      params.push(`%${busca}%`);
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
  exigirEmpresaComPlaquinha(input.companyId);
  // Liberar é dizer "o adesivo existe e pode ser colado" — só onde há bancada
  // para colá-lo (GAP-PRD-110).
  exigirBancadaQueColaPlaquinha(input.companyId);

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
      `A plaquinha ${formatTagId(input.publicId)} não existe no sistema. Gere um lote e exporte a `
      + 'folha antes de usar o número.',
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
      `A plaquinha ${formatTagId(tag.public_id)} já está em outra máquina.`,
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

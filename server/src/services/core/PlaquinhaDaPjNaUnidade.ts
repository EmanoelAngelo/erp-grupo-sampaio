/**
 * A PLAQUINHA DA PJ MOTORS NA MOTO DO ESTOQUE (P0 das plaquinhas).
 *
 * ## O defeito: a plaquinha que a PJ gera nunca podia ser usada
 *
 * O dono decidiu que plaquinha com QR e número é SÓ da PJ Motors: ela gera o
 * lote, imprime a folha e libera (`EquipmentTagPoolService`). Mas o adesivo
 * liberado só virava `associada` num lugar — `createEquipment`, quando uma
 * MÁQUINA era cadastrada com ele —, e cadastrar máquina exige bancada. A PJ
 * não tem bancada, e a Oficina (que tem) não pode mais tocar no pool. Somado:
 * o adesivo impresso e colado na moto do pátio ficava `disponivel` para
 * sempre, e o QR dele respondia 404 — a página pública só conhecia o token de
 * máquina.
 *
 * ## O que este arquivo faz, sem máquina falsa e sem bancada falsa
 *
 * A moto do pátio da PJ JÁ existe no sistema: é a UNIDADE de estoque
 * (`core_product_units`). A plaquinha passa a apontar para ela
 * (`core_equipment_tags.unit_id`), e a página pública resolve o token por esse
 * vínculo (`EquipmentPublicView`). Nenhuma linha em `core_equipment` nem em
 * `core_workshops` nasce para a PJ.
 *
 * ## O ciclo de vida inteiro
 *
 *   gerar o lote → imprimir a folha → liberar   (Plaquinhas, já existia)
 *   colar/vincular na unidade                   `vincularPlaquinhaDoPool`
 *   o QR abre a moto                            `publicEquipmentByToken`
 *   reimprimir o MESMO adesivo                  `UnitTagReprint` (pela unidade)
 *   soltar (moto errada, ainda no pátio)        `desvincularPlaquinhaDoPool`
 *   trocar o adesivo estragado                  `substituirPlaquinhaDaUnidade`
 *   venda                                       nada novo: a unidade só com a
 *                                               plaquinha da PJ vende como
 *                                               qualquer unidade serializada
 *
 * ## A regra: só a PJ Motors
 *
 * Toda escrita começa por `exigirEmpresaComPlaquinha`, ANTES de qualquer
 * leitura: Preço Justo, Oficina (com bancada), Gringa e qualquer outra levam
 * 403 `CORE_COMPANY_NO_TAGS` sem descobrir se a unidade ou a plaquinha
 * existem. Quem pode, dentro da PJ, decide a rota (`inventory.units.manage`):
 * o caixa do PDV não administra plaquinha.
 *
 * ## A unicidade mora aqui
 *
 * "Uma plaquinha viva por unidade" e "plaquinha da máquina OU plaquinha da PJ,
 * nunca as duas" são conferidas dentro da transação, com a escrita guardada por
 * `WHERE status = 'disponivel' AND unit_id IS NULL` e `changes === 1`. O índice
 * único parcial sobre `unit_id` não pode ficar na DDL canônica (ver o
 * comentário da coluna em `schema.ts`) e fica para um passo numerado de
 * migração aprovado pelo dono.
 *
 * O histórico destes gestos vai para `core_audit_log` (as rotas gravam):
 * `core_equipment_events` exige uma máquina, e aqui não há máquina.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  exigirEmpresaComPlaquinha,
  formatTagId,
  type EquipmentTag,
} from './EquipmentTagPoolService.js';

export interface PlaquinhaDoPoolNaUnidade {
  tagId: string;
  publicId: number;
  publicIdLabel: string;
  associatedAt: string;
}

interface LinhaDaUnidade {
  id: string;
  status: string;
  equipment_id: string | null;
}

interface LinhaDaPlaquinha {
  id: string;
  public_id: number;
  associated_at: string | null;
  unit_id?: string;
}

function bloco(l: LinhaDaPlaquinha): PlaquinhaDoPoolNaUnidade {
  return {
    tagId: l.id,
    publicId: l.public_id,
    publicIdLabel: formatTagId(l.public_id),
    associatedAt: l.associated_at ?? '',
  };
}

/** A plaquinha da PJ colada nesta unidade, ou null. Não confere a empresa da sessão: quem chama já conferiu. */
export function plaquinhaDoPoolDaUnidade(companyId: string, unitId: string): PlaquinhaDoPoolNaUnidade | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT id, public_id, associated_at FROM core_equipment_tags
        WHERE unit_id = ? AND company_id = ? AND status = 'associada'
        LIMIT 1`,
    )
    .get(unitId, companyId) as LinhaDaPlaquinha | undefined;
  return linha ? bloco(linha) : null;
}

/**
 * As plaquinhas da PJ de várias unidades, numa consulta só — a lista de
 * unidades do produto não paga uma consulta por linha.
 */
export function plaquinhasDoPoolDasUnidades(
  companyId: string,
  unitIds: string[],
): Map<string, PlaquinhaDoPoolNaUnidade> {
  const mapa = new Map<string, PlaquinhaDoPoolNaUnidade>();
  if (unitIds.length === 0) return mapa;
  ensureCoreSchema();
  const marcas = unitIds.map(() => '?').join(', ');
  const linhas = getConnection()
    .prepare(
      `SELECT id, public_id, associated_at, unit_id FROM core_equipment_tags
        WHERE company_id = ? AND status = 'associada' AND unit_id IN (${marcas})`,
    )
    .all(companyId, ...(unitIds as never[])) as unknown as LinhaDaPlaquinha[];
  for (const l of linhas) {
    if (l.unit_id) mapa.set(l.unit_id, bloco(l));
  }
  return mapa;
}

/** O que a folha da reimpressão precisa: número, token do QR e a moto (marca e modelo do produto). */
export function plaquinhaDoPoolParaFolha(
  companyId: string,
  unitId: string,
): { tagId: string; publicId: number; publicToken: string; brand: string | null; model: string | null } | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT t.id, t.public_id, t.public_token, p.brand, p.name
         FROM core_equipment_tags t
         JOIN core_product_units u ON u.id = t.unit_id AND u.company_id = t.company_id
         JOIN core_products p ON p.id = u.product_id AND p.company_id = u.company_id
        WHERE t.unit_id = ? AND t.company_id = ? AND t.status = 'associada'
        LIMIT 1`,
    )
    .get(unitId, companyId) as
    | { id: string; public_id: number; public_token: string; brand: string | null; name: string | null }
    | undefined;
  if (!linha) return null;
  return {
    tagId: linha.id,
    publicId: linha.public_id,
    publicToken: linha.public_token,
    brand: linha.brand,
    model: linha.name,
  };
}

function lerUnidadeDaEmpresa(companyId: string, unitId: string): LinhaDaUnidade {
  const unidade = getConnection()
    .prepare('SELECT id, status, equipment_id FROM core_product_units WHERE id = ? AND company_id = ?')
    .get(unitId, companyId) as LinhaDaUnidade | undefined;
  if (!unidade) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
  return unidade;
}

/**
 * O número da plaquinha da MÁQUINA vinculada à unidade, para a mensagem.
 *
 * Sem filtro de empresa, como `lerPlaquinha` na ponte do estoque: a máquina
 * vive na Oficina. Só o rótulo sai daqui, e só para quem já provou ser dono da
 * unidade.
 */
function rotuloDaMaquina(equipmentId: string): string {
  const linha = getConnection()
    .prepare('SELECT public_id FROM core_equipment WHERE id = ?')
    .get(equipmentId) as { public_id: number } | undefined;
  return linha ? formatTagId(linha.public_id) : '(sem número)';
}

function lerPlaquinhaDaEmpresa(companyId: string, tagId: string): EquipmentTag {
  // Plaquinha de outra empresa é "não encontrada": dizer que existe seria
  // contar a quem adivinha um id que ele acertou.
  const tag = getConnection()
    .prepare('SELECT * FROM core_equipment_tags WHERE id = ? AND company_id = ?')
    .get(tagId, companyId) as EquipmentTag | undefined;
  if (!tag) throw new ApiError('CORE_TAG_NOT_FOUND', 'Plaquinha não encontrada.', 404);
  return tag;
}

/**
 * As mesmas recusas, com os mesmos códigos e a mesma voz, de
 * `reservarPlaquinhaParaEquipamento` — o balcão e a tela já tratam esses
 * códigos, e a plaquinha é a mesma coisa nos dois caminhos.
 */
function recusarSeNaoLivre(tag: EquipmentTag): void {
  const rotulo = formatTagId(tag.public_id);
  if (tag.status === 'gerada') {
    throw new ApiError(
      'CORE_TAG_NOT_RELEASED',
      `A plaquinha ${rotulo} ainda não foi liberada. Imprima a folha do lote e libere antes de colar `
      + 'o adesivo na moto.',
      409,
    );
  }
  if (tag.status === 'associada') {
    throw new ApiError('CORE_TAG_IN_USE', `A plaquinha ${rotulo} já está em outra moto.`, 409);
  }
  if (tag.status === 'danificada') {
    throw new ApiError('CORE_TAG_DAMAGED', `A plaquinha ${rotulo} está marcada como danificada.`, 409);
  }
}

/**
 * COLA a plaquinha liberada da PJ na moto do estoque.
 *
 * Cada recusa acontece antes de qualquer escrita, e a escrita é guardada: se
 * outra requisição levou a mesma plaquinha no meio do caminho, o UPDATE não
 * acha a linha `disponivel` e a resposta é 409, não uma segunda moto com o
 * mesmo adesivo.
 */
export function vincularPlaquinhaDoPool(input: {
  companyId: string;
  unitId: string;
  tagId: string;
  userId: string;
}): PlaquinhaDoPoolNaUnidade {
  ensureCoreSchema();
  // A regra da empresa ANTES de qualquer leitura: fora da PJ, 403 sem dizer
  // se a unidade ou a plaquinha existem.
  exigirEmpresaComPlaquinha(input.companyId);
  const tagId = String(input.tagId ?? '').trim();
  if (!tagId) {
    throw new ApiError('CORE_TAG_REQUIRED', 'Escolha a plaquinha liberada a colar nesta moto.', 400);
  }

  withTransaction(() => {
    const db = getConnection();
    const unidade = lerUnidadeDaEmpresa(input.companyId, input.unitId);

    if (unidade.status !== 'in_stock') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        unidade.status === 'sold'
          ? 'Esta moto já saiu vendida: a plaquinha da PJ é colada enquanto ela está no pátio.'
          : 'Esta unidade recebeu baixa e não está em estoque.',
        409,
      );
    }
    if (unidade.equipment_id) {
      throw new ApiError(
        'CORE_UNIT_ALREADY_LINKED',
        `Esta moto já usa a plaquinha da máquina (${rotuloDaMaquina(unidade.equipment_id)}). Desvincule `
        + 'antes de colar uma plaquinha da PJ.',
        409,
      );
    }
    const jaTem = plaquinhaDoPoolDaUnidade(input.companyId, unidade.id);
    if (jaTem) {
      throw new ApiError(
        'CORE_UNIT_ALREADY_TAGGED',
        `Esta moto já tem a plaquinha ${jaTem.publicIdLabel} da PJ. Para trocar o adesivo use Trocar adesivo.`,
        409,
      );
    }

    const tag = lerPlaquinhaDaEmpresa(input.companyId, tagId);
    recusarSeNaoLivre(tag);

    const agora = new Date().toISOString();
    const escrita = db
      .prepare(
        `UPDATE core_equipment_tags
            SET status = 'associada', unit_id = ?, associated_at = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND status = 'disponivel'
            AND unit_id IS NULL AND equipment_id IS NULL`,
      )
      .run(unidade.id, agora, agora, tag.id, input.companyId);
    if (Number(escrita.changes) !== 1) {
      throw new ApiError('CORE_TAG_IN_USE', `A plaquinha ${formatTagId(tag.public_id)} já está em outra moto.`, 409);
    }
  });

  return plaquinhaDoPoolDaUnidade(input.companyId, input.unitId)!;
}

/**
 * SOLTA a plaquinha da PJ da unidade — a correção da moto errada.
 *
 * É o mesmo motivo de `desvincularUnidade` na ponte da máquina: quem colou o
 * adesivo na moto do lado precisa de um caminho de volta. O adesivo físico
 * continua existindo, então a plaquinha volta a `disponivel` e pode ser colada
 * na moto certa.
 *
 * É a ÚNICA exceção ao "associada não se desfaz" do pool, e ela vale só
 * enquanto a moto está no pátio. Vendida, a plaquinha acompanha a moto (o
 * comprador tem o QR); baixada, fica no histórico da unidade. Quem "consertar"
 * isto para recusar sempre devolve o beco: adesivo na moto errada para sempre.
 */
export function desvincularPlaquinhaDoPool(input: {
  companyId: string;
  unitId: string;
  userId: string;
}): { tagId: string; publicIdLabel: string } {
  ensureCoreSchema();
  exigirEmpresaComPlaquinha(input.companyId);

  return withTransaction(() => {
    const db = getConnection();
    const unidade = lerUnidadeDaEmpresa(input.companyId, input.unitId);
    const atual = plaquinhaDoPoolDaUnidade(input.companyId, unidade.id);
    if (!atual) {
      throw new ApiError('CORE_UNIT_WITHOUT_TAG', 'Esta unidade não tem plaquinha da PJ vinculada.', 409);
    }
    if (unidade.status !== 'in_stock') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        unidade.status === 'sold'
          ? 'A plaquinha acompanha a moto vendida e não se solta aqui. Adesivo estragado? Use Trocar adesivo.'
          : 'A plaquinha fica com a unidade baixada, no histórico.',
        409,
      );
    }

    const agora = new Date().toISOString();
    db.prepare(
      `UPDATE core_equipment_tags
          SET status = 'disponivel', unit_id = NULL, associated_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'associada'`,
    ).run(agora, atual.tagId);

    return { tagId: atual.tagId, publicIdLabel: atual.publicIdLabel };
  });
}

/**
 * TROCA o adesivo estragado da moto da PJ.
 *
 * O mesmo fato de `substituirPlaquinha` na máquina: a plaquinha velha é
 * aposentada como `danificada` (guardando `unit_id`, para a auditoria saber de
 * qual moto era) e a nova passa a responder pela moto na mesma transação. O QR
 * velho deixa de abrir a página no mesmo instante.
 *
 * Vale na moto do pátio e na VENDIDA — o adesivo descasca no sol na garagem do
 * comprador também. Não vale na baixada: ela saiu sem venda e o QR dela já não
 * abre nada.
 *
 * A moto com plaquinha de MÁQUINA não passa por aqui: aquela plaquinha é da
 * Oficina (outra empresa) e trocar o número dela escreveria no cadastro de
 * outra operação. A recusa diz o caminho que existe.
 */
export function substituirPlaquinhaDaUnidade(input: {
  companyId: string;
  unitId: string;
  novaTagId: string;
  motivo?: string | null;
  userId: string;
}): { anterior: string; atual: string } {
  ensureCoreSchema();
  exigirEmpresaComPlaquinha(input.companyId);
  const motivo = String(input.motivo ?? '').trim();
  if (!motivo) {
    throw new ApiError(
      'CORE_TAG_REPLACE_REASON',
      'Diga por que a plaquinha está sendo trocada — o número da máquina muda, e quem consultar '
      + 'o histórico depois precisa saber por quê.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const unidade = lerUnidadeDaEmpresa(input.companyId, input.unitId);
    if (unidade.status === 'baixada') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        'Esta unidade recebeu baixa: o adesivo dela não é mais trocado.',
        409,
      );
    }
    if (unidade.equipment_id) {
      throw new ApiError(
        'CORE_UNIT_MACHINE_TAG',
        `A ${rotuloDaMaquina(unidade.equipment_id)} é a plaquinha da máquina, cadastrada pela Oficina. `
        + 'Para trocar o adesivo desta moto, desvincule a plaquinha da máquina e cole uma plaquinha livre da PJ.',
        409,
      );
    }
    const antiga = plaquinhaDoPoolDaUnidade(input.companyId, unidade.id);
    if (!antiga) {
      throw new ApiError('CORE_UNIT_WITHOUT_TAG', 'Esta unidade não tem plaquinha da PJ vinculada.', 409);
    }

    const nova = lerPlaquinhaDaEmpresa(input.companyId, String(input.novaTagId ?? '').trim());
    if (nova.status !== 'disponivel') {
      throw new ApiError(
        'CORE_TAG_NOT_AVAILABLE',
        `A ${formatTagId(nova.public_id)} não está disponível: só plaquinha liberada e sem dono `
        + 'entra numa máquina.',
        409,
      );
    }

    const agora = new Date().toISOString();
    // A velha morre com o `unit_id` guardado: a auditoria sabe de qual moto era.
    db.prepare(
      `UPDATE core_equipment_tags
          SET status = 'danificada', damaged_at = ?, damaged_by = ?, damaged_reason = ?, updated_at = ?
        WHERE id = ?`,
    ).run(agora, input.userId, motivo, agora, antiga.tagId);

    const entra = db
      .prepare(
        `UPDATE core_equipment_tags
            SET status = 'associada', unit_id = ?, associated_at = ?, updated_at = ?
          WHERE id = ? AND status = 'disponivel'`,
      )
      .run(unidade.id, agora, agora, nova.id);
    if (Number(entra.changes) !== 1) {
      throw new ApiError(
        'CORE_TAG_NOT_AVAILABLE',
        `A ${formatTagId(nova.public_id)} não está disponível: só plaquinha liberada e sem dono `
        + 'entra numa máquina.',
        409,
      );
    }

    return { anterior: antiga.publicIdLabel, atual: formatTagId(nova.public_id) };
  });
}

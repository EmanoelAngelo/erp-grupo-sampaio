/**
 * CORRIGIR A IDENTIDADE DA MÁQUINA — com motivo, antes e depois (GAP-PRD-106).
 *
 * ## O defeito
 *
 * Marca, modelo, chassi, série, motor e categoria não tinham porta de edição:
 * `PATCH /equipment/:id` era estreito de propósito (garantia e montagem). O
 * chassi digitado errado na bancada virava plaquinha errada para sempre — o
 * único conserto era a unidade da loja (só para a moto da PJ) ou SQL.
 *
 * ## A correção é um fato, e o fato fica
 *
 * Toda mudança de identidade exige MOTIVO e grava o evento
 * `identidade_corrigida` com cada campo "antes → depois": sem os dois valores
 * ninguém reconstitui o que foi sobrescrito. Quilometragem e observações não
 * são identidade — mudam a cada visita — e entram sem motivo, com o evento
 * `km_registrado` quando o km muda. Km que VOLTA exige motivo: é correção de
 * leitura, não leitura nova.
 *
 * ## O que a ficha não corrige
 *
 * Chassi, motor e série de máquina VINCULADA a uma unidade de estoque são da
 * unidade (é o número do documento fiscal da venda): a recusa diz de qual loja,
 * e o caminho é a tela de Unidades de lá (`identifyUnit` propaga para cá).
 *
 * ## Unicidade
 *
 * Chassi e placa são únicos por empresa, conferidos AQUI (os testes rodam contra
 * a DDL canônica, e `ux_equipment_chassis` nasce na migração); o `catch` de
 * UNIQUE é a rede do banco real.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import {
  formatPublicId,
  getEquipment,
  recordEquipmentEvent,
  type Equipment,
} from './EquipmentService.js';
import {
  EQUIPMENT_CATEGORY_LABEL,
  conferirIdentidadePorTipo,
  exigirAno,
  exigirCategoria,
  exigirKm,
  normalizarPlaca,
  textoOuNulo,
  type EquipmentCategory,
} from './EquipmentIdentityRules.js';

/** Campo da API → coluna, e o nome que a pessoa lê no histórico. */
const CAMPOS = {
  category: { coluna: 'category', rotulo: 'tipo', identidade: true },
  brand: { coluna: 'brand', rotulo: 'marca', identidade: true },
  model: { coluna: 'model', rotulo: 'modelo', identidade: true },
  version: { coluna: 'version', rotulo: 'versão', identidade: true },
  color: { coluna: 'color', rotulo: 'cor', identidade: true },
  year: { coluna: 'year', rotulo: 'ano', identidade: true },
  serialNumber: { coluna: 'serial_number', rotulo: 'número de série', identidade: true },
  motorNumber: { coluna: 'motor_number', rotulo: 'número do motor', identidade: true },
  chassis: { coluna: 'chassis', rotulo: 'chassi', identidade: true },
  battery: { coluna: 'battery', rotulo: 'bateria', identidade: true },
  batterySerial: { coluna: 'battery_serial', rotulo: 'série da bateria', identidade: true },
  plate: { coluna: 'plate', rotulo: 'placa', identidade: true },
  odometerKm: { coluna: 'odometer_km', rotulo: 'quilometragem', identidade: false },
  notes: { coluna: 'notes', rotulo: 'observações', identidade: false },
} as const;
type CampoDaApi = keyof typeof CAMPOS;

/** As colunas que são identidade (exigem motivo); km e observações não são. */
const COLUNAS_DE_IDENTIDADE = new Set<string>(
  Object.values(CAMPOS)
    .filter((c) => c.identidade)
    .map((c) => c.coluna),
);

/** Os três números que a unidade de estoque manda quando há vínculo. */
const TRAVADOS_PELA_UNIDADE = new Set<string>(['chassis', 'motor_number', 'serial_number']);

export interface VinculoDeEstoque {
  unitId: string;
  companyName: string;
}

/** A unidade da loja que manda na identidade desta máquina, se houver. */
export function vinculoDeEstoque(equipmentId: string): VinculoDeEstoque | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT u.id AS unit_id, c.trade_name AS company_name
         FROM core_product_units u
         JOIN core_companies c ON c.id = u.company_id
        WHERE u.equipment_id = ?
        LIMIT 1`,
    )
    .get(equipmentId) as { unit_id: string; company_name: string } | undefined;
  return linha ? { unitId: linha.unit_id, companyName: linha.company_name } : null;
}

export interface Mudanca {
  campo: string;
  rotulo: string;
  antes: string | number | null;
  depois: string | number | null;
}

export interface IdentidadeCorrigida {
  equipment: Equipment;
  mudancas: Mudanca[];
  /** `identidade_corrigida`, `km_registrado`, ou nulo quando nada mudou. */
  evento: string | null;
}

function paraTexto(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(vazio)';
  return String(v);
}

function rotuloDoValor(campo: string, v: unknown): string {
  if (campo === 'category' && typeof v === 'string' && v in EQUIPMENT_CATEGORY_LABEL) {
    return EQUIPMENT_CATEGORY_LABEL[v as EquipmentCategory];
  }
  if (campo === 'odometer_km' && v !== null && v !== undefined) {
    return `${Number(v).toLocaleString('pt-BR')} km`;
  }
  return paraTexto(v);
}

/** Lê do corpo o valor novo de cada campo PRESENTE, já validado e normalizado. */
function valorNovo(campo: CampoDaApi, bruto: unknown): string | number | null {
  switch (campo) {
    case 'category':
      return exigirCategoria(bruto);
    case 'plate':
      return normalizarPlaca(bruto);
    case 'odometerKm':
      return exigirKm(bruto);
    case 'year':
      return exigirAno(bruto);
    default:
      return textoOuNulo(bruto);
  }
}

export function corrigirIdentidade(input: {
  companyId: string;
  equipmentId: string;
  userId: string;
  campos: Record<string, unknown>;
  motivo?: unknown;
}): IdentidadeCorrigida {
  ensureCoreSchema();
  const presentes = (Object.keys(CAMPOS) as CampoDaApi[]).filter(
    (c) => input.campos[c] !== undefined,
  );
  if (presentes.length === 0) {
    throw new ApiError('CORE_EQUIPMENT_PATCH_EMPTY', 'Informe o que corrigir.', 400);
  }
  // Valida TUDO antes de abrir a transação: um campo ruim recusa o pedido
  // inteiro, e nada fica pela metade.
  const novos = new Map<CampoDaApi, string | number | null>();
  for (const c of presentes) novos.set(c, valorNovo(c, input.campos[c]));
  const motivo = String(input.motivo ?? '').trim();

  return withTransaction(() => {
    const db = getConnection();
    const antes = getEquipment(input.companyId, input.equipmentId) as
      | (Equipment & Record<string, unknown>)
      | null;
    if (!antes) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
    }

    const mudancas: Mudanca[] = [];
    for (const c of presentes) {
      const { coluna, rotulo } = CAMPOS[c];
      const velho = (antes[coluna] ?? null) as string | number | null;
      const novo = novos.get(c) ?? null;
      if (String(velho ?? '') === String(novo ?? '')) continue;
      mudancas.push({ campo: coluna, rotulo, antes: velho, depois: novo });
    }
    if (mudancas.length === 0) {
      return { equipment: antes, mudancas, evento: null };
    }

    const deIdentidade = mudancas.filter((m) => COLUNAS_DE_IDENTIDADE.has(m.campo));
    const kmMudou = mudancas.find((m) => m.campo === 'odometer_km');
    const kmVoltou =
      kmMudou && kmMudou.antes !== null && kmMudou.depois !== null
      && Number(kmMudou.depois) < Number(kmMudou.antes);
    if ((deIdentidade.length > 0 || kmVoltou) && !motivo) {
      throw new ApiError(
        'CORE_REASON_REQUIRED',
        kmVoltou
          ? 'A quilometragem está voltando: diga o motivo da correção de leitura.'
          : 'Corrigir a identidade da máquina exige o motivo — é o que o histórico mostra depois.',
        400,
      );
    }

    const travados = mudancas.filter((m) => TRAVADOS_PELA_UNIDADE.has(m.campo));
    if (travados.length > 0) {
      const vinculo = vinculoDeEstoque(input.equipmentId);
      if (vinculo) {
        throw new ApiError(
          'CORE_EQUIPMENT_IDENTITY_BY_UNIT',
          `${travados.map((m) => m.rotulo).join(', ')} desta máquina vêm da unidade de estoque da `
            + `${vinculo.companyName}: é o número do documento fiscal da venda. Corrija pela tela de `
            + 'Unidades de estoque de lá, e a plaquinha acompanha.',
          409,
          { campos: travados.map((m) => m.campo), empresa: vinculo.companyName },
        );
      }
    }

    // O estado FINAL, para as regras que dependem do tipo.
    const depois = { ...antes } as Record<string, unknown>;
    for (const m of mudancas) depois[m.campo] = m.depois;
    conferirIdentidadePorTipo({
      category: (depois.category as string | null) ?? null,
      brand: (depois.brand as string | null) ?? null,
      model: (depois.model as string | null) ?? null,
      plate: (depois.plate as string | null) ?? null,
      odometer_km: (depois.odometer_km as number | null) ?? null,
    });

    for (const m of mudancas) {
      if (m.campo !== 'chassis' && m.campo !== 'plate') continue;
      if (m.depois === null) continue;
      const outra = db
        .prepare(`SELECT public_id FROM core_equipment WHERE company_id = ? AND ${m.campo} = ? AND id <> ? LIMIT 1`)
        .get(input.companyId, m.depois, input.equipmentId) as { public_id: number } | undefined;
      if (outra) {
        throw new ApiError(
          'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
          `A plaquinha ${formatPublicId(outra.public_id)} já usa ${m.campo === 'chassis' ? 'o chassi' : 'a placa'} `
            + `${m.depois}. Confira o número ou abra a plaquinha existente.`,
          409,
        );
      }
    }

    const agora = new Date().toISOString();
    const sets = mudancas.map((m) => `${m.campo} = ?`);
    const valores: unknown[] = mudancas.map((m) => m.depois);
    if (kmMudou) {
      sets.push('odometer_at = ?');
      valores.push(kmMudou.depois === null ? null : agora);
    }
    sets.push('updated_at = ?');
    valores.push(agora);
    try {
      db.prepare(`UPDATE core_equipment SET ${sets.join(', ')} WHERE id = ?`).run(
        ...(valores as never[]),
        input.equipmentId,
      );
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        throw new ApiError(
          'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
          'Já existe outra plaquinha desta oficina com esse chassi. Confira o número digitado.',
          409,
        );
      }
      throw err;
    }

    const evento = deIdentidade.length > 0 ? 'identidade_corrigida' : kmMudou ? 'km_registrado' : 'ficha_atualizada';
    const linhas = mudancas.map(
      (m) => `${m.rotulo}: ${rotuloDoValor(m.campo, m.antes)} → ${rotuloDoValor(m.campo, m.depois)}`,
    );
    recordEquipmentEvent({
      equipmentId: input.equipmentId,
      companyId: input.companyId,
      eventType: evento,
      description:
        (evento === 'identidade_corrigida' ? 'Identidade corrigida — ' : '')
        + linhas.join('; ')
        + (motivo ? `. Motivo: ${motivo}` : ''),
      userId: input.userId,
    });

    const equipamento = getEquipment(input.companyId, input.equipmentId)!;
    // A central recebe o retrato novo, sem a credencial da plaquinha.
    const { public_token: _token, ...semCredencial } = equipamento;
    void _token;
    recordDomainEvent({
      eventType: 'equipment.upserted',
      aggregateType: 'equipment',
      aggregateId: input.equipmentId,
      companyId: input.companyId,
      operationalUnitId: equipamento.workshop_id ?? null,
      operation: 'update',
      payload: semCredencial as unknown as Record<string, unknown>,
    });

    return { equipment: equipamento, mudancas, evento };
  });
}

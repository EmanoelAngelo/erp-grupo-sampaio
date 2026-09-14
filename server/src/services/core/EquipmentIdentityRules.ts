/**
 * AS REGRAS DA IDENTIDADE DA MÁQUINA — tipo, placa e quilometragem
 * (GAP-PRD-106).
 *
 * ## O que faltava
 *
 * A categoria era texto livre ("Moto, bicicleta elétrica…" no placeholder) e
 * cada atendente escrevia de um jeito; a placa morava só na OS (digitada de
 * novo a cada visita), a quilometragem não existia, e marca, modelo, chassi e
 * série não tinham porta de correção — o erro de digitação virava plaquinha
 * errada para sempre.
 *
 * ## O tipo decide o que se pergunta
 *
 *   moto, scooter       placa e quilometragem fazem sentido
 *   bicicleta, patinete quilometragem (o painel mostra), placa não se usa
 *   celular             nem placa nem quilometragem: a identidade é a série
 *   outro               sem tipo que descreva, marca ou modelo é obrigatório —
 *                       "Outro" sozinho não identifica máquina nenhuma
 *
 * A placa não é recusada na bicicleta (há ciclomotor emplacado, e a lei muda);
 * é recusada no celular, onde não existe. A quilometragem só é recusada no
 * celular pelo mesmo motivo.
 *
 * ## Dado antigo
 *
 * A coluna `category` continua TEXT: as linhas de antes guardam o texto livre,
 * e a ficha o mostra como veio. A regra vale para o que entra daqui em diante,
 * e a correção de identidade é o caminho para trazer a linha antiga ao
 * vocabulário.
 *
 * Este módulo é folha: não importa serviço nenhum, para que o cadastro
 * (`EquipmentService`) e a correção (`EquipmentIdentityService`) usem a MESMA
 * régua sem ciclo.
 */
import { ApiError } from '../../utils/errors.js';

export const EQUIPMENT_CATEGORIES = [
  'moto',
  'scooter',
  'bicicleta_eletrica',
  'patinete',
  'celular',
  'outro',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_CATEGORY_LABEL: Record<EquipmentCategory, string> = {
  moto: 'Moto',
  scooter: 'Scooter',
  bicicleta_eletrica: 'Bicicleta elétrica',
  patinete: 'Patinete',
  celular: 'Celular',
  outro: 'Outro',
};

const CATEGORIA_SET = new Set<string>(EQUIPMENT_CATEGORIES);

/** Onde a placa e a quilometragem NÃO existem. */
const SEM_PLACA = new Set<string>(['celular']);
const SEM_KM = new Set<string>(['celular']);

/** Texto aparado; vazio vira nulo (vazio não é identidade). */
export function textoOuNulo(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s ? s : null;
}

/** A categoria do vocabulário, ou nula. Fora dele é 400 com a lista. */
export function exigirCategoria(valor: unknown): EquipmentCategory | null {
  const s = textoOuNulo(valor);
  if (s === null) return null;
  if (!CATEGORIA_SET.has(s)) {
    throw new ApiError(
      'CORE_EQUIPMENT_CATEGORY_INVALID',
      `Tipo de equipamento inválido: use ${EQUIPMENT_CATEGORIES.map((c) => EQUIPMENT_CATEGORY_LABEL[c]).join(', ')}.`,
      400,
      { categorias: EQUIPMENT_CATEGORIES },
    );
  }
  return s as EquipmentCategory;
}

/**
 * Placa brasileira, normalizada: maiúscula, sem espaço nem hífen. Aceita o
 * formato antigo (ABC1234) e o Mercosul (ABC1D23). Qualquer outra coisa é 400:
 * placa errada no cadastro é a moto que ninguém acha pela placa depois.
 */
export function normalizarPlaca(valor: unknown): string | null {
  const s = textoOuNulo(valor);
  if (s === null) return null;
  const limpa = s.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(limpa)) {
    throw new ApiError(
      'CORE_EQUIPMENT_PLATE_INVALID',
      `Placa inválida: "${s}". Use o formato ABC1234 ou o Mercosul ABC1D23.`,
      400,
    );
  }
  return limpa;
}

/** Quilometragem inteira, de 0 a 9.999.999, ou nula. */
export function exigirKm(valor: unknown): number | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const km = Number(valor);
  if (!Number.isInteger(km) || km < 0 || km > 9_999_999) {
    throw new ApiError(
      'CORE_EQUIPMENT_ODOMETER_INVALID',
      'Quilometragem inválida: informe um número inteiro de 0 a 9.999.999.',
      400,
    );
  }
  return km;
}

/** Ano de fabricação plausível (1950 até o modelo do ano que vem), ou nulo. */
export function exigirAno(valor: unknown): number | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const ano = Math.trunc(Number(valor));
  if (!Number.isFinite(ano) || ano < 1950 || ano > new Date().getFullYear() + 1) {
    throw new ApiError('CORE_INVALID_YEAR', 'Ano de fabricação inválido.', 400);
  }
  return ano;
}

/**
 * As regras que dependem do TIPO, conferidas sobre o estado FINAL da máquina
 * (o cadastro inteiro, ou a linha depois da correção).
 */
export function conferirIdentidadePorTipo(estado: {
  category: string | null;
  brand: string | null;
  model: string | null;
  plate: string | null;
  odometer_km: number | null;
}): void {
  const tipo = estado.category ?? '';
  if (SEM_PLACA.has(tipo) && estado.plate) {
    throw new ApiError(
      'CORE_EQUIPMENT_FIELD_NOT_APPLICABLE',
      'Celular não tem placa. Tire a placa ou corrija o tipo do equipamento.',
      400,
    );
  }
  if (SEM_KM.has(tipo) && estado.odometer_km !== null && estado.odometer_km !== undefined) {
    throw new ApiError(
      'CORE_EQUIPMENT_FIELD_NOT_APPLICABLE',
      'Celular não tem quilometragem. Tire a quilometragem ou corrija o tipo do equipamento.',
      400,
    );
  }
  if (tipo === 'outro' && !estado.brand && !estado.model) {
    throw new ApiError(
      'CORE_EQUIPMENT_DESCRIPTION_REQUIRED',
      'Para o tipo "Outro", informe ao menos a marca ou o modelo: é o que identifica a máquina.',
      400,
    );
  }
}

/**
 * Equipamentos acompanhados pelas oficinas.
 *
 * Dois tipos, explícitos no domínio:
 *
 *   INTERNAL_PJ_MOTORS — veículo da PJ Motors montado pela Oficina. Enquanto
 *                        não é vendido não tem proprietário. Depois da venda
 *                        o registro CONTINUA o mesmo, ganha proprietário e
 *                        preserva todo o histórico de montagem.
 *
 *   EXTERNAL_CUSTOMER  — equipamento trazido por um cliente. Tem dono desde o
 *                        início e NUNCA entra no estoque comercial.
 *
 * Identificação: cada equipamento recebe um número humano sequencial (#0001)
 * e um token opaco. O QR da plaquinha aponta para o token, nunca para o
 * número nem para dados pessoais — o número serve para leitura humana, não
 * como autorização.
 *
 * ## Quem escreve na plaquinha depois do cadastro
 *
 * Dois caminhos (GAP-PRD-106):
 *
 *   - a máquina SEM unidade de estoque é corrigida pela ficha:
 *     `EquipmentIdentityService.corrigirIdentidade`, com motivo e o evento
 *     `identidade_corrigida` guardando o antes e o depois de cada campo;
 *   - a máquina VINCULADA a uma unidade da loja
 *     (`core_product_units.equipment_id`) tem chassi, motor e série mandados
 *     pela unidade: `ProductUnitService.identifyUnit` propaga os três para cá
 *     na mesma transação, e a correção pela ficha recusa esses três campos
 *     (`CORE_EQUIPMENT_IDENTITY_BY_UNIT`). A razão de a unidade mandar: é o
 *     número que sai no documento fiscal da venda.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';
import {
  associarPlaquinha,
  exigirEmpresaComPlaquinha,
  formatTagId as formatPublicId,
  registrarPlaquinhaDoCadastro,
  reservarPlaquinhaParaEquipamento,
} from './EquipmentTagPoolService.js';
import { diaDaLoja } from './CalendarioOperacional.js';
import {
  conferirIdentidadePorTipo,
  exigirCategoria,
  exigirKm,
  normalizarPlaca,
} from './EquipmentIdentityRules.js';

export type EquipmentOrigin = 'INTERNAL_PJ_MOTORS' | 'EXTERNAL_CUSTOMER';

export interface Equipment {
  id: string;
  company_id: string;
  workshop_id: string;
  public_id: number;
  public_token: string;
  origin: string;
  origin_company_id: string | null;
  linked_product_id: string | null;
  category: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  serial_number: string | null;
  motor_number: string | null;
  chassis: string | null;
  battery: string | null;
  battery_serial: string | null;
  owner_customer_id: string | null;
  sale_status: string;
  /** Quando foi vendida ao dono — a base da garantia quando existe. */
  sold_at: string | null;
  status: string;
  notes: string | null;
  /** Meses de garantia combinados (rodada 52). Nulo = sem garantia. */
  warranty_months: number | null;
  /** Quem montou a máquina, e quando (rodada 52). */
  assembly_mechanic_id: string | null;
  assembled_at: string | null;
  /** Quando a máquina entrou — base da garantia quando não houve venda. */
  entered_at: string | null;
  /** Placa do veículo (GAP-PRD-106), normalizada: ABC1234 ou ABC1D23. */
  plate?: string | null;
  /** Última quilometragem conhecida, e quando foi lida (GAP-PRD-106). */
  odometer_km?: number | null;
  odometer_at?: string | null;
  created_at: string;
}

/**
 * `#0001` — formato humano da plaquinha.
 *
 * A conta mora no POOL, que e quem dona o numero: a plaquinha existe antes
 * da maquina (rodada 53). Esta cópia — e as duas que viviam em
 * `EquipmentPublicView` e no `PrintRenderer` — diziam a mesma coisa em tres
 * lugares, e tres cópias do mesmo formato divergem no dia em que alguem
 * decidir que o numero tem cinco digitos.
 */
export { formatPublicId };

// ------------------------------------------------------ garantia (rodada 52)

/**
 * A GARANTIA É DERIVADA, SEMPRE — nunca um estado gravado.
 *
 * O sistema anterior guardava um campo `warrantyStatus` escrito à mão no
 * cadastro e jamais recalculado: a venda não o atualizava, o tempo não o
 * movia, e a moto seguia "em garantia" na tela anos depois de vencer. Os
 * filtros e os números do painel liam essa mentira congelada.
 *
 * Aqui o banco guarda só o COMBINADO — quantos meses — e a data-base. O
 * estado é calculado toda vez que alguém pergunta, e por isso nunca envelhece
 * sozinho.
 *
 * ## A data-base é a VENDA quando ela existe
 *
 * Para o cliente, a garantia começa no dia em que ele levou a máquina — e é
 * `sold_at`. Sem venda (a moto ainda no pátio, ou a máquina do cliente que
 * veio de fora), a base é `entered_at`: é a data em que ela entrou na casa.
 */
export type WarrantyStatus = 'sem_garantia' | 'vigente' | 'vence_em_breve' | 'vencida';

export interface WarrantyView {
  months: number | null;
  /** De quando conta: 'venda' | 'entrada' | null (sem garantia). */
  baseKind: 'venda' | 'entrada' | null;
  baseDate: string | null;
  expiresAt: string | null;
  status: WarrantyStatus;
  /** Dias que faltam (negativo = venceu há tantos dias). */
  daysLeft: number | null;
}

/** Dentro de quantos dias do fim a garantia acende o aviso. */
const WARRANTY_WARNING_DAYS = 30;

/**
 * Quem pode constar como quem MONTOU a máquina.
 *
 * Não é a equipe da oficina inteira: caixa e atendente trabalham na oficina e
 * não montam nada. O gerente entra porque, na oficina do grupo, ele também põe
 * a mão na bancada.
 */
const PERFIS_QUE_MONTAM = new Set(['mecanico', 'gerente_oficina']);

/**
 * O montador é gente DESTA empresa, e é gente que monta.
 *
 * As duas perguntas ficam juntas de propósito: elas nasceram só no PATCH da
 * ficha, e o POST do cadastro — que recebe o MESMO campo — não fazia nenhuma
 * das duas. A chave estrangeira é global (`REFERENCES core_users(id)`) e não
 * conhece empresa, então o id de um funcionário da loja passava direto e a
 * ficha depois exibia o nome dele como quem montou a moto da oficina.
 */
function exigirMontador(userId: string, companyId: string): void {
  const membro = getConnection()
    .prepare('SELECT profile_code FROM core_user_companies WHERE user_id = ? AND company_id = ?')
    .get(userId, companyId) as { profile_code?: string } | undefined;
  if (!membro) {
    throw new ApiError(
      'CORE_MECHANIC_NOT_IN_COMPANY',
      'Este usuário não trabalha nesta empresa.',
      400,
    );
  }
  if (!PERFIS_QUE_MONTAM.has(String(membro.profile_code))) {
    throw new ApiError(
      'CORE_NOT_A_MECHANIC',
      'Só mecânico ou gerente de oficina entra como quem montou a máquina.',
      400,
    );
  }
}

/**
 * O dono é cliente DESTA empresa.
 *
 * `assignOwner` já perguntava isso na venda; o cadastro não perguntava nada, e
 * a chave estrangeira do dono também é global. Antes da rodada 52 o estrago
 * era invisível — a lista não juntava o cliente. A ficha junta.
 */
function exigirClienteDaEmpresa(customerId: string, companyId: string): void {
  const cliente = getConnection()
    .prepare('SELECT id FROM core_customers WHERE id = ? AND company_id = ?')
    .get(customerId, companyId) as { id?: string } | undefined;
  if (!cliente) {
    throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta empresa.', 404);
  }
}

export function warrantyOf(
  equip: {
    warranty_months?: number | null;
    sold_at?: string | null;
    entered_at?: string | null;
  },
  agora: Date = new Date(),
): WarrantyView {
  const meses = Number(equip.warranty_months ?? 0);
  const semGarantia: WarrantyView = {
    months: equip.warranty_months ?? null,
    baseKind: null,
    baseDate: null,
    expiresAt: null,
    status: 'sem_garantia',
    daysLeft: null,
  };
  if (!Number.isFinite(meses) || meses <= 0) return semGarantia;

  const baseKind = equip.sold_at ? 'venda' : equip.entered_at ? 'entrada' : null;
  const baseDate = equip.sold_at ?? equip.entered_at ?? null;
  if (!baseDate) return semGarantia;

  /*
    A base é o DIA DA LOJA em que a venda (ou a entrada) aconteceu.

    `sold_at` é instante. Lido cru, a venda das 21h30 de 31 de janeiro tem base
    em 1º de fevereiro, e a garantia de doze meses vence um dia depois do
    combinado — na ficha que o cliente leva para casa. Meio-dia de propósito:
    a conta de meses abaixo é toda em UTC, e o meio-dia não escorrega.
  */
  const diaBase = diaDaLoja(baseDate);
  const base = new Date(`${diaBase}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return semGarantia;

  /*
    Meses de calendário, não "30 dias vezes N" — e a conta inteira em UTC.

    Doze meses a partir de 31 de janeiro vencem em 31 de janeiro, não em 26.
    `setUTCMonth` rola o excedente (31 de janeiro + 1 mês = 3 de março), então
    o dia volta para o último do mês de destino quando ele não existe: uma
    garantia de 1 mês vendida em 31 de janeiro vence em 28 de fevereiro.

    UTC dos dois lados de propósito: a data vem como `AAAA-MM-DD` (meia-noite
    UTC) e, lida com métodos LOCAIS no Brasil, o dia 31 já é o dia 30 — a
    conta erraria por um dia em todo fuso negativo.
  */
  const fim = new Date(base.getTime());
  const diaOriginal = fim.getUTCDate();
  fim.setUTCMonth(fim.getUTCMonth() + meses);
  if (fim.getUTCDate() !== diaOriginal) fim.setUTCDate(0);

  const diasRestantes = Math.ceil((fim.getTime() - agora.getTime()) / 86_400_000);
  const status: WarrantyStatus =
    diasRestantes < 0
      ? 'vencida'
      : diasRestantes <= WARRANTY_WARNING_DAYS
        ? 'vence_em_breve'
        : 'vigente';

  /*
    O que sai daqui é DIA DE CALENDÁRIO, não instante.

    Garantia vence num dia — "vence em 12 de fevereiro" —, e um ISO completo
    (`2027-02-12T00:00:00.000Z`) convida quem imprime a convertê-lo para o fuso
    de quem lê: no Brasil, meia-noite UTC é o dia anterior às 21h, e a ficha
    passa a anunciar o vencimento um dia antes. A data-base sai pelo mesmo
    corte — a venda grava data E hora, e o que a ficha mostra é o dia.
  */
  return {
    months: meses,
    baseKind,
    baseDate: diaBase,
    expiresAt: fim.toISOString().slice(0, 10),
    status,
    daysLeft: diasRestantes,
  };
}

/** Meses de garantia aceitos: nada, ou de 1 a 120 (dez anos). */
function exigirMesesDeGarantia(valor: unknown): number | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const meses = Math.trunc(Number(valor));
  if (!Number.isFinite(meses) || meses < 0 || meses > 120) {
    throw new ApiError(
      'CORE_INVALID_WARRANTY',
      'Garantia inválida: informe de 0 a 120 meses.',
      400,
    );
  }
  return meses === 0 ? null : meses;
}

/** Data ISO de calendário (AAAA-MM-DD), ou nada. A mesma régua do prazo da OS. */
function exigirDataDeCalendario(valor: unknown, campo: string): string | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const bruto = String(valor).trim();
  const formato = /^\d{4}-\d{2}-\d{2}$/.exec(bruto);
  const data = formato ? new Date(`${bruto}T00:00:00Z`) : null;
  if (!data || Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== bruto) {
    throw new ApiError('CORE_INVALID_DATE', `${campo}: use uma data no formato AAAA-MM-DD.`, 400);
  }
  return bruto;
}

/**
 * Sequência global: dois equipamentos nunca compartilham `#ID`, mesmo em
 * oficinas diferentes, e o número não é reaproveitado após exclusão.
 */
function nextPublicId(): number {
  return nextSequenceValue('__grupo__', 'equipment_public_id');
}

export function createEquipment(input: {
  companyId: string;
  workshopId: string;
  userId: string;
  origin: EquipmentOrigin;
  originCompanyId?: string | null;
  ownerCustomerId?: string | null;
  category?: string;
  brand?: string;
  model?: string;
  year?: number;
  version?: string;
  color?: string;
  serialNumber?: string;
  motorNumber?: string;
  chassis?: string;
  battery?: string;
  batterySerial?: string;
  notes?: string;
  /** Meses de garantia combinados (rodada 52). Ausente = sem garantia. */
  warrantyMonths?: unknown;
  /** Quando a máquina entrou (aquisição/recebimento). Ausente = hoje. */
  enteredAt?: unknown;
  /** Quem montou, e quando — só faz sentido no equipamento da casa. */
  assemblyMechanicId?: string | null;
  assembledAt?: unknown;
  /**
   * O número da plaquinha JÁ COLADA na máquina (rodada 53).
   *
   * Ausente = a máquina chegou sem adesivo, e o número é sorteado como
   * sempre foi.
   */
  tagPublicId?: unknown;
  /** Placa e quilometragem na entrada (GAP-PRD-106). */
  plate?: unknown;
  odometerKm?: unknown;
}): Equipment {
  ensureCoreSchema();
  /*
    O TIPO, A PLACA E O KM (GAP-PRD-106): a categoria sai do vocabulário (era
    texto livre, cada atendente escrevia de um jeito), a placa é normalizada e
    conferida, e o que depende do tipo — celular sem placa, "Outro" com marca
    ou modelo — é conferido sobre o cadastro inteiro.
  */
  const categoria = exigirCategoria(input.category);
  const placa = normalizarPlaca(input.plate);
  const km = exigirKm(input.odometerKm);
  conferirIdentidadePorTipo({
    category: categoria,
    brand: String(input.brand ?? '').trim() || null,
    model: String(input.model ?? '').trim() || null,
    plate: placa,
    odometer_km: km,
  });
  const warrantyMonths = exigirMesesDeGarantia(input.warrantyMonths);
  const enteredAt = exigirDataDeCalendario(input.enteredAt, 'Data de entrada');
  const assembledAt = exigirDataDeCalendario(input.assembledAt, 'Data de montagem');
  const temPlaquinhaEscolhida =
    input.tagPublicId !== undefined && input.tagPublicId !== null && input.tagPublicId !== '';
  /*
    ESCOLHER A PLAQUINHA DO POOL É GESTÃO DE PLAQUINHA (P0 das plaquinhas).

    O cadastro da máquina aceitava o número de um adesivo do pool em qualquer
    empresa com bancada, e a Oficina associava por aqui as plaquinhas que ela
    mesma gerava. Plaquinha agora é só da PJ Motors: fora dela, o cadastro
    segue o caminho de sempre — o número do equipamento é sorteado da
    sequência do grupo —, e pedir um adesivo do pool é recusado com a regra
    escrita, em vez de devolver "a plaquinha é de outra operação".
  */
  if (temPlaquinhaEscolhida) exigirEmpresaComPlaquinha(input.companyId);

  // Equipamento externo é do cliente: precisa de dono desde o início.
  if (input.origin === 'EXTERNAL_CUSTOMER' && !input.ownerCustomerId) {
    throw new ApiError(
      'CORE_OWNER_REQUIRED',
      'Equipamento externo exige um proprietário.',
      400,
    );
  }
  // Ano de fabricação plausível ou nada: 1950 cobre qualquer clássico que
  // apareça na bancada, e +1 cobre o modelo do ano seguinte já à venda.
  if (input.year !== undefined && input.year !== null) {
    const ano = Math.trunc(Number(input.year));
    if (!Number.isFinite(ano) || ano < 1950 || ano > new Date().getFullYear() + 1) {
      throw new ApiError('CORE_INVALID_YEAR', 'Ano de fabricação inválido.', 400);
    }
  }
  // Equipamento interno ainda não vendido não tem dono — e não deve fingir ter.
  if (input.origin === 'INTERNAL_PJ_MOTORS' && input.ownerCustomerId) {
    throw new ApiError(
      'CORE_OWNER_NOT_ALLOWED',
      'Equipamento interno só ganha proprietário quando for vendido.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const workshop = db
      .prepare('SELECT id, company_id FROM core_workshops WHERE id = ? AND company_id = ?')
      .get(input.workshopId, input.companyId) as { id: string } | undefined;
    if (!workshop) {
      throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Oficina não encontrada nesta empresa.', 404);
    }

    /*
      CHASSI REPETIDO NA MESMA EMPRESA É RECUSA, E A RECUSA DIZ QUAL PLAQUINHA.

      O chassi é o que prova que a unidade da loja e a plaquinha da oficina são a
      MESMA moto — é sobre ele que o vínculo casa. Duas plaquinhas com o mesmo
      número tornariam esse casamento ambíguo justamente no ponto em que ele
      precisa ser exato.

      A regra mora AQUI, no código, e não pendurada só no índice: os testes rodam
      contra a DDL canônica pura e `ux_equipment_chassis` nasce na migração, então
      regra que só existisse no índice seria regra que nenhum teste alcança. O
      índice continua valendo como rede para o banco real.

      E dizer QUAL plaquinha já tem o número não é enfeite: sem o `#000N`, quem
      está na bancada não sabe se digitou errado ou se a moto já foi cadastrada
      por outra pessoa — e o caminho mais curto para descobrir é cadastrar de novo.
    */
    /*
      AS MESMAS DUAS PERGUNTAS DA FICHA, NA PORTA DE ENTRADA.

      O PATCH conferia montador e a venda conferia dono; o cadastro — que
      recebe os dois campos — não conferia nenhum. Quem tem vínculo em duas
      empresas anotava um id na loja e cadastrava a moto da oficina com ele.
    */
    if (input.assemblyMechanicId) {
      exigirMontador(input.assemblyMechanicId, input.companyId);
    }
    if (input.ownerCustomerId) {
      exigirClienteDaEmpresa(input.ownerCustomerId, input.companyId);
    }

    const chassiInformado = String(input.chassis ?? '').trim();
    if (chassiInformado) {
      const jaExiste = db
        .prepare('SELECT public_id FROM core_equipment WHERE company_id = ? AND chassis = ? LIMIT 1')
        .get(input.companyId, chassiInformado) as { public_id: number } | undefined;
      if (jaExiste) {
        throw new ApiError(
          'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
          `A plaquinha ${formatPublicId(jaExiste.public_id)} já usa o chassi ${chassiInformado}. ` +
            'Confira o número ou abra a plaquinha existente.',
          409,
        );
      }
    }

    // A placa identifica o veículo na empresa inteira, como o chassi — e a
    // recusa diz qual plaquinha já a usa.
    if (placa) {
      const comAPlaca = db
        .prepare('SELECT public_id FROM core_equipment WHERE company_id = ? AND plate = ? LIMIT 1')
        .get(input.companyId, placa) as { public_id: number } | undefined;
      if (comAPlaca) {
        throw new ApiError(
          'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
          `A plaquinha ${formatPublicId(comAPlaca.public_id)} já usa a placa ${placa}. `
            + 'Confira a placa ou abra a plaquinha existente.',
          409,
        );
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    /*
      O NÚMERO PODE JÁ EXISTIR — E AGORA ELE É DO POOL (rodada 53).

      Dois caminhos, os dois legítimos:

        com plaquinha  a oficina imprimiu a folha, colou o adesivo na moto e
                       agora cadastra a máquina com o número que está nela.
                       O número e o token vêm da plaquinha; ela sai de
                       `disponivel` e vira `associada` nesta mesma transação.

        sem plaquinha  a máquina chegou sem adesivo. O número é sorteado como
                       sempre foi — e o pool aprende sobre ele na hora, já
                       `associada`. Sem esse registro haveria DUAS numerações
                       vivas no grupo, e a primeira colisão seriam dois
                       adesivos com o mesmo número em duas motos diferentes.
    */
    const plaquinha = temPlaquinhaEscolhida
      ? reservarPlaquinhaParaEquipamento({
          companyId: input.companyId,
          publicId: Number(input.tagPublicId),
        })
      : null;
    const publicId = plaquinha ? plaquinha.public_id : nextPublicId();
    const token = plaquinha ? plaquinha.public_token : randomBytes(24).toString('base64url');

    /*
      `linked_product_id` NÃO entra aqui, e a ausência é a decisão.

      A coluna existe desde o início e nunca teve um só leitor. A rodada 19
      chegou a gravá-la no vínculo e voltou atrás por dois motivos: o bloco de
      estoque de `listEquipment` já traz produto, unidade e empresa pelo JOIN
      com `core_product_units`, e — o que decide — a chave estrangeira aponta
      para `core_products` SEM conferir empresa. A moto é produto da LOJA e
      esta linha pertence à OFICINA, então a coluna guardaria um id que
      nenhum JOIN filtrado por empresa encontra.

      Tirar da criação também foi preciso: enquanto a rota aceitasse o campo
      no corpo, a decisão valeria só para o vínculo e a porta da API ficaria
      aberta — contradizendo o teste que cobra que a coluna permaneça nula.
    */
    db.prepare(
      `INSERT INTO core_equipment
         (id, company_id, workshop_id, public_id, public_token, origin, origin_company_id,
          category, brand, model, year, version, color, serial_number,
          motor_number, chassis, battery, battery_serial, owner_customer_id, sale_status,
          status, notes, warranty_months, assembly_mechanic_id, assembled_at,
          entered_at, plate, odometer_km, odometer_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.workshopId,
      publicId,
      token,
      input.origin,
      input.originCompanyId ?? null,
      categoria,
      input.brand ?? null,
      input.model ?? null,
      input.year != null ? Math.trunc(Number(input.year)) : null,
      input.version ?? null,
      input.color ?? null,
      input.serialNumber ?? null,
      input.motorNumber ?? null,
      // Já normalizado: em branco vira NULL, como o passo de migração fez com o
      // que estava gravado. String vazia ENTRA no índice parcial de chassi e
      // duas plaquinhas em branco colidiriam entre si.
      chassiInformado || null,
      input.battery ?? null,
      input.batterySerial ?? null,
      input.ownerCustomerId ?? null,
      input.origin === 'INTERNAL_PJ_MOTORS' ? 'NOT_SOLD' : 'NOT_APPLICABLE',
      input.notes ?? null,
      warrantyMonths,
      input.assemblyMechanicId ?? null,
      assembledAt,
      // A data informada, ou hoje: a coluna deixou de ser "o instante do
      // cadastro" e passou a ser a data em que a máquina entrou de verdade.
      enteredAt ?? now,
      placa,
      km,
      km !== null ? now : null,
      now,
      now,
    );

    // O pool fecha o vínculo na MESMA transação do nascimento da máquina:
    // meia associação deixaria um número queimado sem dono.
    if (plaquinha) {
      associarPlaquinha({ tagId: plaquinha.id, equipmentId: id });
    } else {
      registrarPlaquinhaDoCadastro({
        companyId: input.companyId,
        equipmentId: id,
        publicId,
        publicToken: token,
      });
    }

    recordEquipmentEvent({
      equipmentId: id,
      companyId: input.companyId,
      eventType: 'created',
      description:
        input.origin === 'INTERNAL_PJ_MOTORS'
          ? 'Equipamento interno registrado para montagem'
          : 'Equipamento do cliente recebido',
      userId: input.userId,
    });

    const equipamento = getEquipment(input.companyId, id)!;
    recordDomainEvent({
      eventType: 'equipment.upserted',
      aggregateType: 'equipment',
      aggregateId: id,
      companyId: input.companyId,
      operationalUnitId: input.workshopId ?? null,
      payload: equipamento as unknown as Record<string, unknown>,
    });
    return equipamento;
  });
}

export function recordEquipmentEvent(input: {
  equipmentId: string;
  companyId: string;
  eventType: string;
  description?: string;
  userId?: string | null;
  orderId?: string | null;
}): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `INSERT INTO core_equipment_events
         (id, equipment_id, company_id, event_type, description, user_id, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.equipmentId,
      input.companyId,
      input.eventType,
      input.description ?? null,
      input.userId ?? null,
      input.orderId ?? null,
      new Date().toISOString(),
    );
}

export function getEquipment(companyId: string, id: string): Equipment | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_equipment WHERE id = ? AND company_id = ?')
    .get(id, companyId) as Equipment | undefined;
  return row ?? null;
}

/*
  Aqui existiram `getEquipmentByToken` e (mais abaixo) `getEquipmentDetail`:
  o par que servia a rota pública do QR que uma rodada anterior removeu por
  entregar a ficha INTEIRA — série, chassi, dono, o próprio token — a quem só
  devia ver estado. A rota saiu e as funções ficaram, sem chamador, parecendo
  a porta de volta. Saíram MEDIDAS: quem lê a plaquinha hoje passa pela
  disciplina do portal (EquipmentPortalService), que projeta coluna a coluna.

  A `fichaDoEquipamento` abaixo (rodada 52) NÃO é a volta daquela função: ela
  é INTERNA — a rota que a serve exige sessão da oficina, e o `public_token`
  é removido do retorno. É a ficha que o mecânico abre para saber a garantia,
  quem montou e o que já aconteceu com aquela máquina.
*/

/**
 * A FICHA da máquina: identidade + garantia derivada + histórico.
 *
 * `core_equipment_events` era WRITE-ONLY desde que nasceu — a auditoria da
 * rodada 14 mediu isso: seis lugares gravam o histórico do equipamento
 * (criação, venda, OS aberta, plaquinha, vínculo de estoque) e nenhuma tela
 * jamais o leu. Esta função é o leitor que faltava.
 */
export interface EquipmentEvent {
  id: string;
  event_type: string;
  description: string | null;
  order_id: string | null;
  order_number: number | null;
  user_name: string | null;
  created_at: string;
}

export interface EquipmentFicha {
  equipment: Omit<Equipment, never> & Record<string, unknown>;
  warranty: WarrantyView;
  assemblyMechanicName: string | null;
  ownerName: string | null;
  workshopName: string | null;
  events: EquipmentEvent[];
  orders: {
    id: string;
    number: number;
    status: string;
    complaint: string | null;
    total_cents: number;
    created_at: string;
    closed_at: string | null;
  }[];
}

export function fichaDoEquipamento(companyId: string, id: string): EquipmentFicha | null {
  ensureCoreSchema();
  const db = getConnection();
  const equip = db
    .prepare('SELECT * FROM core_equipment WHERE id = ? AND company_id = ?')
    .get(id, companyId) as (Equipment & Record<string, unknown>) | undefined;
  if (!equip) return null;

  // O token da plaquinha é a credencial da página pública: ele não sai daqui.
  const semToken: Record<string, unknown> = { ...(equip as Record<string, unknown>) };
  delete semToken.public_token;

  /*
    AS RESOLUÇÕES DE NOME PERGUNTAM DE QUE EMPRESA.

    O cadastro passou a recusar montador e dono de fora (rodada 52), mas linha
    torta gravada ANTES continua no banco — e a ficha, resolvendo o nome sem
    `company_id`, seguiria exibindo gente de outra empresa como se fosse da
    casa. Filtro na leitura é o que impede o dado velho de continuar mentindo.
  */
  const nomeDe = (userId: unknown): string | null => {
    if (!userId) return null;
    const row = db
      .prepare(
        `SELECT u.display_name
           FROM core_users u
           JOIN core_user_companies uc ON uc.user_id = u.id AND uc.company_id = ?
          WHERE u.id = ?`,
      )
      .get(companyId, String(userId)) as { display_name: string } | undefined;
    return row?.display_name ?? null;
  };

  const owner = equip.owner_customer_id
    ? (db
        .prepare('SELECT name FROM core_customers WHERE id = ? AND company_id = ?')
        .get(equip.owner_customer_id, companyId) as { name: string } | undefined)
    : undefined;
  const workshop = db
    .prepare('SELECT name FROM core_workshops WHERE id = ? AND company_id = ?')
    .get(equip.workshop_id, companyId) as { name: string } | undefined;

  const events = db
    .prepare(
      `SELECT e.id, e.event_type, e.description, e.order_id, e.created_at,
              o.number AS order_number,
              u.display_name AS user_name
         FROM core_equipment_events e
         LEFT JOIN core_service_orders o ON o.id = e.order_id
         LEFT JOIN core_users u ON u.id = e.user_id
        WHERE e.equipment_id = ? AND e.company_id = ?
        ORDER BY e.created_at DESC
        LIMIT 200`,
    )
    .all(id, companyId) as unknown as EquipmentEvent[];

  const orders = db
    .prepare(
      `SELECT id, number, status, complaint, total_cents, created_at, closed_at
         FROM core_service_orders
        WHERE equipment_id = ? AND company_id = ?
        ORDER BY number DESC
        LIMIT 100`,
    )
    .all(id, companyId) as unknown as EquipmentFicha['orders'];

  return {
    equipment: semToken as EquipmentFicha['equipment'],
    warranty: warrantyOf(equip),
    assemblyMechanicName: nomeDe(equip.assembly_mechanic_id),
    ownerName: owner?.name ?? null,
    workshopName: workshop?.name ?? null,
    events,
    orders,
  };
}

/**
 * Completa GARANTIA e MONTAGEM de uma máquina já cadastrada.
 *
 * É um patch ESTREITO de propósito: identidade (chassi, série, número do
 * motor) continua sem porta de edição — a doutrina do topo deste arquivo não
 * mudou. O que se corrige aqui é o que a bancada descobre depois: os meses
 * combinados, quem montou e quando.
 */
export function setEquipmentWarrantyAndAssembly(input: {
  companyId: string;
  equipmentId: string;
  userId: string;
  warrantyMonths?: unknown;
  assemblyMechanicId?: string | null;
  assembledAt?: unknown;
  enteredAt?: unknown;
}): Equipment {
  ensureCoreSchema();
  const temGarantia = input.warrantyMonths !== undefined;
  const temMecanico = input.assemblyMechanicId !== undefined;
  const temMontagem = input.assembledAt !== undefined;
  const temEntrada = input.enteredAt !== undefined;
  if (!temGarantia && !temMecanico && !temMontagem && !temEntrada) {
    throw new ApiError('CORE_EQUIPMENT_PATCH_EMPTY', 'Informe o que mudar.', 400);
  }

  const meses = temGarantia ? exigirMesesDeGarantia(input.warrantyMonths) : null;
  const montadoEm = temMontagem ? exigirDataDeCalendario(input.assembledAt, 'Data de montagem') : null;
  const entradaEm = temEntrada ? exigirDataDeCalendario(input.enteredAt, 'Data de entrada') : null;

  return withTransaction(() => {
    const db = getConnection();
    const equip = getEquipment(input.companyId, input.equipmentId);
    if (!equip) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
    }

    /*
      DUAS PERGUNTAS, não uma.

      A primeira é de empresa: um id qualquer no corpo não vira "montado por"
      de ninguém. A segunda é de OFÍCIO — e faltava. Quem monta a máquina põe a
      mão nela: mecânico, ou o gerente da oficina, que também monta. O caixa da
      oficina é da empresa e da equipe, e passava: a ficha aceitava registrar
      "Montada por: PDV Oficina", que é afirmação falsa sobre trabalho de
      bancada, no lugar onde ninguém a confere depois.
    */
    if (temMecanico && input.assemblyMechanicId) {
      exigirMontador(input.assemblyMechanicId, input.companyId);
    }

    /*
      GARANTIA VIVA EXIGE DATA-BASE.

      Sem `sold_at` nem `entered_at` a conta não tem de onde partir, e o
      resultado era a ficha se contradizendo: o selo "Sem garantia" e, logo
      abaixo, "12 meses · vence em —". Bastava um backspace no campo "Entrou
      em", na mesma tela em que a garantia é combinada, porque a tela manda
      sempre os dois campos juntos.

      A saída honesta está na mensagem: quem quer mesmo apagar a data tira a
      garantia na mesma requisição.
    */
    const mesesDepois = temGarantia ? meses : (equip.warranty_months ?? 0);
    const entradaDepois = temEntrada ? entradaEm : equip.entered_at;
    if (Number(mesesDepois ?? 0) > 0 && !equip.sold_at && !entradaDepois) {
      throw new ApiError(
        'CORE_WARRANTY_NEEDS_BASE',
        `A garantia de ${mesesDepois} meses precisa da data de entrada: informe a data, `
        + 'ou remova a garantia na mesma alteração.',
        409,
      );
    }

    const agora = new Date().toISOString();
    const campos: string[] = [];
    const valores: unknown[] = [];
    const mudancas: string[] = [];
    if (temGarantia) {
      campos.push('warranty_months = ?');
      valores.push(meses);
      mudancas.push(meses ? `garantia de ${meses} meses` : 'garantia removida');
    }
    if (temMecanico) {
      campos.push('assembly_mechanic_id = ?');
      valores.push(input.assemblyMechanicId ?? null);
      mudancas.push(input.assemblyMechanicId ? 'montador definido' : 'montador removido');
    }
    if (temMontagem) {
      campos.push('assembled_at = ?');
      valores.push(montadoEm);
      mudancas.push(montadoEm ? `montagem em ${montadoEm}` : 'data de montagem removida');
    }
    if (temEntrada) {
      campos.push('entered_at = ?');
      valores.push(entradaEm);
      mudancas.push(entradaEm ? `entrada em ${entradaEm}` : 'data de entrada removida');
    }
    campos.push('updated_at = ?');
    valores.push(agora);

    db.prepare(`UPDATE core_equipment SET ${campos.join(', ')} WHERE id = ?`).run(
      ...(valores as never[]),
      input.equipmentId,
    );

    recordEquipmentEvent({
      equipmentId: input.equipmentId,
      companyId: input.companyId,
      eventType: 'ficha_atualizada',
      description: `Ficha atualizada: ${mudancas.join('; ')}`,
      userId: input.userId,
    });

    return getEquipment(input.companyId, input.equipmentId)!;
  });
}

/**
 * A unidade de estoque que ESTA plaquinha representa, quando existe.
 *
 * `null` para o equipamento do cliente e para a moto que ainda não foi adotada
 * pela loja.
 */
export interface EquipmentStockBlock {
  unitId: string;
  unitStatus: string;
  productName: string;
  companyName: string;
}

export interface EquipmentListItem extends Equipment {
  estoque: EquipmentStockBlock | null;
}

/**
 * A lista da oficina, agora sabendo se a moto é da loja.
 *
 * ## Por que o `LEFT JOIN` com a unidade
 *
 * A tela da oficina precisa distinguir três coisas que antes tinham a mesma
 * cara: o aparelho do cliente, a moto interna solta e a moto que É uma unidade
 * do estoque da loja. Sem esta coluna, a tela teria um campo sem escritor — que
 * é exatamente o defeito que esta rodada existe para matar, só que na outra
 * ponta.
 *
 * O JOIN cruza empresa DE PROPÓSITO: a unidade vive na loja e a plaquinha na
 * oficina, e `company_name` existe justamente para dizer de qual loja ela é.
 * `u.equipment_id` tem índice único parcial (`ux_product_units_equipment`), então
 * o LEFT JOIN não multiplica linha: uma plaquinha é de no máximo uma unidade.
 */
export function listEquipment(
  companyId: string,
  options: FiltroDosEquipamentos & { limit?: number; offset?: number } = {},
): EquipmentListItem[] {
  ensureCoreSchema();
  const filtro = filtroDosEquipamentos(companyId, options);
  /*
    Página de 300 por padrão, como sempre foi — agora com `offset` e com o
    total contado por `countEquipment` (GAP-PRD-070): a 301ª plaquinha sumia
    da tela sem ninguém saber.
  */
  const sql = `
    SELECT e.*,
           u.id AS estoque_unit_id,
           u.status AS estoque_unit_status,
           p.name AS estoque_product_name,
           uc.trade_name AS estoque_company_name
      FROM core_equipment e
      LEFT JOIN core_product_units u ON u.equipment_id = e.id
      LEFT JOIN core_products p ON p.id = u.product_id
      LEFT JOIN core_companies uc ON uc.id = u.company_id
     WHERE ${filtro.where}
     ORDER BY e.public_id DESC LIMIT ? OFFSET ?`;
  const params = [
    ...filtro.params,
    limitarPagina(options.limit, 300),
    limitarDeslocamento(options.offset),
  ];

  const linhas = getConnection().prepare(sql).all(...(params as never[])) as unknown as (Equipment & {
    estoque_unit_id: string | null;
    estoque_unit_status: string | null;
    estoque_product_name: string | null;
    estoque_company_name: string | null;
  })[];

  return linhas.map((linha) => {
    const {
      estoque_unit_id: unitId,
      estoque_unit_status: unitStatus,
      estoque_product_name: productName,
      estoque_company_name: companyName,
      ...equipamento
    } = linha;
    return {
      ...(equipamento as Equipment),
      estoque: unitId
        ? {
            unitId,
            unitStatus: unitStatus ?? 'in_stock',
            // Produto e empresa vêm de LEFT JOIN e podem faltar em base antiga;
            // um traço na tela é melhor do que a linha inteira sumir.
            productName: productName ?? '—',
            companyName: companyName ?? '—',
          }
        : null,
    };
  });
}

export interface FiltroDosEquipamentos {
  workshopId?: string;
  ownerCustomerId?: string;
  search?: string;
  /** Só uma origem — é como a tela conta "do grupo" e "de cliente" sem somar a página. */
  origin?: 'INTERNAL_PJ_MOTORS' | 'EXTERNAL_CUSTOMER';
}

/** Quantos equipamentos o recorte de `listEquipment` tem — o `total` da página. */
export function countEquipment(companyId: string, options: FiltroDosEquipamentos = {}): number {
  ensureCoreSchema();
  const filtro = filtroDosEquipamentos(companyId, options);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS total FROM core_equipment e WHERE ${filtro.where}`)
    .get(...(filtro.params as never[])) as { total: number };
  return Number(linha.total);
}

/** O WHERE da lista de equipamentos — um só, para a lista e para a contagem. */
function filtroDosEquipamentos(
  companyId: string,
  options: FiltroDosEquipamentos,
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let sql = 'e.company_id = ?';
  if (options.origin) {
    sql += ' AND e.origin = ?';
    params.push(options.origin);
  }
  if (options.workshopId) {
    sql += ' AND e.workshop_id = ?';
    params.push(options.workshopId);
  }
  if (options.ownerCustomerId) {
    sql += ' AND e.owner_customer_id = ?';
    params.push(options.ownerCustomerId);
  }
  if (options.search) {
    const like = `%${options.search}%`;
    const condicoes = [
      'e.brand LIKE ?',
      'e.model LIKE ?',
      'e.serial_number LIKE ?',
      'e.chassis LIKE ?',
    ];
    params.push(like, like, like, like);

    // A plaquinha é como o balcão chama o equipamento — quem digita "#0007",
    // "0007" ou "7" está procurando o mesmo. Sem isto, a busca ignorava
    // justamente o identificador principal.
    const plaquinha = Number(options.search.replace(/^#/, '').trim());
    if (Number.isInteger(plaquinha) && plaquinha > 0) {
      condicoes.push('e.public_id = ?');
      params.push(plaquinha);
    }

    sql += ` AND (${condicoes.join(' OR ')})`;
  }
  return { where: sql, params };
}

/**
 * Registra a venda de um equipamento interno, À MÃO.
 *
 * O registro NÃO é recriado: o mesmo equipamento passa a ter proprietário e
 * conserva todo o histórico de montagem e manutenção anterior à venda.
 *
 * ## As duas recusas, e por que elas são conserto de defeito
 *
 * Esta função gravava `sale_status = 'SOLD'` INCONDICIONALMENTE — inclusive
 * sobre equipamento `EXTERNAL_CUSTOMER`, que é o aparelho que o cliente TROUXE
 * e que nunca foi vendido pela loja. Ali o `sale_status` correto é
 * `NOT_APPLICABLE`, e é o que `createEquipment` grava; carimbar `SOLD` em cima
 * disso passava a afirmar uma venda que não existiu, com data e tudo.
 *
 * A segunda recusa é nova e nasce do vínculo com o estoque: quando a plaquinha
 * tem uma UNIDADE vinculada, quem carimba o dono é a VENDA — `applyMovement`
 * chama `venderPelaUnidade` na mesma transação da baixa, espelhando o cliente na
 * empresa da oficina. Deixar esta rota escrever por cima criaria duas verdades
 * sobre o mesmo fato: um dono vindo do balcão e outro digitado aqui, sem venda
 * nenhuma por trás. Duas verdades sobre quem é o dono é pior do que nenhuma —
 * é a que o portal mostra para a pessoa errada.
 */
export function assignOwner(input: {
  companyId: string;
  equipmentId: string;
  customerId: string;
  userId: string;
  saleId?: string | null;
}): Equipment {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const equipment = getEquipment(input.companyId, input.equipmentId);
    if (!equipment) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
    }

    if (equipment.origin === 'EXTERNAL_CUSTOMER') {
      throw new ApiError(
        'CORE_EQUIPMENT_NOT_SELLABLE',
        `A ${formatPublicId(equipment.public_id)} é o equipamento que o cliente trouxe: ele não foi ` +
          'vendido pela loja e não recebe registro de venda.',
        409,
      );
    }

    const unidadeVinculada = db
      .prepare('SELECT id FROM core_product_units WHERE equipment_id = ? LIMIT 1')
      .get(input.equipmentId) as { id: string } | undefined;
    if (unidadeVinculada) {
      throw new ApiError(
        'CORE_EQUIPMENT_LINKED_TO_UNIT',
        `A ${formatPublicId(equipment.public_id)} está vinculada a uma unidade do estoque: o dono é ` +
          'gravado pela venda no balcão, e não à mão por aqui.',
        409,
      );
    }

    /*
      A MOTO DO PÁTIO SE VENDE PELO PDV DA LOJA (GAP-PRD-189).

      A recusa acima só olhava o VÍNCULO. A plaquinha interna ainda não adotada
      passava, e o registro à mão gravava `SOLD` sem venda, sem financeiro e sem
      nota — enquanto a mesma moto (o mesmo chassi) seguia `in_stock` na PJ. A
      plaquinha sumia das candidatas (já tem dono), a unidade continuava à venda,
      e a única volta era mexer no banco: duas verdades para sempre.

      A pergunta agora é pelo NÚMERO: se alguma empresa do grupo tem no pátio
      uma unidade com o mesmo chassi, motor ou série, a moto não foi vendida — e
      a venda dela sai pelo PDV da loja, que é quem carimba o dono na mesma
      transação do estoque. O registro à mão continua para o que ele serve: a
      moto que saiu antes do sistema, sem unidade nenhuma no pátio.
    */
    if (equipment.origin === 'INTERNAL_PJ_MOTORS') {
      const noPatio = unidadeNoPatioComAIdentidade(equipment);
      if (noPatio) {
        throw new ApiError(
          'CORE_EQUIPMENT_SALE_BY_PDV',
          `A ${formatPublicId(equipment.public_id)} tem o ${noPatio.campo} ${noPatio.valor}, de uma moto que ` +
            `ainda está no estoque da ${noPatio.empresa} (${noPatio.produto}). A venda dela sai pelo PDV da ` +
            'loja — com estoque, financeiro e nota —, e o dono é gravado lá. Vincule a plaquinha à unidade em ' +
            'Estoque › Unidades antes de vender.',
          409,
          { unitCompany: noPatio.empresa },
        );
      }
    }

    // A venda informada tem de EXISTIR nesta empresa: um id qualquer no corpo
    // afirmaria uma venda que ninguém fez, com a mesma cara de uma de verdade.
    if (input.saleId) {
      const venda = db
        .prepare('SELECT id FROM core_sales WHERE id = ? AND company_id = ?')
        .get(input.saleId, input.companyId) as { id: string } | undefined;
      if (!venda) {
        throw new ApiError('CORE_SALE_NOT_FOUND', 'A venda informada não existe nesta empresa.', 404);
      }
    }

    // Sem esta checagem, um id inválido só falharia lá embaixo na FK, virando
    // erro 500 em vez de uma resposta compreensível.
    const customer = db
      .prepare('SELECT id FROM core_customers WHERE id = ? AND company_id = ?')
      .get(input.customerId, input.companyId) as { id: string } | undefined;
    if (!customer) {
      throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta empresa.', 404);
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_equipment
          SET owner_customer_id = ?, sale_status = 'SOLD', sold_at = ?, sale_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.customerId, now, input.saleId ?? null, now, input.equipmentId);

    recordEquipmentEvent({
      equipmentId: input.equipmentId,
      companyId: input.companyId,
      eventType: 'sold',
      description: input.saleId
        ? 'Equipamento vendido e vinculado ao proprietário'
        : 'Proprietário registrado à mão, sem venda no sistema',
      userId: input.userId,
    });

    return getEquipment(input.companyId, input.equipmentId)!;
  });
}

/**
 * Uma unidade EM ESTOQUE, em qualquer empresa do grupo, com o mesmo chassi,
 * motor ou série desta plaquinha (GAP-PRD-189). Cruza empresa de propósito — a
 * unidade vive na loja e a plaquinha na oficina — e devolve só o que a recusa
 * precisa dizer.
 */
function unidadeNoPatioComAIdentidade(
  equipment: Pick<Equipment, 'chassis' | 'motor_number' | 'serial_number'>,
): { campo: string; valor: string; empresa: string; produto: string } | null {
  const campos = [
    { rotulo: 'chassi', coluna: 'chassis', valor: equipment.chassis },
    { rotulo: 'número do motor', coluna: 'motor_number', valor: equipment.motor_number },
    { rotulo: 'número de série', coluna: 'serial_number', valor: equipment.serial_number },
  ] as const;
  for (const campo of campos) {
    const valor = String(campo.valor ?? '').trim();
    if (!valor) continue;
    const linha = getConnection()
      .prepare(
        `SELECT c.trade_name AS empresa, p.name AS produto
           FROM core_product_units u
           JOIN core_companies c ON c.id = u.company_id
           JOIN core_products p ON p.id = u.product_id
          WHERE u.status = 'in_stock' AND u.${campo.coluna} IS NOT NULL
            AND UPPER(TRIM(u.${campo.coluna})) = UPPER(TRIM(?))
          LIMIT 1`,
      )
      .get(valor) as { empresa: string; produto: string } | undefined;
    if (linha) return { campo: campo.rotulo, valor, empresa: linha.empresa, produto: linha.produto };
  }
  return null;
}

// `getEquipmentDetail` morava aqui — ver a nota sobre o par do QR, mais acima.

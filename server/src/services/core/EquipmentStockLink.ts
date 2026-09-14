/**
 * A ponte entre a UNIDADE de estoque e a PLAQUINHA da oficina.
 *
 * ## O defeito que este arquivo existe para matar
 *
 * A PJ Motors compra a moto para revender; a Oficina monta. A MESMA moto
 * física é ao mesmo tempo uma linha de `core_product_units` (o que o balcão
 * vende) e uma linha de `core_equipment` (o que tem plaquinha, QR e histórico
 * de montagem). Hoje são dois cadastros que não se conhecem: o balcão vende, a
 * unidade vira `sold`, e o equipamento continua `NOT_SOLD`, sem dono e sem
 * `sold_at`. Quem comprou raspa o QR e o portal responde vazio — porque o
 * portal lista por `owner_customer_id`, que ninguém escreveu.
 *
 * ## Por que este módulo CRUZA empresa de propósito
 *
 * A oficina é OUTRA EMPRESA. `core_companies` tem "Oficina" e "Preço Justo"
 * como empresas próprias, e `createEquipment` exige que a oficina pertença à
 * empresa que cria o equipamento (`EquipmentService.ts`) — logo a PJ Motors
 * NÃO PODE criar equipamento. A unidade vive na loja, a plaquinha vive na
 * oficina, e não existe um `company_id` que contenha as duas.
 *
 * Todo o resto do sistema filtra por `company_id`, e está certo. Aqui a
 * travessia é o assunto, não um descuido — por isso ela é explícita, mora num
 * arquivo só, e é limitada por regra em vez de por escopo de consulta:
 *
 *   - só plaquinha `INTERNAL_PJ_MOTORS` atravessa. Equipamento de CLIENTE
 *     (`EXTERNAL_CUSTOMER`) NUNCA é adotável, e essa é a linha que impede a
 *     travessia entre empresas de virar vazamento: sem ela, a loja A veria e
 *     adotaria o celular que um cliente deixou na oficina da loja B;
 *   - `origin_company_id` marca quem adotou. Plaquinha já adotada por outra
 *     empresa some da lista da minha.
 *
 * ## O que esta rodada NÃO resolve, e fica nomeado
 *
 * 1. OS DE MONTAGEM INTERNA COM PEÇAS NÃO TEM CAMINHO PARA `finalizada`.
 *    `closeOrder` recusa encerrar sem custo quando `total_cents > 0`
 *    (`CORE_HAS_PARTS_COST`) e, com custo, grava `aguardando_pagamento`. A
 *    única saída de lá é `settleOrder`, que EXIGE `saleId` — e ninguém vai
 *    cobrar a loja por montar a própria moto. A OS fica presa para sempre.
 *    Ver `assertUnidadesComPlaquinhaVendiveis`, regra 3.
 *
 * ## O CANAL ONLINE É COBERTO, E NUNCA RECUSADO
 *
 * A primeira versão desta ponte RECUSAVA vender moto com plaquinha pela loja
 * online. Estava errado, e o motivo é de dinheiro, não de gosto: a recusa
 * dispara em `consumeReservation`, que roda dentro de `handlePaymentWebhook`
 * DEPOIS de o pagamento ser capturado. O webhook não abre transação e já gravou
 * a intent antes de chamar `markOrderPaid`; o 409 deixava o pedido em
 * `aguardando_pagamento`, e a re-entrega do provedor batia no dedupe do topo e
 * respondia 200 sem processar nada. O estado final era permanente: dinheiro
 * capturado, pedido travado, reserva presa — e ninguém tinha escolhido aquela
 * moto, foi o `pickUnitsFifo` que a pegou.
 *
 * Por isso `venderPelaUnidade` atende os DOIS canais (ver `REFERENCIAS_QUE_DAO_DONO`)
 * e NENHUMA recusa vale para `ecommerce_order`. O que falta de informação lá
 * vira EVENTO no histórico da plaquinha, não erro: meia-verdade registrada é
 * melhor que divergência silenciosa, e infinitamente melhor que dinheiro preso.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordEquipmentEvent } from './EquipmentService.js';
import { findOrCreateCustomer } from './CatalogService.js';
import { ORDER_STATUSES_ON_BENCH } from './WorkshopCoreService.js';
import {
  empresaUsaPlaquinha,
  exigirEmpresaComPlaquinha,
} from './EquipmentTagPoolService.js';

const agora = () => new Date().toISOString();

/**
 * Estados em que a moto está DESMONTADA na bancada.
 *
 * É a mesma lista que `EquipmentPortalService` usa para dizer "o aparelho está
 * na oficina", e pelo mesmo motivo: `aguardando_pagamento` e `finalizada`
 * ficam de fora porque nos dois a moto está inteira. Ver a regra 4 de
 * `assertUnidadesComPlaquinhaVendiveis` para o porquê disso ser obrigatório e
 * não conservadorismo.
 */
// A lista vive em UM lugar (rodada 51): copiada aqui, ela não soube da coluna
// `parada_setor` quando ela nasceu — e a moto parada no setor virava vendível.
/*
  A lista e montada DENTRO da funcao, e nao no topo do modulo (rodada 54).
  Espalhar no topo faz este arquivo depender de `WorkshopCoreService` ja ter
  TERMINADO de avaliar; num ciclo de importacao a constante ainda esta vazia,
  e o processo morre com "not iterable" num arquivo sem relacao com oficina.
*/
function osMotoDesmontada(): string[] {
  return [...ORDER_STATUSES_ON_BENCH];
}

/**
 * As referências em que a saída de estoque É UMA VENDA, e o documento de onde
 * sai o comprador de cada uma.
 *
 * Existe com NOME, e não como comparação solta com strings no meio do código,
 * porque a lista é uma decisão de domínio que precisa ser lida e discutida:
 * quem está aqui carimba dono na plaquinha, quem não está tira a moto do
 * estoque sem que haja comprador para nomear (baixa, transferência, consumo em
 * OS, acerto de contagem, saída manual).
 *
 * `sale` lê `core_sales.customer_id`; `ecommerce_order` lê
 * `core_orders.customer_id`. São dois documentos diferentes para o mesmo fato —
 * alguém comprou a moto — e por isso a leitura do cliente é feita conforme a
 * referência, em `clienteDaReferencia`.
 *
 * Quem NÃO está aqui, e por quê — todas passam por `applyMovement` com saída, e
 * em nenhuma existe um comprador para nomear:
 *
 *   `transferencia`   — a moto muda de prateleira, não de dono.
 *   `unit_write_off`  — perda, quebra ou devolução ao fornecedor. Não há venda.
 *   `inventory_count` — acerto de contagem: a peça sumiu do pátio, não foi vendida.
 *   `service_order`   — peça consumida na bancada; quem paga é a OS, e a moto
 *                       montada não é o que está saindo.
 *   `manual`          — saída lançada à mão pelo estoquista, sem documento.
 *
 * `sale_cancel` e `sale_return` não estão aqui porque são ENTRADA: quem cuida
 * delas é `devolverPelaUnidade`, no outro lado do ramo.
 *
 * ## É EXPORTADA, e existe UMA SÓ
 *
 * `InventoryService` tinha uma cópia literal desta lista, com outro nome
 * (`REFERENCIAS_DE_VENDA`), para decidir QUANDO perguntar. Foi a divergência
 * entre as duas que deixou o canal online como código morto por um tempo: aqui
 * `ecommerce_order` já dava dono, lá a lista ainda dizia só `'sale'`, então a
 * moto vendida pelo site saía do estoque e a plaquinha continuava `NOT_SOLD`.
 * Duas listas sobre o mesmo assunto vão divergir de novo, e nenhum teste afirma
 * que são iguais — o único jeito de a divergência ser impossível é não haver
 * duas. A decisão de domínio está documentada AQUI, então é daqui que ela sai.
 */
export const REFERENCIAS_QUE_DAO_DONO = new Set(['sale', 'ecommerce_order']);

/**
 * O documento como o CADASTRO o guarda: só dígitos.
 *
 * `findOrCreateCustomer` normaliza com `replace(/\D/g, '')` antes de gravar, e
 * é esse valor que `syncLinks` compara para unir os cadastros das várias
 * empresas na mesma conta de portal. Conferir "documento preenchido" por texto
 * não-vazio deixava "ISENTO" passar como se fosse CPF: o espelho nascia com
 * `document` NULL e o portal ficava mudo justo para quem acabou de comprar.
 * Guarda e escrita têm de medir a MESMA coisa.
 */
function somenteDigitos(v: string | null | undefined): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Os três números que existem dos DOIS lados e precisam ser reconciliados. */
const CAMPOS_DE_IDENTIDADE = [
  { rotulo: 'chassi', unidade: 'chassis', plaquinha: 'chassis' },
  { rotulo: 'número do motor', unidade: 'motor_number', plaquinha: 'motor_number' },
  { rotulo: 'número de série', unidade: 'serial_number', plaquinha: 'serial_number' },
] as const;

export interface PlaquinhaCandidata {
  id: string;
  publicId: number;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  chassis: string | null;
  motorNumber: string | null;
  serialNumber: string | null;
  workshopName: string;
  workshopCompanyName: string;
}

export interface PlaquinhaDaUnidade {
  id: string;
  publicId: number;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  saleStatus: string;
  status: string;
  workshopName: string;
  workshopCompanyName: string;
  ordensAbertas: number;
}

/** `#0001` — o mesmo formato humano de `EquipmentService.formatPublicId`. */
function rotuloPublico(publicId: number): string {
  return `#${String(publicId).padStart(4, '0')}`;
}

/** Texto vazio vira nulo: em branco não é identidade, e colide em índice único. */
function limpo(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim();
  return t || null;
}

/**
 * Comparação de identidade tolerante a caixa e espaço.
 *
 * "9C2JC4110ER" e "9c2jc4110er " são o MESMO chassi digitado por duas pessoas.
 * Tratar isso como divergência criaria recusa onde não há erro, e empurraria o
 * operador a usar a válvula de sobrescrita sem precisar dela.
 */
function mesmaIdentidade(a: string | null, b: string | null): boolean {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

interface LinhaUnidade {
  id: string;
  company_id: string;
  product_id: string;
  status: string;
  chassis: string | null;
  motor_number: string | null;
  serial_number: string | null;
  equipment_id: string | null;
}

interface LinhaPlaquinha {
  id: string;
  company_id: string;
  workshop_id: string;
  public_id: number;
  origin: string;
  origin_company_id: string | null;
  brand: string | null;
  model: string | null;
  chassis: string | null;
  motor_number: string | null;
  serial_number: string | null;
  owner_customer_id: string | null;
  sale_status: string;
  status: string;
}

function lerUnidade(companyId: string, unitId: string): LinhaUnidade {
  const linha = getConnection()
    .prepare(
      `SELECT id, company_id, product_id, status, chassis, motor_number, serial_number, equipment_id
         FROM core_product_units WHERE id = ? AND company_id = ?`,
    )
    .get(unitId, companyId) as LinhaUnidade | undefined;
  if (!linha) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
  return linha;
}

/**
 * A plaquinha pelo id, SEM filtro de empresa.
 *
 * É a travessia, e ela é intencional — ver o cabeçalho. Quem chama é
 * responsável por aplicar as regras de adoção logo em seguida; sozinha, esta
 * função não autoriza nada.
 */
function lerPlaquinha(equipmentId: string): LinhaPlaquinha {
  const linha = getConnection()
    .prepare(
      `SELECT id, company_id, workshop_id, public_id, origin, origin_company_id,
              brand, model, chassis, motor_number, serial_number,
              owner_customer_id, sale_status, status
         FROM core_equipment WHERE id = ?`,
    )
    .get(equipmentId) as LinhaPlaquinha | undefined;
  if (!linha) throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Plaquinha não encontrada.', 404);
  return linha;
}

/** Quantas OS deixam a moto desmontada agora. */
function ordensAbertasDaPlaquinha(equipmentId: string): number {
  const marcas = osMotoDesmontada().map(() => '?').join(', ');
  const linha = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_service_orders
        WHERE equipment_id = ? AND status IN (${marcas})`,
    )
    .get(...([equipmentId, ...osMotoDesmontada()] as never[])) as { n: number };
  return linha.n;
}

/**
 * A primeira OS que deixa a moto desmontada agora, se houver.
 *
 * Serve a dois donos de propósito: no balcão ela vira RECUSA (regra 3 de
 * `assertUnidadesComPlaquinhaVendiveis`), e na venda online vira EVENTO. É o
 * mesmo fato lido pela mesma consulta — o que muda é o que se pode fazer com
 * ele em cada canal.
 */
function ordemDeBancadaAberta(equipmentId: string): { number: number; status: string } | undefined {
  const marcas = osMotoDesmontada().map(() => '?').join(', ');
  return getConnection()
    .prepare(
      `SELECT number, status FROM core_service_orders
        WHERE equipment_id = ? AND status IN (${marcas})
        ORDER BY number LIMIT 1`,
    )
    .get(...([equipmentId, ...osMotoDesmontada()] as never[])) as
    | { number: number; status: string }
    | undefined;
}

/**
 * Plaquinhas do grupo que a loja pode adotar. Cruza empresa DE PROPÓSITO.
 *
 * As condições, e o porquê de cada uma:
 *
 *   `origin = 'INTERNAL_PJ_MOTORS'` — NUNCA `EXTERNAL_CUSTOMER`. Aparelho de
 *      cliente de outra empresa não é adotável, e esta é a linha que impede a
 *      travessia entre empresas de virar vazamento de dado alheio.
 *   `sale_status = 'NOT_SOLD'` — plaquinha já vendida tem dono; adotar seria
 *      colocar no estoque uma moto que está na garagem de alguém.
 *   sem unidade vinculada — uma moto é uma linha de estoque só.
 *   `origin_company_id IS NULL OR = companyId` — nunca adotada, ou já minha.
 *
 * Traz o nome da oficina e o da empresa dela porque quem escolhe no balcão
 * precisa saber DE ONDE a plaquinha vem: "#0007 — Oficina de Mobilidade
 * (Oficina)" é uma escolha informada; "#0007" sozinho é um chute.
 */
/**
 * A plaquinha `e` tem a identidade de uma moto VENDIDA SEM PLAQUINHA desta empresa
 * (GAP-PRD-108)? Fragmento SQL com dois parâmetros: a empresa e o id da unidade
 * que NÃO conta (a própria moto vendida, no vínculo tardio; vazio = nenhuma).
 *
 * Essa plaquinha é daquela moto — a oficina a montou, a loja a vendeu antes de
 * vincular. Oferecê-la a outra unidade era o risco que a auditoria mediu: o
 * operador adota a plaquinha certa na moto errada, e o comprador verdadeiro
 * nunca vê a moto dele no portal.
 */
const SQL_E_DE_MOTO_VENDIDA = `
  SELECT 1 FROM core_product_units s
   WHERE s.company_id = ? AND s.status = 'sold' AND s.equipment_id IS NULL AND s.id <> ?
     AND ((e.chassis IS NOT NULL AND s.chassis IS NOT NULL
           AND UPPER(TRIM(s.chassis)) = UPPER(TRIM(e.chassis)))
       OR (e.motor_number IS NOT NULL AND s.motor_number IS NOT NULL
           AND UPPER(TRIM(s.motor_number)) = UPPER(TRIM(e.motor_number)))
       OR (e.serial_number IS NOT NULL AND s.serial_number IS NOT NULL
           AND UPPER(TRIM(s.serial_number)) = UPPER(TRIM(e.serial_number))))`;

export function plaquinhasVinculaveis(
  companyId: string,
  termo?: string,
  /**
   * A unidade que vai receber a plaquinha. Quando ela já foi VENDIDA (vínculo
   * tardio, GAP-PRD-108), a lista traz só a plaquinha com a MESMA identidade:
   * depois da venda, o que liga a plaquinha à moto é o número, não a escolha.
   */
  unitId?: string,
): PlaquinhaCandidata[] {
  ensureCoreSchema();
  /*
    A REGRA DE OURO TAMBÉM VALE PARA QUEM ADOTA (rodada 53).

    Esta é a única leitura de unidade que atravessa empresa de propósito: ela
    mostra plaquinha que vive na Oficina para a loja que vende a moto. O filtro
    olhava a ORIGEM do equipamento e nunca QUEM está adotando — qualquer loja
    do grupo com perfil de gerente ou estoquista via a lista e podia adotar a
    plaquinha da Oficina para uma unidade sua. Loja de roupa não tem máquina
    com plaquinha, e a lista vazia com o motivo escrito é a resposta honesta.
  */
  if (!empresaUsaPlaquinha(companyId)) return [];
  const alvo = unitId ? lerUnidade(companyId, unitId) : null;
  const params: unknown[] = [companyId, companyId, alvo?.id ?? ''];
  let sql = `
    SELECT e.id, e.public_id, e.brand, e.model, e.chassis, e.motor_number, e.serial_number,
           w.name AS workshop_name, c.trade_name AS company_name
      FROM core_equipment e
      JOIN core_workshops w ON w.id = e.workshop_id AND w.company_id = e.company_id
      JOIN core_companies c ON c.id = e.company_id
     WHERE e.origin = 'INTERNAL_PJ_MOTORS'
       AND e.sale_status = 'NOT_SOLD'
       AND (e.origin_company_id IS NULL OR e.origin_company_id = ?)
       AND NOT EXISTS (SELECT 1 FROM core_product_units u WHERE u.equipment_id = e.id)
       AND NOT EXISTS (${SQL_E_DE_MOTO_VENDIDA})`;

  if (alvo && alvo.status === 'sold') {
    const iguais: string[] = [];
    for (const campo of CAMPOS_DE_IDENTIDADE) {
      const valor = limpo(alvo[campo.unidade]);
      if (!valor) continue;
      iguais.push(`UPPER(TRIM(e.${campo.plaquinha})) = UPPER(TRIM(?))`);
      params.push(valor);
    }
    // Moto vendida sem número nenhum: não há o que ligue plaquinha a ela.
    if (iguais.length === 0) return [];
    sql += ` AND (${iguais.join(' OR ')})`;
  }

  const busca = String(termo ?? '').trim();
  if (busca) {
    const like = `%${busca}%`;
    const condicoes = [
      'e.brand LIKE ?',
      'e.model LIKE ?',
      'e.chassis LIKE ?',
      'e.motor_number LIKE ?',
      'e.serial_number LIKE ?',
    ];
    params.push(like, like, like, like, like);

    // A plaquinha é como o balcão chama a moto: quem digita "#0007", "0007" ou
    // "7" está procurando a mesma. Sem isto a busca ignoraria justamente o
    // identificador principal.
    const numero = Number(busca.replace(/^#/, '').trim());
    if (Number.isInteger(numero) && numero > 0) {
      condicoes.push('e.public_id = ?');
      params.push(numero);
    }
    sql += ` AND (${condicoes.join(' OR ')})`;
  }
  sql += ' ORDER BY e.public_id DESC LIMIT 200';

  const linhas = getConnection().prepare(sql).all(...(params as never[])) as unknown as {
    id: string;
    public_id: number;
    brand: string | null;
    model: string | null;
    chassis: string | null;
    motor_number: string | null;
    serial_number: string | null;
    workshop_name: string;
    company_name: string;
  }[];

  return linhas.map((l) => ({
    id: l.id,
    publicId: l.public_id,
    publicIdLabel: rotuloPublico(l.public_id),
    brand: l.brand,
    model: l.model,
    chassis: l.chassis,
    motorNumber: l.motor_number,
    serialNumber: l.serial_number,
    workshopName: l.workshop_name,
    workshopCompanyName: l.company_name,
  }));
}

/**
 * A plaquinha desta unidade, ou null. Cruza empresa DE PROPÓSITO.
 *
 * A unidade é conferida contra `companyId` — a autorização mora nela. A
 * plaquinha é lida sem filtro de empresa, porque ela vive na oficina e é
 * exatamente isso que a tela precisa mostrar.
 */
export function plaquinhaDaUnidade(companyId: string, unitId: string): PlaquinhaDaUnidade | null {
  ensureCoreSchema();
  const unidade = lerUnidade(companyId, unitId);
  if (!unidade.equipment_id) return null;

  const linha = getConnection()
    .prepare(
      `SELECT e.id, e.public_id, e.brand, e.model, e.sale_status, e.status,
              w.name AS workshop_name, c.trade_name AS company_name
         FROM core_equipment e
         JOIN core_workshops w ON w.id = e.workshop_id AND w.company_id = e.company_id
         JOIN core_companies c ON c.id = e.company_id
        WHERE e.id = ?`,
    )
    .get(unidade.equipment_id) as
    | {
        id: string;
        public_id: number;
        brand: string | null;
        model: string | null;
        sale_status: string;
        status: string;
        workshop_name: string;
        company_name: string;
      }
    | undefined;
  if (!linha) return null;

  return {
    id: linha.id,
    publicId: linha.public_id,
    publicIdLabel: rotuloPublico(linha.public_id),
    brand: linha.brand,
    model: linha.model,
    saleStatus: linha.sale_status,
    status: linha.status,
    workshopName: linha.workshop_name,
    workshopCompanyName: linha.company_name,
    ordensAbertas: ordensAbertasDaPlaquinha(linha.id),
  };
}

/**
 * Outra plaquinha da MESMA empresa já usa este chassi?
 *
 * A REGRA MORA AQUI, no código, e não pendurada no índice. Os testes rodam
 * contra a DDL canônica pura (`resetDbForTests` só chama `ensureCoreSchema`), e
 * `ux_equipment_chassis` nasce na migração — regra que só existisse no índice
 * seria regra que nenhum teste alcança. O índice continua valendo como REDE
 * para o banco real, e o `catch` de UNIQUE lá embaixo traduz o que ela pegar.
 */
function chassiJaUsadoNaEmpresa(companyId: string, chassi: string, equipmentId: string): boolean {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_equipment
        WHERE company_id = ? AND chassis = ? AND id <> ? LIMIT 1`,
    )
    .get(companyId, chassi, equipmentId) as { id: string } | undefined;
  return Boolean(linha);
}

/** Traduz a colisão crua do SQLite para a linguagem de quem está no balcão. */
function traduzirUnique(err: unknown, lado: 'unidade' | 'plaquinha'): never {
  if (String(err).includes('UNIQUE')) {
    if (lado === 'plaquinha') {
      throw new ApiError(
        'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
        'Já existe outra plaquinha desta oficina com esse chassi. Confira o número digitado.',
        409,
      );
    }
    throw new ApiError(
      'CORE_UNIT_DUPLICATE_IDENTITY',
      'Já existe outra unidade com essa identidade nesta empresa. Confira o número digitado.',
      409,
    );
  }
  throw err;
}

/**
 * Adota a plaquinha da oficina para esta unidade de estoque.
 *
 * Dá escritor a `origin_company_id`, que existia no schema sem que nenhuma tela
 * jamais o enviasse. Sem escritor, era documentação de uma intenção que o
 * sistema nunca cumpriu; com escritor, é o campo que `plaquinhasVinculaveis` lê
 * para saber que esta plaquinha já foi adotada por uma empresa do grupo.
 *
 * ## `linked_product_id` NÃO É ESCRITO AQUI, e isso é uma decisão
 *
 * A primeira versão deste vínculo também gravava
 * `core_equipment.linked_product_id = unidade.product_id`. Um grep no projeto
 * inteiro devolvia só escritas, tipos e comentários: ZERO leituras. Escrever
 * campo que ninguém lê é o mesmo defeito que este arquivo existe para matar —
 * dado que afirma uma coisa e sistema que nunca a consulta —, só que ao
 * contrário.
 *
 * Dar leitor a ela seria pior que não ter: a tela já traz o produto pelo
 * caminho da UNIDADE (`listEquipment` faz `LEFT JOIN core_product_units u ON
 * u.equipment_id = e.id` e dali `JOIN core_products p ON p.id = u.product_id`),
 * e é o mesmo JOIN que responde `unitId`, `unitStatus` e `companyName`. O JOIN
 * não sai; a coluna não teria nada a acrescentar.
 *
 * E ela era PIOR que decorativa. A FK é `REFERENCES core_products(id)` sem
 * conferir empresa: o produto é da LOJA e a linha é da OFICINA, que é outra
 * empresa. A coluna guardava, portanto, um produto de empresa alheia numa linha
 * da oficina — e um leitor futuro que fizesse o JOIN natural filtrando pela
 * empresa do equipamento não acharia nada, e concluiria que o vínculo não
 * existe. Melhor a coluna vazia, que é honesta, do que preenchida com um valor
 * que só engana quem chegar depois.
 *
 * ## A identidade, e por que A UNIDADE MANDA
 *
 * Chassi, número do motor e número de série existem dos dois lados. Quando
 * divergem, o lado que vale é a UNIDADE, por dois motivos: é o lado corrigível
 * (`identifyUnit` existe, e traduz a colisão do índice único), e é o número que
 * sai no documento da venda — o `infAdProd` da nota, o DANFE, o DANFCE e o
 * cupom, pelo leitor de `IdentidadeDaUnidadeFiscal` (GAP-PRD-026).
 *
 * ## A válvula `confirmarPelaUnidade` é OBRIGATÓRIA
 *
 * O erro mais provável de todo o fluxo é o mecânico digitar um dígito errado na
 * bancada. Sem a válvula, esse erro vira beco sem saída: o vínculo é o único
 * caminho para consertar a plaquinha, e recusar o vínculo tira justamente o
 * conserto. A moto ficaria com plaquinha errada e sem forma de corrigi-la.
 *
 * Com a válvula, a correção é registrada em evento GUARDANDO OS DOIS VALORES —
 * o que estava e o que passou a estar. Sobrescrever calado seria trocar um
 * defeito por outro.
 */
export function vincularUnidade(input: {
  companyId: string;
  unitId: string;
  equipmentId: string;
  userId: string;
  /** A unidade manda: sobrescreve a identidade divergente da plaquinha. */
  confirmarPelaUnidade?: boolean;
}): PlaquinhaDaUnidade {
  ensureCoreSchema();
  // A leitura devolve lista vazia para quem não usa plaquinha; a ESCRITA diz
  // por quê. Sem o guarda aqui, bastava adivinhar um id de equipamento.
  exigirEmpresaComPlaquinha(input.companyId);
  return withTransaction(() => {
    const db = getConnection();
    const unidade = lerUnidade(input.companyId, input.unitId);

    if (unidade.status === 'baixada') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        'Esta unidade recebeu baixa e não está em estoque.',
        409,
      );
    }
    /*
      A MOTO VENDIDA SEM PLAQUINHA GANHA O VÍNCULO TARDIO (GAP-PRD-108).

      Antes, unidade vendida era recusada aqui ("não recebe plaquinha nova"), e a
      moto que saiu do pátio sem vínculo ficava assim para sempre: a plaquinha que
      a oficina montou continuava `NOT_SOLD`, sem dono, com o portal do comprador
      mudo, a garantia sem data de venda — e aparecendo nas candidatas de QUALQUER
      unidade nova. O único contorno era a "venda à mão" na oficina, que cria uma
      segunda verdade sem venda por trás.

      O vínculo tardio carimba na plaquinha O QUE A VENDA JÁ DISSE: o comprador
      (espelhado pelo CPF, como em `venderPelaUnidade`), a data da venda e o id
      dela. Três travas que o vínculo antes da venda não precisa:
        - a venda tem de ser VENDA (balcão ou loja online) e ter comprador com
          documento — sem isso não há dono para carimbar;
        - a plaquinha e a unidade têm de ter ao menos um número IGUAL (chassi,
          motor ou série): depois da venda, o que liga a plaquinha à moto é o
          número, e não a escolha de quem está na tela;
        - a identidade da UNIDADE não é mexida: ela já está no documento do
          cliente (`identifyUnit` recusa unidade vendida pelo mesmo motivo).
    */
    const venda = unidade.status === 'sold' ? vendaDaUnidade(input.companyId, unidade.id) : null;
    if (unidade.equipment_id) {
      throw new ApiError(
        'CORE_UNIT_ALREADY_LINKED',
        'Esta unidade já tem plaquinha. Desvincule a atual antes de trocar.',
        409,
      );
    }

    const plaquinha = lerPlaquinha(input.equipmentId);

    // As MESMAS regras de `plaquinhasVinculaveis`, repetidas aqui de propósito:
    // a lista é conveniência de tela, e tela não é autorização. Quem chama a
    // rota direto com um id qualquer bate nestas linhas.
    if (
      plaquinha.origin !== 'INTERNAL_PJ_MOTORS' ||
      plaquinha.sale_status !== 'NOT_SOLD' ||
      (plaquinha.origin_company_id && plaquinha.origin_company_id !== input.companyId)
    ) {
      throw new ApiError(
        'CORE_EQUIPMENT_NOT_LINKABLE',
        plaquinha.origin !== 'INTERNAL_PJ_MOTORS'
          ? 'Esta plaquinha é de um equipamento de cliente e não entra no estoque da loja.'
          : plaquinha.sale_status !== 'NOT_SOLD'
            ? 'Esta plaquinha já foi vendida e tem proprietário.'
            : 'Esta plaquinha já pertence ao estoque de outra empresa do grupo.',
        409,
      );
    }

    const outraUnidade = db
      .prepare('SELECT id FROM core_product_units WHERE equipment_id = ? AND id <> ? LIMIT 1')
      .get(plaquinha.id, unidade.id) as { id: string } | undefined;
    if (outraUnidade) {
      throw new ApiError(
        'CORE_EQUIPMENT_ALREADY_LINKED',
        'Esta plaquinha já pertence a outra unidade de estoque.',
        409,
      );
    }

    // A plaquinha com o número de uma moto VENDIDA sem plaquinha é daquela moto
    // (GAP-PRD-108) — a lista já a esconde; aqui é a recusa para quem chama a
    // rota direto. No vínculo tardio a própria moto vendida não conta.
    const daVendida = motoVendidaComAIdentidade(input.companyId, plaquinha, unidade.id);
    if (daVendida) {
      throw new ApiError(
        'CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT',
        `A plaquinha ${rotuloPublico(plaquinha.public_id)} tem o ${daVendida.campo} ${daVendida.valor}, ` +
          'de uma moto desta loja que já foi vendida sem plaquinha. Ela é daquela moto: vincule pela ' +
          'unidade vendida (Unidades › vendidas sem plaquinha), e o comprador vira o dono no portal.',
        409,
        { unitId: daVendida.unitId },
      );
    }

    // ------------------------------------------------------- reconciliação
    const paraUnidade: Record<string, string | null> = {};
    const paraPlaquinha: Record<string, string | null> = {};
    const correcoes: string[] = [];
    let numerosIguais = 0;

    for (const campo of CAMPOS_DE_IDENTIDADE) {
      const naUnidade = limpo(unidade[campo.unidade]);
      const naPlaquinha = limpo(plaquinha[campo.plaquinha]);

      if (!naUnidade && naPlaquinha) {
        // A unidade nasce sem identidade (a nota traz "3 motos" muito antes de
        // alguém ir ao pátio ler os chassis). A oficina já leu o número na
        // bancada: aproveitar é o caminho normal, não uma exceção.
        //
        // Na moto já VENDIDA, não: o número dela está no documento do cliente.
        if (!venda) paraUnidade[campo.unidade] = naPlaquinha;
        continue;
      }
      if (naUnidade && naPlaquinha && mesmaIdentidade(naUnidade, naPlaquinha)) numerosIguais += 1;
      if (naUnidade && !naPlaquinha) {
        // Plaquinha vazia não é divergência: é campo que ninguém preencheu.
        // Preencher com o número da unidade é o mesmo movimento, ao contrário.
        paraPlaquinha[campo.plaquinha] = naUnidade;
        continue;
      }
      if (!naUnidade || !naPlaquinha) continue;
      if (mesmaIdentidade(naUnidade, naPlaquinha)) continue;

      if (!input.confirmarPelaUnidade) {
        throw new ApiError(
          'CORE_UNIT_EQUIPMENT_IDENTITY_MISMATCH',
          `O ${campo.rotulo} da unidade e o da plaquinha ${rotuloPublico(plaquinha.public_id)} não batem. ` +
            'Confira qual está certo — confirmando pela unidade, a plaquinha é corrigida.',
          409,
          { campo: campo.rotulo, unidade: naUnidade, plaquinha: naPlaquinha },
        );
      }
      paraPlaquinha[campo.plaquinha] = naUnidade;
      correcoes.push(`${campo.rotulo} da plaquinha era ${naPlaquinha}, corrigido para ${naUnidade} no vínculo`);
    }

    // Depois da venda, o que liga a plaquinha à moto é o NÚMERO (GAP-PRD-108).
    if (venda && numerosIguais === 0) {
      throw new ApiError(
        'CORE_LATE_LINK_NEEDS_IDENTITY',
        `A moto já foi vendida: a plaquinha ${rotuloPublico(plaquinha.public_id)} só entra nela se as duas ` +
          'tiverem o mesmo chassi, número do motor ou número de série. Confira o número na moto e na ' +
          'ficha da plaquinha na oficina.',
        409,
      );
    }

    // O chassi é o número que identifica a moto na oficina inteira. Antes de
    // sobrescrever, confere na mão — ver `chassiJaUsadoNaEmpresa`.
    const chassiNovo = paraPlaquinha.chassis;
    if (chassiNovo && chassiJaUsadoNaEmpresa(plaquinha.company_id, chassiNovo, plaquinha.id)) {
      throw new ApiError(
        'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
        `Já existe outra plaquinha desta oficina com o chassi ${chassiNovo}. Confira o número digitado.`,
        409,
      );
    }

    const ts = agora();

    // --------------------------------------------------------- a escrita
    // Tudo na MESMA transação: unidade sem plaquinha do outro lado (ou o
    // contrário) é exatamente a divergência que este arquivo existe para
    // impedir, e um rollback pela metade a criaria de novo.
    const camposUnidade = Object.keys(paraUnidade);
    if (camposUnidade.length > 0) {
      const sets = camposUnidade.map((c) => `${c} = ?`).join(', ');
      try {
        db.prepare(
          `UPDATE core_product_units SET ${sets}, updated_at = ? WHERE id = ? AND company_id = ?`,
        ).run(...([...camposUnidade.map((c) => paraUnidade[c]), ts, unidade.id, input.companyId] as never[]));
      } catch (err) {
        traduzirUnique(err, 'unidade');
      }
    }

    db.prepare(
      'UPDATE core_product_units SET equipment_id = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(plaquinha.id, ts, unidade.id, input.companyId);

    // `origin_company_id` e SÓ ele: é o único campo desta escrita que tem
    // leitor (`plaquinhasVinculaveis`). Ver o cabeçalho desta função para por
    // que `linked_product_id` ficou de fora.
    const camposPlaquinha = Object.keys(paraPlaquinha);
    const setsPlaquinha = camposPlaquinha.map((c) => `${c} = ?`).join(', ');
    try {
      db.prepare(
        `UPDATE core_equipment
            SET origin_company_id = ?${setsPlaquinha ? `, ${setsPlaquinha}` : ''},
                updated_at = ?
          WHERE id = ?`,
      ).run(
        ...([
          input.companyId,
          ...camposPlaquinha.map((c) => paraPlaquinha[c]),
          ts,
          plaquinha.id,
        ] as never[]),
      );
    } catch (err) {
      traduzirUnique(err, 'plaquinha');
    }

    // O evento vive na empresa da OFICINA, que é onde o histórico da plaquinha
    // é lido. Guarda as correções por extenso: sem os dois valores, ninguém
    // consegue reconstituir o que foi sobrescrito.
    recordEquipmentEvent({
      equipmentId: plaquinha.id,
      companyId: plaquinha.company_id,
      eventType: 'stock_linked',
      description:
        (venda
          ? `Plaquinha vinculada à moto depois da venda (${venda.rotulo})`
          : 'Plaquinha vinculada à unidade de estoque da loja') +
        (correcoes.length > 0 ? ` — ${correcoes.join('; ')}` : ''),
      userId: input.userId,
    });

    /*
      O QUE A VENDA JÁ DISSE, CARIMBADO NA PLAQUINHA (GAP-PRD-108): o comprador
      espelhado pelo CPF na empresa da oficina, a data DA VENDA (a garantia conta
      dela, não do dia do vínculo) e o id da venda de balcão. O pedido online não
      é `core_sales`, e fica só no evento — como em `venderPelaUnidade`.
    */
    if (venda) {
      const comprador = venda.comprador;
      const espelho = findOrCreateCustomer(
        plaquinha.company_id,
        {
          name: comprador.name,
          document: comprador.document ?? undefined,
          email: comprador.email ?? undefined,
          phone: comprador.phone ?? undefined,
        },
        { matchBy: 'document' },
      );
      // `vendaDaUnidade` já exigiu o documento; sem espelho, o cadastro da
      // oficina recusou a pessoa, e carimbar SOLD sem dono é o que não se faz.
      if (!espelho) {
        throw new ApiError(
          'CORE_LATE_LINK_BUYER_WITHOUT_DOCUMENT',
          `Não foi possível reconhecer ${comprador.name} na oficina pelo CPF/CNPJ do cadastro. ` +
            'Confira o documento do cliente e vincule de novo.',
          409,
        );
      }
      db.prepare(
        `UPDATE core_equipment
            SET owner_customer_id = ?, sale_status = 'SOLD', sold_at = ?, sale_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(String(espelho.id), venda.data ?? ts, venda.saleId, ts, plaquinha.id);
      recordEquipmentEvent({
        equipmentId: plaquinha.id,
        companyId: plaquinha.company_id,
        eventType: 'sold',
        description:
          `Moto vendida (${venda.rotulo}${venda.data ? `, em ${venda.data.slice(0, 10)}` : ''}) e entregue a ` +
          `${comprador.name}. O vínculo com a plaquinha foi feito depois da venda.`,
        userId: input.userId,
      });
    }

    return plaquinhaDaUnidade(input.companyId, unidade.id)!;
  });
}

/**
 * A venda que tirou esta unidade do pátio, e quem comprou — para o vínculo
 * tardio (GAP-PRD-108). Recusa o que não é venda com comprador de documento:
 * sem ele não há dono para carimbar, e carimbar `SOLD` sem dono esconderia o
 * defeito que o vínculo existe para consertar.
 */
function vendaDaUnidade(
  companyId: string,
  unitId: string,
): { rotulo: string; data: string | null; saleId: string | null; comprador: ClienteDaLoja } {
  const db = getConnection();
  const saida = db
    .prepare('SELECT exit_reference_type, exit_reference_id FROM core_product_units WHERE id = ? AND company_id = ?')
    .get(unitId, companyId) as { exit_reference_type: string | null; exit_reference_id: string | null } | undefined;
  const tipo = saida?.exit_reference_type ?? '';
  const id = saida?.exit_reference_id ?? '';
  const referencia = REFERENCIAS_QUE_DAO_DONO.has(tipo) && id ? clienteDaReferencia(companyId, tipo, id) : null;
  if (!referencia) {
    throw new ApiError(
      'CORE_UNIT_NOT_AVAILABLE',
      'Esta unidade saiu do estoque sem uma venda que diga quem a comprou, e não recebe plaquinha.',
      409,
    );
  }
  if (!referencia.cliente) {
    throw new ApiError(
      'CORE_LATE_LINK_WITHOUT_BUYER',
      `A ${referencia.rotulo} desta moto não tem cliente: sem comprador não há dono para a plaquinha. ` +
        'Registre o cliente na venda antes de vincular.',
      409,
    );
  }
  if (!somenteDigitos(referencia.cliente.document)) {
    throw new ApiError(
      'CORE_LATE_LINK_BUYER_WITHOUT_DOCUMENT',
      `${referencia.cliente.name} não tem CPF ou CNPJ no cadastro — é por ele que a oficina reconhece o ` +
        'dono no portal. Complete o cadastro do cliente e vincule de novo.',
      409,
    );
  }
  const documento = (
    tipo === 'ecommerce_order'
      ? db.prepare('SELECT number, created_at FROM core_orders WHERE id = ? AND company_id = ?').get(id, companyId)
      : db.prepare('SELECT number, created_at FROM core_sales WHERE id = ? AND company_id = ?').get(id, companyId)
  ) as { number: number; created_at: string } | undefined;
  return {
    rotulo:
      tipo === 'ecommerce_order'
        ? `pedido online nº ${documento?.number ?? '?'}`
        : `venda nº ${documento?.number ?? '?'}`,
    data: documento?.created_at ?? null,
    saleId: tipo === 'sale' ? id : null,
    comprador: referencia.cliente,
  };
}

/**
 * A moto VENDIDA SEM PLAQUINHA desta empresa que tem um número igual ao da
 * plaquinha — a mesma pergunta de `SQL_E_DE_MOTO_VENDIDA`, com a resposta
 * nomeada para a recusa.
 */
function motoVendidaComAIdentidade(
  companyId: string,
  plaquinha: LinhaPlaquinha,
  excetoUnitId: string,
): { unitId: string; campo: string; valor: string } | null {
  for (const campo of CAMPOS_DE_IDENTIDADE) {
    const valor = limpo(plaquinha[campo.plaquinha]);
    if (!valor) continue;
    const linha = getConnection()
      .prepare(
        `SELECT id FROM core_product_units
          WHERE company_id = ? AND status = 'sold' AND equipment_id IS NULL AND id <> ?
            AND ${campo.unidade} IS NOT NULL AND UPPER(TRIM(${campo.unidade})) = UPPER(TRIM(?))
          LIMIT 1`,
      )
      .get(companyId, excetoUnitId, valor) as { id: string } | undefined;
    if (linha) return { unitId: linha.id, campo: campo.rotulo, valor };
  }
  return null;
}

/**
 * Desfaz o vínculo.
 *
 * Existe para que plaquinha errada tenha conserto: sem isto, vincular a moto
 * errada seria definitivo, e o único jeito de corrigir passaria a ser criar uma
 * segunda unidade — que é como o estoque dobra.
 *
 * Só enquanto nada saiu: unidade em estoque e plaquinha ainda não vendida.
 * Depois da venda o vínculo é o que sustenta o portal do dono, e desfazê-lo
 * apagaria o caminho entre a pessoa e a moto dela.
 */
export function desvincularUnidade(input: {
  companyId: string;
  unitId: string;
  userId: string;
}): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const unidade = lerUnidade(input.companyId, input.unitId);
    if (!unidade.equipment_id) {
      throw new ApiError('CORE_UNIT_NOT_LINKED', 'Esta unidade não tem plaquinha vinculada.', 409);
    }
    // A MENSAGEM TEM DE DESCREVER O ESTADO CERTO.
    //
    // Uma frase só falava de VENDA, e a unidade baixada caía nela: o operador
    // recebia "consta na venda" para uma moto que nunca foi vendida, e saía
    // procurar no sistema uma venda que não existe. Mensagem que descreve o
    // estado errado é pior que nenhuma — ela manda a pessoa para o lugar errado
    // com confiança.
    //
    // Na baixa o vínculo já foi desfeito por `baixarPelaUnidade`, na mesma
    // transação da saída. Se ainda houver plaquinha aqui, é linha antiga, de
    // antes daquele conserto: a frase diz o que aconteceu de fato, e não inventa
    // uma venda.
    if (unidade.status !== 'in_stock') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        unidade.status === 'sold'
          ? 'Esta unidade já foi vendida: a plaquinha dela consta na venda e não se desfaz aqui.'
          : 'Esta unidade recebeu baixa e saiu do estoque: o vínculo com a plaquinha se desfaz na própria baixa, não por aqui.',
        409,
      );
    }

    const plaquinha = lerPlaquinha(unidade.equipment_id);
    if (plaquinha.sale_status !== 'NOT_SOLD') {
      throw new ApiError(
        'CORE_EQUIPMENT_NOT_LINKABLE',
        'Esta plaquinha já foi vendida e tem proprietário. O vínculo não se desfaz.',
        409,
      );
    }

    const ts = agora();
    db.prepare(
      'UPDATE core_product_units SET equipment_id = NULL, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(ts, unidade.id, input.companyId);

    // Limpa o campo que o vínculo escreveu. Deixar `origin_company_id`
    // preenchido faria a plaquinha sumir da lista de candidatas de TODAS as
    // empresas, inclusive da que acabou de soltá-la.
    //
    // O UPDATE continua existindo por causa DELE. `linked_product_id` também
    // era limpo aqui, e saiu junto com a escrita: limpeza de campo que ninguém
    // escreve é trabalho que só serve para fazer parecer que o campo importa.
    db.prepare(
      `UPDATE core_equipment
          SET origin_company_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(ts, plaquinha.id);

    recordEquipmentEvent({
      equipmentId: plaquinha.id,
      companyId: plaquinha.company_id,
      eventType: 'stock_unlinked',
      description: 'Vínculo com a unidade de estoque da loja desfeito',
      userId: input.userId,
    });
  });
}

/** As unidades desta lista que têm plaquinha, com a plaquinha já carregada. */
function unidadesComPlaquinha(
  companyId: string,
  unitIds: string[],
): { unidade: LinhaUnidade; plaquinha: LinhaPlaquinha }[] {
  if (unitIds.length === 0) return [];
  const db = getConnection();
  const saida: { unidade: LinhaUnidade; plaquinha: LinhaPlaquinha }[] = [];
  for (const id of unitIds) {
    const unidade = db
      .prepare(
        `SELECT id, company_id, product_id, status, chassis, motor_number, serial_number, equipment_id
           FROM core_product_units WHERE id = ? AND company_id = ?`,
      )
      .get(id, companyId) as LinhaUnidade | undefined;
    // Unidade inexistente NÃO é assunto daqui: `assertUnitsSellable` já recusa
    // isso com a mensagem certa, e duplicar a recusa só mudaria o código de
    // erro que o balcão vê.
    if (!unidade?.equipment_id) continue;
    saida.push({ unidade, plaquinha: lerPlaquinha(unidade.equipment_id) });
  }
  return saida;
}

/**
 * As recusas que precisam rodar ANTES de baixar o estoque.
 *
 * Antes, e não durante: depois que `applyMovement` escreveu o saldo, recusar
 * significa desfazer — e o caminho de desfazer é justamente o que esta rodada
 * descobriu não existir para a plaquinha.
 *
 * É chamada em TODA saída de unidade serializada, mas só recusa a VENDA DE
 * BALCÃO: as três regras falam de cliente, de documento do comprador e de
 * entregar a moto, e nenhuma dessas coisas existe numa baixa ou numa
 * transferência. As duas saídas antecipadas lá dentro — o canal online e o que
 * não é venda — são cada uma um bloco de comentário explicando por quê.
 */
export function assertUnidadesComPlaquinhaVendiveis(input: {
  companyId: string;
  unitIds: string[];
  referenceType: string;
  referenceId: string;
}): void {
  ensureCoreSchema();
  const pares = unidadesComPlaquinha(input.companyId, input.unitIds);
  if (pares.length === 0) return;

  // NENHUMA RECUSA VALE PARA O CANAL ONLINE. A saída é aqui, antes do laço.
  //
  // Toda recusa deste arquivo roda dentro de `applyMovement`, e no caminho
  // online `applyMovement` é chamado por `consumeReservation`, que roda dentro
  // de `handlePaymentWebhook` — DEPOIS de o dinheiro ser capturado. O webhook
  // não abre transação e já gravou o próprio registro e a intent antes de
  // chamar `markOrderPaid`. Um 409 aqui deixa o pedido em
  // `aguardando_pagamento` para sempre: a re-entrega do provedor bate no dedupe
  // do topo e responde 200 sem processar. Dinheiro capturado, pedido travado,
  // reserva presa — e sem ninguém para consertar, porque não há balcão do outro
  // lado. Pior ainda: quem escolheu a moto vinculada foi o `pickUnitsFifo`, não
  // o comprador.
  //
  // As recusas abaixo continuam valendo para o BALCÃO, e é lá que elas fazem
  // sentido: a venda ainda não fechou, o operador está na frente da tela, e
  // informar o cliente ou concluir a OS é trabalho de um minuto.
  //
  // O que o canal online perde em recusa, ele ganha em REGISTRO: `venderPelaUnidade`
  // grava evento na plaquinha quando o dono não pode ser estabelecido e quando a
  // moto saiu vendida estando na bancada.
  if (input.referenceType === 'ecommerce_order') return;

  /*
    E NENHUMA RECUSA VALE PARA O QUE NÃO É VENDA. Segunda saída, pelo motivo
    oposto ao da primeira.

    Esta função roda em TODA saída de estoque de unidade serializada (`delta < 0`
    em `applyMovement`), e não só na venda: baixa, transferência entre locais,
    acerto de contagem, saída manual. As três recusas abaixo falam de VENDA — de
    cliente, de documento do comprador, de "entregar a moto" — porque foi para a
    venda que foram escritas.

    Aplicadas a uma baixa, elas MENTIAM. Baixar uma moto acidentada que está
    desmontada na bancada devolvia `CORE_SALE_EQUIPMENT_IN_WORKSHOP` e a frase
    "Conclua o serviço antes de entregar a moto" — falando de uma entrega a um
    cliente que não existe, numa operação que não tem comprador nenhum. É o MESMO
    defeito de mensagem falsa que esta rodada consertou em `desvincularUnidade`
    duzentas linhas acima, e vale aqui a mesma sentença: mensagem que descreve o
    estado errado é pior que nenhuma — ela manda a pessoa para o lugar errado com
    confiança.

    ## POR QUE LIBERAR, e não trocar a frase por outra recusa

    Trocar o texto consertaria a mentira e deixaria de pé uma recusa que não se
    sustenta. Cada caso:

    BAIXA (`unit_write_off`) — a baixa existe para registrar que a moto ACABOU:
    perdida, roubada, batida, devolvida ao fornecedor. Recusá-la porque há OS
    aberta é exigir que se conclua o serviço de uma moto que não existe mais para
    ser consertada. E a exigência seria muitas vezes IMPOSSÍVEL de cumprir: a OS
    de montagem interna com peças não tem caminho para `finalizada` — ver a regra
    3 e o cabeçalho do arquivo —, então a moto batida ficaria presa no estoque
    para sempre, inflando o saldo com uma moto que virou sucata. Criar beco sem
    saída é justamente o que a válvula `confirmarPelaUnidade` existe para não
    fazer.

    Nada fica solto: `baixarPelaUnidade` roda na MESMA transação da saída, desfaz
    o vínculo, e a plaquinha continua na oficina com todo o histórico de montagem,
    `NOT_SOLD`, sem dono e adotável de novo. A OS segue aberta na oficina, que é
    de quem ela é. E o evento `stock_written_off` nomeia a OS por extenso, para
    que a bancada saiba que a moto que ela tem desmontada saiu do estoque da loja.

    TRANSFERÊNCIA (`transferencia`) — é troca de PRATELEIRA dentro da mesma
    empresa (`transferStock`, duas pernas `out`/`in` com a mesma referência). A
    unidade não sai do estoque: volta na perna de entrada com outro
    `location_id`, o vínculo com a plaquinha nem é tocado, e nenhum dono é
    inventado. Não há fato nenhum sobre o qual recusar — e a recusa seria
    perversa, porque o lugar certo de uma moto desmontada é justamente o local da
    oficina, e era para lá que a transferência estava levando.

    O QUE SOBRA — `inventory_count`, `service_order`, `manual` e o que vier —
    liberam pelo mesmo motivo que as duas: nenhuma delas entrega a moto a alguém,
    e é a entrega que a regra 3 protege.

    A recusa continua inteira onde ela significa alguma coisa: no BALCÃO, com a
    venda ainda aberta, o operador na frente da tela e um cliente de carne e osso
    esperando para levar a moto embora.
  */
  if (input.referenceType !== 'sale') return;

  const db = getConnection();

  for (const { plaquinha } of pares) {
    const venda = db
      .prepare('SELECT customer_id FROM core_sales WHERE id = ? AND company_id = ?')
      .get(input.referenceId, input.companyId) as { customer_id: string | null } | undefined;

    // 1. Sem cliente na venda não há a quem entregar a plaquinha. A moto
    //    sairia do estoque e o equipamento continuaria órfão.
    if (!venda?.customer_id) {
      throw new ApiError(
        'CORE_SALE_EQUIPMENT_WITHOUT_CUSTOMER',
        `A ${rotuloPublico(plaquinha.public_id)} tem plaquinha de oficina: informe o cliente na venda ` +
          'para que ele receba o histórico da moto no portal.',
        409,
      );
    }

    const cliente = db
      .prepare('SELECT id, document FROM core_customers WHERE id = ? AND company_id = ?')
      .get(venda.customer_id, input.companyId) as
      | { id: string; document: string | null }
      | undefined;

    // 2. Sem documento não há ESPELHO confiável.
    //
    //    A oficina é outra empresa, e o dono precisa existir como cliente DELA
    //    para que a OS possa ser aberta e o portal liste as ordens. O espelho é
    //    criado por `findOrCreateCustomer` com `matchBy: 'document'` — é o
    //    mesmo critério que `syncLinks` usa para unir os cadastros das várias
    //    empresas na mesma conta de portal.
    //
    //    Sem documento o espelho NÃO É CRIADO, e o portal ficaria mudo justo
    //    para quem acabou de comprar.
    //
    //    A conferência é por DÍGITOS, e não por texto não-vazio: é assim que o
    //    cadastro guarda o documento (ver `somenteDigitos`). Medindo texto,
    //    "ISENTO" passava por esta guarda e virava `document` NULL do outro
    //    lado — a venda seguia, o espelho nascia sem identidade e `syncLinks`
    //    nunca unia nada. Guarda que mede uma coisa e escrita que grava outra
    //    é guarda que não guarda.
    if (!somenteDigitos(cliente?.document)) {
      throw new ApiError(
        'CORE_SALE_EQUIPMENT_CUSTOMER_WITHOUT_DOCUMENT',
        `Para levar a plaquinha ${rotuloPublico(plaquinha.public_id)} junto, o cliente precisa de CPF ou CNPJ ` +
          'no cadastro — é por ele que a oficina reconhece o dono no portal.',
        409,
      );
    }

    // 3. A MOTO ESTÁ DESMONTADA NA BANCADA — E ALGUÉM VEIO BUSCÁ-LA.
    //
    //    O que esta regra protege é a ENTREGA, e é por isso que ela vive aqui
    //    dentro, depois da saída antecipada que deixa passar tudo que não é
    //    venda: só na venda existe uma pessoa esperando para levar a moto
    //    embora, e só nela "conclua o serviço antes de entregar" é uma frase
    //    verdadeira. Ver o bloco daquela saída para por que baixa e
    //    transferência liberam.
    //
    //    A recusa olha SÓ os quatro estados de `OS_MOTO_DESMONTADA`.
    //    `aguardando_pagamento` e `finalizada` LIBERAM a venda, e isso não é
    //    frouxidão:
    //
    //    A OS de montagem interna com peças NÃO TEM CAMINHO para `finalizada`.
    //    `closeOrder` recusa encerrar sem custo quando `total_cents > 0`
    //    (`CORE_HAS_PARTS_COST`), e com custo grava `aguardando_pagamento`. A
    //    única saída de lá é `settleOrder`, que EXIGE `saleId` — e ninguém vai
    //    emitir uma venda para cobrar a loja por montar a própria moto. A OS
    //    fica presa em `aguardando_pagamento` para sempre.
    //
    //    Recusar "OS != finalizada" tornaria INVENDÁVEL toda moto que passou
    //    pela bancada. Nos dois estados liberados a moto está inteira, que é o
    //    que de fato importa para entregá-la.
    //
    //    A dívida — dar um caminho de encerramento à OS de montagem interna —
    //    fica FORA DE ESCOPO desta rodada, e fica nomeada aqui em vez de
    //    escondida atrás de uma regra que parece mais rígida do que é.
    const ordem = ordemDeBancadaAberta(plaquinha.id);
    if (ordem) {
      throw new ApiError(
        'CORE_SALE_EQUIPMENT_IN_WORKSHOP',
        `A ${rotuloPublico(plaquinha.public_id)} está na bancada: a OS nº ${ordem.number} ainda está em andamento. ` +
          'Conclua o serviço antes de entregar a moto.',
        409,
        { ordem: ordem.number, situacao: ordem.status },
      );
    }
  }
}

interface ClienteDaLoja {
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Quem comprou, lido no documento certo para cada canal.
 *
 * O mesmo fato — alguém comprou a moto — mora em duas tabelas: `core_sales` no
 * balcão e `core_orders` na loja online. Ler a tabela conforme a referência é o
 * que permite os dois canais carimbarem a plaquinha sem que um saiba do outro.
 *
 * Devolve `null` quando o próprio documento não existe naquela empresa. `cliente`
 * nulo com `rotulo` preenchido é outra coisa, e é um caso real do online: o
 * pedido existe e não tem cliente vinculado. Separar os dois é o que permite ao
 * evento dizer QUAL das duas faltas aconteceu.
 *
 * As duas consultas são escritas por extenso, e não com o nome da tabela
 * interpolado: SQL montado com pedaço de variável é o começo de todo acidente,
 * mesmo quando hoje o pedaço vem de um `if`.
 */
function clienteDaReferencia(
  companyId: string,
  referenceType: string,
  referenceId: string,
): { rotulo: string; cliente: ClienteDaLoja | null } | null {
  const db = getConnection();

  // Sem inicializador de propósito: os dois ramos do `if` abaixo ou retornam ou
  // atribuem antes de qualquer leitura, então o `= null` era um valor que nunca
  // chegava a ser lido — e o compilador confere isso melhor que a leitura humana.
  let customerId: string | null;
  let rotulo: string;

  if (referenceType === 'ecommerce_order') {
    const pedido = db
      .prepare('SELECT customer_id, number FROM core_orders WHERE id = ? AND company_id = ?')
      .get(referenceId, companyId) as { customer_id: string | null; number: number } | undefined;
    if (!pedido) return null;
    customerId = pedido.customer_id;
    rotulo = `pedido nº ${pedido.number}`;
  } else {
    const venda = db
      .prepare('SELECT customer_id FROM core_sales WHERE id = ? AND company_id = ?')
      .get(referenceId, companyId) as { customer_id: string | null } | undefined;
    if (!venda) return null;
    customerId = venda.customer_id;
    rotulo = 'venda de balcão';
  }

  if (!customerId) return { rotulo, cliente: null };

  const cliente = db
    .prepare('SELECT name, document, email, phone FROM core_customers WHERE id = ? AND company_id = ?')
    .get(customerId, companyId) as ClienteDaLoja | undefined;
  return { rotulo, cliente: cliente ?? null };
}

/**
 * A venda atravessando para a plaquinha. Chamado de dentro de `applyMovement`,
 * na MESMA transação — sem isso, o saldo baixaria e a plaquinha continuaria
 * `NOT_SOLD` se qualquer coisa falhasse no meio.
 *
 * ## A travessia do cliente, e por que é um ESPELHO e não um ponteiro
 *
 * O comprador é cliente da LOJA. A plaquinha vive na OFICINA, que é outra
 * empresa. Gravar `owner_customer_id` apontando para o cadastro da loja
 * deixaria o portal mudo de duas formas ao mesmo tempo: converter um chamado em
 * OS daria 404 `CORE_CUSTOMER_NOT_FOUND` (`resolveVinculos` busca o cliente com
 * o `company_id` da oficina), e a listagem de ordens do portal filtra por
 * `customer_id` da oficina.
 *
 * Por isso o cliente é ESPELHADO na empresa da oficina. Uma pessoa tem uma
 * linha por empresa, unidas pelo DOCUMENTO — é o padrão que já existe:
 * `findOrCreateCustomer` com `matchBy: 'document'` casa por documento dentro de
 * uma empresa, e `syncLinks` casa os cadastros ENTRE empresas pelo mesmo
 * documento, ligando todos à mesma conta de portal. O espelho não inventa nada:
 * entra no trilho que já corria.
 *
 * ## Por que o espelho casa SÓ POR DOCUMENTO
 *
 * `findOrCreateCustomer` sem opção cai para e-mail quando não acha o documento,
 * e AINDA grava `document = COALESCE(document, ?)` no que casou. Espelhando
 * entre empresas isso é sequestro de cadastro alheio: basta o cadastro do
 * comprador na loja carregar o e-mail de outra pessoa — coisa que um balcão faz
 * sem querer — e existir na oficina um cliente antigo, sem CPF, com aquele
 * e-mail. O espelho casaria com ELE: `owner_customer_id` apontando para a outra
 * pessoa, que passa a ver a moto e o histórico no portal, e o CPF do comprador
 * carimbado no cadastro dela.
 *
 * É o MESMO vazamento que a rodada 17 consertou em `syncLinks`
 * (`CustomerPortalService.ts`), e o critério aqui é o mesmo pelo mesmo motivo:
 * quem é a mesma pessoa em duas empresas tem o mesmo DOCUMENTO, e e-mail
 * sozinho não identifica ninguém.
 *
 * ## Os DOIS canais, e por que o online nunca é recusado
 *
 * `sale` é o balcão e lê `core_sales.customer_id`; `ecommerce_order` é a loja
 * online e lê `core_orders.customer_id`. O online chega aqui dentro do webhook
 * de pagamento, DEPOIS de o dinheiro ser capturado — ver o cabeçalho do arquivo
 * e a saída antecipada de `assertUnidadesComPlaquinhaVendiveis`. Por isso, do
 * lado de cá, o que falta vira EVENTO e nunca exceção: a moto FOI vendida, isso
 * é fato, e o que ficou desconhecido é quem é o dono para efeito de portal.
 */
export function venderPelaUnidade(input: {
  companyId: string;
  unitIds: string[];
  referenceType: string;
  referenceId: string;
  userId: string | null;
}): void {
  ensureCoreSchema();

  // Só VENDA dá dono. Baixa, transferência e consumo tiram a moto do estoque
  // sem que exista comprador — carimbar `SOLD` ali inventaria um proprietário
  // que ninguém pode nomear. Ver `REFERENCIAS_QUE_DAO_DONO`.
  if (!REFERENCIAS_QUE_DAO_DONO.has(input.referenceType)) return;
  const online = input.referenceType === 'ecommerce_order';

  const db = getConnection();
  const pares = unidadesComPlaquinha(input.companyId, input.unitIds);

  for (const { plaquinha } of pares) {
    // Decide por ESTADO: plaquinha que já tem dono não é re-vendida por um
    // movimento repetido.
    if (plaquinha.sale_status !== 'NOT_SOLD') continue;

    const referencia = clienteDaReferencia(input.companyId, input.referenceType, input.referenceId);
    const comprador = referencia?.cliente ?? null;
    const documento = somenteDigitos(comprador?.document);

    // NO BALCÃO, faltar cliente ou documento é impossível aqui: as regras 1 e 2
    // de `assertUnidadesComPlaquinhaVendiveis` já recusaram a venda inteira
    // antes de o saldo se mexer. Se ainda assim faltar, a plaquinha fica como
    // estava — carimbar `SOLD` sem dono no balcão esconderia um defeito que lá
    // tem quem conserte, e o operador ainda está na frente da tela.
    if (!online && !documento) continue;

    const espelho = comprador
      ? findOrCreateCustomer(
          plaquinha.company_id,
          {
            name: comprador.name,
            document: comprador.document ?? undefined,
            email: comprador.email ?? undefined,
            phone: comprador.phone ?? undefined,
          },
          { matchBy: 'document' },
        )
      : null;

    const ts = agora();
    db.prepare(
      `UPDATE core_equipment
          SET owner_customer_id = ?, sale_status = 'SOLD', sold_at = ?, sale_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      espelho ? String(espelho.id) : null,
      ts,
      // `sale_id` REFERENCIA `core_sales`. O pedido da loja online NÃO é uma
      // venda de balcão — e no momento do webhook ainda não existe linha em
      // `core_sales` para ele. Gravar o id do pedido aqui estouraria a FOREIGN
      // KEY e, se não estourasse, seria uma afirmação falsa. O rastro do pedido
      // fica no evento abaixo, que é onde ele pode ser dito por extenso.
      online ? null : input.referenceId,
      ts,
      plaquinha.id,
    );

    recordEquipmentEvent({
      equipmentId: plaquinha.id,
      companyId: plaquinha.company_id,
      eventType: 'sold',
      description: online
        ? `Moto vendida pela loja online (${referencia?.rotulo ?? 'pedido ' + input.referenceId})` +
          (comprador ? ` e entregue a ${comprador.name}` : '')
        : `Moto vendida no balcão e entregue a ${comprador?.name ?? 'cliente da venda'}`,
      userId: input.userId,
    });

    // A MEIA-VERDADE REGISTRADA, no lugar da divergência silenciosa.
    //
    // Só acontece online, porque só lá a venda segue sem documento. A moto FOI
    // vendida — isso é fato, e é o que `sale_status = 'SOLD'` afirma. Quem é o
    // dono para efeito de portal é que ficou desconhecido, e o histórico diz
    // isso com todas as letras em vez de deixar `owner_customer_id` nulo sem
    // explicação, que é o que faz alguém, meses depois, achar que houve bug.
    if (!espelho) {
      recordEquipmentEvent({
        equipmentId: plaquinha.id,
        companyId: plaquinha.company_id,
        eventType: 'owner_unknown',
        description:
          'Dono não pôde ser estabelecido nesta venda online: ' +
          (comprador
            ? 'o comprador do pedido não tem CPF/CNPJ no cadastro'
            : 'o pedido não tem cliente vinculado') +
          '. O espelho na oficina une as pessoas pelo DOCUMENTO, e sem ele não há como afirmar de quem é a moto. ' +
          'Informe o documento do comprador e registre o proprietário para que ele veja a moto no portal.',
        userId: input.userId,
      });
    }

    // SAIU VENDIDA ESTANDO NA BANCADA.
    //
    // Só se pergunta no online: no balcão a regra 3 do assert já recusou a
    // venda inteira antes de chegar aqui, e um evento com este texto ali seria
    // uma afirmação que o código não pode fazer. Online a recusa é impossível —
    // ela rodaria depois do dinheiro entrar —, então fica o registro com o
    // número da OS, que é o que a oficina precisa para ir atrás da moto: ela
    // está desmontada lá dentro e já tem dono do lado de fora.
    const ordem = online ? ordemDeBancadaAberta(plaquinha.id) : undefined;
    if (ordem) {
      recordEquipmentEvent({
        equipmentId: plaquinha.id,
        companyId: plaquinha.company_id,
        eventType: 'sold_in_workshop',
        description:
          `Moto saiu vendida pela loja online enquanto estava na bancada: a OS nº ${ordem.number} ` +
          `está ${ordem.status}. A venda não foi recusada porque o pagamento já havia sido capturado — ` +
          'conclua o serviço antes de entregar.',
        userId: input.userId,
      });
    }
  }
}

/**
 * A BAIXA SOLTA A PLAQUINHA. Chamada de dentro de `applyMovement`, na mesma
 * transação da saída.
 *
 * ## O defeito que ela existe para matar
 *
 * `POST /units/:id/write-off` baixa a unidade — perda, quebra, devolução ao
 * fornecedor — e a unidade fica `baixada` com `equipment_id` ainda apontando
 * para a plaquinha. Nada desfazia esse vínculo, e o resultado era uma plaquinha
 * CONGELADA: `plaquinhasVinculaveis` exclui toda plaquinha que tenha unidade
 * apontando para ela, então a moto sumia da lista de adotáveis para sempre; e
 * `desvincularUnidade` recusava soltá-la, porque a unidade não está mais
 * `in_stock`. A única saída era mexer no banco à mão.
 *
 * A baixa é o oposto da venda, e por isso a escrita é o oposto: a venda AMARRA
 * (dono, `sold_at`, `sale_id`), a baixa SOLTA. A moto saiu do estoque sem
 * comprador; a plaquinha continua existindo na oficina, com todo o histórico de
 * montagem, e volta a ser adotável por uma unidade nova — que é exatamente o que
 * acontece de verdade quando a moto some do pátio e depois aparece.
 *
 * ## Decide por ESTADO, como `devolverPelaUnidade`
 *
 * Só age em plaquinha `NOT_SOLD`. Plaquinha vendida tem dono, e o vínculo é o
 * que sustenta o portal dele: soltar ali apagaria o caminho entre a pessoa e a
 * moto dela. Perguntando ao banco em vez de confiar no chamador, uma baixa que
 * envolva unidade sem plaquinha, ou com plaquinha já vendida, simplesmente não
 * faz nada — em vez de derrubar a baixa inteira.
 *
 * A referência entra no registro E na decisão: as referências que DÃO DONO
 * ficam de fora, porque lá quem manda é `venderPelaUnidade`. Chamar as duas na
 * mesma saída não pode desamarrar o que a venda acabou de amarrar.
 */
export function baixarPelaUnidade(input: {
  companyId: string;
  unitIds: string[];
  referenceType: string;
  userId: string | null;
}): void {
  ensureCoreSchema();
  if (REFERENCIAS_QUE_DAO_DONO.has(input.referenceType)) return;

  const db = getConnection();

  for (const { unidade, plaquinha } of unidadesComPlaquinha(input.companyId, input.unitIds)) {
    if (plaquinha.sale_status !== 'NOT_SOLD') continue;

    const ts = agora();
    db.prepare(
      'UPDATE core_product_units SET equipment_id = NULL, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(ts, unidade.id, input.companyId);

    // O MESMO campo que `desvincularUnidade` limpa, pelo mesmo motivo:
    // `origin_company_id` preenchido faria a plaquinha sumir da lista de
    // candidatas de TODAS as empresas, inclusive da que acabou de soltá-la.
    db.prepare(
      `UPDATE core_equipment
          SET origin_company_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(ts, plaquinha.id);

    // A BAIXA DA MOTO QUE ESTÁ NA BANCADA É LIBERADA, ENTÃO ELA FICA REGISTRADA.
    //
    // `assertUnidadesComPlaquinhaVendiveis` não recusa baixa — a moto batida
    // precisa poder sair do estoque, e a OS de montagem interna pode nunca ter
    // caminho para `finalizada`. Mas liberar calado seria a divergência
    // silenciosa que este arquivo combate: a bancada continuaria com a moto
    // desmontada e uma OS aberta, sem saber que do lado da loja aquela moto
    // deixou de existir. O número da OS vai no texto porque é por ele que a
    // oficina acha o serviço que agora não tem mais moto.
    const ordem = ordemDeBancadaAberta(plaquinha.id);

    recordEquipmentEvent({
      equipmentId: plaquinha.id,
      companyId: plaquinha.company_id,
      eventType: 'stock_written_off',
      description:
        `Unidade de estoque da loja recebeu baixa (${input.referenceType}) e o vínculo foi desfeito. ` +
        'Não houve venda: a plaquinha continua sem proprietário e volta a poder ser vinculada a outra unidade.' +
        (ordem
          ? ` A moto estava na bancada: a OS nº ${ordem.number} está ${ordem.status} e continua aberta — ` +
            'a baixa não foi recusada porque a moto saiu do estoque sem ir para cliente nenhum.'
          : ''),
      userId: input.userId,
    });
  }
}

/**
 * O espelho da venda, no caminho de volta.
 *
 * Decide por ESTADO, e não por parâmetro: quem chama é o estorno genérico de
 * estoque, que não sabe se aquela unidade chegou a ter dono. Perguntando ao
 * banco, a devolução de uma unidade que nunca foi vendida simplesmente não faz
 * nada — em vez de errar e derrubar o estorno inteiro por causa de uma moto que
 * nem plaquinha tinha.
 */
export function devolverPelaUnidade(input: {
  companyId: string;
  unitIds: string[];
  userId: string | null;
}): void {
  ensureCoreSchema();
  const db = getConnection();

  for (const { plaquinha } of unidadesComPlaquinha(input.companyId, input.unitIds)) {
    if (plaquinha.sale_status !== 'SOLD') continue;

    db.prepare(
      `UPDATE core_equipment
          SET owner_customer_id = NULL, sale_status = 'NOT_SOLD', sold_at = NULL,
              sale_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(agora(), plaquinha.id);

    // O evento fica: o histórico da plaquinha registra que houve dono e que ele
    // deixou de ser. Apagar a passagem seria mentir sobre a moto.
    recordEquipmentEvent({
      equipmentId: plaquinha.id,
      companyId: plaquinha.company_id,
      eventType: 'sale_reverted',
      description: 'Venda desfeita: a moto voltou ao estoque da loja e a plaquinha ficou sem proprietário',
      userId: input.userId,
    });
  }
}

/**
 * A plaquinha precisa levar a algum lugar.
 *
 * A oficina imprime a plaquinha com QR, cola no equipamento e o cliente
 * escaneia — e até agora não encontrava nada: a rota `/equipamento/<token>` só
 * existia no roteador legado, inalcançável, e não havia endpoint público para
 * resolver o token. A funcionalidade inteira terminava num link morto.
 *
 * O QUE ESTA VISÃO MOSTRA, E O QUE ELA NUNCA MOSTRA
 *
 * A plaquinha fica EXPOSTA no equipamento, no pátio, na calçada. Quem passa
 * pode escanear. Então o token identifica o aparelho e mais nada:
 *
 *   MOSTRA    o que é o equipamento (marca, modelo, cor), o número público, se
 *             está em serviço, e o andamento — as etapas por que passou.
 *   NUNCA     nome, telefone ou documento do dono; custo, preço de peça ou
 *             valor de serviço; diagnóstico interno; nome do mecânico.
 *
 * Já havia teste cobrando que o QR não carregue dado do dono. Esta visão é o
 * outro lado do mesmo cuidado: não basta o QR ser opaco se a página que ele
 * abre despeja tudo.
 *
 * A MOTO DO ESTOQUE DA PJ MOTORS TAMBÉM (P0 das plaquinhas)
 *
 * O adesivo que a PJ gera e cola na moto do pátio (`core_equipment_tags` com
 * `unit_id`, ver `PlaquinhaDaPjNaUnidade.ts`) não tem máquina — e esta visão
 * só conhecia o token de máquina: o QR da PJ respondia 404 para sempre. Agora,
 * quando o token não é de máquina, ele é procurado entre as plaquinhas da PJ
 * coladas numa unidade. A mesma visão mínima: marca e modelo do produto, o
 * número e a loja. NUNCA id de unidade, de plaquinha ou de produto, chassi,
 * preço ou custo.
 *
 * E o 404 é UM SÓ: plaquinha gerada, livre ou danificada, token inventado,
 * unidade baixada e plaquinha fora da PJ Motors respondem exatamente igual —
 * quem tenta adivinhar não distingue um token real de um aleatório.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { formatTagId } from './EquipmentTagPoolService.js';
import { ehEmpresaDasPlaquinhas } from './EmpresaDasPlaquinhas.js';

export interface PublicEquipmentView {
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  category: string | null;
  workshopName: string | null;
  /** Nome fantasia de quem está atendendo — é ele que o cliente procura. */
  companyName: string;
  inService: boolean;
  status: string | null;
  /** Só o que o cliente pode ler: etapa e quando. Sem autor e sem valor. */
  timeline: { step: string; at: string }[];
  /**
   * De onde o token veio: a máquina (plaquinha da Oficina, com OS e portal do
   * dono) ou a unidade de estoque da PJ Motors (adesivo do lote, sem máquina —
   * a página não oferece portal, porque não há ficha de dono para abrir).
   */
  origem: 'equipamento' | 'unidade';
}

/**
 * Rótulos que o cliente entende, no lugar do estado interno da OS.
 *
 * ## Uma chave para cada estado que existe, e nenhuma a mais
 *
 * As chaves são exatamente os `ORDER_STATUSES`. Havia duas sobrando —
 * `aguardando_aprovacao` e `parada_setor` — do vocabulário anterior à
 * unificação. A primeira ainda aparecia em eventos antigos do banco da loja e
 * por isso "funcionava"; a segunda nunca existiu em lugar nenhum. Depois que a
 * migração passou a traduzir também a tabela de eventos, as duas viraram
 * chaves para estados que não podem mais chegar aqui.
 *
 * ## E faltava a mais útil de todas
 *
 * `aguardando_pagamento` não estava na lista. Estado sem rótulo SOME da linha
 * do tempo — a regra existe para o nome interno nunca vazar — então o momento
 * em que o aparelho fica PRONTO era justamente o invisível: o cliente
 * escaneava o QR e continuava lendo "Em serviço" enquanto a moto esperava por
 * ele no balcão.
 *
 * O rótulo fala do que interessa ao dono (pode buscar), não do que interessa
 * ao caixa (falta receber).
 */
export const ETAPA_PUBLICA: Record<string, string> = {
  em_aberto: 'Recebido pela oficina',
  em_andamento: 'Em serviço',
  aguardando_peca: 'Aguardando peça',
  manutencao_externa: 'Em manutenção externa',
  // "Parada no setor" (rodada 51) é jargão interno — para o dono da moto o
  // serviço segue na oficina, então o rótulo público é o mesmo de "em
  // serviço": a supressão de etapa repetida logo abaixo evita linha dupla.
  parada_setor: 'Em serviço',
  aguardando_pagamento: 'Pronto para retirada',
  finalizada: 'Serviço concluído',
};

/**
 * O formato do número é do POOL — uma conta só no sistema inteiro.
 *
 * Esta era a segunda de três cópias (rodada 53).
 */
function formatPublicId(n: unknown): string {
  return formatTagId(Number(n ?? 0));
}

/**
 * Resolve o token opaco.
 *
 * Devolve `null` para token desconhecido — e a rota responde 404 igual para
 * token inválido e para equipamento inexistente. Distinguir os dois diria a
 * quem está tentando adivinhar que ele chegou perto.
 */
export function publicEquipmentByToken(token: string): PublicEquipmentView | null {
  ensureCoreSchema();
  const alvo = String(token ?? '').trim();
  if (!alvo) return null;

  const db = getConnection();
  const equipamento = db
    .prepare(
      `SELECT e.id, e.public_id, e.brand, e.model, e.color, e.category,
              w.name AS workshop_name, c.trade_name AS company_name
         FROM core_equipment e
         LEFT JOIN core_workshops w ON w.id = e.workshop_id AND w.company_id = e.company_id
         JOIN core_companies c ON c.id = e.company_id
        WHERE e.public_token = ?`,
    )
    .get(alvo) as
    | {
        id: string;
        public_id: number;
        brand: string | null;
        model: string | null;
        color: string | null;
        category: string | null;
        workshop_name: string | null;
        company_name: string;
      }
    | undefined;
  if (!equipamento) return plaquinhaDaPjNaUnidade(alvo);

  // A OS mais recente é a que interessa: é o serviço que está acontecendo.
  const os = db
    .prepare(
      `SELECT id, status, created_at FROM core_service_orders
        WHERE equipment_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(equipamento.id) as { id: string; status: string; created_at: string } | undefined;

  const timeline: { step: string; at: string }[] = [];
  if (os) {
    const eventos = db
      .prepare(
        `SELECT to_status, created_at FROM core_service_order_events
          WHERE order_id = ? ORDER BY created_at`,
      )
      .all(os.id) as unknown as { to_status: string; created_at: string }[];

    timeline.push({ step: ETAPA_PUBLICA.em_aberto, at: os.created_at });
    for (const ev of eventos) {
      const rotulo = ETAPA_PUBLICA[ev.to_status];
      // Estado sem rótulo público NÃO vaza o nome interno: some da linha.
      if (!rotulo) continue;
      // Etapa repetida em seguida não vira linha nova. A OS nasce em aberto e
      // o primeiro evento costuma registrar o mesmo estado — para dentro isso
      // é histórico, para o cliente é "Recebido pela oficina" duas vezes, e ele
      // fica procurando a diferença entre as duas.
      if (timeline[timeline.length - 1]?.step === rotulo) continue;
      timeline.push({ step: rotulo, at: ev.created_at });
    }
  }

  return {
    publicIdLabel: formatPublicId(equipamento.public_id),
    brand: equipamento.brand,
    model: equipamento.model,
    color: equipamento.color,
    category: equipamento.category,
    workshopName: equipamento.workshop_name,
    companyName: equipamento.company_name,
    inService: Boolean(os && os.status !== 'finalizada'),
    status: os ? (ETAPA_PUBLICA[os.status] ?? 'Em atendimento') : null,
    timeline,
    origem: 'equipamento',
  };
}

/**
 * O token que não é de máquina: o adesivo da PJ Motors colado numa unidade do
 * estoque dela (P0 das plaquinhas).
 *
 * ## O defeito
 *
 * A PJ gera, imprime e libera o lote — e o QR do adesivo colado na moto do
 * pátio abria "Equipamento não encontrado", porque só `core_equipment` era
 * consultado e a PJ não tem máquina (não tem bancada). A plaquinha era papel
 * sem destino.
 *
 * ## As três portas, todas no mesmo 404
 *
 *   - só `associada` e sem máquina: a plaquinha gerada, livre ou danificada
 *     (o adesivo trocado) não abre nada — o QR velho morre na troca;
 *   - só a PJ Motors (`ehEmpresaDasPlaquinhas` pelo slug): um banco antigo com
 *     plaquinha de outra empresa colada à força não reabre a página. A marca
 *     `uses_equipment_tags` NÃO é consultada: adesivo já colado continua
 *     respondendo mesmo com a marca desligada, como na regra da empresa;
 *   - só unidade em estoque ou vendida: a baixada saiu sem venda (perda,
 *     quebra, devolução ao fornecedor) e o QR dela deixa de abrir.
 *
 * Não escreve nada. A venda desfeita (a unidade volta a `in_stock`) volta a
 * dizer "Disponível na loja" sozinha.
 */
function plaquinhaDaPjNaUnidade(token: string): PublicEquipmentView | null {
  const linha = getConnection()
    .prepare(
      `SELECT t.public_id, u.status AS unit_status, p.name, p.brand, p.category,
              c.trade_name, c.slug
         FROM core_equipment_tags t
         JOIN core_companies c ON c.id = t.company_id
         JOIN core_product_units u ON u.id = t.unit_id AND u.company_id = t.company_id
         JOIN core_products p ON p.id = u.product_id AND p.company_id = u.company_id
        WHERE t.public_token = ? AND t.status = 'associada' AND t.equipment_id IS NULL`,
    )
    .get(token) as
    | {
        public_id: number;
        unit_status: string;
        name: string | null;
        brand: string | null;
        category: string | null;
        trade_name: string;
        slug: string;
      }
    | undefined;
  if (!linha) return null;
  if (!ehEmpresaDasPlaquinhas(linha.slug)) return null;
  if (linha.unit_status !== 'in_stock' && linha.unit_status !== 'sold') return null;

  return {
    publicIdLabel: formatPublicId(linha.public_id),
    brand: linha.brand,
    model: linha.name,
    color: null,
    category: linha.category,
    workshopName: null,
    companyName: linha.trade_name,
    inService: false,
    // Na moto do pátio o que interessa a quem escaneia é que ela está à venda;
    // vendida, a página não inventa andamento nenhum.
    status: linha.unit_status === 'in_stock' ? 'Disponível na loja' : null,
    timeline: [],
    origem: 'unidade',
  };
}

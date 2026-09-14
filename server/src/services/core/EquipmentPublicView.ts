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
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { formatTagId } from './EquipmentTagPoolService.js';

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
  if (!equipamento) return null;

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
  };
}

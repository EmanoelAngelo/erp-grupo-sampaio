/**
 * O que cada oficina faz — e o que ela NÃO faz.
 *
 * As duas oficinas do grupo trabalham diferente, e tratá-las igual obriga as
 * duas a conviver com tela que não serve para nenhuma:
 *
 *   MOBILIDADE (Oficina)      moto, bike e patinete ficam na oficina por dias.
 *                             O equipamento precisa de PLAQUINHA: é por ela que
 *                             se acha o aparelho no meio do pátio e é por ela
 *                             que o cliente consulta o andamento.
 *
 *   CELULARES (Preço Justo)   o aparelho entra e sai, muitas vezes no mesmo
 *                             dia, e vai para uma gaveta identificada pela
 *                             própria OS. Plaquinha com QR colada em celular
 *                             de cliente não faz sentido — e oferecer o botão
 *                             ensina a usar o que não se usa.
 *
 * As duas têm kanban e estoque de peças: é o trabalho comum de bancada.
 *
 * A regra mora AQUI, num lugar só, e não espalhada em `if` de tela. Espalhada,
 * a próxima oficina do grupo entraria com metade das regras aplicadas.
 */

export type WorkshopKind = 'mobility' | 'phones';

export interface WorkshopCapabilities {
  /** Quadro de ordens de serviço. As duas têm. */
  kanban: boolean;
  /**
   * Estoque de peças da bancada. As duas têm — e quem não estiver descrito
   * acima NÃO tem: esta capacidade decide se um produto pode virar peça da
   * bancada, e peça é saldo.
   */
  parts: boolean;
  /** Plaquinha com QR no equipamento. Só onde o aparelho fica. */
  equipmentTags: boolean;
}

const POR_TIPO: Record<string, WorkshopCapabilities> = {
  mobility: { kanban: true, parts: true, equipmentTags: true },
  phones: { kanban: true, parts: true, equipmentTags: false },
};

/**
 * Tipo desconhecido: não se libera por omissão o que consome de terceiros.
 *
 * O comentário acima sempre disse isto, e a linha dizia o contrário para
 * `parts` — a bancada de um `kind` que ninguém descreveu ganhava estoque de
 * peças de brinde. Enquanto `parts` só acendia uma aba de tela, o engano era
 * barato; a partir do momento em que `ProductKindService` passou a LER esta
 * capacidade para decidir se um produto pode virar peça daquela bancada, ele
 * passou a valer saldo: a peça ficaria apontada para uma bancada que não tem
 * onde guardá-la nem quem a requisite, e a recusa
 * `CORE_WORKSHOP_WITHOUT_PARTS` — que existe justamente para esse caso — nunca
 * chegava a disparar em bancada nenhuma.
 *
 * O `kind` desconhecido não é hipótese: é o estado de qualquer bancada nova
 * cadastrada antes de alguém escrever a capacidade dela aqui, e é o que sobra
 * de uma migração em que o campo chegou escrito errado.
 *
 * `kanban` continua liberado, e a diferença é de natureza: o quadro de ordens é
 * o trabalho PRÓPRIO da bancada, e uma oficina sem ele não é oficina — negá-lo
 * por omissão fecharia a tela principal de quem acabou de ser cadastrado. As
 * outras duas capacidades mexem em coisa alheia: `parts` consome o saldo de
 * estoque da empresa, e `equipmentTags` imprime plaquinha no aparelho do
 * cliente. Essas ficam apagadas até alguém escrever a linha aqui em cima.
 */
export function capabilitiesFor(kind: string | null | undefined): WorkshopCapabilities {
  return POR_TIPO[String(kind ?? '')] ?? { kanban: true, parts: false, equipmentTags: false };
}

export const CAPABILITY_LABEL: Record<keyof WorkshopCapabilities, string> = {
  kanban: 'Ordens de serviço',
  parts: 'Estoque de peças',
  equipmentTags: 'Plaquinha do equipamento',
};

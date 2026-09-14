/**
 * Vendas em espera (F7) — o carrinho que fica parado enquanto outro cliente é
 * atendido.
 *
 * O QUE HAVIA ANTES
 *
 * O botão "Aguardar (F7)" mostrava a mensagem "Venda em espera." e não fazia
 * nada: o carrinho seguia na tela, e nenhuma espera existia. Uma mensagem que
 * afirma um fato que não aconteceu é pior do que botão nenhum — o operador
 * confia, atende o próximo cliente e descobre depois que perdeu o carrinho.
 *
 * ESPERA NÃO É PRÉ-VENDA
 *
 * A pré-venda (F9) é um documento: existe no servidor, reserva estoque e
 * sobrevive ao turno. A espera é o oposto — é o carrinho parado por dois
 * minutos porque o cliente esqueceu a carteira no carro. Ela NÃO reserva
 * estoque, e não deve: segurar saldo por causa de um carrinho que talvez nem
 * vire venda tiraria peça da prateleira de quem está pronto para pagar.
 *
 * POR QUE FICA NO NAVEGADOR, E POR QUE ATRELADA AO TURNO
 *
 * Fica no `localStorage` para sobreviver a um F5 ou a uma queda de energia do
 * monitor — perder o carrinho por causa disso é o defeito que a espera existe
 * para evitar. E é atrelada à sessão de caixa: espera de ontem, com preço e
 * estoque de ontem, não deve reaparecer amanhã como se fosse válida.
 *
 * E O QUE PRECISA CRUZAR TERMINAIS? (GAP-V59)
 *
 * Continua não sendo isto aqui — e agora a tela oferece o caminho certo ao
 * lado, em vez de deixar o operador descobrir sozinho que a espera é local.
 *
 * O carrinho que precisa sobreviver ao TERMINAL (caixa 1 guarda, caixa 2
 * retoma; a máquina é formatada e o carrinho continua lá) é guardado como
 * ORÇAMENTO pelo botão "Guardar no servidor" do PDV. Não nasceu tabela nova
 * para isso, e a razão é o custo de uma terceira ideia de "carrinho guardado":
 * já existiriam a espera local, a pré-venda e mais esta, com três telas para
 * listar, três estados para reconciliar e três caminhos para faturar.
 *
 * O orçamento é o documento certo porque tem exatamente as propriedades que
 * faltavam aqui e nenhuma que atrapalhe: vive no servidor, é numerado, cruza
 * terminais, é retomado pelo mesmo F9 que o balcão já usa — e NÃO RESERVA
 * ESTOQUE. A pré-venda seria a escolha errada: ela reserva, e segurar saldo
 * por um carrinho que talvez nem vire venda tira peça da prateleira de quem
 * está pronto para pagar. É a mesma razão pela qual a espera local nunca
 * reservou nada.
 *
 * Os dois convivem porque custam coisas diferentes: o F7 é instantâneo e não
 * fala com a rede — é o cliente que esqueceu a carteira no carro. O outro custa
 * uma ida ao servidor e ganha um número.
 */
import type { CartLine, ItemRemovidoDoCarrinho } from './pdvTypes';

const CHAVE = 'gs.pdv.emEspera';

export interface VendaEmEspera {
  id: string;
  /** Sessão de caixa dona da espera. Sem caixa aberto, o terminal. */
  escopo: string;
  rotulo: string;
  criadoEm: string;
  lines: CartLine[];
  customerId: string | null;
  customerName: string | null;
  discount: number;
  note: string;
  /**
   * O RASTRO DE CANCELADOS DESTE CARRINHO (D-pdv-teclado-M05).
   *
   * A espera guardava só as linhas e o rastro ficava na tela: retomar a espera
   * B por cima do carrinho A mandava para o Finalizar de B o item que saiu de
   * A — e o de A se perdia. Pior, era um contorno do GAP-V52 com dois cliques:
   * remove o item, F7, retoma, e o rastro sumiu. O rastro é do carrinho, então
   * viaja com ele. Ausente nas esperas gravadas antes desta rodada: lê vazio.
   */
  removidos?: ItemRemovidoDoCarrinho[];
}

/**
 * ONDE ESTE CARRINHO FICA GUARDADO.
 *
 * Com caixa aberto, o dono é a sessão — e sessão é única por empresa, então o
 * cerco vem de graça. Sem caixa aberto era a constante literal `'sem-caixa'`:
 * as SEIS empresas do grupo gravavam na mesma chave do mesmo `localStorage`
 * da mesma máquina, e o carrinho em espera da Gringa aparecia no PDV da Me
 * Mimei. Desde que a tela de abertura passou a subir sozinha, "sem caixa" é
 * exatamente como o dia começa.
 *
 * A regra mora aqui, junto da espera, e não numa expressão solta na tela: é
 * aqui que se pergunta de quem é o carrinho.
 */
export function escopoDaEspera(
  cashSessionId: string | null | undefined,
  companyId: string | null | undefined,
): string {
  if (cashSessionId) return cashSessionId;
  return `sem-caixa:${companyId ?? 'sem-empresa'}`;
}

function ler(): VendaEmEspera[] {
  try {
    const bruto = localStorage.getItem(CHAVE);
    if (!bruto) return [];
    const lista = JSON.parse(bruto) as VendaEmEspera[];
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

function gravar(lista: VendaEmEspera[]): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(lista));
  } catch {
    // Sem armazenamento a espera vale só nesta aba. Melhor do que impedir a
    // operação por causa de um recurso de conveniência.
  }
}

/** As esperas do turno corrente. As de outros escopos ficam guardadas. */
export function listar(escopo: string): VendaEmEspera[] {
  return ler().filter((v) => v.escopo === escopo);
}

/**
 * Põe o carrinho em espera.
 *
 * Recusa carrinho vazio: "esperar" nada confundiria a contagem na tela e
 * encheria a lista de itens sem conteúdo.
 */
export function guardar(input: {
  escopo: string;
  lines: CartLine[];
  customerId: string | null;
  customerName: string | null;
  discount: number;
  note: string;
  removidos?: ItemRemovidoDoCarrinho[];
}): VendaEmEspera | null {
  if (input.lines.length === 0) return null;

  const itens = input.lines.reduce((acc, l) => acc + l.quantity, 0);
  const venda: VendaEmEspera = {
    id: `espera-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    escopo: input.escopo,
    rotulo:
      input.customerName
      ?? `${itens} item(ns) · ${new Date().toLocaleTimeString('pt-BR', { timeStyle: 'short' })}`,
    criadoEm: new Date().toISOString(),
    lines: input.lines,
    customerId: input.customerId,
    customerName: input.customerName,
    discount: input.discount,
    note: input.note,
    removidos: input.removidos ?? [],
  };

  gravar([...ler(), venda]);
  return venda;
}

/**
 * Retoma uma espera e a REMOVE da lista.
 *
 * Remover na retomada é o que impede o mesmo carrinho de ser faturado duas
 * vezes: quem retoma passa a ser dono dele na tela.
 */
export function retomar(id: string): VendaEmEspera | null {
  const lista = ler();
  const venda = lista.find((v) => v.id === id) ?? null;
  if (!venda) return null;
  gravar(lista.filter((v) => v.id !== id));
  /*
    A MARCA DE PREÇO NÃO SOBREVIVE À ESPERA (G-offline-sync-07, reauditoria).

    O DEFEITO: as linhas voltavam com `precificadaPara`/`precificadaQtd` de
    quando foram guardadas — a marca que diz "este preço já é o do servidor para
    este cliente e esta quantidade". Retomada para o mesmo cliente, a marca
    batia: se a pergunta de preço da retomada falhasse (sem rede, servidor
    lento), nada mais via a linha como pendente. A faixa dizia "o Finalizar
    confere", mas o Finalizar (`precoDoCarrinhoEmDia`) só pergunta linha
    pendente: a espera das 13h50 era cobrada às 14h10 pelo preço velho, e o
    servidor lançava a diferença como concessão do operador ("preço de tela
    desatualizado"), com diálogo de liberação acima da alçada — sem ninguém ter
    digitado preço.

    O preço de uma espera é de OUTRA hora: ele volta sem marca, e quem retoma
    pergunta o de agora. O valor combinado (`precoDigitado` e
    `precoNegociadoCents`) continua: é dele que a reprecificação tira o teto.
  */
  return { ...venda, lines: venda.lines.map((l) => ({ ...l, precificadaPara: undefined })) };
}

export function descartar(id: string): void {
  gravar(ler().filter((v) => v.id !== id));
}

/** Limpa as esperas de um turno encerrado. */
export function limparEscopo(escopo: string): void {
  gravar(ler().filter((v) => v.escopo !== escopo));
}

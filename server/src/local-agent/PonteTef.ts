/**
 * O CONTRATO ENTRE O AGENTE LOCAL E O CLIENTE TEF (GAP-PRD-014).
 *
 * O agente não fala com adquirente nenhuma: quem fala é o cliente TEF
 * instalado no computador do caixa (o gerenciador da rede/TEF house), que
 * comanda o PinPad e é homologado junto à adquirente. A "ponte" é o
 * pedaço do agente que conversa com esse cliente. Hoje existe a ponte pelo
 * protocolo de TROCA DE ARQUIVOS (`PonteTefDial`, o padrão "TEF Discado /
 * Gerenciador Padrão"), que é o modo de integração que a maioria dos
 * gerenciadores oferece a automações comerciais.
 *
 * Outra ponte (uma DLL de cliente TEF, por exemplo) implementa esta mesma
 * interface — o resto do agente não muda.
 */

export interface SaudeDaPonte {
  /** `ok` quando o gerenciador respondeu à verificação agora. */
  tefClient: 'ok' | 'unavailable';
  pinpad: string | null;
  bridge: string;
  message: string | null;
}

export interface EtapaDaCobranca {
  stage: 'awaiting_customer' | 'processing';
  message?: string;
}

export interface PedidoDeCobranca {
  /** Identificação única e numérica da operação no cliente TEF. */
  referencia: string;
  /** Número do documento (a referência curta que o servidor manda). */
  documento: string;
  valorEmCentavos: number;
  metodo: 'credit' | 'debit' | 'pix';
  parcelas: number;
}

/** O que o cliente TEF precisa para confirmar (CNF) ou desfazer (NCN) uma transação. */
export interface DadosDeConfirmacao {
  rede: string;
  nsu: string;
  finalizacao: string;
  referencia: string;
}

export interface ResultadoDaPonte {
  status: 'approved' | 'declined' | 'cancelled' | 'failed' | 'uncertain';
  message?: string | null;
  nsu?: string | null;
  authorizationCode?: string | null;
  maskedCard?: string | null;
  cardBrand?: string | null;
  acquirer?: string | null;
  merchantReceipt?: string | null;
  customerReceipt?: string | null;
  providerTransactionId?: string | null;
  /** O cliente TEF está em modo de treinamento: nada é dinheiro. */
  simulated?: boolean;
  /** Data e hora da transação no cliente TEF (DDMMAAAA e HHMMSS), para cancelar depois. */
  data?: string | null;
  hora?: string | null;
  /** Presente quando o cliente TEF espera a confirmação desta transação. */
  confirmacao?: DadosDeConfirmacao | null;
}

export interface PedidoDeCancelamento {
  referencia: string;
  valorEmCentavos: number;
  valorOriginalEmCentavos: number;
  rede: string | null;
  nsu: string | null;
  data: string | null;
  hora: string | null;
}

export interface PonteTef {
  readonly nome: string;
  saude(): Promise<SaudeDaPonte>;
  cobrar(pedido: PedidoDeCobranca, aoAndar?: (etapa: EtapaDaCobranca) => void): Promise<ResultadoDaPonte>;
  cancelar(pedido: PedidoDeCancelamento): Promise<ResultadoDaPonte>;
  consultar(referencia: string): Promise<ResultadoDaPonte>;
  confirmar(dados: DadosDeConfirmacao): Promise<void>;
  desfazer(dados: DadosDeConfirmacao): Promise<void>;
}

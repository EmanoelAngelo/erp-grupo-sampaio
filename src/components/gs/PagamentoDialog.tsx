/**
 * Fechamento da venda no balcão.
 *
 * Duas telas modais que o operador enxerga como uma só etapa:
 *
 *   PagamentoDialog          divide o valor entre meios de pagamento, mostra
 *                            o que falta e calcula o troco.
 *   AutorizacaoGerenteDialog pede a credencial de quem tem alçada quando o
 *                            desconto passa do limite do operador.
 *
 * Regras que valem aqui e no servidor (a tela é só a primeira barreira; quem
 * decide é a API):
 *   - a soma dos pagamentos nunca pode ser menor que o total;
 *   - troco só existe sobre o que foi recebido em dinheiro;
 *   - a senha do gestor não é guardada, nem em estado que sobreviva ao modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estaNoTopo, prenderFoco } from './armadilhaDeFoco';
import { Button } from './ui';
import { contar, formatCents, parseReaisToCents } from './format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type PaymentMethodOption,
  type TerminalPayment,
  type TerminalState,
} from '@/lib/api/core';
import { pendenciasDaMaquininhaApi } from '@/lib/api/maquininhas';
import { uuid } from '@/lib/uuid';
import { pixBalcaoApi, type PixDoBalcao, type StatusDoPixDoBalcao } from '@/lib/api/pixBalcao';
import { PixDoBalcaoPainel } from './PixDoBalcaoPainel';

/**
 * Meios aceitos no balcão — vindos do SERVIDOR.
 *
 * Esta lista era literal aqui, e o servidor nunca a lia: `method` chegava como
 * string livre e qualquer coisa entrava no banco. Agora quem declara é
 * `server/src/services/core/PaymentMethods.ts`, que é quem grava e quem sabe o
 * comportamento de cada meio.
 *
 * O valor abaixo é só o PONTO DE PARTIDA enquanto a resposta não chega: sem
 * ele o diálogo abriria sem nenhum botão e o caixa acharia que travou. Ele é
 * substituído assim que o servidor responde, e o servidor tem a palavra final
 * de qualquer jeito — método recusado por lá não fecha venda.
 */
const MEIOS_ENQUANTO_CARREGA: PaymentMethodOption[] = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];

export interface PaymentLine {
  method: string;
  amountCents: number;
  /**
   * A cobrança da maquininha que autorizou esta linha (GAP-V48).
   *
   * Só existe quando o valor passou pelo aparelho. O servidor exige este
   * campo nas linhas de cartão quando há maquininha integrada — sem ele, uma
   * venda no crédito fecharia sem que cobrança nenhuma tivesse acontecido.
   */
  providerRef?: string;
  /**
   * O PIX do balcão gerado pelo provedor de cobrança (GAP-PRD-077). O servidor
   * confere a cobrança e decide o status da linha pelo que o PROVEDOR disse.
   */
  paymentIntentId?: string;
  /** Pendente: o PIX foi gerado e o cliente vai pagar depois (GAP-PRD-077). */
  status?: 'settled' | 'pending';
}

/**
 * O VALOR DIGITADO AQUI É EM REAIS — como em todo o resto do PDV.
 *
 * Era `text.replace(/D/g, '')` tratado como CENTAVOS: "50" virava R$ 0,50.
 * No mesmo balcão, na mesma venda, o campo de preço da linha usa
 * `parseReaisToCents` — "50" ali é R$ 50,00. Dois campos vizinhos com regras
 * opostas é erro de digitação garantido, e o erro sai em dinheiro.
 */
function parseCents(text: string): number {
  return parseReaisToCents(text) ?? 0;
}

/**
 * A lista corrente, em nível de módulo.
 *
 * `methodLabel` e `isCash` são usados fora do componente e não enxergam estado
 * de React. Guardar aqui é o que permite que a resposta do servidor valha para
 * os dois — e o pior caso, se a resposta não vier, é o rótulo cair no próprio
 * código do método, que continua legível.
 */
let metodosAtuais: PaymentMethodOption[] = MEIOS_ENQUANTO_CARREGA;

function methodLabel(code: string): string {
  return metodosAtuais.find((m) => m.code === code)?.label ?? code;
}

function isCash(code: string): boolean {
  return metodosAtuais.find((m) => m.code === code)?.cash ?? false;
}

/** Ordem em que o operador vê a cobrança andar. */
const STATE_STEPS: TerminalState[] = [
  'aguardando_terminal',
  'aguardando_cliente',
  'processando',
  'aprovado',
];

const STATE_LABEL: Record<TerminalState, string> = {
  aguardando_terminal: 'AGUARDANDO TERMINAL',
  aguardando_cliente: 'AGUARDANDO CLIENTE',
  processando: 'PROCESSANDO',
  aprovado: 'APROVADO',
  recusado: 'RECUSADO',
  cancelado: 'CANCELADO',
  timeout_nao_confirmado: 'STATUS NÃO CONFIRMADO',
  erro: 'ERRO',
};

/**
 * Andamento da cobrança na maquininha.
 *
 * Mostrar o caminho inteiro importa: sem isso o operador fica olhando uma tela
 * parada sem saber se pode pedir o cartão, se já passou, ou se travou.
 */
function TerminalProgress({ payment }: { payment: TerminalPayment }) {
  const falhou = !STATE_STEPS.includes(payment.state);
  const atual = STATE_STEPS.indexOf(payment.state);

  const tom = payment.settled
    ? 'var(--gs-success)'
    : payment.needsReconciliation
      ? 'var(--gs-warning)'
      : falhou
        ? 'var(--gs-danger)'
        : 'var(--gs-purple-700)';

  return (
    <div className="flex flex-col gap-3 p-4 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)]">
      <div className="flex items-center gap-2 flex-wrap">
        {STATE_STEPS.map((step, i) => (
          <span key={step} className="flex items-center gap-2">
            <span
              className="px-3 py-1 rounded-full text-[length:var(--gs-text-xs)] font-bold tracking-wide"
              style={{
                background:
                  !falhou && i <= atual ? 'var(--gs-purple-700)' : 'var(--gs-surface)',
                color: !falhou && i <= atual ? '#fff' : 'var(--gs-text-soft)',
                border: '1px solid var(--gs-border)',
              }}
            >
              {STATE_LABEL[step]}
            </span>
            {i < STATE_STEPS.length - 1 && (
              <span aria-hidden className="text-[var(--gs-text-soft)]">
                →
              </span>
            )}
          </span>
        ))}
      </div>

      <p role="status" className="font-bold" style={{ color: tom }}>
        {STATE_LABEL[payment.state]}
      </p>
      <p className="text-[length:var(--gs-text-sm)]">{payment.message}</p>

      {payment.maskedCard && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Cartão {payment.maskedCard}
          {payment.authorizationCode ? ` · autorização ${payment.authorizationCode}` : ''}
        </p>
      )}

      {payment.simulated && (
        <p className="text-[length:var(--gs-text-xs)] font-semibold text-[var(--gs-warning)]">
          Resposta simulada — sem maquininha física homologada, isto não é uma cobrança real.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ shell do modal

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  /*
    O ESC É DO DIÁLOGO DE CIMA (PED-pdv-05).

    O ouvinte fechava ESTE diálogo com qualquer Esc da janela, mesmo com outra
    tela por cima dele (a autorização do gestor, a pergunta de sair): o Esc
    que o operador deu para fechar a de cima fechava as duas. E o
    `stopPropagation` não segurava os outros ouvintes da própria janela — o
    Esc seguia para quem estivesse registrado ao lado. Agora só age quem está no
    topo da pilha de diálogos, e a tecla para ali.
  */
  const raizRef = useRef<HTMLDivElement | null>(null);
  const prender = useCallback((el: HTMLDivElement | null) => {
    raizRef.current = el;
    return prenderFoco(el);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!estaNoTopo(raizRef.current)) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prender}
      tabIndex={-1}
      aria-label={title}
    >
      <div className="w-full max-w-2xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">{title}</h2>
        </header>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------- autorização gerente

export function AutorizacaoGerenteDialog({
  motivo,
  onConfirm,
  onCancel,
  busy,
  error,
  justificativa,
}: {
  motivo: string;
  /** O terceiro argumento é o motivo digitado — vazio quando o campo não aparece. */
  onConfirm: (login: string, password: string, justificativa: string) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  /**
   * PEDE O PORQUÊ DA LIBERAÇÃO (P0 da Preço Justo) — só a liberação de desconto
   * passa isto.
   *
   * O DEFEITO: o diálogo pedia usuário e senha e mais nada. O que ficava na
   * trilha como "motivo" era a frase que a tela montava com os números, e o dono
   * lendo a auditoria via QUANTO e QUEM, nunca POR QUÊ. `obrigatorio` trava o
   * botão enquanto o campo está vazio; o servidor confere de novo, e é ele
   * quem decide.
   */
  justificativa?: { obrigatorio: boolean };
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [porque, setPorque] = useState('');
  const loginRef = useRef<HTMLInputElement>(null);
  const faltaOPorque = justificativa?.obrigatorio === true && porque.trim().length < 3;

  useEffect(() => {
    loginRef.current?.focus();
  }, []);

  // A senha não fica em memória depois que o modal sai de cena.
  useEffect(() => () => setPassword(''), []);

  return (
    <Modal title="Autorização do gestor" onClose={onCancel}>
      <form
        className="px-6 py-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(login, password, porque.trim());
        }}
      >
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{motivo}</p>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Usuário do gestor
          </span>
          <input
            ref={loginRef}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="off"
            className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
              text-[length:var(--gs-text-base)] outline-none focus:border-[var(--gs-focus-ring)]"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Senha
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
              text-[length:var(--gs-text-base)] outline-none focus:border-[var(--gs-focus-ring)]"
          />
        </label>

        {justificativa && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Motivo da liberação{justificativa.obrigatorio ? ' (obrigatório)' : ''}
            </span>
            <input
              aria-label="Motivo da liberação"
              value={porque}
              maxLength={500}
              onChange={(e) => setPorque(e.target.value)}
              autoComplete="off"
              placeholder="Ex.: cliente fiel, compra de atacado"
              className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                text-[length:var(--gs-text-base)] outline-none focus:border-[var(--gs-focus-ring)]"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy} disabled={!login || !password || faltaOPorque}>
            Autorizar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// --------------------------------------------------------------- pagamentos

export function PagamentoDialog({
  totalCents,
  customerId,
  customerName,
  onConfirm,
  onCancel,
  busy,
  error,
  terminalId = null,
}: {
  totalCents: number;
  /**
   * O cliente do carrinho — é ele que traz (ou não) crédito de loja.
   *
   * Sem cliente não há saldo de ninguém a oferecer, e o bloco do vale nem
   * aparece: mostrar um campo que sempre recusa ensinaria o operador a ignorar
   * a tela.
   */
  customerId?: string | null;
  customerName?: string | null;
  onConfirm: (
    payments: PaymentLine[],
    changeCents: number,
    surchargeCents: number,
    /** Quanto do CRÉDITO DE LOJA do cliente esta venda abate (GAP-V10/V47). */
    customerCreditCents: number,
  ) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  /**
   * O caixa deste computador (GAP-PRD-014). A maquininha é por caixa: o
   * PinPad do Caixa 1 não cobra a venda do Caixa 2. Sem caixa, vale a
   * maquininha da operação (o servidor decide).
   */
  terminalId?: string | null;
}) {
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  /*
    A lista vem do servidor. Enquanto não chega, vale o ponto de partida —
    diálogo sem botão nenhum pareceria travado para quem está no balcão.
  */
  const [metodos, setMetodos] = useState<PaymentMethodOption[]>(MEIOS_ENQUANTO_CARREGA);
  useEffect(() => {
    void coreApi
      .paymentMethods()
      .then((m) => {
        if (m.length === 0) return;
        metodosAtuais = m;
        setMetodos(m);
      })
      // Servidor fora do ar: o balcão segue com o ponto de partida, e é o
      // servidor que recusa método inválido na hora de fechar de qualquer jeito.
      .catch(() => undefined);
  }, []);
  const [method, setMethod] = useState<string>('dinheiro');
  const [amountText, setAmountText] = useState('');
  /**
   * O que a tela tem a dizer sobre o valor digitado ou sobre o F10 — antes de
   * qualquer lançamento ou cobrança. Some ao digitar de novo.
   */
  const [avisoDoValor, setAvisoDoValor] = useState<string | null>(null);
  /**
   * ACRÉSCIMO DE VERDADE — juros de parcelamento e frete.
   *
   * A faixa "Acima do preço vigente" do PDV instrui, com todas as letras:
   * "Acréscimo de verdade — juros, frete — entra no pagamento, onde fica
   * visível". No pagamento não havia onde. O servidor aceita `surchargeCents`
   * desde sempre — coluna própria, recusa de valor negativo, regra escrita
   * para não inflar a base de comissão — e era um campo inteiro sem leitor.
   *
   * Sem ele, quem precisa cobrar frete sobe o preço da linha: vira "acima do
   * vigente", que o servidor recusa cobrando o preço da tabela.
   */
  const [acrescimoText, setAcrescimoText] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  // Maquininha: enquanto houver cobrança em curso, o modal não aceita nada
  // novo — nem um segundo lançamento, nem o Finalizar.
  const [terminal, setTerminal] = useState<{
    configured: boolean;
    provider: string | null;
    message: string;
    /** Maquininha de TESTE: a cobrança é simulada (GAP-PRD-001). */
    simulated?: boolean;
    /** O caminho até o aparelho responde agora? (agente local, GAP-PRD-014) */
    channelReady?: boolean;
  } | null>(null);
  const [charging, setCharging] = useState(false);
  const [terminalPayment, setTerminalPayment] = useState<TerminalPayment | null>(null);
  /**
   * Enquanto o PIX está pendente, esta é a transação que se consulta (GAP-V49).
   *
   * PIX no aparelho é ASSÍNCRONO: o QR aparece, o cliente abre o banco, paga —
   * e a confirmação chega depois. Enquanto isso a tela não pode nem fechar a
   * venda nem afirmar que recebeu; ela CONSULTA, que é uma operação sem efeito
   * colateral nenhum do lado do servidor.
   */
  const [pixEmCurso, setPixEmCurso] = useState<{ id: string; cents: number } | null>(null);
  const [consultando, setConsultando] = useState(false);
  /**
   * Cartão ainda no aparelho (GAP-PRD-014). Pelo agente local a cobrança não
   * volta aprovada na hora: sai "aguardando a maquininha", passa por
   * "aguardando o cliente" (cartão, senha) e só então é aprovada ou recusada.
   * A tela CONSULTA — sem cobrar de novo — até sair de "em andamento".
   */
  const [cartaoEmCurso, setCartaoEmCurso] = useState<{ id: string; cents: number; method: string } | null>(
    null,
  );

  /*
    O PIX DO BALCÃO PELO PROVEDOR DE COBRANÇA (GAP-PRD-077).

    Sem maquininha, o PIX era lançado à mão depois de o operador conferir o app
    do banco. Com o Asaas configurado na operação, o QR nasce aqui, na conta
    dela, e a linha só entra na venda quando o servidor diz — liquidada (pago)
    ou pendente (o cliente vai pagar depois).
  */
  const [pixAsaas, setPixAsaas] = useState<StatusDoPixDoBalcao | null>(null);
  const [pixBalcao, setPixBalcao] = useState<PixDoBalcao | null>(null);
  const [pagadorDocumento, setPagadorDocumento] = useState('');
  const [gerandoPix, setGerandoPix] = useState(false);
  const [erroPix, setErroPix] = useState<string | null>(null);
  useEffect(() => {
    void pixBalcaoApi
      .status()
      .then(setPixAsaas)
      // Servidor fora do ar: o PIX continua sendo lançado à mão, como sempre.
      .catch(() => setPixAsaas(null));
  }, []);

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  useEffect(() => {
    void coreApi
      .terminalStatus(terminalId)
      .then(setTerminal)
      .catch(() =>
        setTerminal({
          configured: false,
          provider: null,
          message: 'Não foi possível consultar a maquininha. O cartão será lançado manualmente.',
        }),
      );
  }, [terminalId]);

  /*
    O CRÉDITO DE LOJA DO CLIENTE (GAP-V10/V47).

    O saldo é PERGUNTADO ao servidor quando há cliente no carrinho, e não
    guardado em lugar nenhum da tela: entre uma venda e outra o mesmo cliente
    pode ter devolvido peça em outro caixa. Sem cliente a pergunta nem sai.

    Falha calada de propósito: servidor fora do ar não pode travar o balcão, e o
    pior caso é o vale não ser oferecido nesta venda — o saldo continua lá para
    a próxima. Quem tem a palavra final é o servidor, que recusa vale sem saldo
    de qualquer jeito.
  */
  const [saldoCredito, setSaldoCredito] = useState(0);
  const [creditoPedido, setCreditoPedido] = useState(0);
  useEffect(() => {
    if (!customerId) {
      setSaldoCredito(0);
      setCreditoPedido(0);
      return;
    }
    let vivo = true;
    void coreApi
      .customerCredits(customerId)
      .then((r) => {
        if (vivo) setSaldoCredito(Math.max(0, r.balance));
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [customerId]);

  const paid = useMemo(() => payments.reduce((acc, p) => acc + p.amountCents, 0), [payments]);
  const cashPaid = useMemo(
    () => payments.filter((p) => isCash(p.method)).reduce((acc, p) => acc + p.amountCents, 0),
    [payments],
  );
  const acrescimo = acrescimoText ? parseCents(acrescimoText) : 0;
  // O que o cliente paga é a mercadoria MAIS o acréscimo.
  const totalAReceber = totalCents + acrescimo;
  /*
    O vale é RECORTADO a cada render, e não só na hora de aplicar.

    O acréscimo pode ser digitado DEPOIS de o crédito entrar, e o total muda com
    ele. Sem este recorte, aplicar R$ 250,00 numa venda de R$ 250,00 e depois
    apagar o acréscimo deixaria o pedido acima do total — que é exatamente o que
    o servidor recusa (vale não vira troco). Recortar aqui faz a tela nunca
    oferecer o que a API vai negar.
  */
  const credito = Math.max(0, Math.min(creditoPedido, saldoCredito, totalAReceber));
  /** O que sobra para os MEIOS cobrarem, depois do vale. */
  const aCobrarNosMeios = totalAReceber - credito;
  const remaining = Math.max(0, aCobrarNosMeios - paid);
  /*
    O PIX "RECEBER DEPOIS" NÃO BANCA TROCO (E-venda-servidor-07).

    O troco era `paid − aCobrar`, com `paid` somando o PIX pendente. Venda de
    R$ 100,00: R$ 30,00 no PIX que não caiu ("receber depois") e uma nota de
    R$ 100,00 — a tela mandava dar R$ 30,00 de troco, e o servidor, que tira o
    troco SÓ do que está liquidado, gravava troco zero e R$ 100,00 na gaveta. O
    caixa entregava R$ 30,00, o fechamento acusava falta de R$ 30,00, e quando o
    PIX caía os R$ 30,00 entravam no banco sem título.

    Agora a tela tem a regra do servidor, uma só: o troco sai do que está
    LIQUIDADO. E receber a mais com um PIX pendente na conta não fecha: o que
    passa do total nesse caso não é troco de ninguém — ou o dinheiro foi lançado
    a mais, ou o PIX sobrou. A tela para e diz qual dos dois ajustar.
  */
  const pendente = useMemo(
    () => payments.filter((p) => p.status === 'pending').reduce((acc, p) => acc + p.amountCents, 0),
    [payments],
  );
  const liquidado = paid - pendente;
  // Contra o que sobrou para os meios, e não contra o total: senão a venda paga
  // pelo vale acusaria troco do tamanho do vale — crédito virando espécie.
  const change = Math.max(0, liquidado - aCobrarNosMeios);
  const trocoContraPendente = pendente > 0 && paid > aCobrarNosMeios;
  /** Quanto o dinheiro deveria ser para fechar sem sobra, com o PIX pendente cobrindo a parte dele. */
  const dinheiroQueFecha = Math.max(0, aCobrarNosMeios - pendente - (liquidado - cashPaid));

  // Troco só sai da gaveta, então não pode ser maior que o dinheiro recebido.
  const changeExceedsCash = change > cashPaid;
  /*
    Cobrança em curso, PIX esperando o cliente pagar, ou status não confirmado
    travam o fechamento: em nenhum dos três casos se sabe que o dinheiro entrou.

    O PIX pendente entrou nesta lista junto com a rota pelo aparelho (GAP-V49).
    Sem ele, o operador poderia clicar Finalizar com o QR ainda na tela e a
    venda sairia sem o valor do PIX — ou pior, com o cliente achando que pagou.
  */
  const blockedByTerminal =
    charging
    || pixEmCurso !== null
    || pixBalcao !== null
    || cartaoEmCurso !== null
    || terminalPayment?.needsReconciliation === true;
  const canConfirm =
    paid + credito >= totalAReceber
    && !changeExceedsCash
    && !trocoContraPendente
    && totalCents > 0
    && !blockedByTerminal;

  const addPayment = useCallback(
    (code: string, cents: number, providerRef?: string) => {
      if (cents <= 0) return;
      setPayments((prev) => [...prev, { method: code, amountCents: cents, providerRef }]);
      setAmountText('');
      setAvisoDoValor(null);
      amountRef.current?.focus();
    },
    [],
  );

  /** A linha do PIX do balcão: leva a cobrança, e o status que o servidor vai conferir. */
  const addPixDoBalcao = useCallback((pix: PixDoBalcao, status: 'settled' | 'pending') => {
    setPayments((prev) =>
      prev.some((p) => p.paymentIntentId === pix.intentId)
        ? prev
        : [...prev, { method: 'pix', amountCents: pix.amountCents, paymentIntentId: pix.intentId, status }],
    );
    setPixBalcao(null);
    setAmountText('');
  }, []);

  /*
    ====================================================================
    POR ONDE CADA MEIO PASSA (GAP-V49)
    ====================================================================

    Era `const isCard = method === 'debito' || method === 'credito'` — e só
    cartão ia para a maquininha. O PIX INTEGRADO estava pronto no servidor
    havia rodadas (QR, estado pendente, consulta, confirmação; doze testes
    verdes) e não tinha uma linha de tela: no dia em que a maquininha real
    chegasse, o PIX do aparelho simplesmente não funcionaria.

    A regra de quem passa pelo aparelho é do SERVIDOR — `methodNeedsTerminal`
    —, e ela diz: cartão sempre; PIX só quando há maquininha integrada. A tela
    repete a MESMA regra, e não uma parecida: sem maquininha, o PIX continua
    sendo o do provedor de cobrança — e AGORA isso é verdade (GAP-PRD-077):
    esta frase prometia "o QR na tela do computador" e o PIX era lançado à mão.
    Com o Asaas configurado, o QR é gerado aqui (`pixPeloProvedor`); sem ele,
    a tela diz que o PIX é conferido no app do banco.
  */
  const passaPelaMaquininha = (code: string): boolean => {
    if (!terminal?.configured) return false;
    return code === 'debito' || code === 'credito' || code === 'pix';
  };
  const pixPeloProvedor =
    method === 'pix' && !passaPelaMaquininha('pix') && pixAsaas?.disponivel === true;

  const gerarPixDoBalcao = useCallback(
    async (cents: number) => {
      setGerandoPix(true);
      setErroPix(null);
      try {
        const pix = await pixBalcaoApi.gerar({
          amountCents: cents,
          referencia: uuid(),
          customerId: customerId ?? null,
          pagadorDocumento: pagadorDocumento.replace(/\D/g, '') || null,
        });
        setPixBalcao(pix);
        if (pix.status === 'confirmed') addPixDoBalcao(pix, 'settled');
      } catch (err) {
        setErroPix(err instanceof ApiRequestError ? err.message : 'Falha ao gerar o PIX.');
      } finally {
        setGerandoPix(false);
      }
    },
    [customerId, pagadorDocumento, addPixDoBalcao],
  );

  /*
    O VALOR LANÇADO TEM TETO (D-pdv-teclado-M03).

    Não tinha nenhum. O foco mora no campo de valor e o Enter do leitor submete
    o formulário: o cliente entregava mais um item com o pagamento aberto, o
    caixa bipava, e entrava uma linha de R$ 7.891.234.567.895,00 em dinheiro —
    com troco do mesmo tamanho, que um F10 por hábito gravava na venda e na
    NFC-e. Em cartão com maquininha integrada, a cobrança desse valor ia para o
    PinPad. Três recusas, antes de qualquer lançamento ou cobrança:
      - oito dígitos ou mais sem separador não é dinheiro, é código de barras;
      - cartão e PIX não passam do que falta (não existe troco de cartão);
      - dinheiro não passa do que falta mais uma folga larga (R$ 1.000 ou dez
        vezes a venda) — a nota de R$ 100 para um item de R$ 5 continua valendo.
  */
  const conferirValor = (texto: string, cents: number, meio: string): string | null => {
    if (/^\s*\d{8,}\s*$/.test(texto)) {
      return 'Isso parece um código de barras, não um valor. Esc volta ao carrinho para incluir o item.';
    }
    if (!isCash(meio) && cents > remaining) {
      return `Em ${methodLabel(meio)} o valor não pode passar do que falta receber (${formatCents(remaining)}). `
        + 'Troco só sai de dinheiro.';
    }
    if (isCash(meio) && cents > remaining + Math.max(100_000, 10 * totalAReceber)) {
      return `${formatCents(cents)} é muito acima do que falta receber (${formatCents(remaining)}). Confira o valor digitado.`;
    }
    return null;
  };

  const submitAmount = useCallback(async () => {
    // Campo vazio significa "o que falta" — é o gesto mais comum no balcão.
    const cents = amountText ? parseCents(amountText) : remaining;
    if (cents <= 0) return;
    const recusa = conferirValor(amountText, cents, method);
    if (recusa) {
      setAvisoDoValor(recusa);
      amountRef.current?.select();
      return;
    }

    // PIX pelo provedor de cobrança: o QR nasce aqui, e a linha só entra
    // quando o servidor disser (GAP-PRD-077).
    if (method === 'pix' && !passaPelaMaquininha('pix') && pixAsaas?.disponivel) {
      await gerarPixDoBalcao(cents);
      return;
    }

    // Sem maquininha integrada, o cartão é lançado à mão: a loja confere o
    // comprovante da maquininha avulsa. Com maquininha, o clique não vale
    // nada — só a confirmação da operadora entra na venda.
    if (!passaPelaMaquininha(method)) {
      addPayment(method, cents);
      return;
    }

    setCharging(true);
    setTerminalPayment(null);
    setPixEmCurso(null);
    setCartaoEmCurso(null);
    try {
      const result = await coreApi.chargeOnTerminal(
        { method, amountInCents: cents, terminalId },
        `pdv-terminal-${uuid()}`,
      );
      setTerminalPayment(result);
      // Só o "aprovado" vira lançamento na venda — e ele leva junto a
      // transação que o autorizou, que é o que o servidor confere.
      if (result.settled) {
        addPayment(method, cents, result.transactionId);
      } else if (method === 'pix' && result.qrPayload) {
        // Nem aprovado nem recusado: o QR está no aparelho e o cliente ainda
        // vai pagar. A venda fica travada até a operadora confirmar.
        setPixEmCurso({ id: result.transactionId, cents });
      } else if (result.pending) {
        // No aparelho (agente local): cartão, senha, operadora. Consulta até
        // sair de "em andamento" — nunca cobra de novo.
        setCartaoEmCurso({ id: result.transactionId, cents, method });
      }
    } catch (err) {
      setTerminalPayment({
        transactionId: '',
        state: 'erro',
        message:
          err instanceof ApiRequestError ? err.message : 'Falha ao falar com a maquininha.',
        settled: false,
        needsReconciliation: false,
        amountInCents: cents,
        method,
        simulated: false,
      });
    } finally {
      setCharging(false);
    }
    // `passaPelaMaquininha` lê `terminal`, que já está na lista; `conferirValor`
    // lê `remaining` e `totalAReceber`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, remaining, totalAReceber, method, addPayment, terminal, pixAsaas, gerarPixDoBalcao, terminalId]);

  /**
   * Pergunta ao servidor o que o PROVEDOR diz do PIX pendente.
   *
   * Não decide nada e não tem efeito colateral: pode ser chamada quantas vezes
   * for preciso. Quando volta liquidada, a linha entra na venda com a
   * transação amarrada e a espera acaba.
   */
  const consultarPix = useCallback(async () => {
    if (!pixEmCurso) return;
    setConsultando(true);
    try {
      const atual = await coreApi.getTerminalPayment(pixEmCurso.id);
      setTerminalPayment(atual);
      if (atual.settled) {
        addPayment('pix', pixEmCurso.cents, atual.transactionId);
        setPixEmCurso(null);
      }
    } catch (err) {
      setTerminalPayment((antes) =>
        antes
          ? {
              ...antes,
              message:
                err instanceof ApiRequestError
                  ? err.message
                  : 'Falha ao consultar a maquininha.',
            }
          : antes,
      );
    } finally {
      setConsultando(false);
    }
  }, [pixEmCurso, addPayment]);

  /*
    A CONSULTA AUTOMÁTICA, a cada três segundos enquanto o QR está de pé.

    Sem ela o operador teria de clicar "Já pagou?" repetidamente com o cliente
    na frente. COM ela, e sem o botão, ficaria dependendo de um relógio para
    saber se o sistema ainda está vivo — por isso existem os dois.

    O intervalo é limpo na saída E quando o PIX deixa de estar em curso: um
    laço que sobrevive ao modal continuaria batendo no servidor para sempre.
  */
  useEffect(() => {
    if (!pixEmCurso) return;
    const relogio = setInterval(() => void consultarPix(), 3000);
    return () => clearInterval(relogio);
  }, [pixEmCurso, consultarPix]);

  /*
    O CARTÃO NO APARELHO, CONSULTADO A CADA DOIS SEGUNDOS (GAP-PRD-014).

    Pelo agente local o PinPad responde quando o cliente termina (cartão,
    senha, operadora). A tela só PERGUNTA: aprovado vira lançamento com a
    cobrança amarrada; recusado, cancelado, erro ou não confirmado encerram a
    espera e ficam na tela como vieram — o bloco de "não repita a cobrança"
    aparece sozinho no último caso. O intervalo morre com o diálogo.
  */
  useEffect(() => {
    if (!cartaoEmCurso) return;
    let vivo = true;
    const consultar = async () => {
      try {
        const atual = await coreApi.getTerminalPayment(cartaoEmCurso.id);
        if (!vivo) return;
        setTerminalPayment(atual);
        if (atual.settled) {
          addPayment(cartaoEmCurso.method, cartaoEmCurso.cents, atual.transactionId);
          setCartaoEmCurso(null);
        } else if (!atual.pending) {
          setCartaoEmCurso(null);
        }
      } catch {
        // Falha de rede numa consulta não decide nada: a próxima volta pergunta de novo.
      }
    };
    const relogio = setInterval(() => void consultar(), 2000);
    return () => {
      vivo = false;
      clearInterval(relogio);
    };
  }, [cartaoEmCurso, addPayment]);

  /**
   * Confirma o PIX no provedor de TESTE.
   *
   * Só aparece quando a resposta vem marcada como `simulated` — e o servidor
   * recusa fora do provedor mock de qualquer jeito. Com adquirente real esta
   * porta não existe: quem confirma pagamento é ela, e um botão de "aprovar no
   * braço" seria o sistema dizer que recebeu dinheiro que ninguém pagou.
   */
  const confirmarPixDeTeste = useCallback(async () => {
    if (!pixEmCurso) return;
    setConsultando(true);
    try {
      const atual = await coreApi.confirmarPixDeTeste(pixEmCurso.id);
      setTerminalPayment(atual);
      if (atual.settled) {
        addPayment('pix', pixEmCurso.cents, atual.transactionId);
        setPixEmCurso(null);
      }
    } catch (err) {
      setTerminalPayment((antes) =>
        antes
          ? {
              ...antes,
              message:
                err instanceof ApiRequestError ? err.message : 'Falha ao confirmar o PIX.',
            }
          : antes,
      );
    } finally {
      setConsultando(false);
    }
  }, [pixEmCurso, addPayment]);

  /*
    DESISTIR CANCELA NA MAQUININHA (GAP-PRD-078).

    "Desistir desta cobrança" só limpava a tela: o PIX continuava de pé no
    aparelho, o cliente pagava depois e o dinheiro virava órfão — aprovado,
    sem venda, fora de qualquer fila. Agora desistir PEDE O CANCELAMENTO à
    operadora (o mesmo vale para o cartão aprovado que o operador tira da
    venda). Se não der para cancelar, a tela diz por quê, a cobrança continua
    na tela para decidir, e o gerente a encontra em Conferência de maquininha
    › Cobranças sem venda — nada some.
  */
  const [desistindo, setDesistindo] = useState(false);
  const desistirDaCobranca = useCallback(async (transactionId: string, motivo: string): Promise<boolean> => {
    setDesistindo(true);
    try {
      const r = await pendenciasDaMaquininhaApi.desistir(transactionId, motivo);
      setTerminalPayment(r);
      return true;
    } catch (err) {
      setTerminalPayment((antes) => ({
        ...(antes ?? ({
          transactionId,
          state: 'erro',
          settled: false,
          needsReconciliation: false,
          amountInCents: 0,
          method: '',
          simulated: false,
        } as TerminalPayment)),
        message:
          `${err instanceof ApiRequestError ? err.message : 'Falha ao cancelar na maquininha.'} `
          + 'A cobrança continua valendo: se não der para cancelar agora, o gerente a encontra em '
          + 'Vendas › Conferência de maquininha.',
      }));
      return false;
    } finally {
      setDesistindo(false);
    }
  }, []);

  /*
    AS TECLAS DO BALCÃO, DEPOIS DE DUAS LIÇÕES.

    F5 SAIU. O `preventDefault` só acontecia quando o Finalizar já podia
    fechar — e em pagamento dividido ele fica desabilitado a montagem inteira,
    que é justamente quando o botão ao lado mandava finalizar com essa mesma
    tecla. A pessoa apertava o que a tela mandava e o navegador recarregava com
    o carrinho montado. O PDV já tinha tirado F5 do próprio mapa por isso, com
    comentário e teste; o diálogo ficou de fora. Quem finaliza agora é F10 — a
    mesma tecla que abriu o pagamento.

    E A ESCOLHA DO MEIO GANHOU O ALT. O ouvinte desistia antes de olhar a
    tecla quando o foco estava num INPUT, e o diálogo põe o foco no campo de
    valor ao abrir e depois de cada lançamento: as teclas 1..5 que a ajuda
    promete NUNCA chegavam, e o dígito ia parar no valor — apertar "2" para
    escolher débito somava um 2 ao número que estava sendo digitado. Alt+1..5
    escolhe o meio sem disputar com os dígitos, no mesmo idioma do Alt+O da
    observação. Sem o Alt, o dígito é do campo, que é o dono legítimo dele.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F10') {
        e.preventDefault();
        e.stopPropagation();
        if (canConfirm) {
          onConfirm(payments, change, acrescimo, credito);
          return;
        }
        /*
          F10 SEM NADA LANÇADO FINALIZA PELO QUE FALTA — ou diz por que não
          (D-pdv-teclado-17).

          A ajuda promete "F10 abre o pagamento — e o finaliza quando fecha".
          Com o diálogo recém-aberto, o segundo F10 não fazia NADA, sem uma
          palavra: o caixa repetia a tecla e a tela ficava parada. Sem
          lançamento, com o campo vazio e num meio que não passa pela
          maquininha nem gera QR, o gesto é o mesmo do Enter no campo vazio:
          lança o que falta no meio escolhido — e fecha. Nos outros casos a
          tela diz o que falta fazer.
        */
        const lancaSozinho =
          payments.length === 0
          && !amountText.trim()
          && remaining > 0
          && totalCents > 0
          && !blockedByTerminal
          && !passaPelaMaquininha(method)
          && !pixPeloProvedor;
        if (lancaSozinho) {
          onConfirm([{ method, amountCents: remaining }], 0, acrescimo, credito);
          return;
        }
        setAvisoDoValor(
          blockedByTerminal
            ? 'Espere a maquininha responder antes de finalizar.'
            : trocoContraPendente
              ? 'Troco não sai contra PIX pendente — ajuste o dinheiro lançado antes de finalizar.'
            : amountText.trim()
              ? 'Lance o valor com Enter antes de finalizar.'
              : remaining > 0
                ? `Ainda falta receber ${formatCents(remaining)} — lance o pagamento com Enter antes de finalizar.`
                : 'Confira os lançamentos: do jeito que estão, a venda não fecha.',
        );
        return;
      }
      if (!e.altKey) return;
      const picked = metodos.find((m) => m.key === e.key);
      if (picked) {
        e.preventDefault();
        e.stopPropagation();
        setMethod(picked.code);
        amountRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // `metodos` entra na lista: sem ele o atalho de teclado ficaria preso na
    // lista inicial e ignoraria a que o servidor devolveu. `credito` idem: sem
    // ele o F10 fecharia a venda com o vale que o operador aplicou valendo
    // zero, e o servidor cobraria o total inteiro. `terminal` é quem
    // `passaPelaMaquininha` lê.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConfirm, onConfirm, payments, change, acrescimo, credito, metodos, amountText, remaining, totalCents, blockedByTerminal, method, pixPeloProvedor, terminal]);

  /*
    SAIR NÃO PODE APAGAR O QUE JÁ FOI LANÇADO SEM PERGUNTAR.

    A lista mora no estado deste diálogo, e o PDV o monta sob `showPayment`:
    qualquer saída desmonta o componente e joga tudo fora. Com três meios já
    lançados e o cliente na frente, refazer tudo por causa de um Esc na tecla
    errada é perda que a tela evita perguntando uma vez.

    Sem lançamento nenhum a pergunta não aparece: seria atrito puro, porque
    não há nada a perder.
  */
  const [confirmandoSaida, setConfirmandoSaida] = useState(false);
  const sair = useCallback(() => {
    if (payments.length > 0) {
      setConfirmandoSaida(true);
      return;
    }
    onCancel();
  }, [payments.length, onCancel]);

  return (
    <Modal title="Pagamento" onClose={sair}>
      <div className="px-6 py-5 flex flex-col gap-5">
        {/* ------------------------------------------------------- totais */}
        <div className="grid grid-cols-3 gap-3">
          <Totalizador rotulo="Total da venda" valor={totalAReceber} />
          <Totalizador rotulo="Falta receber" valor={remaining} destaque={remaining > 0} />
          <Totalizador rotulo="Troco" valor={change} destaque={change > 0} positivo />
        </div>

        {/*
          ------------------------------------------- crédito de loja do cliente

          SÓ APARECE COM CLIENTE E COM SALDO, e as duas condições são a mesma
          decisão: um botão "Crédito do cliente" sempre visível seria uma promessa
          que recusa na maioria das vendas, e o operador aprenderia a ignorá-lo.

          E ele fica FORA da fileira de meios de pagamento de propósito. Crédito
          de loja não é instrumento — é dívida que a loja já tinha com esta
          pessoa. Posto ao lado de Dinheiro e PIX, ele viraria "mais uma forma de
          receber", e é o contrário: aqui não entra dinheiro nenhum.

          O SALDO VAI ESCRITO. "Usar crédito" sem número obriga o operador a
          adivinhar quanto o cliente tem — e é justamente o número que o cliente
          vai perguntar em voz alta no balcão.
        */}
        {customerId && saldoCredito > 0 && (
          <div
            data-testid="pdv-credito-de-loja"
            className="rounded-[var(--gs-radius)] border border-[var(--gs-purple-600)]
              bg-[var(--gs-canvas)] px-4 py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-[length:var(--gs-text-sm)]">
              <strong>Crédito do cliente</strong>
              {customerName ? ` · ${customerName}` : ''} — saldo {formatCents(saldoCredito)}
              {credito > 0 && (
                <span className="text-[var(--gs-success)] font-semibold">
                  {' '}
                  · usando {formatCents(credito)}
                </span>
              )}
            </span>
            {credito > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreditoPedido(0)}
                aria-label="Não usar o crédito do cliente"
              >
                Não usar
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  // O gesto do balcão é "abate o que der": o vale cobre até o
                  // que ainda falta, nunca mais que isso — crédito não vira
                  // troco, e o servidor recusaria.
                  setCreditoPedido(Math.min(saldoCredito, Math.max(0, totalAReceber - paid)))
                }
              >
                Usar crédito ({formatCents(Math.min(saldoCredito, totalAReceber))})
              </Button>
            )}
          </div>
        )}

        {/* -------------------------------------------------- meios e valor */}
        <div className="flex flex-wrap gap-2">
          {metodos.map((m) => (
            <button
              key={m.code}
              type="button"
              onClick={() => {
                setMethod(m.code);
                amountRef.current?.focus();
              }}
              aria-pressed={method === m.code}
              className={`px-4 py-2 rounded-[var(--gs-radius)] border font-semibold text-[length:var(--gs-text-sm)]
                ${
                  method === m.code
                    ? 'bg-[var(--gs-purple-600)] text-white border-[var(--gs-purple-600)]'
                    : 'bg-white text-[var(--gs-text)] border-[var(--gs-border)]'
                }`}
            >
              {m.label} <span className="opacity-60">(Alt+{m.key})</span>
            </button>
          ))}
        </div>

        <form
          className="flex gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAmount();
          }}
        >
          <label className="flex-1 flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Valor recebido em {methodLabel(method)}
            </span>
            <input
              ref={amountRef}
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setAvisoDoValor(null);
              }}
              inputMode="numeric"
              placeholder={`Vazio = ${formatCents(remaining)}`}
              className="h-12 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                text-[length:var(--gs-text-lg)] font-semibold outline-none focus:border-[var(--gs-focus-ring)]"
            />
          </label>
          <label className="w-40 flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Acréscimo (juros, frete)
            </span>
            <input
              aria-label="Acréscimo (juros, frete)"
              value={acrescimoText}
              onChange={(e) => setAcrescimoText(e.target.value)}
              inputMode="decimal"
              placeholder="0,00"
              className="h-12 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                text-[length:var(--gs-text-lg)] font-semibold outline-none focus:border-[var(--gs-focus-ring)]"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            loading={charging}
            // Com um PIX esperando o cliente, um segundo lançamento cobraria
            // duas vezes o mesmo carrinho.
            disabled={pixEmCurso !== null || pixBalcao !== null}
          >
            {passaPelaMaquininha(method)
              ? 'Cobrar na maquininha'
              : pixPeloProvedor
                ? gerandoPix
                  ? 'Gerando QR…'
                  : 'Gerar QR do PIX'
                : 'Lançar'}
          </Button>
        </form>

        {/*
          -------------------------------------- PIX do balcão pelo provedor

          O PAGADOR: o provedor pendura toda cobrança num CPF/CNPJ. Com cliente
          no carrinho, vale o dele; sem cliente, pergunta-se o de quem paga — o
          sistema não inventa pagador.
        */}
        {pixPeloProvedor && !pixBalcao && (
          <div className="flex flex-wrap items-end gap-3">
            {!customerId && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  CPF de quem paga (o provedor exige)
                </span>
                <input
                  aria-label="CPF de quem paga"
                  value={pagadorDocumento}
                  onChange={(e) => setPagadorDocumento(e.target.value)}
                  inputMode="numeric"
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                    text-[length:var(--gs-text-base)] outline-none focus:border-[var(--gs-focus-ring)]"
                />
              </label>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                // O caminho de antes continua existindo — PIX na chave da loja,
                // conferido no app do banco —, mas não é mais o único.
                const cents = amountText ? parseCents(amountText) : remaining;
                const recusa = conferirValor(amountText, cents, 'pix');
                if (recusa) {
                  setAvisoDoValor(recusa);
                  return;
                }
                addPayment('pix', cents);
              }}
            >
              Lançar sem QR (já conferido no banco)
            </Button>
            <span className="w-full text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
              {pixAsaas?.motivo}
            </span>
          </div>
        )}
        {method === 'pix' && !passaPelaMaquininha('pix') && pixAsaas && !pixAsaas.disponivel && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            PIX sem QR pelo sistema: confira o pagamento no app do banco antes de lançar. {pixAsaas.motivo}
          </p>
        )}
        {erroPix && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erroPix}
          </p>
        )}
        {pixBalcao && (
          <PixDoBalcaoPainel
            pix={pixBalcao}
            onAtualizou={setPixBalcao}
            onPago={(pix) => addPixDoBalcao(pix, 'settled')}
            onReceberDepois={(pix) => addPixDoBalcao(pix, 'pending')}
            onDesistiu={() => setPixBalcao(null)}
          />
        )}

        {/* -------------------------------------------------- lançamentos */}
        {payments.length > 0 && (
          <ul className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
            {payments.map((p, i) => (
              <li
                key={`${p.method}-${i}`}
                className="flex items-center justify-between px-3 py-2 rounded-[var(--gs-radius)]
                  bg-[var(--gs-canvas)] text-[length:var(--gs-text-sm)]"
              >
                <span className="font-semibold">
                  {methodLabel(p.method)}
                  {p.paymentIntentId ? ' (QR do sistema)' : ''}
                  {p.status === 'pending' && (
                    <span className="ml-2 text-[var(--gs-warning)]">pendente — liquida quando o provedor confirmar</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-bold">{formatCents(p.amountCents)}</span>
                  <button
                    type="button"
                    disabled={desistindo}
                    onClick={async () => {
                      // A linha que veio da maquininha leva a cobrança junto
                      // (GAP-PRD-078): tirar da venda o cartão aprovado sem
                      // cancelá-lo deixaria dinheiro do cliente sem venda.
                      if (
                        p.providerRef
                        && !(await desistirDaCobranca(p.providerRef, 'Pagamento retirado da venda no balcão'))
                      ) {
                        return;
                      }
                      setPayments((prev) => prev.filter((x, j) => (p.providerRef ? x !== p : j !== i)));
                    }}
                    className="text-[var(--gs-danger)] font-semibold"
                    aria-label={`Remover ${methodLabel(p.method)} de ${formatCents(p.amountCents)}`}
                  >
                    remover
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {terminalPayment && <TerminalProgress payment={terminalPayment} />}

        {/*
          -------------------------------------------- PIX pendente na maquininha

          O QR ESTÁ NO APARELHO, e o copia-e-cola aparece aqui pelo mesmo motivo
          que ele existe na resposta do servidor: a maquininha pode estar longe
          do operador, e há cliente que prefere colar o código no aplicativo do
          banco em vez de mirar a câmera.

          A VENDA NÃO FECHA ENQUANTO ISTO ESTIVER NA TELA. Não é cautela
          decorativa: dizer "recebido" antes de o provedor confirmar é afirmar
          que entrou dinheiro que ninguém pagou — o pior defeito possível neste
          sistema, e o motivo de o fluxo ser assíncrono desde o servidor.
        */}
        {pixEmCurso && terminalPayment?.qrPayload && (
          <div
            data-testid="pdv-pix-na-maquininha"
            className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] flex flex-col gap-3"
          >
            <strong className="text-[var(--gs-purple-900)]">
              PIX de {formatCents(pixEmCurso.cents)} na maquininha
            </strong>
            <span className="text-[length:var(--gs-text-sm)]">
              O QR está no aparelho. A venda só fecha depois que a operadora confirmar o
              pagamento.
            </span>
            <code
              aria-label="Copia e cola do PIX"
              className="break-all px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-surface)]
                border border-[var(--gs-border)] text-[length:var(--gs-text-xs)]"
            >
              {terminalPayment.qrPayload}
            </code>
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                loading={consultando}
                onClick={() => void consultarPix()}
              >
                Já pagou? Consultar
              </Button>
              {/*
                A confirmação manual só existe no provedor de TESTE, e o
                servidor a recusa fora dele. O botão segue a mesma régua: sem a
                marca de simulado, ele nem aparece — um "aprovar no braço" ao
                lado de uma cobrança real seria a porta dos fundos deste ERP.
              */}
              {terminalPayment.simulated && (
                <Button
                  type="button"
                  variant="ghost"
                  loading={consultando}
                  onClick={() => void confirmarPixDeTeste()}
                >
                  Confirmar (provedor de teste)
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                loading={desistindo}
                onClick={async () => {
                  // Desistir CANCELA a cobrança na maquininha (GAP-PRD-078).
                  // Só sai da tela quando a operadora confirmar; se não der,
                  // a recusa aparece e a cobrança continua aqui.
                  const id = pixEmCurso.id;
                  if (await desistirDaCobranca(id, 'Cliente desistiu do PIX no balcão')) setPixEmCurso(null);
                }}
              >
                Desistir desta cobrança
              </Button>
            </span>
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
              Desistir pede à maquininha o cancelamento deste PIX. Se não der para cancelar, ele
              aparece para o gerente em Vendas › Conferência de maquininha — não receba por outro
              meio antes de saber.
            </span>
          </div>
        )}

        {/* Status não confirmado trava o balcão de propósito: ninguém sabe se
            o cliente pagou. Quem resolve é um gestor, conferindo o extrato. */}
        {terminalPayment?.needsReconciliation && (
          <div
            role="alert"
            className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]
              flex flex-col gap-2"
          >
            <strong>Não repita a cobrança.</strong>
            <span className="text-[length:var(--gs-text-sm)]">
              Peça a um gestor para conferir o extrato da operadora e registrar o resultado em
              Vendas › Conferência de maquininha. Enquanto isso, use outro meio de pagamento ou
              deixe a venda em aberto.
            </span>
          </div>
        )}

        {terminal && !terminal.configured && (method === 'debito' || method === 'credito') && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{terminal.message}</p>
        )}

        {/*
          MAQUININHA DE TESTE, DITA ANTES DE COBRAR (GAP-PRD-001).

          O aviso "resposta simulada" só aparecia DEPOIS da aprovação, em letra
          pequena. Com a configuração de teste ligada fora de produção, o
          operador fechava a venda e entregava a mercadoria achando que o
          cartão tinha passado. O aviso vem agora antes do clique, em destaque.
        */}
        {/*
          O APARELHO NÃO RESPONDE, DITO ANTES DE COBRAR (GAP-PRD-014).

          Com a maquininha do caixa ligada e o agente local fora do ar, o
          cartão não passa — o servidor recusa a cobrança antes de ela nascer.
          A tela avisa antes do clique, com o que fazer.
        */}
        {terminal?.configured && terminal.channelReady === false && passaPelaMaquininha(method) && (
          <p
            role="alert"
            aria-label="Maquininha sem resposta"
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-danger)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
          >
            {terminal.message}
          </p>
        )}

        {cartaoEmCurso && (
          <p role="status" aria-label="Cobrança no aparelho" className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            A cobrança está na maquininha. Não cobre de novo: a tela confirma sozinha quando o aparelho responder.
          </p>
        )}

        {terminal?.configured && terminal.simulated && passaPelaMaquininha(method) && (
          <p
            role="alert"
            aria-label="Maquininha de teste"
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)]
              text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
          >
            {terminal.message}
          </p>
        )}

        {avisoDoValor && (
          <p
            role="alert"
            data-testid="pagamento-aviso"
            className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
          >
            {avisoDoValor}
          </p>
        )}
        {changeExceedsCash && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            Troco só é possível sobre o valor recebido em dinheiro.
          </p>
        )}
        {trocoContraPendente && (
          <p
            role="alert"
            data-testid="pagamento-troco-com-pix-pendente"
            className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
          >
            O PIX de {formatCents(pendente)} ainda não caiu, e o recebido passa da venda em{' '}
            {formatCents(paid - aCobrarNosMeios)}. Troco não sai contra PIX pendente: receba em
            dinheiro só {formatCents(dinheiroQueFecha)}, ou remova o PIX pendente e receba tudo em
            dinheiro.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {confirmandoSaida && (
          <div
            role="alertdialog"
            aria-label="Descartar os lançamentos?"
            className="rounded-[var(--gs-radius)] border border-[var(--gs-warning)]
              bg-[var(--gs-warning-bg)] px-4 py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
              {contar(payments.length, 'lançamento já feito', 'lançamentos já feitos')} nesta venda.
              Sair agora apaga {payments.length === 1 ? 'ele' : 'todos'} — o carrinho continua.
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setConfirmandoSaida(false)}>
                Continuar recebendo
              </Button>
              <Button type="button" variant="secondary" onClick={onCancel}>
                Descartar e voltar
              </Button>
            </span>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={sair}>
            Voltar (Esc)
          </Button>
          <Button
            type="button"
            size="lg"
            loading={busy}
            disabled={!canConfirm}
            onClick={() => onConfirm(payments, change, acrescimo, credito)}
          >
            Finalizar (F10)
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Totalizador({
  rotulo,
  valor,
  destaque,
  positivo,
}: {
  rotulo: string;
  valor: number;
  destaque?: boolean;
  positivo?: boolean;
}) {
  const cor = !destaque
    ? 'text-[var(--gs-purple-900)]'
    : positivo
      ? 'text-[var(--gs-success)]'
      : 'text-[var(--gs-danger)]';
  return (
    <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
      <p className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </p>
      <p className={`text-[length:var(--gs-text-xl)] font-bold ${cor}`}>{formatCents(valor)}</p>
    </div>
  );
}

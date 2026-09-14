/**
 * Portal do cliente: entrar e acompanhar os próprios pedidos.
 *
 * É a loja, não o ERP — sem sidebar, sem menu administrativo. Quem chega aqui
 * comprou alguma coisa e quer saber onde ela está.
 *
 * A sessão é do PORTAL e vive em chave própria (`gs.portal`), separada da
 * sessão do sistema. Um cliente nunca carrega escopo de PDV ou de gerente por
 * descuido de código, e sair daqui não desloga ninguém do ERP.
 *
 * Pedido não é buscado por id na URL sem prova: o token vai no header e o
 * servidor decide. Conhecer o número de um pedido não abre nada.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArmadilhaDeFoco } from '@/components/gs/armadilhaDeFoco';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { contar, formatCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { ContaDoCliente } from '@/components/gs/ContaDoCliente';
import { TrazerMinhasCompras } from '@/components/gs/TrazerMinhasCompras';
import { EntrarComGoogle } from '@/components/gs/EntrarComGoogle';
import { GoogleNaConta } from '@/components/gs/GoogleNaConta';
import { SenhaNovaComConfirmacao } from '@/components/gs/SenhaNova';
import { esquecerCarrinhoDaConta } from '@/lib/carrinhoLocal';
import { problemaDaSenhaNova } from '@/lib/senhaNova';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import { dataBR, dataHoraBR } from '@/lib/datas';
import { NotaDoPedido } from '@/components/gs/NotaDoPedido';
import { DevolucaoDoPedido } from '@/components/gs/DevolucaoDoPedido';
import type { DevolucaoNoPortal, NotaDoPedidoNoPortal } from '@/lib/api/posVenda';

import {
  lerSessaoPortal as lerSessao,
  guardarSessaoPortal as guardarSessao,
  comTokenPortal,
  type SessaoPortal as Sessao,
} from '@/lib/portalSession';

/**
 * Para onde a conta devolve quem veio do carrinho (GAP-PRD-028).
 *
 * A loja que exige conta manda o cliente para cá com `?voltar=<a vitrine>`.
 * Só caminho interno vale: `/algo`, nunca `//outro-site` nem endereço
 * completo — um parâmetro de URL que redireciona para fora é porta de golpe.
 */
function voltaDoCarrinho(valor: string | null): string | null {
  if (!valor || !/^\/(?!\/)[\w\-/]*$/.test(valor)) return null;
  return `${valor}?carrinho=1`;
}

// O token vai no cabeçalho próprio do portal — nunca no Authorization do ERP.
function comToken<T>(caminho: string, token: string): Promise<T> {
  return comTokenPortal<T>(caminho, token);
}

interface EnvioDeEmail {
  envioDeEmailAtivo: boolean;
  message: string | null;
}

/**
 * O ENVIO DE E-MAILS DA LOJA ESTÁ LIGADO? (GAP-PRD-200)
 *
 * O portal prometia "enviamos um link" e "código novo enviado" com o
 * carteiro desligado — e o cliente esperava um e-mail que não vinha. Antes de
 * prometer, a tela pergunta ao servidor (rota pública, igual para todo mundo:
 * não diz nada sobre conta nenhuma). Só pergunta quando vai prometer — a tela
 * de entrar não faz chamada nenhuma à toa.
 *
 * `null` = não se sabe (rede, servidor antigo): a tela não afirma nada além
 * do que a resposta de cada ação disser.
 */
function useEnvioDeEmail(perguntar: boolean): EnvioDeEmail | null {
  const [envio, setEnvio] = useState<EnvioDeEmail | null>(null);
  useEffect(() => {
    if (!perguntar) return;
    let vivo = true;
    apiRequest<EnvioDeEmail>('/loja/portal/envio-de-email', { anonymous: true })
      .then((r) => {
        if (vivo && r && typeof r.envioDeEmailAtivo === 'boolean') setEnvio(r);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [perguntar]);
  return envio;
}

/**
 * O aviso de e-mail não confirmado — e o campo do código (rodada 50).
 *
 * Enquanto a caixa de entrada não provar dona, a conta não puxa pedidos por
 * documento digitado — é o que impede alguém que só CONHECE o e-mail e o CPF
 * de outra pessoa de ler o histórico dela. O código de seis dígitos chegou
 * junto com o aviso de conta criada; aqui ele volta.
 */
function ConfirmarEmail({
  sessao,
  onVerificado,
}: {
  sessao: Sessao;
  onVerificado: () => void;
}) {
  const [codigo, setCodigo] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const envio = useEnvioDeEmail(true);

  const confirmar = async () => {
    setAviso(null);
    setEnviando(true);
    try {
      await comTokenPortal('/loja/portal/verificar-email', sessao.token, {
        method: 'POST',
        body: { code: codigo.trim() },
      });
      onVerificado();
    } catch (err) {
      setAviso(err instanceof ApiRequestError ? err.message : 'Não deu para confirmar agora.');
    } finally {
      setEnviando(false);
    }
  };

  const reenviar = async () => {
    setAviso(null);
    try {
      const r = await comTokenPortal<{ message?: string } | null>(
        '/loja/portal/reenviar-verificacao',
        sessao.token,
        { method: 'POST' },
      );
      // A frase é do servidor: "enviado" só quando o envio está ligado (GAP-PRD-200).
      setAviso(r?.message ?? 'Código novo enviado. Olhe também a caixa de spam.');
    } catch (err) {
      setAviso(err instanceof ApiRequestError ? err.message : 'Não deu para reenviar agora.');
    }
  };

  return (
    <section
      aria-label="Confirme seu e-mail"
      className="bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
        rounded-[var(--gs-radius)] p-4 mb-6"
    >
      <p className="font-semibold text-[var(--gs-purple-900)] m-0">
        Confirme seu e-mail
      </p>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-3">
        Um código de 6 dígitos confirma que <strong>{sessao.account.email}</strong> é seu — e
        libera vincular suas compras pelo CPF. Se ele não chegou, toque em
        "Enviar código".
      </p>
      {envio && !envio.envioDeEmailAtivo && envio.message && (
        <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] mt-0 mb-3">
          {envio.message}
        </p>
      )}
      {/*
        <form>: quem digita seis dígitos aperta Enter — e a <div> anterior
        deixava o gesto mudo. O "Enviar código" continua type="button" para o
        Enter nunca reenviar por engano.
      */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void confirmar();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          aria-label="Código de confirmação"
          className="border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
            px-3 py-2 w-32 tracking-widest text-center"
        />
        <button
          type="submit"
          disabled={enviando || codigo.trim().length !== 6}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer disabled:opacity-60"
        >
          Confirmar
        </button>
        <button
          type="button"
          onClick={() => void reenviar()}
          className="bg-transparent border-0 text-[var(--gs-purple-700)] underline cursor-pointer px-2 py-1"
        >
          Enviar código
        </button>
      </form>
      {aviso && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] mt-2 mb-0">
          {aviso}
        </p>
      )}
    </section>
  );
}

interface PedidoResumo {
  id: string;
  number: number;
  storeName: string;
  createdAt: string;
  totalCents: number;
  statusLabel: string;
  paymentStatusLabel: string | null;
  paymentMethod: string | null;
  deliveryMethod: string;
  trackingCode: string | null;
  /** A página pública da transportadora (GAP-PRD-119). Opcional: servidor antigo não manda. */
  trackingUrl?: string | null;
  carrierName?: string | null;
}

/**
 * O rastreio do pedido, como o servidor gravou na última consulta ao provedor
 * (GAP-PRD-119). Abrir esta tela não consulta ninguém; quando a consulta
 * falhou, `aviso` diz isso — e o link leva o cliente direto à transportadora.
 */
interface RastreioDoPedido {
  carrier: string | null;
  carrierName: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  status: string | null;
  statusLabel: string | null;
  viaProvedor: boolean;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  aviso: string | null;
  events: { status: string; description: string; occurredAt: string; origin: string }[];
}

interface PedidoDetalhe {
  id: string;
  number: number;
  storeName: string;
  createdAt: string;
  statusLabel: string;
  status: string;
  itemsCents: number;
  /** O cupom (GAP-PRD-123): itemsCents já é líquido dele. Zero = sem cupom. */
  discountCents?: number;
  couponCode?: string | null;
  shippingCents: number;
  totalCents: number;
  deliveryMethod: string;
  shippingZip: string | null;
  shippingAddress: string | null;
  /** O retrato do endereço de entrega em campos (GAP-PRD-115). */
  shippingAddressDetail?: { recipientName: string | null } | null;
  /** Em nome de quem e onde a nota sai (GAP-PRD-115). */
  billingAddress?: {
    name: string | null;
    street: string;
    number: string | null;
    city: string | null;
    state: string | null;
  } | null;
  trackingCode: string | null;
  carrierName?: string | null;
  trackingUrl?: string | null;
  tracking?: RastreioDoPedido | null;
  shippingServiceName: string | null;
  deliveryEstimate: DeliveryEstimate | null;
  customer: { name: string; email: string | null; document: string | null };
  items: {
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    /** A parte do cupom desta linha; totalCents já é líquido. */
    discountCents?: number;
    imageUrl: string | null;
  }[];
  payments: {
    method: string;
    status: string;
    statusLabel: string;
    amountCents: number;
    pixPayload: string | null;
    invoiceUrl: string | null;
  }[];
  /** `origin`: quem disse — 'provedor' (a transportadora) ou 'operador' (a loja). */
  timeline: { statusLabel: string; note: string | null; createdAt: string; origin?: string | null }[];
  /**
   * O pós-venda (GAP-PRD-125): nota fiscal e devolução. O link de rastreio
   * (`trackingUrl`) já está declarado acima, junto do rastreio (GAP-PRD-119).
   */
  notaFiscal?: NotaDoPedidoNoPortal | null;
  devolucao?: DevolucaoNoPortal | null;
}

/** O prazo, do jeito que o servidor manda. Ver `deliveryEstimate` no núcleo. */
interface DeliveryEstimate {
  kind: 'prometido' | 'previsto' | 'sem_prazo';
  days: number | null;
  dueDate: string | null;
  real: boolean;
}

/**
 * O prazo de entrega — e o cuidado de não prometer o que ninguém disse.
 *
 * Uma DATA só aparece quando a encomenda já saiu e há prazo cotado. Antes da
 * postagem, mostra-se o PRAZO, não a data: contar a partir de hoje anteciparia
 * a promessa a cada vez que o cliente abrisse a tela, e a separação ainda pode
 * demorar. Sem prazo nenhum, a tela diz isso — "chega em X dias" inventado é
 * dívida que a loja não contraiu.
 *
 * A origem acompanha: prazo de transportadora e estimativa da loja não valem
 * o mesmo, e esconder a diferença é fazer a loja responder por promessa que
 * ela não fez.
 */
function Prazo({ estimativa }: { estimativa?: DeliveryEstimate | null }) {
  if (!estimativa) return null;

  if (estimativa.kind === 'sem_prazo') {
    return (
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-2 mb-0">
        O prazo de entrega é confirmado pela loja na hora do envio.
      </p>
    );
  }

  const origem = estimativa.real ? 'prazo da transportadora' : 'estimativa da loja';

  if (estimativa.kind === 'prometido' && estimativa.dueDate) {
    return (
      <p className="text-[length:var(--gs-text-sm)] mt-2 mb-0">
        Previsão de entrega:{' '}
        <strong>
          {dataBR(estimativa.dueDate)}
        </strong>{' '}
        <span className="text-[var(--gs-muted)]">({origem})</span>
      </p>
    );
  }

  return (
    <p className="text-[length:var(--gs-text-sm)] mt-2 mb-0">
      Prazo de <strong>{contar(estimativa.days, 'dia útil', 'dias úteis')}</strong> a partir da postagem{' '}
      <span className="text-[var(--gs-muted)]">({origem})</span>
    </p>
  );
}

function dataHora(iso: string): string {
  return dataHoraBR(iso);
}

/**
 * O RASTREIO, PARA O CLIENTE (GAP-PRD-119).
 *
 * Era só "Rastreio: BR123..." em texto. Agora: quem leva, o link para a página
 * da transportadora, e os eventos que a transportadora informou — cada um com
 * a origem. Quando a última consulta ao provedor FALHOU, a tela diz isso em
 * vez de mostrar um rastreio parado como se estivesse em dia; o link continua
 * valendo, porque leva o cliente direto à fonte.
 *
 * Servidor de versão anterior não manda `tracking`: cai no código e no link
 * soltos, como antes.
 */
function RastreioDoCliente({ pedido }: { pedido: PedidoDetalhe }) {
  const r = pedido.tracking;
  const codigo = r?.trackingCode ?? pedido.trackingCode;
  const link = r?.trackingUrl ?? pedido.trackingUrl ?? null;
  const quem = r?.carrierName ?? pedido.carrierName ?? null;
  if (!codigo && !quem) return null;
  return (
    <div className="mt-2" data-testid="rastreio-do-pedido">
      <p className="text-[length:var(--gs-text-sm)] m-0">
        {quem && <strong>{quem}</strong>}
        {quem && codigo && ' · '}
        {codigo && (
          <>
            Rastreio: <span className="font-mono">{codigo}</span>
          </>
        )}
      </p>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] font-semibold"
        >
          Acompanhar na transportadora
        </a>
      )}
      {r?.aviso && (
        <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] mt-2 mb-0">
          {r.aviso}
        </p>
      )}
      {r && r.events.length > 0 && (
        <ul className="list-none p-0 mt-2 mb-0 flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
          {r.events.map((e, i) => (
            <li key={`${e.occurredAt}-${i}`}>
              <span className="text-[var(--gs-muted)]">{dataHora(e.occurredAt)}</span> — {e.description}
              <span className="text-[var(--gs-muted)]">
                {e.origin === 'provedor' ? ' (transportadora)' : e.origin === 'operador' ? ' (loja)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {r?.viaProvedor && r.lastSyncOk && r.lastSyncAt && (
        <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mt-1 mb-0">
          Atualizado com a transportadora em {dataHora(r.lastSyncAt)}.
        </p>
      )}
    </div>
  );
}

export default function MinhaContaPage() {
  const [sessao, setSessao] = useState<Sessao | null>(lerSessao);
  const [paramsDaUrl] = useSearchParams();
  const voltar = voltaDoCarrinho(paramsDaUrl.get('voltar'));
  const [pedidos, setPedidos] = useState<PedidoResumo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!sessao) return;
    setErro(null);
    try {
      const dados = await comToken<{ items: PedidoResumo[] }>(
        '/loja/portal/pedidos',
        sessao.token,
      );
      setPedidos(dados.items);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        guardarSessao(null);
        setSessao(null);
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar seus pedidos.');
    }
  }, [sessao]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    TROCAR DE CONTA ZERA A LISTA (rodada 57).

    Sair e outra pessoa entrar no MESMO navegador — o computador da casa, o
    balcão da loja — mantinha `pedidos` da conta anterior: a tela mostrava os
    pedidos de quem saiu enquanto a chamada da conta nova não voltava, e o
    gate de carregamento novo não pegava, porque `pedidos` já não era null.
    Pedido de outra pessoa na tela é vazamento, não atraso.
  */
  useEffect(() => {
    setPedidos(null);
  }, [sessao?.token]);

  if (!sessao) {
    return (
      <CascaDaLoja larguraMax="max-w-4xl">
        <Acesso
          voltar={voltar}
          onEntrou={(s) => {
            guardarSessao(s);
            setSessao(s);
          }}
        />
      </CascaDaLoja>
    );
  }

  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] m-0">
            Meus pedidos
          </h1>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
            {sessao.account.email}
          </p>
          {/* Veio do carrinho de uma loja que exige conta: o caminho de volta. */}
          {voltar && (
            <Link
              to={voltar}
              className="block mt-2 font-semibold text-[var(--gs-purple-700)]"
            >
              Voltar ao carrinho e finalizar →
            </Link>
          )}
          <Link
            to="/minha-conta/equipamentos"
            className="inline-block mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]
              underline"
          >
            Meus equipamentos e chamados da oficina →
          </Link>
        </div>
        <button
          type="button"
          onClick={() => {
            // Sai do portal. Pedidos e o carrinho continuam guardados NA
            // CONTA; a cópia do carrinho sai deste aparelho (GAP-PRD-193).
            void apiRequest('/loja/portal/sair', {
              method: 'POST',
              anonymous: true,
              headers: { 'x-portal-token': sessao.token },
            }).catch(() => undefined);
            esquecerCarrinhoDaConta();
            guardarSessao(null);
            setSessao(null);
          }}
          className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer"
        >
          Sair
        </button>
      </div>

      {!sessao.account.emailVerifiedAt && (
        <ConfirmarEmail
          sessao={sessao}
          onVerificado={() => {
            const nova = {
              ...sessao,
              account: { ...sessao.account, emailVerifiedAt: new Date().toISOString() },
            };
            guardarSessao(nova);
            setSessao(nova);
            // Os pedidos podem ter acabado de chegar com a co-prova.
            void carregar();
          }}
        />
      )}

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] mb-4">
          {erro}
        </p>
      )}

      {/*
        O carregando que faltava: `pedidos` nasce null e a área ficava em
        branco até a resposta — quem entra na conta vem acompanhar uma compra,
        e num 4G lento lia o título seguido dos endereços, como se os pedidos
        tivessem sumido.
      */}
      {pedidos === null && !erro && (
        <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Carregando seus pedidos…
        </p>
      )}

      {pedidos && pedidos.length === 0 && (
        <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-8 text-center">
          <p className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] m-0">
            Nenhum pedido ainda
          </p>
          <Link to="/loja" className="text-[var(--gs-purple-700)]">
            Ver a loja
          </Link>
        </div>
      )}

      <ul className="list-none p-0 m-0 flex flex-col gap-3">
        {(pedidos ?? []).map((p) => (
          <li
            key={p.id}
            className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-purple-700)]">
                  {p.storeName}
                </span>
                <strong className="block text-[length:var(--gs-text-lg)]">Pedido #{p.number}</strong>
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {dataHora(p.createdAt)} · {p.deliveryMethod === 'retirada' ? 'Retirada' : 'Entrega'}
                </span>
              </div>
              <div className="text-right">
                <strong className="block text-[length:var(--gs-text-lg)]">
                  {formatCents(p.totalCents)}
                </strong>
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {p.statusLabel}
                </span>
              </div>
            </div>
            {p.trackingCode && (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-2 mb-0">
                Rastreio{p.carrierName ? ` (${p.carrierName})` : ''}:{' '}
                {/* O link da transportadora, montado pelo servidor
                    (GAP-PRD-119): o código sozinho mandava o cliente adivinhar
                    em que site procurar. */}
                {p.trackingUrl ? (
                  <a
                    href={p.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[var(--gs-purple-700)]"
                  >
                    {p.trackingCode}
                  </a>
                ) : (
                  <span className="font-mono">{p.trackingCode}</span>
                )}
              </p>
            )}
            <Link
              to={`/minha-conta/pedidos/${p.id}`}
              className="inline-block mt-3 text-[var(--gs-purple-700)] font-semibold"
            >
              Ver detalhes
            </Link>
          </li>
        ))}
      </ul>

      {/* O controle que a conta prometia e não tinha (GAP-PRD-028/043). */}
      <TrazerMinhasCompras
        token={sessao.token}
        email={sessao.account.email}
        verificado={Boolean(sessao.account.emailVerifiedAt)}
        onTrouxe={() => void carregar()}
      />

      {/* Endereços e senha ficam abaixo dos pedidos: quem abre "Minha conta"
          vem quase sempre para acompanhar uma compra, não para editar cadastro. */}
      <ContaDoCliente token={sessao.token} />

      {/* Ligar/desligar a entrada pelo Google (GAP-PRD-027). Some sozinho
          quando a loja não oferece e a conta não está ligada. */}
      <GoogleNaConta token={sessao.token} />
    </CascaDaLoja>
  );
}

/**
 * Entrar ou criar acesso.
 *
 * Criar exige e-mail E documento usados numa compra: sem envio de e-mail, é a
 * prova possível de que a pessoa realmente comprou. O documento NÃO é a senha
 * — ela é escolhida aqui.
 */
type ModoAcesso = 'entrar' | 'criar' | 'recuperar';

function Acesso({ onEntrou, voltar }: { onEntrou: (s: Sessao) => void; voltar?: string | null }) {
  const [modo, setModo] = useState<ModoAcesso>('entrar');
  const [form, setForm] = useState({
    name: '',
    email: '',
    document: '',
    password: '',
    confirmacao: '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  /** O aceite dos termos — obrigatório para CRIAR (LGPD, rodada 45). */
  const [aceitei, setAceitei] = useState(false);
  // Só "recuperar" promete e-mail — só ali a tela pergunta (GAP-PRD-200).
  const envio = useEnvioDeEmail(modo === 'recuperar');

  const enviar = async (event: React.FormEvent) => {
    event.preventDefault();
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      /*
        CRIAR CONFERE ANTES DE ENVIAR (GAP-PRD-192): o nome, e a senha digitada
        duas vezes. Um dedo escorregado no celular criava uma senha que a
        pessoa não sabia qual era. A lista das senhas óbvias é do servidor.
      */
      if (modo === 'criar') {
        const problema = !form.name.trim()
          ? 'Informe seu nome.'
          : problemaDaSenhaNova(form.password, form.confirmacao);
        if (problema) {
          setErro(problema);
          return;
        }
      }
      if (modo === 'recuperar') {
        // Resposta é sempre a mesma, exista a conta ou não — a tela não pode
        // revelar quem tem conta.
        const r = await apiRequest<{ message?: string } | null>('/loja/portal/recuperar-senha', {
          method: 'POST',
          anonymous: true,
          body: { email: form.email },
        });
        // A frase vem do servidor, que sabe se o envio está ligado — e ela é
        // a mesma exista a conta ou não (GAP-PRD-200).
        setAviso(
          r?.message
            ?? 'Se houver uma conta com esse e-mail, enviamos um link para redefinir a senha. '
              + 'Confira sua caixa de entrada.',
        );
        return;
      }
      onEntrou(
        await apiRequest<Sessao>(
          modo === 'entrar' ? '/loja/portal/entrar' : '/loja/portal/registrar',
          {
            method: 'POST',
            anonymous: true,
            body:
              modo === 'entrar'
                ? { email: form.email, password: form.password }
                // O documento é OPCIONAL: sem ele a conta nasce e fica vazia
                // até o cliente vincular. Enviar string vazia é o mesmo que
                // não enviar — o servidor só vincula na co-prova.
                : {
                    // O nome nasce na conta (GAP-PRD-192).
                    name: form.name.trim(),
                    email: form.email,
                    document: form.document,
                    password: form.password,
                    // O aceite viaja como BOOLEANO — o servidor só reconhece true.
                    termsAccepted: aceitei,
                  },
          },
        ),
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível entrar.');
    } finally {
      setOcupado(false);
    }
  };

  const titulo =
    modo === 'entrar' ? 'Entrar' : modo === 'criar' ? 'Criar acesso' : 'Recuperar senha';

  return (
    <div className="max-w-md mx-auto bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-6">
      <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-1">
        {titulo}
      </h1>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
        {modo === 'entrar'
          ? 'Acompanhe seus pedidos das lojas do Grupo Sampaio.'
          : modo === 'criar'
            ? 'Basta seu nome, um e-mail e uma senha. Já comprou com a gente? Informe o CPF para trazer seus pedidos.'
            : envio && !envio.envioDeEmailAtivo && envio.message
              ? envio.message
              : 'Informe seu e-mail e enviaremos um link para escolher uma nova senha.'}
      </p>

      <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3">
        {modo === 'criar' && (
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Nome</span>
            <input
              required
              autoComplete="name"
              aria-label="Nome"
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--gs-text-sm)] font-semibold">E-mail</span>
          <input
            required
            type="email"
            aria-label="E-mail"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
        </label>

        {modo === 'criar' && (
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              CPF ou CNPJ <span className="text-[var(--gs-muted)] font-normal">(opcional)</span>
            </span>
            <input
              inputMode="numeric"
              aria-label="CPF ou CNPJ"
              value={form.document}
              onChange={(e) => setForm({ ...form, document: e.target.value })}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Traz os pedidos que você já fez com esse documento. Dá para informar depois.
            </span>
          </label>
        )}

        {modo === 'criar' && (
          <SenhaNovaComConfirmacao
            senha={form.password}
            confirmacao={form.confirmacao}
            onSenha={(v) => setForm((f) => ({ ...f, password: v }))}
            onConfirmacao={(v) => setForm((f) => ({ ...f, confirmacao: v }))}
          />
        )}

        {modo === 'entrar' && (
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Senha</span>
            <input
              required
              type="password"
              autoComplete="current-password"
              aria-label="Senha"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
        )}

        {modo === 'criar' && (
          <label className="flex items-start gap-2 text-[length:var(--gs-text-sm)]">
            <input
              type="checkbox"
              checked={aceitei}
              onChange={(e) => setAceitei(e.target.checked)}
              aria-label="Aceito os termos e a política de privacidade"
              className="mt-1"
            />
            <span>
              Li e aceito os{' '}
              <Link to="/termos-de-uso" target="_blank">
                Termos de Uso
              </Link>{' '}
              e a{' '}
              <Link to="/politica-de-privacidade" target="_blank">
                Política de Privacidade
              </Link>
              . A data do aceite fica registrada.
            </span>
          </label>
        )}

        {erro && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
            {erro}
          </p>
        )}
        {aviso && (
          <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-success)] m-0">
            {aviso}
          </p>
        )}

        <button
          type="submit"
          disabled={ocupado || (modo === 'criar' && !aceitei)}
          className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white border-0
            rounded-[var(--gs-radius)] px-4 py-3 cursor-pointer font-semibold disabled:opacity-50"
        >
          {ocupado
            ? 'Aguarde…'
            : modo === 'entrar'
              ? 'Entrar'
              : modo === 'criar'
                ? 'Criar acesso'
                : 'Enviar link'}
        </button>
      </form>

      {/*
        Entrar/criar com Google (GAP-PRD-027). Só aparece se a loja oferece.
        Em "criar", o aceite marcado acima vai junto; sem ele, a volta do
        Google pede o aceite antes de criar a conta. Quem veio do carrinho
        volta para o carrinho.
      */}
      {modo !== 'recuperar' && (
        <div className="mt-4">
          <EntrarComGoogle
            termsAccepted={modo === 'criar' ? aceitei : undefined}
            returnTo={voltar ?? null}
            rotulo={modo === 'criar' ? 'Criar conta com Google' : 'Entrar com Google'}
          />
        </div>
      )}

      <div className="mt-4 flex flex-col gap-1 items-start">
        <button
          type="button"
          onClick={() => {
            setModo(modo === 'entrar' ? 'criar' : 'entrar');
            setErro(null);
            setAviso(null);
          }}
          className="bg-transparent border-0 text-[var(--gs-purple-700)] cursor-pointer p-0 underline"
        >
          {modo === 'entrar' ? 'Ainda não tenho acesso' : 'Já tenho acesso'}
        </button>
        {modo === 'entrar' && (
          <button
            type="button"
            onClick={() => {
              setModo('recuperar');
              setErro(null);
              setAviso(null);
            }}
            className="bg-transparent border-0 text-[var(--gs-purple-700)] cursor-pointer p-0 underline"
          >
            Esqueci minha senha
          </button>
        )}
      </div>
    </div>
  );
}

/** Detalhe do pedido. Rota própria para o cliente poder guardar o link. */
export function MeuPedidoPage() {
  const { orderId = '' } = useParams();
  const [sessao] = useState<Sessao | null>(lerSessao);
  const [pedido, setPedido] = useState<PedidoDetalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  /*
    A falha do REFRESH é outra coisa que a falha da CARGA (rodada 57). O
    polling de 15s chama o mesmo `carregar`, e o catch antigo derrubava a
    página inteira — com o PIX copia-e-cola que o cliente estava usando — e
    ainda dizia "Pedido não encontrado", que era mentira: a rede piscou. Com
    o pedido em mãos, a falha vira um aviso discreto e a tela fica de pé.
  */
  const [erroAtualizacao, setErroAtualizacao] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [erroCancelar, setErroCancelar] = useState<string | null>(null);
  // O pedido que JÁ está na tela, para o catch decidir sem recriar o efeito
  // do polling a cada resposta.
  const pedidoRef = useRef<PedidoDetalhe | null>(null);
  useEffect(() => {
    pedidoRef.current = pedido;
  }, [pedido]);

  /*
    O DIÁLOGO E O TECLADO (rodada 57). O que faltava, medido com a lente de
    acessibilidade: abrir não movia o foco (o teclado continuava atrás do
    véu), Escape não fechava, e fechar largava o foco no <body> — a pessoa
    recomeçava a página do zero. O foco de abertura nasce em "Manter pedido":
    Enter apertado por reflexo mantém, nunca cancela.
  */
  const dialogoRef = useRef<HTMLDivElement | null>(null);
  const abridorDoDialogoRef = useRef<HTMLButtonElement | null>(null);
  const tituloDoPedidoRef = useRef<HTMLHeadingElement | null>(null);
  /*
    A MOLDURA PRENDE O FOCO PELA ARMADILHA DA CASA (GAP-PRD-159) — no
    DOCUMENTO, como a rodada 57 exigiu: o Tab e o foco que escapa voltam para
    dentro de qualquer lugar da página, mesmo depois de o botão que abriu
    desmontar. O foco entra no "Manter" (`data-foco-inicial`), e ao fechar
    volta a quem abriu.
  */
  useArmadilhaDeFoco(dialogoRef, { ativa: confirmando, focoInicial: '[data-foco-inicial]' });

  /*
    O que é SÓ deste diálogo fica aqui:
    - Escape com a requisição em voo não fecha: o pedido pode estar sendo
      cancelado neste instante, e sumir com o diálogo esconde o desfecho.
    - Cancelar com sucesso tira o pedido de "aguardando pagamento" e o botão
      "Cancelar pedido" deixa de existir; a armadilha devolve o foco a quem
      abriu só se ele ainda está na tela. Com o abridor fora do documento, o
      foco vai para o título do pedido, que sempre está lá — senão o teclado
      caía no <body> depois da ação mais importante da tela.
  */
  useEffect(() => {
    if (!confirmando) return undefined;
    // Congelados NA ABERTURA: na limpeza os refs podem já apontar para outro render.
    const abridor = abridorDoDialogoRef.current;
    const titulo = tituloDoPedidoRef.current;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cancelandoRef.current) setConfirmando(false);
    };
    document.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      if (!abridor?.isConnected && titulo?.isConnected) titulo.focus();
    };
  }, [confirmando]);

  /** Espelha `cancelando` para o listener de Escape, que não é recriado. */
  const cancelandoRef = useRef(false);
  useEffect(() => {
    cancelandoRef.current = cancelando;
  }, [cancelando]);

  const carregar = useCallback(async () => {
    if (!sessao) return;
    try {
      setPedido(await comToken<PedidoDetalhe>(`/loja/portal/pedidos/${orderId}`, sessao.token));
      setErro(null);
      setErroAtualizacao(null);
    } catch (err) {
      /*
        FALHA DEFINITIVA NÃO É "TENTANDO DE NOVO". O polling roda justamente
        na tela do PIX, onde o cliente fica minutos — e a sessão do portal
        vence em uma hora, sem renovação. Tratar o 401 como rede piscando
        deixaria a página martelando um 401 a cada 15 segundos, prometendo uma
        atualização que nunca vem, e quem pagou nunca veria o pedido virar
        "pago". Só o transitório — rede ou 5xx — vira o aviso discreto.
      */
      const definitivo = err instanceof ApiRequestError && err.status < 500;
      if (pedidoRef.current && !definitivo) {
        setErroAtualizacao('Não foi possível atualizar agora. Tentando de novo…');
        return;
      }
      if (err instanceof ApiRequestError && err.status === 401) {
        // A sessão morreu: a tela diz isso e oferece a porta, como a lista faz.
        guardarSessao(null);
        setErro('Sua sessão venceu. Entre de novo para acompanhar este pedido.');
        setErroAtualizacao(null);
        setPedido(null);
        pedidoRef.current = null;
        return;
      }
      /*
        "Não encontrado" SÓ quando o servidor disser (o err.message do 404 já
        diz). Falha de rede é TypeError, e chamá-la de "não encontrado" faz o
        cliente concluir que o pedido sumiu — e que não deve pagar.
      */
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível carregar o pedido agora.',
      );
    }
  }, [orderId, sessao]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * Enquanto o pagamento não resolve, a página se atualiza sozinha.
   *
   * Para em estado terminal: ficar consultando um pedido entregue é gastar
   * bateria do cliente por nada.
   */
  useEffect(() => {
    if (!pedido) return undefined;
    const terminal = ['pago', 'entregue', 'cancelado', 'reembolsado'].includes(pedido.status);
    if (terminal) return undefined;
    const id = setInterval(() => void carregar(), 15_000);
    return () => clearInterval(id);
  }, [pedido, carregar]);

  if (!sessao) {
    return (
      <CascaDaLoja larguraMax="max-w-4xl">
        <p className="text-[length:var(--gs-text-lg)]">
          <Link to="/minha-conta" className="text-[var(--gs-purple-700)]">
            Entre na sua conta
          </Link>{' '}
          para ver este pedido.
        </p>
      </CascaDaLoja>
    );
  }

  if (erro) {
    return (
      <CascaDaLoja larguraMax="max-w-4xl">
        <p role="alert" className="text-[var(--gs-danger)]">
          {erro}
        </p>
        <Link to="/minha-conta" className="text-[var(--gs-purple-700)]">
          Voltar para meus pedidos
        </Link>
      </CascaDaLoja>
    );
  }

  if (!pedido) {
    return (
      <CascaDaLoja larguraMax="max-w-4xl">
        <p className="text-[var(--gs-muted)]">Carregando…</p>
      </CascaDaLoja>
    );
  }

  const pixPendente = pedido.payments.find(
    (p) => p.method === 'pix' && p.status === 'pending' && p.pixPayload,
  );

  /**
   * O botão só existe enquanto cancelar é possível de verdade.
   *
   * Depois do pagamento o servidor recusa, e mostrar um botão que sempre dá
   * erro é pior do que não mostrar botão nenhum: o cliente conclui que o
   * cancelamento foi feito e some.
   */
  const cancelavel = pedido.status === 'aguardando_pagamento';

  /**
   * Pagamento que caiu depois do cancelamento. Não é motivo de pânico nem
   * pode ficar escondido: o cliente pagou e precisa ver que a loja sabe.
   */
  const pagoAposCancelar = pedido.payments.find((p) => p.status === 'paid_after_cancel');

  const cancelar = async () => {
    if (!sessao) return;
    setCancelando(true);
    setErroCancelar(null);
    try {
      await apiRequest(`/loja/portal/pedidos/${orderId}/cancelar`, {
        method: 'POST',
        anonymous: true,
        headers: { 'x-portal-token': sessao.token },
      });
      setConfirmando(false);
      await carregar();
    } catch (err) {
      setErroCancelar(
        err instanceof ApiRequestError ? err.message : 'Não foi possível cancelar agora.',
      );
      // A tela recarrega mesmo no erro: quase sempre o motivo é que o pedido
      // mudou de estado (pagou, entrou em separação), e o cliente precisa ver
      // o estado novo, não o antigo com uma mensagem em cima.
      await carregar();
    } finally {
      setCancelando(false);
    }
  };

  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <Link to="/minha-conta" className="text-[var(--gs-purple-700)] text-[length:var(--gs-text-sm)]">
        ← Meus pedidos
      </Link>

      {erroAtualizacao && (
        <p
          role="status"
          className="mt-3 mb-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
        >
          {erroAtualizacao}
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3 mt-3 mb-5">
        <div>
          <span className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-purple-700)]">
            {pedido.storeName}
          </span>
          {/* tabIndex -1: não entra na tabulação, mas é alvo estável para o
              foco voltar quando o botão que abriu o diálogo desmonta. */}
          <h1
            ref={tituloDoPedidoRef}
            tabIndex={-1}
            className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] m-0"
          >
            Pedido #{pedido.number}
          </h1>
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {dataHora(pedido.createdAt)}
          </span>
        </div>
        <span className="px-3 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] font-semibold">
          {pedido.statusLabel}
        </span>
      </div>

      {pagoAposCancelar && (
        <section
          role="status"
          data-testid="pedido-pago-apos-cancelamento"
          className="mb-5 bg-[var(--gs-warning-bg)] border border-[var(--gs-warning)]
            rounded-[var(--gs-radius-lg)] p-5"
        >
          <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-warning)] mt-0 mb-2">
            Recebemos um pagamento depois do cancelamento
          </h2>
          <p className="text-[length:var(--gs-text-sm)] m-0">
            O pedido foi cancelado e continua cancelado — os itens voltaram para o estoque e
            podem já ter sido vendidos. O pagamento de {formatCents(pagoAposCancelar.amountCents)}{' '}
            está registrado e a loja vai entrar em contato para devolver o valor ou refazer o
            pedido. Você não precisa pagar de novo.
          </p>
        </section>
      )}

      {pixPendente && (
        <section className="mb-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] m-0">
              Pague com PIX
            </h2>
            <span
              className="px-2 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                text-[length:var(--gs-text-xs)] font-semibold text-[var(--gs-warning)]"
            >
              AGUARDANDO PAGAMENTO
            </span>
          </div>
          <label
            htmlFor="pix-pedido"
            className="text-[length:var(--gs-text-sm)] font-semibold block mb-1"
          >
            PIX copia e cola
          </label>
          <textarea
            id="pix-pedido"
            readOnly
            rows={3}
            value={pixPendente.pixPayload ?? ''}
            /* xs só do md em diante — ver a nota do mesmo campo na LojaPage:
               a classe derrotava o piso de 16px do toque no campo do PIX. */
            className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
              font-mono md:text-[length:var(--gs-text-xs)] break-all"
          />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(pixPendente.pixPayload ?? '')
                .then(() => setCopiado(true), () => setCopiado(false));
            }}
            className="mt-2 bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
              border-0 rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
          >
            {copiado ? 'Copiado' : 'Copiar código'}
          </button>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] mt-3 mb-0">
            Assim que o pagamento for confirmado, esta página atualiza sozinha.
          </p>
        </section>
      )}

      <section className="mb-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5">
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
          Itens
        </h2>
        <ul className="list-none p-0 m-0">
          {pedido.items.map((i, idx) => (
            <li
              key={`${i.description}-${idx}`}
              className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)] last:border-0"
            >
              <span>
                <strong>{i.description}</strong>
                <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {i.quantity} × {formatCents(i.unitPriceCents)}
                </span>
              </span>
              {/* O valor da linha ANTES do cupom: o desconto aparece uma vez, no
                  resumo — somar linhas líquidas com o cupom embaixo contaria o
                  desconto duas vezes na cabeça de quem lê. */}
              <strong>{formatCents(i.totalCents + (i.discountCents ?? 0))}</strong>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 mt-4 mb-0 max-w-xs ml-auto text-right">
          <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Itens</dt>
          <dd className="m-0">{formatCents(pedido.itemsCents + (pedido.discountCents ?? 0))}</dd>
          {(pedido.discountCents ?? 0) > 0 && (
            <>
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Cupom {pedido.couponCode}
              </dt>
              <dd className="m-0 text-[var(--gs-success)]">−{formatCents(pedido.discountCents ?? 0)}</dd>
            </>
          )}
          <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Frete</dt>
          <dd className="m-0">{formatCents(pedido.shippingCents)}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="m-0 font-semibold">{formatCents(pedido.totalCents)}</dd>
        </dl>
      </section>

      <section className="mb-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5">
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
          {pedido.deliveryMethod === 'retirada' ? 'Retirada' : 'Entrega'}
        </h2>
        <p className="text-[length:var(--gs-text-sm)] m-0">
          {pedido.deliveryMethod === 'retirada'
            ? 'Você retira na loja quando o pedido estiver pronto.'
            : pedido.shippingAddress
              ? `${pedido.shippingAddress}${pedido.shippingZip ? ` · CEP ${pedido.shippingZip}` : ''}`
              : 'Endereço será confirmado com a loja.'}
        </p>
        {pedido.deliveryMethod !== 'retirada' && pedido.shippingAddressDetail?.recipientName && (
          <p className="text-[length:var(--gs-text-sm)] mt-1 mb-0">
            Quem recebe: {pedido.shippingAddressDetail.recipientName}
          </p>
        )}
        {/* O endereço da NOTA, como ficou guardado na compra (GAP-PRD-115). */}
        {pedido.billingAddress && (
          <p className="text-[length:var(--gs-text-sm)] mt-2 mb-0 text-[var(--gs-muted)]">
            Nota fiscal em nome de {pedido.billingAddress.name ?? pedido.customer.name}:{' '}
            {pedido.billingAddress.street}
            {pedido.billingAddress.number ? `, ${pedido.billingAddress.number}` : ''}
            {pedido.billingAddress.city ? ` · ${pedido.billingAddress.city}/${pedido.billingAddress.state ?? ''}` : ''}
          </p>
        )}
        {/* O rastreio é UM só (GAP-PRD-119 + GAP-PRD-125): quem leva, o código,
            o link que o servidor montou e os eventos com origem. */}
        {pedido.deliveryMethod !== 'retirada' && <RastreioDoCliente pedido={pedido} />}
        {pedido.deliveryMethod !== 'retirada' && <Prazo estimativa={pedido.deliveryEstimate} />}
      </section>

      <section className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5">
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
          Acompanhamento
        </h2>
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {pedido.timeline.map((e, i) => (
            <li key={`${e.createdAt}-${i}`} className="flex gap-3 text-[length:var(--gs-text-sm)]">
              <span className="text-[var(--gs-muted)] whitespace-nowrap">
                {dataHora(e.createdAt)}
              </span>
              <span>
                <strong>{e.statusLabel}</strong>
                {/* Quem disse (GAP-PRD-119): "entregue" pela transportadora e
                    pela loja não valem o mesmo para quem espera a encomenda. */}
                {e.origin === 'provedor' && (
                  <span className="text-[var(--gs-muted)]"> · informado pela transportadora</span>
                )}
                {e.origin === 'operador' && (
                  <span className="text-[var(--gs-muted)]"> · informado pela loja</span>
                )}
                {e.note && (
                  <span className="block text-[var(--gs-muted)]">{e.note}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* A nota da compra e a devolução pelo portal (GAP-PRD-125). */}
      {sessao && (
        <NotaDoPedido
          orderId={orderId}
          token={sessao.token}
          nota={pedido.notaFiscal ?? null}
          pago={pedido.status !== 'aguardando_pagamento' && pedido.status !== 'cancelado'}
        />
      )}
      {sessao && pedido.devolucao && (
        <DevolucaoDoPedido
          orderId={orderId}
          token={sessao.token}
          devolucao={pedido.devolucao}
          aoMudar={carregar}
        />
      )}

      {cancelavel && (
        <section className="mt-5 text-center">
          <button
            type="button"
            ref={abridorDoDialogoRef}
            onClick={() => setConfirmando(true)}
            className="bg-transparent border border-[var(--gs-danger)] text-[var(--gs-danger)]
              rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
          >
            Cancelar pedido
          </button>
          <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mt-2 mb-0">
            Só é possível cancelar enquanto o pagamento não é confirmado.
          </p>
          {erroCancelar && (
            <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] mt-2 mb-0">
              {erroCancelar}
            </p>
          )}
        </section>
      )}

      {confirmando && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancelar-titulo"
          ref={dialogoRef}
          tabIndex={-1}
          /* O trap de Tab, o Escape e a devolução do foco vivem no efeito de
             `confirmando` — no documento, para segurarem mesmo se o foco
             escapar. */
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md bg-[var(--gs-surface)] rounded-[var(--gs-radius-lg)] p-5">
            <h2
              id="cancelar-titulo"
              className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0"
            >
              Cancelar o pedido #{pedido.number}?
            </h2>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Os itens voltam para o estoque e o código PIX deixa de valer. Não dá para desfazer:
              se mudar de ideia, será preciso fazer um pedido novo, e o preço ou a
              disponibilidade podem ter mudado.
            </p>
            {/*
              O ERRO DENTRO DO DIÁLOGO (rodada 57). Falhar não fecha o
              diálogo — e a mensagem morava na seção de baixo, atrás do véu:
              quem clicava "Sim, cancelar" e batia num erro via o botão voltar
              ao normal e mais nada, sem saber se cancelou.
            */}
            {erroCancelar && (
              <p
                role="alert"
                className="m-0 mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
              >
                {erroCancelar}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                data-foco-inicial
                onClick={() => setConfirmando(false)}
                disabled={cancelando}
                className="bg-transparent border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer"
              >
                Manter pedido
              </button>
              <button
                type="button"
                onClick={() => void cancelar()}
                disabled={cancelando}
                className="bg-[var(--gs-danger)] text-white border-0 rounded-[var(--gs-radius)]
                  px-4 py-2 cursor-pointer font-semibold disabled:opacity-60"
              >
                {cancelando ? 'Cancelando…' : 'Sim, cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CascaDaLoja>
  );
}

/** Casca da loja — o portal do cliente não é tela administrativa. */

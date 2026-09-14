/**
 * O checkout COM CONTA, na vitrine (GAP-PRD-028 e GAP-PRD-043).
 *
 * A auditoria entrou pelo navegador: criou a conta, provou o e-mail, salvou o
 * endereço, fechou o pedido — e "Meus pedidos" dizia "Nenhum pedido ainda". A
 * tela mandava o checkout como visitante (`anonymous: true`, sem o token do
 * portal), não pré-preenchia nada e ignorava o endereço salvo.
 *
 * Os pedaços, num arquivo próprio para a `LojaPage` só os encaixar:
 *
 *   - `EntreParaComprar`: a loja exige conta e ninguém entrou. O carrinho fica
 *     guardado; o link leva à conta e a conta traz de volta.
 *   - `CompradorDaConta`: quem está comprando. Mostra o e-mail da conta (é ele
 *     que vai no pedido), pré-preenche nome e telefone do perfil, e pede o
 *     CPF/CNPJ só enquanto a conta não tem um. Diz o que falta ANTES do clique;
 *     o servidor confere de novo no fechamento.
 *   - `EnderecoDaConta`: os endereços salvos de ENTREGA, com o padrão já
 *     escolhido, e o cadastro de um novo ali mesmo (GAP-PRD-115);
 *   - `FaturamentoDaConta`: o endereço da NOTA FISCAL (com IBGE), que o
 *     pedido guarda em campos junto com o de entrega (GAP-PRD-115).
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiRequestError } from '@/lib/api/client';
import { comTokenPortal, type SessaoPortal } from '@/lib/portalSession';
import type { PerfilDoServidor } from '@/components/gs/ContaDoCliente';
import { FormularioDeEndereco } from '@/components/gs/FormularioDeEndereco';
import {
  ENDERECO_VAZIO,
  descreverFalta,
  enderecosApi,
  faltaParaEntregar,
  paraFormulario,
  serveParaEntrega,
  serveParaFaturamento,
  type DadosDoEndereco,
  type EnderecoDaConta as EnderecoDaContaApi,
} from '@/lib/api/enderecos';

const CAMPO = 'px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]';

/** CEP formatado só para leitura; o servidor guarda os 8 dígitos. */
function cep(digitos: string): string {
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : digitos;
}

/** A loja exige conta e não há sessão: entrar, e voltar ao carrinho. */
export function EntreParaComprar() {
  // A conta traz de volta para ESTA vitrine (a da marca ou a do grupo), com o
  // carrinho aberto — ver o 'voltar' da MinhaContaPage.
  const { pathname } = useLocation();
  return (
    <div
      role="status"
      className="sm:col-span-3 bg-[var(--gs-info-bg)] border border-[var(--gs-border)]
        rounded-[var(--gs-radius)] p-4"
    >
      <p className="m-0 font-semibold text-[var(--gs-purple-900)]">
        Para comprar, entre na sua conta
      </p>
      <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        Seu pedido fica guardado na conta, para acompanhar a entrega e o pagamento. Ainda não tem
        conta? Leva um minuto. O carrinho continua aqui.
      </p>
      <Link
        to={`/minha-conta?voltar=${encodeURIComponent(pathname)}`}
        className="inline-block mt-3 bg-[var(--gs-purple-700)] text-white rounded-[var(--gs-radius)]
          px-4 py-2 font-semibold no-underline"
      >
        Entrar ou criar conta
      </Link>
    </div>
  );
}

export interface DadosDoComprador {
  name: string;
  document: string;
  phone: string;
}

export function CompradorDaConta({
  sessao,
  dados,
  onCampo,
  onPerfil,
  onBloqueio,
}: {
  sessao: SessaoPortal;
  dados: DadosDoComprador;
  onCampo: (campos: Partial<DadosDoComprador>) => void;
  /** O perfil chegou: quem usa decide o que pré-preencher (sem apagar o digitado). */
  onPerfil: (perfil: PerfilDoServidor) => void;
  /** Motivo para não deixar finalizar, ou nulo. */
  onBloqueio: (motivo: string | null) => void;
}) {
  const [perfil, setPerfil] = useState<PerfilDoServidor | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    comTokenPortal<PerfilDoServidor>('/loja/portal/perfil', sessao.token)
      .then((p) => {
        if (!vivo) return;
        setPerfil(p);
        setErro(null);
        onPerfil(p);
      })
      .catch((err) => {
        if (!vivo) return;
        setErro(
          err instanceof ApiRequestError
            ? err.message
            : 'Não deu para carregar seus dados — preencha abaixo.',
        );
      });
    return () => {
      vivo = false;
    };
    // O perfil é lido uma vez por sessão; `onPerfil` muda a cada render da loja.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao.token]);

  // A caixa provada é a primeira regra do fechamento: é para ela que o pedido
  // e o PIX vão, e é ela que põe o pedido na conta.
  const verificado = Boolean(sessao.account.emailVerifiedAt) || Boolean(perfil?.emailVerified);
  useEffect(() => {
    onBloqueio(
      verificado ? null : 'Confirme seu e-mail na sua conta para finalizar — o código está na sua caixa de entrada.',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verificado]);

  const temDocumento = Boolean(perfil?.hasDocument);

  return (
    <>
      <div className="sm:col-span-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-[length:var(--gs-text-sm)]">
          Comprando como <strong>{sessao.account.email}</strong>
        </p>
        <Link to="/minha-conta" className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]">
          Minha conta
        </Link>
      </div>
      {!verificado && (
        <p role="alert" className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          Confirme seu e-mail para finalizar: o código de 6 dígitos está na sua caixa de entrada.{' '}
          <Link to="/minha-conta">Confirmar agora</Link>
        </p>
      )}
      {erro && (
        <p role="alert" className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      <input
        required
        placeholder="Seu nome"
        aria-label="Nome"
        value={dados.name}
        onChange={(e) => onCampo({ name: e.target.value })}
        className={CAMPO}
      />
      {temDocumento ? (
        <input
          disabled
          aria-label="CPF ou CNPJ"
          value={perfil?.documentMasked ?? ''}
          title="O CPF/CNPJ da sua conta. Para trocar, fale com a loja."
          className={`${CAMPO} bg-[var(--gs-surface-hover)] text-[var(--gs-muted)]`}
        />
      ) : (
        <input
          required
          placeholder="CPF ou CNPJ"
          aria-label="CPF ou CNPJ"
          inputMode="numeric"
          value={dados.document}
          onChange={(e) => onCampo({ document: e.target.value })}
          className={CAMPO}
        />
      )}
      <input
        required
        placeholder="Telefone com DDD"
        aria-label="Telefone"
        inputMode="tel"
        value={dados.phone}
        onChange={(e) => onCampo({ phone: e.target.value })}
        className={CAMPO}
      />
      {!temDocumento && (
        <p className="sm:col-span-3 m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Nome, CPF/CNPJ e telefone ficam guardados na sua conta para as próximas compras. A nota
          e a cobrança saem neste documento.
        </p>
      )}
    </>
  );
}

/**
 * O ENDEREÇO DE ENTREGA, entre os salvos na conta (GAP-PRD-115).
 *
 * Só aparecem os que servem para entregar; o padrão já vem escolhido. Quem
 * vai mandar para outro lugar CADASTRA o endereço ali mesmo — ele fica na
 * conta, e o pedido guarda o retrato em campos (rua, número, bairro, cidade,
 * UF, IBGE, quem recebe). A linha de texto solta ficou para o visitante: com
 * conta, o endereço que vai no pedido é sempre um endereço de verdade — e o
 * servidor recusa o texto solto (422 CHECKOUT_ENDERECO_SALVO_OBRIGATORIO).
 *
 * O endereço precisa estar COMPLETO para receber (GAP-PRD-028, reauditoria):
 * número, bairro e o código IBGE do município, além de rua, cidade, UF e CEP.
 * O incompleto aparece com o que falta e um "Completar" que abre o formulário
 * preenchido ali mesmo — o servidor recusaria com 422
 * CHECKOUT_ENDERECO_INCOMPLETO.
 */
export function EnderecoDaConta({
  token,
  enderecos,
  escolhido,
  onEscolher,
  onCadastrado,
}: {
  token: string;
  /** A lista da conta (`useEnderecosDaConta`); `null` = carregando. */
  enderecos: EnderecoDaContaApi[] | null;
  escolhido: string | null;
  onEscolher: (endereco: { id: string; zip: string } | null) => void;
  /** Relê a lista depois de cadastrar — a nota fiscal lê a mesma. */
  onCadastrado: () => Promise<EnderecoDaContaApi[]>;
}) {
  const [cadastrando, setCadastrando] = useState(false);
  /** O endereço salvo sendo COMPLETADO ali mesmo (GAP-PRD-028). */
  const [completando, setCompletando] = useState<string | null>(null);
  const paraEntrega = (enderecos ?? []).filter(serveParaEntrega);

  // O padrão já vem escolhido: quem salvou um endereço não quer escolhê-lo
  // de novo. Só enquanto ninguém escolheu nada.
  useEffect(() => {
    if (escolhido || paraEntrega.length === 0) return;
    const padrao = paraEntrega.find((e) => e.isDefault) ?? paraEntrega[0];
    onEscolher({ id: padrao.id, zip: padrao.zip });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enderecos]);

  if (enderecos === null) {
    return (
      <p role="status" className="m-0 mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        Carregando seus endereços…
      </p>
    );
  }

  const cadastrar = async (dados: DadosDoEndereco) => {
    const novo = await enderecosApi.criar(token, dados);
    await onCadastrado();
    setCadastrando(false);
    if (serveParaEntrega(novo)) onEscolher({ id: novo.id, zip: novo.zip });
  };

  /** Completa o endereço (PUT) e o mantém escolhido para a entrega. */
  const completar = async (id: string, dados: DadosDoEndereco) => {
    const salvo = await enderecosApi.editar(token, id, dados);
    await onCadastrado();
    setCompletando(null);
    if (serveParaEntrega(salvo)) onEscolher({ id: salvo.id, zip: salvo.zip });
  };
  const emCompletar = paraEntrega.find((e) => e.id === completando) ?? null;

  return (
    <div className="mt-2 flex flex-col gap-1">
      {paraEntrega.length > 0 && (
        <div role="radiogroup" aria-label="Endereço de entrega" className="flex flex-col gap-1">
          {paraEntrega.map((e) => {
            const falta = faltaParaEntregar(e);
            const nome = e.label ?? 'Endereço';
            return (
              <div key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="endereco-salvo"
                    value={e.id}
                    checked={escolhido === e.id}
                    onChange={() => onEscolher({ id: e.id, zip: e.zip })}
                    className="mt-1"
                  />
                  <span className="text-[length:var(--gs-text-sm)]">
                    <strong>{nome}</strong>
                    {' — '}
                    {e.street}
                    {e.number ? `, ${e.number}` : ''}
                    {e.district ? ` · ${e.district}` : ''} · {e.city}/{e.state} · CEP {cep(e.zip)}
                    {e.recipientName ? ` · recebe ${e.recipientName}` : ''}
                    {falta.length > 0 && (
                      <span className="block text-[var(--gs-warning)]">
                        Incompleto para entrega: falta {descreverFalta(falta)}.
                      </span>
                    )}
                  </span>
                </label>
                {falta.length > 0 && completando !== e.id && (
                  <button
                    type="button"
                    aria-label={`Completar ${nome}`}
                    onClick={() => {
                      setCadastrando(false);
                      setCompletando(e.id);
                    }}
                    className="bg-transparent border-0 p-0 cursor-pointer underline
                      text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]"
                  >
                    Completar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {emCompletar ? (
        <div className="mt-2">
          <FormularioDeEndereco
            titulo={`Completar ${emCompletar.label ?? 'Endereço'}`}
            inicial={paraFormulario(emCompletar)}
            rotuloSalvar="Salvar e usar este endereço"
            onSalvar={(dados) => completar(emCompletar.id, dados)}
            onCancelar={() => setCompletando(null)}
          />
        </div>
      ) : cadastrando || paraEntrega.length === 0 ? (
        <div className="mt-2">
          {paraEntrega.length === 0 && (
            <p className="m-0 mb-2 text-[length:var(--gs-text-sm)]">
              Cadastre o endereço de entrega — ele fica salvo na sua conta para as próximas compras.
            </p>
          )}
          <FormularioDeEndereco
            titulo="Novo endereço de entrega"
            rotuloSalvar="Salvar e usar este endereço"
            onSalvar={cadastrar}
            onCancelar={paraEntrega.length > 0 ? () => setCadastrando(false) : undefined}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCadastrando(true)}
          className="self-start mt-1 bg-transparent border-0 p-0 cursor-pointer underline
            text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]"
        >
          Entregar em outro endereço
        </button>
      )}
    </div>
  );
}

/**
 * O ENDEREÇO DA NOTA FISCAL (GAP-PRD-115).
 *
 * A NF-e do pedido sai em nome de quem compra, no endereço de faturamento —
 * que precisa do código IBGE do município. O padrão é o próprio endereço de
 * entrega quando ele também serve para a nota (o caso comum); senão, o de
 * faturamento da conta. Sem nenhum, a compra NÃO trava: a tela avisa que a
 * nota espera o endereço, e a loja completa depois.
 */
export function FaturamentoDaConta({
  token,
  enderecos,
  entrega,
  escolhido,
  onEscolher,
  onCadastrado,
}: {
  token: string;
  enderecos: EnderecoDaContaApi[] | null;
  /** O endereço de entrega escolhido (se houver entrega). */
  entrega: string | null;
  escolhido: string | null;
  onEscolher: (id: string | null) => void;
  onCadastrado: () => Promise<EnderecoDaContaApi[]>;
}) {
  const [cadastrando, setCadastrando] = useState(false);
  const paraNota = (enderecos ?? []).filter(serveParaFaturamento);

  // O padrão acompanha a entrega enquanto a pessoa não escolheu outro.
  const [escolhaManual, setEscolhaManual] = useState(false);
  useEffect(() => {
    if (escolhaManual) return;
    const daEntrega = paraNota.find((e) => e.id === entrega);
    const padrao = daEntrega ?? paraNota.find((e) => e.isDefault) ?? paraNota[0] ?? null;
    if ((padrao?.id ?? null) !== escolhido) onEscolher(padrao?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enderecos, entrega, escolhaManual]);

  if (enderecos === null) return null;

  const cadastrar = async (dados: DadosDoEndereco) => {
    const novo = await enderecosApi.criar(token, { ...dados, kind: dados.kind || 'faturamento' });
    await onCadastrado();
    setCadastrando(false);
    setEscolhaManual(true);
    onEscolher(novo.id);
  };

  return (
    <fieldset className="sm:col-span-3 border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3 m-0">
      <legend className="text-[length:var(--gs-text-sm)] font-semibold px-1">Nota fiscal</legend>
      {paraNota.length > 0 ? (
        <div role="radiogroup" aria-label="Endereço da nota fiscal" className="flex flex-col gap-1">
          {paraNota.map((e) => (
            <label key={e.id} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="endereco-nota"
                value={e.id}
                checked={escolhido === e.id}
                onChange={() => {
                  setEscolhaManual(true);
                  onEscolher(e.id);
                }}
                className="mt-1"
              />
              <span className="text-[length:var(--gs-text-sm)]">
                <strong>{e.label ?? 'Endereço'}</strong>
                {' — '}
                {e.street}
                {e.number ? `, ${e.number}` : ''} · {e.city}/{e.state} · IBGE {e.cityIbge}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          Nenhum endereço seu serve para a nota fiscal ainda (falta o código IBGE do município). A
          compra segue; a nota espera até o endereço de faturamento ser cadastrado.
        </p>
      )}
      {cadastrando ? (
        <div className="mt-2">
          <FormularioDeEndereco
            titulo="Novo endereço da nota fiscal"
            inicial={{ ...ENDERECO_VAZIO, kind: 'faturamento' }}
            rotuloSalvar="Salvar e usar na nota"
            onSalvar={cadastrar}
            onCancelar={() => setCadastrando(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCadastrando(true)}
          className="mt-1 bg-transparent border-0 p-0 cursor-pointer underline
            text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]"
        >
          {paraNota.length > 0 ? 'Usar outro endereço na nota' : 'Cadastrar endereço da nota fiscal'}
        </button>
      )}
    </fieldset>
  );
}

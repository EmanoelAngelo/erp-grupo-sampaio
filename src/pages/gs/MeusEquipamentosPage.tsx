/**
 * Portal do cliente: os aparelhos dele na oficina.
 *
 * ## Por que esta tela existe, e por que a plaquinha continua como está
 *
 * O QR colado no equipamento leva a uma página pública e mínima — marca,
 * modelo e andamento — porque a plaquinha fica exposta na calçada e quem
 * escaneia normalmente não tem conta. Ela não mudou.
 *
 * Esta é a outra porta. Aqui o dono está autenticado, e vê o que o anônimo não
 * pode: seus aparelhos, as ordens DELE e quanto custou cada serviço. É a mesma
 * conta do e-commerce; muda o que ela alcança.
 *
 * ## "Do dono", e não "do aparelho"
 *
 * O corte das ordens é por PESSOA, não por equipamento — `equipamentoDoDono`
 * filtra por `customer_id`. Não é limitação a corrigir, é a trava da rodada 17:
 * moto usada troca de mãos sem trocar de registro, e a queixa que o dono
 * anterior escreveu são as palavras dele. Fica de fora também a ordem sem
 * cliente — a montagem interna da moto nova, que roda antes de a moto ter dono
 * e carrega o custo de fábrica do grupo.
 *
 * Por isso o texto desta tela fala de serviço SEU, e nunca de "histórico
 * completo": quem compra uma moto montada aqui abre o portal e encontra a
 * própria moto com a lista vazia, e isso é o certo — não uma falha de carga.
 *
 * ## O código do balcão
 *
 * Quem foi cadastrado na oficina tem nome e telefone, e não consegue criar
 * conta pelo caminho normal (que exige e-mail e documento no cadastro). O
 * código entregue no balcão é a prova alternativa — e vale tanto para criar
 * conta quanto para ligar a oficina a uma conta que já existe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import {
  lerSessaoPortal as lerSessao,
  comTokenPortal as comToken,
  type SessaoPortal as Sessao,
} from '@/lib/portalSession';
import { dataBR } from '@/lib/datas';

interface Equipamento {
  id: string;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  workshopName: string | null;
  companyName: string;
  serialNumber: string | null;
  plate: string | null;
}

interface Ordem {
  id: string;
  number: number;
  status: string;
  complaint: string | null;
  diagnosis: string | null;
  laborCents: number;
  partsCents: number;
  totalCents: number;
  createdAt: string;
  closedAt: string | null;
  approvalRequestedAt: string | null;
  approvedAt: string | null;
  /**
   * O orçamento está na mesa do dono AGORA — pedido de pé, sem resposta, e a
   * OS ainda na bancada (GAP-PRD-182). Vem pronto do servidor, que é quem
   * recusa a decisão fora dessas condições.
   */
  aguardandoDecisao?: boolean;
}

interface Chamado {
  id: string;
  equipmentId: string;
  description: string;
  status: string;
  createdAt: string;
}

const SITUACAO: Record<string, string> = {
  em_aberto: 'Recebido pela oficina',
  em_andamento: 'Em serviço',
  aguardando_peca: 'Aguardando peça',
  manutencao_externa: 'Em manutenção externa',
  // "Parada no setor" é jargão de bancada — para o dono da moto o serviço
  // segue na oficina. Sem esta linha, o nome interno vazava na tela dele
  // (o mapa cai no `?? status` quando a chave não existe).
  parada_setor: 'Em serviço',
  aguardando_pagamento: 'Pronto para retirada',
  finalizada: 'Serviço concluído',
};

const SITUACAO_CHAMADO: Record<string, string> = {
  aberto: 'Aguardando a oficina',
  convertido: 'Virou ordem de serviço',
  encerrado: 'Encerrado pela oficina',
  cancelado: 'Cancelado por você',
};

/** Toda chamada do portal leva o token no header próprio, nunca na URL. */
function data(iso: string): string {
  return dataBR(iso);
}

export default function MeusEquipamentosPage() {
  const [sessao] = useState<Sessao | null>(() => lerSessao());
  const [busca] = useSearchParams();
  /*
    `null` = ainda não sei (rodada 57). Nascendo `[]`, a tela afirmava
    "Nenhum aparelho ligado a esta conta… peça o código no balcão" DURANTE o
    carregamento — o dono da moto lia num 4G lento que não tem moto, e um
    segundo depois a moto chegava. O vazio é uma afirmação; só a resposta dá
    o direito de fazê-la.
  */
  const [equipamentos, setEquipamentos] = useState<Equipamento[] | null>(null);
  /** O botão da lista que abriu a ficha — o "fechar" devolve o foco a ele. */
  const quemAbriuAFichaRef = useRef<HTMLButtonElement | null>(null);
  /** Alvo de foco quando não houve botão (ficha aberta pelo QR). */
  const tituloDaPaginaRef = useRef<HTMLHeadingElement | null>(null);
  const [chamados, setChamados] = useState<Chamado[]>([]);
  const [aberto, setAberto] = useState<{ equipamento: Equipamento; ordens: Ordem[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [codigo, setCodigo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    if (!sessao) return;
    try {
      setErro(null);
      const [e, c] = await Promise.all([
        comToken<{ items: Equipamento[] }>('/loja/portal/equipamentos', sessao.token),
        comToken<{ items: Chamado[] }>('/loja/portal/chamados', sessao.token),
      ]);
      setEquipamentos(e.items);
      setChamados(c.items);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar agora.');
    }
  }, [sessao]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function resgatar() {
    if (!sessao || !codigo.trim()) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await comToken<{ customerName: string }>(
        '/loja/portal/convite/resgatar',
        sessao.token,
        { method: 'POST', body: { code: codigo.trim() } },
      );
      setAviso(`Pronto, ${r.customerName}. Seus aparelhos aparecem abaixo.`);
      setCodigo('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível usar este código.');
    } finally {
      setOcupado(false);
    }
  }

  const abrir = useCallback(
    async (id: string) => {
      if (!sessao) return;
      try {
        setErro(null);
        setAberto(
          await comToken<{ equipamento: Equipamento; ordens: Ordem[] }>(
            `/loja/portal/equipamentos/${id}`,
            sessao.token,
          ),
        );
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível abrir.');
      }
    },
    [sessao],
  );

  /*
    O elo que faltava do QR: a plaquinha manda o dono para cá com
    `?equipamento=#0001`, e a ficha daquele aparelho abre sozinha — sem
    obrigar quem está na calçada a procurar a moto na lista.
  */
  const alvoDoQr = busca.get('equipamento');
  /*
    O QR abre a ficha UMA vez (rodada 57). O efeito depende de `equipamentos`,
    e a lista recarrega a cada ação — pedir serviço, cancelar chamado, resgatar
    código. Sem consumir o alvo, fechar a ficha e mexer em qualquer coisa a
    reabria sozinha: o cliente fecha, ela volta, ele fecha de novo.
  */
  const qrConsumido = useRef(false);
  useEffect(() => {
    if (qrConsumido.current) return;
    if (!alvoDoQr || !equipamentos || equipamentos.length === 0) return;
    const alvo = equipamentos.find((e) => e.publicIdLabel === alvoDoQr);
    if (alvo) {
      qrConsumido.current = true;
      void abrir(alvo.id);
    }
  }, [alvoDoQr, equipamentos, abrir]);

  /** A decisão do orçamento — aprova ou recusa, e a ficha recarrega. */
  async function decidir(ordemId: string, acao: 'aprovar' | 'recusar') {
    if (!sessao || !aberto) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      await comToken(`/loja/portal/ordens/${ordemId}/${acao}`, sessao.token, {
        method: 'POST',
      });
      setAviso(
        acao === 'aprovar'
          ? 'Orçamento aprovado. A oficina já pode começar o serviço.'
          : 'Orçamento recusado. A oficina será avisada.',
      );
      await abrir(aberto.equipamento.id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível registrar.');
    } finally {
      setOcupado(false);
    }
  }

  async function pedirServico(equipmentId: string) {
    if (!sessao || !descricao.trim()) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      await comToken(`/loja/portal/equipamentos/${equipmentId}/chamados`, sessao.token, {
        method: 'POST',
        body: { description: descricao.trim() },
      });
      setAviso('Pedido enviado. A oficina entra em contato para combinar a entrega.');
      setDescricao('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível enviar o pedido.');
    } finally {
      setOcupado(false);
    }
  }

  async function cancelar(id: string) {
    if (!sessao) return;
    try {
      await comToken(`/loja/portal/chamados/${id}/cancelar`, sessao.token, { method: 'POST' });
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível cancelar.');
    }
  }

  if (!sessao) {
    return (
      <CascaDaLoja larguraMax="max-w-4xl">
        <div className="text-center py-10">
          <p className="m-0">Entre na sua conta para ver seus equipamentos.</p>
          <Link to="/minha-conta" className="text-[var(--gs-purple-800)] font-semibold">
            Ir para minha conta
          </Link>
        </div>
      </CascaDaLoja>
    );
  }

  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <div>
        <h1 ref={tituloDaPaginaRef} tabIndex={-1} className="text-[length:var(--gs-text-lg)] mt-1">
          Meus equipamentos
        </h1>
        <Link to="/minha-conta" className="text-[length:var(--gs-text-sm)]">
          ← Meus pedidos
        </Link>

        {erro && (
          <p role="alert" className="mt-4 text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
        {aviso && <p className="mt-4 font-semibold">{aviso}</p>}

        {/*
          O código do balcão. Fica no topo e sem esconder atrás de menu: quem
          acabou de receber o papel na oficina chega aqui procurando onde
          digitá-lo, e não achar é o que faz o papel virar lixo.
        */}
        <section className="mt-6 rounded-[var(--gs-radius)] border border-[var(--gs-border)] p-4">
          <h2 className="m-0 text-[length:var(--gs-text-base)]">Recebeu um código na oficina?</h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Digite aqui para ligar seus aparelhos a esta conta.
          </p>
          {/* <form>: quem digita o código do papel aperta Enter — e a <div>
              anterior deixava o gesto mudo. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void resgatar();
            }}
            className="flex gap-2 mt-3 flex-wrap"
          >
            <input
              aria-label="Código da oficina"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.toUpperCase())}
              placeholder="ABCD234567"
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] font-mono tracking-wider"
            />
            <button
              type="submit"
              disabled={ocupado || !codigo.trim()}
              className="h-10 px-4 rounded-[var(--gs-radius)] bg-[var(--gs-purple-800)] text-white font-semibold disabled:opacity-50"
            >
              Usar código
            </button>
          </form>
        </section>

        <section className="mt-6">
          <h2 className="text-[length:var(--gs-text-base)]">Aparelhos</h2>
          {equipamentos === null ? (
            // Em erro, quem fala é o aviso lá em cima — "não deu para
            // carregar" e "nenhum aparelho" juntos se contradizem.
            !erro && (
              <p role="status" className="text-[var(--gs-muted)]">
                Carregando seus aparelhos…
              </p>
            )
          ) : equipamentos.length === 0 ? (
            <p className="text-[var(--gs-muted)]">
              Nenhum aparelho ligado a esta conta ainda. Se a oficina já atendeu você, peça o
              código no balcão.
            </p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-3">
              {equipamentos.map((e) => (
                <li
                  key={e.id}
                  className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] p-4"
                >
                  <div className="flex justify-between items-baseline gap-3 flex-wrap">
                    <strong>
                      {[e.brand, e.model].filter(Boolean).join(' ') || 'Equipamento'}{' '}
                      <span className="font-mono text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        {e.publicIdLabel}
                      </span>
                    </strong>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {e.workshopName ?? e.companyName}
                    </span>
                  </div>
                  <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {[e.color, e.plate, e.serialNumber].filter(Boolean).join(' · ') || '—'}
                  </p>
                  <button
                    type="button"
                    onClick={(ev) => {
                      // Guarda quem abriu: o "fechar" da ficha devolve o foco
                      // aqui, em vez de largar o teclado no <body>.
                      quemAbriuAFichaRef.current = ev.currentTarget;
                      void abrir(e.id);
                    }}
                    className="mt-3 text-[var(--gs-purple-800)] font-semibold bg-transparent border-0 px-2 py-1 -ml-2 cursor-pointer"
                  >
                    Ver histórico e pedir serviço
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {aberto && (
          <section className="mt-6 rounded-[var(--gs-radius)] border border-[var(--gs-border)] p-4">
            <div className="flex justify-between items-baseline gap-3">
              <h2 className="m-0 text-[length:var(--gs-text-base)]">
                {[aberto.equipamento.brand, aberto.equipamento.model].filter(Boolean).join(' ')}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setAberto(null);
                  /*
                    Chegando pelo QR não houve clique nenhum — o ref é nulo e
                    o foco cairia no <body>, deixando quem usa teclado no
                    início da página. O título é o alvo estável.
                  */
                  const volta = quemAbriuAFichaRef.current;
                  if (volta?.isConnected) volta.focus();
                  else tituloDaPaginaRef.current?.focus();
                }}
                className="bg-transparent border-0 cursor-pointer text-[var(--gs-muted)] px-2 py-1"
              >
                fechar
              </button>
            </div>

            {/*
              "SEUS", e não "já feitos".

              A lista é cortada por pessoa: só entra ordem aberta em nome desta
              conta. "Serviços já feitos" com a lista vazia afirmava que a
              oficina nunca tocou no aparelho — mentira exata para quem acabou
              de comprar uma moto montada aqui, que tem OS de montagem sem
              cliente e nunca vai vê-la. O rótulo passa a dizer de quem é a
              lista, e o vazio explica o que ficou de fora em vez de deixar o
              cliente achar que a tela não carregou.
            */}
            <h3 className="text-[length:var(--gs-text-sm)] uppercase tracking-wide text-[var(--gs-muted)]">
              Serviços feitos para você
            </h3>
            {aberto.ordens.length === 0 ? (
              <p className="text-[var(--gs-muted)]">
                Nenhum serviço seu registrado ainda. O que a oficina fez antes de este aparelho ser
                seu não aparece aqui.
              </p>
            ) : (
              <ul className="list-none p-0 m-0 flex flex-col gap-2">
                {aberto.ordens.map((o) => (
                  <li key={o.number} className="border-l-2 border-[var(--gs-border)] pl-3">
                    <div className="flex justify-between gap-3 flex-wrap">
                      <strong>OS #{o.number}</strong>
                      {/* O valor é justamente o que a plaquinha esconde. */}
                      <span className="tabular-nums">{formatCents(o.totalCents)}</span>
                    </div>
                    <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {data(o.createdAt)} · {SITUACAO[o.status] ?? o.status}
                    </p>
                    {o.complaint && <p className="m-0 text-[length:var(--gs-text-sm)]">{o.complaint}</p>}
                    {/*
                      O orçamento é decidido AQUI, por quem paga. O botão só
                      existe com pedido pendente E a OS na bancada — a regra
                      vem do servidor (`aguardandoDecisao`, GAP-PRD-182), que
                      recusa decidir OS que já virou conta; aprovado, vira
                      registro com data — e mudar de ideia é conversa com a
                      oficina.
                    */}
                    {o.aguardandoDecisao === true && (
                      <div className="mt-2 rounded-[var(--gs-radius)] border-2 border-[var(--gs-purple-800)] p-3">
                        <p className="m-0 font-semibold">
                          Orçamento de {formatCents(o.totalCents)} aguardando a sua aprovação.
                        </p>
                        <div className="flex gap-2 mt-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => void decidir(o.id, 'aprovar')}
                            disabled={ocupado}
                            className="h-10 px-4 rounded-[var(--gs-radius)] bg-[var(--gs-purple-800)] text-white font-semibold disabled:opacity-50"
                          >
                            Aprovar orçamento
                          </button>
                          <button
                            type="button"
                            onClick={() => void decidir(o.id, 'recusar')}
                            disabled={ocupado}
                            className="h-10 px-4 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-transparent font-semibold disabled:opacity-50"
                          >
                            Recusar
                          </button>
                        </div>
                      </div>
                    )}
                    {o.approvedAt && (
                      <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] font-semibold">
                        Orçamento aprovado por você em {data(o.approvedAt)}.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="text-[length:var(--gs-text-sm)] uppercase tracking-wide text-[var(--gs-muted)] mt-4">
              Precisa de serviço?
            </h3>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Descreva o problema. A oficina entra em contato para combinar a entrega do aparelho —
              o pedido não abre ordem de serviço sozinho.
            </p>
            <textarea
              aria-label="O que está acontecendo"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              className="w-full mt-2 p-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
            />
            <button
              type="button"
              onClick={() => void pedirServico(aberto.equipamento.id)}
              disabled={ocupado || !descricao.trim()}
              className="mt-2 h-10 px-4 rounded-[var(--gs-radius)] bg-[var(--gs-purple-800)] text-white font-semibold disabled:opacity-50"
            >
              Enviar pedido
            </button>
          </section>
        )}

        {chamados.length > 0 && (
          <section className="mt-6">
            <h2 className="text-[length:var(--gs-text-base)]">Pedidos que você enviou</h2>
            <ul className="list-none p-0 m-0 flex flex-col gap-2">
              {chamados.map((c) => (
                <li
                  key={c.id}
                  className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] p-3"
                >
                  <div className="flex justify-between gap-3 flex-wrap">
                    <span>{c.description}</span>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {SITUACAO_CHAMADO[c.status] ?? c.status}
                    </span>
                  </div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {data(c.createdAt)}
                  </p>
                  {c.status === 'aberto' && (
                    <button
                      type="button"
                      onClick={() => void cancelar(c.id)}
                      className="mt-1 bg-transparent border-0 px-2 py-1 -ml-2 cursor-pointer text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] underline"
                    >
                      cancelar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </CascaDaLoja>
  );
}

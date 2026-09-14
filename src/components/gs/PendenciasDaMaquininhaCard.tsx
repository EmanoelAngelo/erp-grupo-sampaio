/**
 * ============================================================================
 * COBRANÇAS SEM VENDA E ESTORNOS A FAZER (GAP-PRD-078, GAP-PRD-080)
 * ============================================================================
 *
 * A Conferência de maquininha só mostrava a cobrança SEM RESPOSTA. Duas outras
 * espécies de dinheiro da operadora ficavam sem fila nenhuma:
 *
 * - a cobrança SEM VENDA: o PIX que o cliente pagou depois de o operador
 *   desistir, o cartão aprovado que saiu da venda, a cobrança que a
 *   conciliação afirmou paga e que nenhuma venda usou. A loja recebeu e não
 *   sabia — ou cobrou de novo por outro meio;
 * - o ESTORNO A FAZER: a venda foi cancelada ou devolvida no cartão, e a
 *   operadora ainda não confirmou o estorno.
 *
 * Cada linha tem as saídas com motivo, e o que o servidor responde aparece
 * como veio: cancelar/estornar na operadora, amarrar à venda que a cobrança
 * pagou, registrar a tratativa, ou registrar o estorno feito no aparelho.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Badge, Button, Card, EmptyState, Input } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { dataHoraBR } from '@/lib/datas';
import {
  maquininhasApi,
  pendenciasDaMaquininhaApi,
  type CobrancaNaFila,
  type PendenciasDaMaquininha,
} from '@/lib/api/maquininhas';

const MEIO: Record<string, string> = { credit: 'Crédito', debit: 'Débito', pix: 'PIX' };

const SITUACAO: Record<string, string> = {
  aprovado: 'Aprovada, sem venda',
  processando: 'Em andamento',
  aguardando_cliente: 'Esperando o cliente',
  aguardando_terminal: 'Enviando ao aparelho',
};

/** A partir de quantos minutos a cobrança sem venda aparece. */
const PRAZOS = [0, 10, 30, 60];

type TipoDeAcao = 'cancelar' | 'vincular' | 'tratativa' | 'reestornar' | 'estorno_manual';

interface Acao {
  tipo: TipoDeAcao;
  item: CobrancaNaFila;
}

const TEXTO_DA_ACAO: Record<TipoDeAcao, { titulo: string; explica: string; exemplo: string; botao: string }> = {
  cancelar: {
    titulo: 'Cancelar na operadora',
    explica:
      'Pede à operadora o cancelamento desta cobrança. Se o cliente já pagou, o dinheiro volta para ele. '
      + 'A cobrança só muda depois que a operadora confirmar.',
    exemplo: 'Ex.: cliente pagou em dinheiro, PIX abandonado no balcão',
    botao: 'Pedir o cancelamento',
  },
  vincular: {
    titulo: 'Amarrar à venda',
    explica:
      'Diga qual venda esta cobrança pagou. A venda precisa ter uma linha do mesmo meio e do mesmo valor, '
      + 'lançada sem cobrança (ex.: com a maquininha fora do ar).',
    exemplo: 'Ex.: NSU confere com o comprovante da venda',
    botao: 'Amarrar',
  },
  tratativa: {
    titulo: 'Registrar tratativa',
    explica:
      'Para quando o dinheiro já se resolveu por fora. A cobrança continua como está na operadora; ela só '
      + 'sai desta fila, com a sua explicação na auditoria.',
    exemplo: 'Ex.: PIX devolvido ao cliente pelo aplicativo do banco',
    botao: 'Registrar',
  },
  reestornar: {
    titulo: 'Pedir o estorno de novo',
    explica: 'Pede outra vez à operadora o estorno desta venda desfeita.',
    exemplo: 'Ex.: operadora voltou ao ar',
    botao: 'Pedir o estorno',
  },
  estorno_manual: {
    titulo: 'Registrar estorno feito no aparelho',
    explica:
      'Afirme que o estorno foi feito direto na maquininha. Fica na auditoria com o seu nome — confira o '
      + 'comprovante do aparelho antes.',
    exemplo: 'Ex.: estornado no aparelho, NSU 123456',
    botao: 'Registrar o estorno',
  },
};

export function PendenciasDaMaquininhaCard() {
  const [minutos, setMinutos] = useState(10);
  const [dados, setDados] = useState<PendenciasDaMaquininha | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [acao, setAcao] = useState<Acao | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setDados(await pendenciasDaMaquininhaApi.listar(minutos));
    } catch (err) {
      // Nulo de propósito: "nada sem venda" depois de uma falha faria o gestor
      // concluir que não há dinheiro sem dono quando ele só não conseguiu ver.
      setDados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as cobranças sem venda.');
    }
  }, [minutos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div className="flex flex-col gap-5" data-testid="pendencias-da-maquininha">
      {aviso && (
        <div
          role="status"
          className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </div>
      )}
      {erro && (
        <div
          role="alert"
          className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      <Card
        title="Cobranças sem venda"
        subtitle="Aprovadas ou ainda em andamento na maquininha, sem venda nenhuma. O PIX pago depois de o operador desistir aparece aqui."
      >
        <label className="flex items-center gap-2 mb-3 text-[length:var(--gs-text-sm)]">
          <span className="text-[var(--gs-text-soft)]">Mostrar as de mais de</span>
          <select
            aria-label="Prazo das cobranças sem venda"
            value={minutos}
            onChange={(e) => setMinutos(Number(e.target.value))}
            className="px-2 py-1 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          >
            {PRAZOS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'qualquer idade' : `${m} min`}
              </option>
            ))}
          </select>
        </label>
        {dados === null ? (
          <p role="status" className="text-[var(--gs-muted)]">
            {erro ? 'Não foi possível listar.' : 'Carregando…'}
          </p>
        ) : dados.semVenda.length === 0 ? (
          <EmptyState
            title="Nenhuma cobrança sem venda"
            description="Toda cobrança aprovada desta operação está amarrada a uma venda ou já foi tratada."
          />
        ) : (
          <TabelaDaFila
            itens={dados.semVenda}
            colunaExtra={(t) => SITUACAO[t.state] ?? t.state}
            acoes={(t) => (
              <>
                <Button size="sm" variant="secondary" onClick={() => setAcao({ tipo: 'cancelar', item: t })}>
                  Cancelar na operadora
                </Button>
                {t.settled && (
                  <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'vincular', item: t })}>
                    Amarrar à venda
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'tratativa', item: t })}>
                  Registrar tratativa
                </Button>
              </>
            )}
          />
        )}
      </Card>

      <Card
        title="Estornos a fazer"
        subtitle="Vendas canceladas ou devolvidas no cartão cujo estorno a operadora ainda não confirmou."
      >
        {dados === null ? (
          <p role="status" className="text-[var(--gs-muted)]">
            {erro ? 'Não foi possível listar.' : 'Carregando…'}
          </p>
        ) : dados.aEstornar.length === 0 ? (
          <EmptyState
            title="Nenhum estorno pendente"
            description="Todo estorno de venda desfeita foi confirmado pela operadora."
          />
        ) : (
          <TabelaDaFila
            itens={dados.aEstornar}
            valor={(t) => t.aEstornarCents}
            colunaExtra={(t) =>
              `${t.saleNumber ? `Venda #${t.saleNumber}` : 'Venda'} · ${
                t.ultimoPedido?.origem === 'devolucao' ? 'devolução' : 'cancelamento'
              }${t.pedidoNoAgente ? ' · esperando o aparelho' : ''}`
            }
            acoes={(t) => (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={t.pedidoNoAgente}
                  onClick={() => setAcao({ tipo: 'reestornar', item: t })}
                >
                  Pedir o estorno de novo
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={t.pedidoNoAgente}
                  onClick={() => setAcao({ tipo: 'estorno_manual', item: t })}
                >
                  Estornado no aparelho
                </Button>
              </>
            )}
          />
        )}
      </Card>

      {acao && (
        <AcaoDialog
          acao={acao}
          onClose={() => setAcao(null)}
          onDone={(texto) => {
            setAcao(null);
            setAviso(texto);
            void carregar();
          }}
        />
      )}
    </div>
  );
}

function TabelaDaFila({
  itens,
  colunaExtra,
  acoes,
  valor = (t) => t.amountInCents,
}: {
  itens: CobrancaNaFila[];
  colunaExtra: (t: CobrancaNaFila) => string;
  acoes: (t: CobrancaNaFila) => React.ReactNode;
  valor?: (t: CobrancaNaFila) => number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[length:var(--gs-text-sm)]">
        <thead>
          <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
            <th className="py-2.5 pr-4 font-semibold">Quando</th>
            <th className="py-2.5 pr-4 font-semibold">Meio</th>
            <th className="py-2.5 pr-4 font-semibold">Situação</th>
            <th className="py-2.5 pr-4 font-semibold text-right">Valor</th>
            <th className="py-2.5 font-semibold text-right">Ação</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((t) => (
            <tr key={t.transactionId} className="border-b border-[var(--gs-border)] last:border-0 align-top">
              <td className="py-3 pr-4">
                {t.startedAt ? dataHoraBR(t.startedAt) : '—'}
                <div className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{t.transactionId}</div>
              </td>
              <td className="py-3 pr-4">
                {MEIO[t.method] ?? t.method}
                {t.maskedCard ? ` · ${t.maskedCard}` : ''}
                {t.simulated && (
                  <span className="ml-2">
                    <Badge tone="warning">TESTE</Badge>
                  </span>
                )}
              </td>
              <td className="py-3 pr-4">{colunaExtra(t)}</td>
              <td className="py-3 pr-4 text-right font-bold tabular-nums">{formatCents(valor(t))}</td>
              <td className="py-3 text-right">
                <span className="inline-flex flex-wrap gap-2 justify-end">{acoes(t)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AcaoDialog({
  acao,
  onClose,
  onDone,
}: {
  acao: Acao;
  onClose: () => void;
  onDone: (texto: string) => void;
}) {
  const { tipo, item } = acao;
  const texto = TEXTO_DA_ACAO[tipo];
  const [motivo, setMotivo] = useState('');
  const [numeroDaVenda, setNumeroDaVenda] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const valor = tipo === 'reestornar' || tipo === 'estorno_manual' ? item.aEstornarCents : item.amountInCents;
  const numero = Number(numeroDaVenda);
  const pronto = motivo.trim().length >= 3 && (tipo !== 'vincular' || (Number.isInteger(numero) && numero > 0));

  const confirmar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      if (tipo === 'cancelar') {
        const r = await maquininhasApi.cancelar(item.transactionId, motivo.trim());
        onDone(
          r.queuedToAgent
            ? 'Pedido de cancelamento enviado ao aparelho. A cobrança muda quando ele confirmar.'
            : `Cobrança de ${formatCents(valor)} cancelada na operadora.`,
        );
      } else if (tipo === 'vincular') {
        const r = await pendenciasDaMaquininhaApi.vincularVenda(item.transactionId, numero, motivo.trim());
        onDone(`Cobrança de ${formatCents(valor)} amarrada à venda #${r.saleNumber}.`);
      } else if (tipo === 'tratativa') {
        await pendenciasDaMaquininhaApi.registrarTratativa(item.transactionId, motivo.trim());
        onDone(`Tratativa registrada: a cobrança de ${formatCents(valor)} saiu da fila.`);
      } else if (tipo === 'reestornar') {
        const r = await maquininhasApi.estornar(item.transactionId, motivo.trim(), item.aEstornarCents);
        onDone(
          r.queuedToAgent
            ? 'Pedido de estorno enviado ao aparelho. A cobrança muda quando ele confirmar.'
            : `Estorno de ${formatCents(valor)} confirmado pela operadora.`,
        );
      } else {
        await pendenciasDaMaquininhaApi.estornoManual(item.transactionId, motivo.trim());
        onDone(`Estorno de ${formatCents(valor)} registrado como feito no aparelho.`);
      }
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={texto.titulo}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            {texto.titulo} — {formatCents(valor)}
          </h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{texto.explica}</p>
          {tipo === 'vincular' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Número da venda
              </span>
              <Input
                aria-label="Número da venda"
                inputMode="numeric"
                value={numeroDaVenda}
                onChange={(e) => setNumeroDaVenda(e.target.value.replace(/\D/g, ''))}
                placeholder="Ex.: 1042"
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Motivo</span>
            <Input
              aria-label="Motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={texto.exemplo}
            />
          </label>
          {erro && (
            <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Voltar
            </Button>
            <Button loading={ocupado} disabled={!pronto} onClick={() => void confirmar()}>
              {texto.botao}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

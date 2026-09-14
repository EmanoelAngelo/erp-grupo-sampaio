/**
 * Estoque › Validade — o que vence, quando, e o que precisa de ação (GAP-V35).
 *
 * ## O que esta tela responde
 *
 * Três perguntas, na ordem em que o gestor as faz de manhã:
 *
 *   1. O QUE VENCE? As faixas no topo — vencido, 7, 15 e 30 dias —, cada uma
 *      com quantos lotes, quanto estoque e quanto DINHEIRO. Clicar na faixa
 *      filtra a lista abaixo; é o mesmo gesto do alerta de estoque mínimo.
 *   2. O QUE FALTA CONFERIR? Lote que entrou e ninguém abriu a caixa para ler
 *      a validade impressa.
 *   3. O QUE ENTROU SEM LOTE? A pendência da doca: mercadoria que chegou por
 *      nota fiscal (o XML traz quantidade e custo, nunca lote) e ainda não tem
 *      identidade. Ela tem porta de saída aqui — a alocação.
 *
 * ## O que esta tela NÃO faz
 *
 * NÃO CALCULA NADA. Faixa, saldo por lote, valor em centavos e até o "hoje"
 * vêm do servidor. A régua da faixa mora em `BatchService` (SQL e TypeScript
 * lado a lado) e refazê-la aqui criaria uma terceira definição — que é
 * exatamente como as três respostas diferentes para "abaixo do mínimo"
 * nasceram nesta casa.
 *
 * E não mostra produto que não controla lote. Quem não usa o módulo não vê
 * nem esta tela pedindo nada dele.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type BatchAlerts,
  type FaixaDeValidade,
  type PendenciaSemLote,
  type ProductBatch,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';

/**
 * A COR DA URGÊNCIA, e ela não é decorativa: vermelho é mercadoria que não
 * pode ser vendida (o servidor recusa), âmbar é a semana que vem.
 */
const TOM_DA_FAIXA: Record<FaixaDeValidade, 'danger' | 'warning' | 'info' | 'neutral'> = {
  vencido: 'danger',
  vence_em_7: 'danger',
  vence_em_15: 'warning',
  vence_em_30: 'warning',
  em_dia: 'info',
  sem_validade: 'neutral',
};

/** A data de calendário como se lê no rótulo. Nunca `new Date(texto)`. */
function dataBonita(dia: string | null): string {
  if (!dia) return '—';
  const [ano, mes, d] = dia.split('-');
  return `${d}/${mes}/${ano}`;
}

export default function ValidadePage() {
  const [alerta, setAlerta] = useState<BatchAlerts | null>(null);
  const [lotes, setLotes] = useState<ProductBatch[] | null>(null);
  const [faixa, setFaixa] = useState<FaixaDeValidade | ''>('');
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  /** O lote sendo alocado, e quanto. Nulo = ninguém está alocando. */
  const [alocando, setAlocando] = useState<PendenciaSemLote | null>(null);
  const [loteDestino, setLoteDestino] = useState('');
  const [validadeDestino, setValidadeDestino] = useState('');
  const [quantidadeAlocar, setQuantidadeAlocar] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [a, l] = await Promise.all([
        coreApi.batchAlerts(),
        coreApi.listBatches({
          faixa: faixa || undefined,
          search: busca.trim() || undefined,
        }),
      ]);
      setAlerta(a);
      setLotes(l);
    } catch (e) {
      setErro(
        e instanceof ApiRequestError ? e.message : 'Não foi possível carregar a validade.',
      );
      setLotes([]);
    }
  }, [faixa, busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function conferir(lote: ProductBatch) {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await coreApi.conferirBatch(lote.id);
      setAviso(
        r.duplicated
          ? `O lote ${lote.code} já tinha sido conferido por ${r.batch.checked_by_name ?? 'alguém'}.`
          : `Lote ${lote.code} conferido.`,
      );
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível conferir o lote.');
    } finally {
      setOcupado(false);
    }
  }

  /**
   * Alocar em UM gesto: cadastra o lote com a validade lida na caixa e move o
   * saldo pendente para ele. São duas chamadas porque são dois fatos — o lote
   * passa a existir, e depois a mercadoria passa a ser dele —, e o servidor
   * recusaria uma alocação para um lote que ainda não nasceu.
   */
  async function alocar() {
    if (!alocando) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const lote = await coreApi.createBatch({
        productId: alocando.productId,
        code: loteDestino.trim(),
        expiresOn: validadeDestino || null,
      });
      await coreApi.alocarEmBatch(lote.id, {
        productId: alocando.productId,
        quantity: Number(quantidadeAlocar.replace(',', '.')),
      });
      setAviso(`${quantidadeAlocar} de "${alocando.productName}" agora é do lote ${lote.code}.`);
      setAlocando(null);
      setLoteDestino('');
      setValidadeDestino('');
      setQuantidadeAlocar('');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível alocar o saldo.');
    } finally {
      setOcupado(false);
    }
  }

  const podeAlocar =
    !!alocando
    && loteDestino.trim().length > 0
    && Number(quantidadeAlocar.replace(',', '.')) > 0
    && Number(quantidadeAlocar.replace(',', '.')) <= alocando.quantity;

  const totalEmRisco = useMemo(() => {
    if (!alerta) return 0;
    // "Em risco" é o que vence em até 30 dias MAIS o que já venceu: é a
    // pergunta do seguro e a do fechamento. O somatório é de valores já
    // arredondados por lote no servidor — somar centavos inteiros nunca cria
    // meio centavo.
    return alerta.faixas
      .filter((f) => f.faixa !== 'em_dia' && f.faixa !== 'sem_validade')
      .reduce((t, f) => t + f.valueCents, 0);
  }, [alerta]);

  return (
    <AppShell>
      <PageHeader
        title="Validade e lotes"
        subtitle="O que vence primeiro sai primeiro. A venda recusa lote vencido; produto sem controle de lote não é afetado em nada."
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]">
          {aviso}
        </div>
      )}

      <Card
        title="O que vence"
        subtitle={
          alerta
            ? `Medido em ${dataBonita(alerta.hoje)} · ${formatCents(totalEmRisco)} em risco nos próximos 30 dias`
            : 'Carregando…'
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {(alerta?.faixas ?? []).map((f) => (
            <button
              key={f.faixa}
              type="button"
              onClick={() => setFaixa(faixa === f.faixa ? '' : f.faixa)}
              className={`text-left px-4 py-3 rounded-[var(--gs-radius)] border transition-colors ${
                faixa === f.faixa
                  ? 'border-[var(--gs-accent)] bg-[var(--gs-surface-hover)]'
                  : 'border-[var(--gs-border)] hover:bg-[var(--gs-surface-hover)]'
              }`}
            >
              <Badge tone={TOM_DA_FAIXA[f.faixa]}>{f.label}</Badge>
              <p className="mt-2 mb-0 text-[length:var(--gs-text-lg)] font-semibold tabular-nums">
                {f.lotes}
              </p>
              <p className="mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)] tabular-nums">
                {formatQuantity(f.quantity)} · {formatCents(f.valueCents)}
              </p>
            </button>
          ))}
        </div>
        {faixa && (
          <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            A lista abaixo está filtrada. <button
              type="button"
              className="underline"
              onClick={() => setFaixa('')}
            >
              Mostrar todas as faixas
            </button>
          </p>
        )}
      </Card>

      {alerta && alerta.pendencias.length > 0 && (
        <Card
          title="Entrou sem lote declarado"
          subtitle="A nota fiscal traz quantidade e custo, nunca o lote. Abra a caixa, leia a validade impressa e aloque — é o que faz esta lista diminuir."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className={TH}>Produto</th>
                  <th className={`${TH} text-right`}>Sem lote</th>
                  <th className={`${TH} text-right`} />
                </tr>
              </thead>
              <tbody>
                {alerta.pendencias.map((p) => (
                  <tr key={p.productId} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className={TD}>
                      <span className="font-mono text-[length:var(--gs-text-xs)] mr-2">
                        {p.internalCode}
                      </span>
                      {p.productName}
                    </td>
                    <td className={`${TD} text-right tabular-nums font-semibold`}>
                      {formatQuantity(p.quantity)} {p.unit}
                    </td>
                    <td className={`${TD} text-right`}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setAlocando(p);
                          setQuantidadeAlocar(String(p.quantity));
                        }}
                      >
                        Alocar em um lote
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {alocando && (
            <div className="mt-4 pt-4 border-t border-[var(--gs-border)]">
              <p className="mb-3 font-semibold">{alocando.productName}</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>Código do lote</span>
                  <Input
                    value={loteDestino}
                    onChange={(e) => setLoteDestino(e.target.value)}
                    placeholder="L2409"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>Validade</span>
                  <Input
                    type="date"
                    value={validadeDestino}
                    onChange={(e) => setValidadeDestino(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>Quantidade</span>
                  <Input
                    inputMode="decimal"
                    value={quantidadeAlocar}
                    onChange={(e) => setQuantidadeAlocar(e.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button onClick={() => void alocar()} disabled={!podeAlocar || ocupado}>
                    Alocar
                  </Button>
                  <Button variant="ghost" onClick={() => setAlocando(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
              {/*
                A alocação NÃO cria nem destrói mercadoria: ela move o saldo do
                balde "sem lote" para o lote, por um par de movimentos no razão
                — o mesmo desenho da transferência entre locais. O total do
                produto não muda, e o histórico registra as duas pernas.
              */}
              <p className="mt-2 mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                O saldo total do produto não muda: a mercadoria só passa a ter identidade. As duas
                pernas ficam no histórico de movimentações.
              </p>
            </div>
          )}
        </Card>
      )}

      <Card
        title="Lotes com saldo"
        subtitle="Em ordem de validade — o primeiro da lista é o primeiro a sair."
      >
        <label className="flex flex-col gap-1.5 mb-4 max-w-md">
          <span className={ROTULO}>Buscar</span>
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Código do lote, nome ou código do produto"
          />
        </label>

        {lotes === null ? (
          <p className="text-[var(--gs-text-soft)]">Carregando…</p>
        ) : lotes.length === 0 ? (
          <EmptyState
            title="Nenhum lote com saldo"
            description="Marque o controle de lote no cadastro do produto e informe o lote na entrada de estoque."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className={TH}>Produto</th>
                  <th className={TH}>Lote</th>
                  <th className={TH}>Validade</th>
                  <th className={`${TH} text-right`}>Saldo</th>
                  <th className={`${TH} text-right`}>Valor</th>
                  <th className={TH}>Conferência</th>
                  <th className={`${TH} text-right`} />
                </tr>
              </thead>
              <tbody>
                {lotes.map((l) => (
                  <tr
                    key={l.id}
                    className="border-b border-[var(--gs-border)] last:border-0 hover:bg-[var(--gs-surface-hover)]"
                  >
                    <td className={TD}>
                      <span className="font-mono text-[length:var(--gs-text-xs)] mr-2">
                        {l.internal_code}
                      </span>
                      {l.product_name}
                    </td>
                    <td className={`${TD} font-mono text-[length:var(--gs-text-xs)]`}>{l.code}</td>
                    <td className={TD}>
                      <span className="mr-2">{dataBonita(l.expires_on)}</span>
                      <Badge tone={TOM_DA_FAIXA[l.faixa]}>
                        {l.faixa === 'vencido'
                          ? 'não pode vender'
                          : l.dias_para_vencer === null
                            ? 'sem validade'
                            : `${l.dias_para_vencer} d`}
                      </Badge>
                    </td>
                    <td className={`${TD} text-right tabular-nums font-semibold`}>
                      {formatQuantity(l.quantity)} {l.unit}
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>
                      {formatCents(l.value_cents)}
                    </td>
                    <td className={TD}>
                      {l.checked_at ? (
                        <span className="text-[var(--gs-text-soft)]">
                          {l.checked_by_name ?? 'conferido'}
                        </span>
                      ) : (
                        <Badge tone="warning">falta conferir</Badge>
                      )}
                    </td>
                    <td className={`${TD} text-right`}>
                      {!l.checked_at && (
                        <Button variant="ghost" disabled={ocupado} onClick={() => void conferir(l)}>
                          Conferir
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
          A régua, escrita em palavras, na tela em que ela decide o que
          acontece no balcão. Sem isto o operador descobre a recusa com o
          cliente na frente e sem saber o que fazer.
        */}
        <p className="mt-4 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Lote vencido não sai pela venda — o PDV recusa. Para tirá-lo da prateleira, lance uma
          saída por perda em <strong>Estoque › Movimentações</strong>, escolhendo o lote. Produto
          sem controle de lote não é afetado por nenhuma destas regras.
        </p>
      </Card>
    </AppShell>
  );
}

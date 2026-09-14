/**
 * Locação › Contratos.
 *
 * LOCAR NÃO É VENDER: o bem sai da loja sem sair do patrimônio. Por isso a tela
 * fala em "está fora" e não em "vendido" — e por isso locar reserva o estoque
 * em vez de dar baixa.
 *
 * O que a reserva garante, e que a tela promete: o balcão NÃO vende a peça que
 * está com o cliente. Devolver solta; cancelar também, porque contrato que não
 * aconteceu não pode manter mercadoria presa.
 *
 * Atraso é calculado na hora da leitura. Um estado gravado envelheceria
 * sozinho: o contrato só ficaria "atrasado" quando alguém abrisse a tela.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type RentalContract,
  type RentalContractDetail,
  type RentalStatus,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';
import { BuscaDeCliente, BuscaDeProduto, type Escolhido } from '@/components/gs/BuscaDeCadastro';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TOM: Record<RentalStatus, 'info' | 'success' | 'danger'> = {
  aberto: 'info',
  devolvido: 'success',
  cancelado: 'danger',
};

const ROTULO: Record<RentalStatus, string> = {
  aberto: 'Fora',
  devolvido: 'Devolvido',
  cancelado: 'Cancelado',
};

export default function LocacaoPage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const [contratos, setContratos] = useState<RentalContract[] | null>(null);
  const [detalhe, setDetalhe] = useState<RentalContractDetail | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const [criando, setCriando] = useState(false);
  /*
    CLIENTE E ITEM POR BUSCA (GAP-PRD-070). Os dois seletores carregavam a
    lista SEM termo — os 100 primeiros clientes e os 100 primeiros produtos em
    ordem alfabética —, e quem vinha depois disso não podia ter contrato.
  */
  const [cliente, setCliente] = useState<Escolhido | null>(null);
  const [produto, setProduto] = useState<Escolhido | null>(null);
  const clienteId = cliente?.id ?? '';
  const produtoId = produto?.id ?? '';
  const [quantidade, setQuantidade] = useState('1');
  const [valor, setValor] = useState('');
  const [devolucao, setDevolucao] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setContratos(await coreApi.listRentals());
    } catch (err) {
      setContratos(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar contratos.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrir = async (id: string) => {
    setErro(null);
    try {
      setDetalhe(await coreApi.getRental(id));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o contrato.');
    }
  };

  const criar = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const c = await coreApi.createRental({
        customerId: clienteId,
        endsAt: new Date(devolucao).toISOString(),
        items: [
          {
            productId: produtoId,
            quantity: Number(quantidade) || 1,
            unitCents: Math.round((Number(valor) || 0) * 100),
          },
        ],
      });
      setAviso(
        `Contrato #${c.number} aberto. A mercadoria saiu do disponível e não pode ser vendida no balcão.`,
      );
      setCriando(false);
      setCliente(null);
      setProduto(null);
      setQuantidade('1');
      setValor('');
      setDevolucao('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o contrato.');
    } finally {
      setOcupado(false);
    }
  };

  const devolverTudo = async () => {
    if (!detalhe) return;
    setOcupado(true);
    setErro(null);
    try {
      const items = detalhe.items
        .filter((i) => i.quantity > i.returned_quantity)
        .map((i) => ({ productId: i.product_id, quantity: i.quantity - i.returned_quantity }));
      const atualizado = await coreApi.returnRental(detalhe.id, items);
      setDetalhe(atualizado);
      setAviso('Devolvido. A mercadoria voltou ao disponível.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a devolução.');
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async () => {
    if (!detalhe) return;
    const motivo = await pedirMotivo({
      titulo: 'Cancelar este contrato de locação?',
      explicacao: 'A mercadoria presa no contrato volta ao disponível.',
      rotulo: 'Motivo do cancelamento',
      minimo: 3,
      confirmar: 'Cancelar o contrato',
      perigoso: true,
    });
    if (!motivo) return;
    try {
      setDetalhe(await coreApi.cancelRental(detalhe.id, motivo));
      setAviso('Contrato cancelado. A mercadoria presa foi liberada.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cancelar.');
    }
  };

  return (
    <AppShell>
      {dialogoDeMotivo}
      <PageHeader
        breadcrumb={['Locação', 'Contratos']}
        title="Contratos de locação"
        subtitle="O bem sai da loja sem sair do patrimônio — fica reservado, e o balcão não o vende."
        actions={
          <Button onClick={() => setCriando((v) => !v)}>
            Novo contrato
          </Button>
        }
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {criando && (
        <Card title="Novo contrato">
          <div className="grid gap-4 md:grid-cols-2">
            <BuscaDeCliente
              obrigatorio
              valor={cliente}
              aoMudar={(c) => setCliente(c ? { id: c.id, nome: c.name } : null)}
            />
            <Field label="Devolver até" required>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={devolucao}
                  onChange={(e) => setDevolucao(e.target.value)}
                />
              )}
            </Field>
            <BuscaDeProduto
              rotulo="Item"
              obrigatorio
              valor={produto}
              aoMudar={(p2) => setProduto(p2 ? { id: p2.id, nome: p2.name } : null)}
            />
            <Field label="Quantidade / valor da locação (R$)">
              {(p) => (
                <div className="flex gap-2">
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    value={quantidade}
                    onChange={(e) => setQuantidade(e.target.value)}
                    className="w-24"
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={valor}
                    onChange={(e) => setValor(e.target.value)}
                    placeholder="Valor por item"
                  />
                </div>
              )}
            </Field>
          </div>
          <div className="flex gap-2 mt-3">
            <Button
              onClick={() => void criar()}
              loading={ocupado}
              disabled={!clienteId || !produtoId || !devolucao}
            >
              Abrir contrato
            </Button>
            <Button variant="ghost" onClick={() => setCriando(false)}>
              Cancelar
            </Button>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Ao abrir, a mercadoria fica reservada: continua no estoque, porque é da loja, e sai do
            disponível, porque está fora.
          </p>
        </Card>
      )}

      {detalhe && (
        <Card title={`Contrato #${detalhe.number} · ${detalhe.customer?.name ?? ''}`}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <Badge tone={TOM[detalhe.status]}>{ROTULO[detalhe.status]}</Badge>
            {detalhe.atrasado && <Badge tone="danger">Atrasado</Badge>}
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Devolver até {dataBR(detalhe.ends_at)}
            </span>
            {detalhe.cancel_reason && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                {detalhe.cancel_reason}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Locado</th>
                  <th className="py-2 text-right">Devolvido</th>
                  <th className="py-2 text-right">Ainda fora</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.items.map((i) => (
                  <tr key={i.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{i.name}</td>
                    <td className="py-2 text-right">{i.quantity}</td>
                    <td className="py-2 text-right">{i.returned_quantity}</td>
                    <td className="py-2 text-right font-semibold">
                      {i.quantity - i.returned_quantity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2 mt-4">
            {detalhe.status === 'aberto' && (
              <>
                <Button onClick={() => void devolverTudo()} loading={ocupado}>
                  Registrar devolução total
                </Button>
                <Button variant="ghost" onClick={() => void cancelar()}>
                  Cancelar contrato
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setDetalhe(null)}>
              Fechar
            </Button>
          </div>
        </Card>
      )}

      <Card title="Contratos">
        {contratos === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : contratos.length === 0 ? (
          <EmptyState
            title="Nenhum contrato"
            description="Ao locar, a mercadoria fica reservada e some do disponível — sem sair do estoque."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Cliente</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2">Devolver até</th>
                  <th className="py-2 text-right">Valor</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {contratos.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{c.number}</td>
                    <td className="py-2">{c.customer_name}</td>
                    <td className="py-2">
                      <Badge tone={TOM[c.status]}>{ROTULO[c.status]}</Badge>
                      {c.atrasado && (
                        <span className="ml-2">
                          <Badge tone="danger">Atrasado</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2">{dataBR(c.ends_at)}</td>
                    <td className="py-2 text-right">{formatCents(c.total_cents)}</td>
                    <td className="py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void abrir(c.id)}>
                        Abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}

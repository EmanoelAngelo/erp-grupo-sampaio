/**
 * CRM › Fidelidade.
 *
 * PONTO ACUMULADO É DÍVIDA DA LOJA, e a tela precisa mostrar isso — não como
 * um número bonito de engajamento, mas como o desconto que ainda vai sair do
 * caixa. Por isso o painel principal se chama "o que a loja deve", e não
 * "pontos distribuídos".
 *
 * O acúmulo acontece sozinho na venda: quem cadastrou o cliente no PDV já ganha
 * ponto sem ninguém apertar nada. Aqui ficam a regra, o extrato de cada cliente
 * e o resgate.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type Customer,
  type LoyaltyEntry,
  type LoyaltyLiability,
  type LoyaltyProgram,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';
import { BuscaDeCliente } from '@/components/gs/BuscaDeCadastro';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const ROTULO_TIPO: Record<LoyaltyEntry['kind'], string> = {
  earn: 'Acúmulo',
  redeem: 'Resgate',
  reversal: 'Estorno',
  adjustment: 'Ajuste',
};

export default function FidelidadePage() {
  const [programa, setPrograma] = useState<LoyaltyProgram | null>(null);
  const [passivo, setPassivo] = useState<LoyaltyLiability | null>(null);
  const [selecionado, setSelecionado] = useState<Customer | null>(null);
  const [extrato, setExtrato] = useState<{ balance: number; entries: LoyaltyEntry[] } | null>(null);
  const [resgate, setResgate] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const res = await coreApi.getLoyaltyProgram();
      setPrograma(res.program);
      setPassivo(res.liability);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a fidelidade.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * `active` é booleano aqui e número na tabela (0/1 do SQLite). Manter os dois
   * no mesmo tipo cria um campo que não aceita nenhum dos dois.
   */
  const salvar = async (mudanca: {
    active?: boolean;
    centsPerPoint?: number;
    pointValueCents?: number;
    minPointsToRedeem?: number;
  }) => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.updateLoyaltyProgram(mudanca);
      await carregar();
      setAviso('Regra salva.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setOcupado(false);
    }
  };

  const abrirCliente = async (cliente: Customer) => {
    setSelecionado(cliente);
    setErro(null);
    try {
      setExtrato(await coreApi.loyaltyStatement(cliente.id));
    } catch (err) {
      setExtrato(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o extrato.');
    }
  };

  const resgatar = async () => {
    if (!selecionado) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await coreApi.redeemPoints(selecionado.id, Number(resgate));
      setAviso(
        `${res.points} ponto(s) resgatados — ${formatCents(res.discountCents)} de desconto. Saldo: ${res.balanceAfter}.`,
      );
      setResgate('');
      await abrirCliente(selecionado);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao resgatar.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['CRM', 'Fidelidade']}
        title="Fidelidade"
        subtitle="Ponto acumulado é desconto que a loja vai dar — por isso aparece como dívida, não como receita."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {passivo && (
        <Card title="O que a loja deve em pontos">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Pontos em aberto</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{passivo.points}</p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Desconto prometido
              </p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(passivo.estimatedCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Clientes</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{passivo.customers}</p>
            </div>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
            Este valor ainda vai sair do caixa em desconto. Ele não é faturamento e não aparece no
            financeiro.
          </p>
        </Card>
      )}

      {programa && (
        <Card title="Regra do programa">
          <div className="flex items-center gap-3 mb-4">
            <Badge tone={programa.active ? 'success' : 'neutral'}>
              {programa.active ? 'Ligado' : 'Desligado'}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              loading={ocupado}
              onClick={() => void salvar({ active: !programa.active })}
            >
              {programa.active ? 'Desligar' : 'Ligar'}
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Centavos por ponto" hint="Quanto o cliente gasta para ganhar 1 ponto">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  defaultValue={programa.cents_per_point}
                  onBlur={(e) => void salvar({ centsPerPoint: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Valor do ponto (centavos)" hint="Quanto 1 ponto vale de desconto">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  defaultValue={programa.point_value_cents}
                  onBlur={(e) => void salvar({ pointValueCents: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Mínimo para resgatar">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  defaultValue={programa.min_points_to_redeem}
                  onBlur={(e) => void salvar({ minPointsToRedeem: Number(e.target.value) })}
                />
              )}
            </Field>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O acúmulo acontece sozinho na venda, quando ela tem cliente. Venda cancelada ou
            devolvida estorna o ponto — na devolução parcial, proporcionalmente.
          </p>
        </Card>
      )}

      <Card title="Extrato do cliente">
        {/*
          A BUSCA NO LUGAR DOS DOZE BOTÕES (GAP-PRD-070).

          Eram os doze primeiros nomes da lista de 100, sem busca: o extrato do
          13º cliente em diante não tinha como ser aberto por esta tela. Agora
          qualquer cliente ativo se acha por nome, CPF, telefone ou código.
        */}
        <div className="mb-3 max-w-xl">
          <BuscaDeCliente
            rotulo="Cliente do extrato"
            valor={selecionado ? { id: selecionado.id, nome: selecionado.name } : null}
            aoMudar={(c) => {
              if (c) {
                void abrirCliente(c);
              } else {
                setSelecionado(null);
                setExtrato(null);
              }
            }}
          />
        </div>

        {selecionado && extrato && (
          <>
            <div className="flex flex-wrap items-end gap-3 mb-3">
              <span className="text-[length:var(--gs-text-lg)] font-bold">
                {extrato.balance} ponto(s)
              </span>
              {programa?.active && extrato.balance > 0 && (
                <>
                  <div className="w-40">
                    <Field label="Resgatar">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min={1}
                          max={extrato.balance}
                          value={resgate}
                          onChange={(e) => setResgate(e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  <Button
                    onClick={() => void resgatar()}
                    loading={ocupado}
                    disabled={!resgate || Number(resgate) <= 0}
                  >
                    Resgatar
                  </Button>
                </>
              )}
            </div>

            {extrato.entries.length === 0 ? (
              <EmptyState
                title="Sem movimentação"
                description="O ponto entra quando a venda tem cliente e o programa está ligado."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                  <thead>
                    <tr className="text-left text-[var(--gs-muted)]">
                      <th className="py-2">Quando</th>
                      <th className="py-2">Tipo</th>
                      <th className="py-2">Descrição</th>
                      <th className="py-2 text-right">Pontos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extrato.entries.map((e) => (
                      <tr key={e.id} className="border-t border-[var(--gs-border)]">
                        <td className="py-2">
                          {dataBR(e.created_at)}
                        </td>
                        <td className="py-2">{ROTULO_TIPO[e.kind]}</td>
                        <td className="py-2">{e.description}</td>
                        <td
                          className={`py-2 text-right font-semibold ${
                            e.points < 0 ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-success)]'
                          }`}
                        >
                          {e.points > 0 ? `+${e.points}` : e.points}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </AppShell>
  );
}

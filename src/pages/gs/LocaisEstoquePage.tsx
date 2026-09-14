/**
 * Estoque › Locais — onde a mercadoria está.
 *
 * A tela responde duas perguntas diferentes e por isso tem duas metades: o
 * cadastro dos locais, e — escolhido um produto — a posição dele repartida por
 * local, com a transferência logo abaixo.
 *
 * A posição por local NÃO é um segundo saldo: ela é somada do histórico de
 * movimentos. Por isso a soma das linhas sempre fecha com o saldo total do
 * produto, e é isso que o rodapé mostra de propósito — para o gestor conferir
 * em vez de acreditar.
 *
 * A transferência move mercadoria sem alterar o total: sai de um local, entra
 * em outro, com a mesma referência. Não é ajuste, e por isso não pede motivo:
 * nada foi criado nem destruído.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type LocationBalance, type StockItem, type StockLocation } from '@/lib/api/core';
import { useHasProfile } from '@/hooks/useSession';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';

export default function LocaisEstoquePage() {
  /*
    QUEM MEXE NOS LOCAIS (GAP-PRD-149). Criar, desativar e transferir são
    `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')` no
    servidor. A tela é ROTA_GESTAO e o atendente chega aqui para CONSULTAR onde
    a mercadoria está; os três botões lhe batiam na cara com 403.
  */
  const podeMexer = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');
  const [locais, setLocais] = useState<StockLocation[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [novoCodigo, setNovoCodigo] = useState('');
  const [novoNome, setNovoNome] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<StockItem[]>([]);
  const [produto, setProduto] = useState<StockItem | null>(null);
  const [posicao, setPosicao] = useState<LocationBalance[] | null>(null);

  const [de, setDe] = useState('');
  const [para, setPara] = useState('');
  const [quantidade, setQuantidade] = useState('');
  const [transferindo, setTransferindo] = useState(false);

  const carregarLocais = useCallback(async () => {
    setErro(null);
    try {
      setLocais(await coreApi.listStockLocations(true));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar os locais.');
      setLocais([]);
    }
  }, []);

  useEffect(() => {
    void carregarLocais();
  }, [carregarLocais]);

  const carregarPosicao = useCallback(async (produtoId: string) => {
    try {
      setPosicao(await coreApi.stockBalanceByLocation(produtoId));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível ler a posição.');
      setPosicao([]);
    }
  }, []);

  async function procurar(termo: string) {
    setBusca(termo);
    if (termo.trim().length < 2) {
      setAchados([]);
      return;
    }
    try {
      setAchados((await coreApi.listStock({ search: termo.trim() })).slice(0, 8));
    } catch {
      setAchados([]);
    }
  }

  function escolher(item: StockItem) {
    setProduto(item);
    setAchados([]);
    setBusca('');
    setPosicao(null);
    void carregarPosicao(item.product_id);
  }

  async function criar() {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const local = await coreApi.createStockLocation({ code: novoCodigo, name: novoNome });
      setNovoCodigo('');
      setNovoNome('');
      setAviso(`Local ${local.code} criado.`);
      await carregarLocais();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível criar o local.');
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo(local: StockLocation) {
    setErro(null);
    try {
      await coreApi.updateStockLocation(local.id, { active: local.active !== 1 });
      await carregarLocais();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível alterar o local.');
    }
  }

  async function transferir() {
    if (!produto) return;
    setTransferindo(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.transferStock({
        productId: produto.product_id,
        fromLocationId: de,
        toLocationId: para,
        quantity: Number(quantidade.replace(',', '.')),
      });
      setQuantidade('');
      setAviso('Transferência registrada.');
      await carregarPosicao(produto.product_id);
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível transferir.');
    } finally {
      setTransferindo(false);
    }
  }

  const ativos = useMemo(() => (locais ?? []).filter((l) => l.active === 1), [locais]);
  const totalPorLocal = useMemo(
    () => (posicao ?? []).reduce((t, l) => t + l.quantity, 0),
    [posicao],
  );
  const podeTransferir =
    !!produto && !!de && !!para && de !== para && Number(quantidade.replace(',', '.')) > 0;

  return (
    <AppShell>
      <PageHeader
        title="Locais de estoque"
        subtitle="Onde a mercadoria está guardada. A posição por local é somada do histórico — não é um segundo saldo."
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Locais cadastrados">
          {podeMexer ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-4">
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Código</span>
                <Input
                  value={novoCodigo}
                  onChange={(e) => setNovoCodigo(e.target.value)}
                  placeholder="DEP"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Nome</span>
                <Input
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  placeholder="Depósito"
                />
              </label>
              <Button
                onClick={() => void criar()}
                disabled={salvando || !novoCodigo.trim() || !novoNome.trim()}
              >
                Adicionar
              </Button>
            </div>
          ) : (
            <p data-testid="locais-so-consulta" className="mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Consulta: criar, desativar e transferir entre locais é do estoque e da gerência.
            </p>
          )}

          {locais === null ? (
            <p className="text-[var(--gs-text-soft)]">Carregando…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Código</th>
                    <th className={TH}>Nome</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {locais.map((l) => (
                    <tr
                      key={l.id}
                      className="border-b border-[var(--gs-border)] last:border-0 hover:bg-[var(--gs-surface-hover)]"
                    >
                      <td className={`${TD} font-mono text-[length:var(--gs-text-xs)]`}>{l.code}</td>
                      <td className={TD}>
                        <span className="mr-2">{l.name}</span>
                        {l.is_default === 1 && <Badge tone="info">padrão</Badge>}
                        {l.active !== 1 && <Badge tone="neutral">inativo</Badge>}
                      </td>
                      <td className={`${TD} text-right`}>
                        {/* O padrão não desliga: é para onde aponta todo
                            movimento gravado sem local — ou seja, o histórico
                            inteiro anterior a esta tela. */}
                        {podeMexer && l.is_default !== 1 && (
                          <Button variant="ghost" onClick={() => void alternarAtivo(l)}>
                            {l.active === 1 ? 'Desativar' : 'Reativar'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Posição por local">
          <label className="flex flex-col gap-1.5 mb-4">
            <span className={ROTULO}>Produto</span>
            <Input
              value={busca}
              onChange={(e) => void procurar(e.target.value)}
              placeholder="Nome, código ou código de barras"
            />
          </label>

          {achados.length > 0 && (
            <ul className="mb-4 border border-[var(--gs-border)] rounded-[var(--gs-radius)] divide-y divide-[var(--gs-border)]">
              {achados.map((a) => (
                <li key={a.product_id}>
                  <button
                    type="button"
                    onClick={() => escolher(a)}
                    className="w-full text-left px-4 py-2.5 hover:bg-[var(--gs-surface-hover)]"
                  >
                    {a.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!produto ? (
            <EmptyState
              title="Escolha um produto"
              description="A posição por local é somada do histórico de movimentos."
            />
          ) : (
            <>
              <p className="font-semibold mb-3">{produto.name}</p>

              {posicao === null ? (
                <p className="text-[var(--gs-text-soft)]">Carregando…</p>
              ) : (
                <div className="overflow-x-auto mb-6">
                  <table className="w-full text-[length:var(--gs-text-sm)]">
                    <thead>
                      <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                        <th className={TH}>Local</th>
                        <th className={`${TH} text-right`}>Quantidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {posicao.map((l) => (
                        <tr
                          key={l.locationId ?? l.code}
                          className="border-b border-[var(--gs-border)]"
                        >
                          <td className={TD}>
                            <span className="font-mono text-[length:var(--gs-text-xs)] mr-2">{l.code}</span>
                            {l.name}
                          </td>
                          <td className={`${TD} text-right tabular-nums font-semibold`}>
                            {formatQuantity(l.quantity)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      {/*
                        Este total existe para conferência: ele tem de bater com
                        o saldo do produto na posição de estoque. Se um dia não
                        bater, o problema está no histórico — não há cache aqui
                        para ficar desatualizado.
                      */}
                      <tr>
                        <td className={`${TD} font-semibold`}>Total</td>
                        <td className={`${TD} text-right tabular-nums font-semibold`}>
                          {formatQuantity(totalPorLocal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {podeMexer && (
                <>
                  <p className={`${ROTULO} mb-2`}>Transferir entre locais</p>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                    <label className="flex flex-col gap-1.5">
                      <span className={ROTULO}>De</span>
                      <select
                        value={de}
                        onChange={(e) => setDe(e.target.value)}
                        className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)]"
                      >
                        <option value="">Escolha…</option>
                        {ativos.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.code} — {l.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className={ROTULO}>Para</span>
                      <select
                        value={para}
                        onChange={(e) => setPara(e.target.value)}
                        className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)]"
                      >
                        <option value="">Escolha…</option>
                        {ativos
                          .filter((l) => l.id !== de)
                          .map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.code} — {l.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className={ROTULO}>Quantidade</span>
                      <Input
                        value={quantidade}
                        onChange={(e) => setQuantidade(e.target.value)}
                        inputMode="decimal"
                      />
                    </label>
                    <Button onClick={() => void transferir()} disabled={!podeTransferir || transferindo}>
                      Transferir
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

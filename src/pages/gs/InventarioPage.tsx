/**
 * Estoque › Ajustes e inventário.
 *
 * O acerto é a ÚNICA entrada de estoque sem documento por trás: não há nota,
 * venda nem OS. É alguém afirmando que o saldo é outro. Por isso esta tela
 * mostra sempre as três colunas juntas — esperado, contado e diferença — e
 * exige motivo para aplicar.
 *
 * DUAS COISAS QUE A TELA PRECISA DEIXAR ÓBVIAS, porque erradas custam
 * mercadoria de verdade:
 *
 *   PENDENTE NÃO É ZERO   item sem contagem fica "—", não "0". Quem não foi
 *                         alcançado pelo corredor de hoje não é mercadoria que
 *                         sumiu, e não entra no acerto.
 *   DIFERENÇA, NÃO TROCA  o que se aplica é `contado − esperado`. Entre contar
 *                         e aplicar a loja segue vendendo; gravar o contado
 *                         como saldo devolveria o vendido ao estoque.
 *
 * CONTAR E APLICAR SÃO DE GENTE DIFERENTE — e a tela precisava dizer isso
 *
 * As quatro rotas da contagem aceitam `gerente_loja`, `gerente_oficina` e
 * `estoquista`; as duas do FIM — aplicar e cancelar — aceitam só os dois
 * gerentes. É deliberado: o acerto é a única entrada de estoque sem documento
 * por trás, e quem afirma que o saldo é outro responde pela loja.
 *
 * A tela não sabia disso. Os botões "Aplicar acerto" e "Cancelar contagem"
 * eram desenhados para todo mundo, e o estoquista — que entra aqui
 * legitimamente desde que a porta da tela foi corrigida — contava a prateleira
 * inteira, digitava o motivo, clicava em Aplicar e lia "Falha ao aplicar o
 * acerto.": o 403 do servidor traduzido para uma frase que não explica nada,
 * DEPOIS do trabalho feito. É a mesma "porta desenhada que não abre" um nível
 * abaixo — no botão, em vez da tela.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type Category,
  type InventoryCount,
  type InventoryCountDetail,
  type InventoryCountStatus,
  type StockLocation,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';
import { useHasProfile } from '@/hooks/useSession';

const TOM: Record<InventoryCountStatus, 'info' | 'success' | 'danger'> = {
  aberta: 'info',
  aplicada: 'success',
  cancelada: 'danger',
};

const ROTULO: Record<InventoryCountStatus, string> = {
  aberta: 'Aberta',
  aplicada: 'Aplicada',
  cancelada: 'Cancelada',
};

export default function InventarioPage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  /*
    O ESPELHO EXATO do guarda das duas rotas do FIM da contagem —
    `requireProfile(req, 'gerente_loja', 'gerente_oficina')` em
    `POST /core/inventory-counts/:id/apply` e em `.../cancel`. `useHasProfile`
    já embute o "admin_geral e gestor passam por cima", igual ao servidor.

    ## POR QUE O BOTÃO SOME, E NÃO APARECE DESABILITADO

    A casa tem precedente para as duas formas, e elas dizem coisas diferentes:

      BOTÃO VISÍVEL COM AVISO  é o de `DevolucoesPage`, e ele só existe porque
                               existe CAMINHO — o servidor recusa com
                               `CORE_CANCEL_NEEDS_AUTHORIZATION`, o gestor
                               assina ali mesmo e a ação segue. Mostrar é
                               oferecer uma saída real.
      BOTÃO QUE NÃO EXISTE     é o dos vizinhos DESTE módulo:
                               `MovimentacoesEstoquePage` (`podeLancar &&
                               <LancamentoManual/>`) e `EntradaNotasPage`
                               (`estorna`, `manifesta`), com a frase "a tela não
                               promete o que o servidor nega" escrita lá.

    Aplicar inventário não tem liberação pontual: `aplicar_inventario` não está
    em `RESTRICTED_ACTIONS` — as cinco ações são desconto_acima_limite,
    sangria_especial, cancelar_venda, devolver_venda e reabrir_caixa. Não há
    bilhete a pedir, e o diálogo do gestor não teria o que fazer. Um botão
    desabilitado seria desenhar a porta e escrever "não abre" nela.

    Some — e no lugar dele a tela DIZ quem aplica. Sumir calado deixaria o
    estoquista com a contagem pronta e sem saber o que fazer com ela, que é o
    segundo defeito do primeiro. CONTAR continua inteiro: é o trabalho dele, e
    o campo de contagem não é tocado por este recorte.
  */
  const podeFecharAContagem = useHasProfile('gerente_loja', 'gerente_oficina');
  const [lista, setLista] = useState<InventoryCount[] | null>(null);
  const [atual, setAtual] = useState<InventoryCountDetail | null>(null);
  const [escopo, setEscopo] = useState('');
  /*
    O RECORTE DA CONTAGEM PARCIAL. A rota sempre aceitou lista de produtos, mas
    a tela só mandava a anotação de escopo — TODA contagem aberta por aqui
    congelava o catálogo ativo inteiro. Numa loja com milhares de SKUs a lista
    ficava impraticável, e o acerto avulso de um produto, lento. Categoria e
    busca viajam na abertura; o servidor congela SÓ o que casar.
  */
  const [categoria, setCategoria] = useState('');
  const [recorteBusca, setRecorteBusca] = useState('');
  const [categorias, setCategorias] = useState<Category[]>([]);
  /*
    O LOCAL CONTADO (GAP-PRD-167). A contagem comparava com o saldo da empresa
    inteira: com loja e depósito, contar a Vitrine exigia somar o depósito de
    cabeça. Vazio = a empresa inteira, como sempre. O seletor só aparece quando
    há mais de um local ativo — quem não usa locais não ganha um campo inútil.
  */
  const [locais, setLocais] = useState<StockLocation[]>([]);
  const [localId, setLocalId] = useState('');
  /** Filtro de TELA sobre os itens da contagem aberta — não muda a contagem. */
  const [filtroItens, setFiltroItens] = useState('');
  const [motivo, setMotivo] = useState('');
  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setLista(await coreApi.listInventoryCounts());
    } catch (err) {
      setLista(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar contagens.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    // As categorias alimentam o recorte. Se a leitura falhar, a contagem
    // continua possível — o recorte por categoria só fica sem opções.
    void coreApi
      .getTaxonomy()
      .then((t) => setCategorias(t.categories))
      .catch(() => setCategorias([]));
    // Os locais alimentam o seletor. Falhar deixa só a contagem da empresa
    // inteira — que é a de sempre.
    void coreApi
      .listStockLocations()
      .then((l) => setLocais(Array.isArray(l) ? l : []))
      .catch(() => setLocais([]));
  }, []);

  const abrir = async (id: string) => {
    setErro(null);
    setFiltroItens('');
    try {
      const detalhe = await coreApi.getInventoryCount(id);
      setAtual(detalhe);
      setRascunho(
        Object.fromEntries(
          detalhe.items.map((i) => [
            i.product_id,
            i.counted_quantity === null ? '' : String(i.counted_quantity),
          ]),
        ),
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a contagem.');
    }
  };

  const nova = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    setFiltroItens('');
    try {
      const detalhe = await coreApi.openInventoryCount({
        scopeNote: escopo || null,
        // Sem recorte, o corpo não inventa filtros: null abre o inventário
        // geral de sempre. Recorte vazio de resultado é RECUSA do servidor,
        // com mensagem legível — melhor que abrir contagem sem itens.
        category: categoria || null,
        search: recorteBusca.trim() || null,
        // Sem local escolhido o corpo não inventa um: a empresa inteira.
        ...(localId ? { locationId: localId } : {}),
      });
      setAtual(detalhe);
      setRascunho(Object.fromEntries(detalhe.items.map((i) => [i.product_id, ''])));
      setEscopo('');
      setCategoria('');
      setRecorteBusca('');
      setLocalId('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a contagem.');
    } finally {
      setOcupado(false);
    }
  };

  const gravarContagem = async (productId: string) => {
    if (!atual) return;
    const valor = rascunho[productId];
    // Campo vazio é "não contei", e isso é informação — não é zero.
    if (valor === '' || valor === undefined) return;
    setErro(null);
    try {
      const detalhe = await coreApi.recordCount(atual.id, productId, Number(valor));
      setAtual(detalhe);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a contagem.');
    }
  };

  const aplicar = async () => {
    if (!atual) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const detalhe = await coreApi.applyInventoryCount(atual.id, motivo);
      setAtual(detalhe);
      setMotivo('');
      setAviso(
        `Inventário #${detalhe.number} aplicado. Só os itens com diferença viraram movimento.`,
      );
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao aplicar o acerto.');
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async () => {
    if (!atual) return;
    const razao = await pedirMotivo({
      titulo: 'Cancelar este inventário?',
      explicacao: 'A contagem para aqui e nenhum acerto de estoque é aplicado.',
      rotulo: 'Motivo do cancelamento',
      minimo: 3,
      confirmar: 'Cancelar o inventário',
      perigoso: true,
    });
    if (!razao) return;
    try {
      setAtual(await coreApi.cancelInventoryCount(atual.id, razao));
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cancelar.');
    }
  };

  /*
    O BIPE (B-estoque-entrada-16).

    A contagem era digitada linha a linha: com o leitor na mão, bipar a caixa
    no filtro não achava nada (o filtro não olhava o código de barras), e o
    conferente lia o nome na etiqueta e procurava a linha — numa contagem de
    milhares de SKUs, o leitor não servia. Agora cada leitura (código + Enter)
    SOMA 1 no servidor, que acha o produto pelo código de barras, pelos códigos
    adicionais ou pelo código interno — inclusive a caixa que a lista não
    previa. As leituras vão em FILA: a resposta de um bipe nunca chega depois
    da do bipe seguinte e desfaz a soma na tela.
  */
  const [bipe, setBipe] = useState('');
  const filaDeBipes = useRef<Promise<void>>(Promise.resolve());
  const biparCodigo = (codigo: string) => {
    if (!atual) return;
    const contagem = atual.id;
    filaDeBipes.current = filaDeBipes.current.then(async () => {
      try {
        const detalhe = await coreApi.recordCountBipe(contagem, codigo);
        setAtual(detalhe);
        const item = detalhe.items.find(
          (i) =>
            i.barcode === codigo
            || i.internal_code === codigo
            || String(i.extra_barcodes ?? '').split(' ').includes(codigo),
        );
        if (item) {
          setRascunho((a) => ({ ...a, [item.product_id]: String(item.counted_quantity ?? '') }));
          setAviso(`${item.name}: ${item.counted_quantity ?? 0} contado(s).`);
        }
        setErro(null);
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a leitura.');
      }
    });
  };

  /*
    O filtro compara em minúsculas dos dois lados; vazio mostra tudo. O código
    de barras e os ADICIONAIS também filtram (B-16): bipar a caixa no filtro
    acha a linha.
  */
  const itensVisiveis = useMemo(() => {
    if (!atual) return [];
    const termo = filtroItens.trim().toLowerCase();
    if (!termo) return atual.items;
    return atual.items.filter(
      (i) =>
        i.name.toLowerCase().includes(termo)
        || i.internal_code.toLowerCase().includes(termo)
        || String(i.barcode ?? '').toLowerCase().includes(termo)
        || String(i.extra_barcodes ?? '').toLowerCase().includes(termo),
    );
  }, [atual, filtroItens]);

  return (
    <AppShell>
      {dialogoDeMotivo}
      <PageHeader
        breadcrumb={['Estoque', 'Inventário']}
        title="Ajustes e inventário"
        subtitle="Contar não mexe no saldo. O acerto move a diferença — e é o único movimento sem documento de origem."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {!atual && (
        <Card title="Nova contagem">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[260px]">
              <Field label="O que está sendo contado" hint="Fica registrado na contagem">
                {(p) => (
                  <Input
                    {...p}
                    value={escopo}
                    onChange={(e) => setEscopo(e.target.value)}
                    placeholder="Corredor 3, loja inteira, peças da oficina…"
                  />
                )}
              </Field>
            </div>
            {/*
              O RECORTE: categoria e/ou busca. Sem nada, é o inventário geral
              de sempre. Com recorte, o servidor congela SÓ o que casar — o
              resto da loja continua vendendo e se movimentando livre.
            */}
            <div className="min-w-[180px]">
              <Field label="Categoria" hint="Opcional — só o recorte é congelado">
                {(p) => (
                  <select
                    {...p}
                    className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                      bg-white text-[length:var(--gs-text-base)] w-full"
                    value={categoria}
                    onChange={(e) => setCategoria(e.target.value)}
                  >
                    <option value="">Todas</option>
                    {categorias.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="min-w-[200px]">
              <Field label="Recorte por busca" hint="Nome, código ou barras">
                {(p) => (
                  <Input
                    {...p}
                    value={recorteBusca}
                    onChange={(e) => setRecorteBusca(e.target.value)}
                    placeholder="Ex.: refrigerante"
                  />
                )}
              </Field>
            </div>
            {locais.length > 1 && (
              <div className="min-w-[200px]">
                <Field label="Local contado" hint="O esperado vira o saldo deste local">
                  {(p) => (
                    <select
                      {...p}
                      className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                        bg-white text-[length:var(--gs-text-base)] w-full"
                      value={localId}
                      onChange={(e) => setLocalId(e.target.value)}
                    >
                      <option value="">Todos os locais (a empresa inteira)</option>
                      {locais.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name} ({l.code})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
            )}
            <Button onClick={() => void nova()} loading={ocupado}>
              Abrir contagem
            </Button>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O saldo esperado de cada produto é congelado agora. Comparar com o saldo do momento de
            aplicar faria o acerto absorver as vendas do intervalo. Com categoria ou busca, a
            contagem é PARCIAL: só o recorte é congelado, e o resto do catálogo fica de fora do
            acerto.
            {locais.length > 1 &&
              ' Com um local escolhido, o esperado é o saldo DAQUELE local e o acerto sai nele — '
                + 'conte a Vitrine sem somar o depósito.'}
          </p>
        </Card>
      )}

      {atual && (
        <Card title={`Inventário #${atual.number}${atual.scope_note ? ` · ${atual.scope_note}` : ''}`}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <Badge tone={TOM[atual.status]}>{ROTULO[atual.status]}</Badge>
            {/* Qual prateleira é esta contagem (GAP-PRD-167). */}
            <Badge tone="neutral">
              {atual.location_name ? `Local: ${atual.location_name}` : 'Empresa inteira'}
            </Badge>
            <span className="text-[length:var(--gs-text-sm)]">
              {atual.resumo.contados} de {atual.resumo.total} contados
            </span>
            {atual.resumo.pendentes > 0 && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {atual.resumo.pendentes} pendente(s) — não entram no acerto
              </span>
            )}
            {atual.resumo.divergentes > 0 && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] font-semibold">
                {atual.resumo.falta} com falta · {atual.resumo.sobra} com sobra
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setAtual(null)}>
              Voltar à lista
            </Button>
          </div>

          {/*
            Filtro de TELA, não da contagem: os itens continuam TODOS na
            contagem — só a rolagem encurta. Era a outra metade do defeito da
            contagem-catálogo-inteiro: mesmo a contagem certa exigia rolar a
            lista completa para achar um item.
          */}
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="max-w-sm flex-1 min-w-[220px]">
              <Input
                value={filtroItens}
                onChange={(e) => setFiltroItens(e.target.value)}
                placeholder="Filtrar itens por nome, código ou código de barras"
                aria-label="Filtrar itens da contagem"
              />
            </div>
            {atual.status === 'aberta' && (
              <div className="max-w-sm flex-1 min-w-[220px]">
                <Input
                  value={bipe}
                  onChange={(e) => setBipe(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const codigo = bipe.trim();
                    setBipe('');
                    if (codigo) biparCodigo(codigo);
                  }}
                  placeholder="Bipe aqui: cada leitura soma 1"
                  aria-label="Bipar código de barras"
                />
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Produto</th>
                  <th className="py-2">Código</th>
                  <th className="py-2 text-right">Esperado</th>
                  <th className="py-2 w-32">Contado</th>
                  <th className="py-2">Contado por</th>
                  <th className="py-2 text-right">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {itensVisiveis.map((item) => {
                  const contado = item.counted_quantity;
                  const dif = contado === null ? null : contado - item.expected_quantity;
                  return (
                    <tr key={item.id} className="border-t border-[var(--gs-border)]">
                      <td className="py-2">{item.name}</td>
                      <td className="py-2 font-mono text-[var(--gs-muted)]">
                        {item.internal_code}
                      </td>
                      <td className="py-2 text-right">{item.expected_quantity}</td>
                      <td className="py-2">
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={rascunho[item.product_id] ?? ''}
                          disabled={atual.status !== 'aberta'}
                          placeholder="—"
                          onChange={(e) =>
                            setRascunho((a) => ({ ...a, [item.product_id]: e.target.value }))
                          }
                          onBlur={() => void gravarContagem(item.product_id)}
                        />
                      </td>
                      <td className="py-2">
                        {/*
                          QUEM contou — a pergunta de quem investiga 40 peças
                          faltando. `counted_by` sempre foi gravado a cada
                          contagem e nenhuma tela o nomeava; o nome vem do
                          servidor por JOIN. Travessão enquanto ninguém contou,
                          pela mesma regra da diferença: pendente não é lacuna.
                        */}
                        {item.counted_by_name ? (
                          item.counted_by_name
                        ) : (
                          <span className="text-[var(--gs-muted)]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right font-semibold">
                        {/*
                          Pendente mostra travessão, nunca zero: item não
                          alcançado pela contagem não é mercadoria que sumiu.
                        */}
                        {dif === null ? (
                          <span className="text-[var(--gs-muted)]">—</span>
                        ) : dif === 0 ? (
                          <span className="text-[var(--gs-muted)]">0</span>
                        ) : (
                          <span
                            className={
                              dif < 0 ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-success)]'
                            }
                          >
                            {dif > 0 ? `+${dif}` : dif}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {atual.status === 'aberta' && podeFecharAContagem && (
            <>
              <div className="mt-4 max-w-xl">
                <Field
                  label="Motivo do acerto"
                  required
                  hint="Fica gravado em cada movimento gerado — é o que resta de rastro"
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={motivo}
                      onChange={(e) => setMotivo(e.target.value)}
                      placeholder="Contagem mensal, quebra identificada…"
                    />
                  )}
                </Field>
              </div>
              <div className="flex gap-2 mt-3">
                <Button
                  onClick={() => void aplicar()}
                  loading={ocupado}
                  disabled={motivo.trim().length < 3 || atual.resumo.contados === 0}
                >
                  Aplicar acerto
                </Button>
                <Button variant="ghost" onClick={() => void cancelar()}>
                  Cancelar contagem
                </Button>
              </div>
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Só os itens com diferença viram movimento. O que bateu não gera linha, e o que não
                foi contado fica de fora.
              </p>
            </>
          )}

          {/*
            QUEM CONTA E NÃO APLICA PRECISA SABER O QUE FAZER COM A CONTAGEM.

            Esconder os dois botões sem dizer nada trocaria o 403 depois do
            trabalho por um silêncio antes dele — o estoquista terminaria o
            corredor e ficaria olhando para uma tela sem saída. A contagem
            continua GRAVADA a cada item: ela fica aberta esperando o gerente,
            e é isso que a frase promete.
          */}
          {atual.status === 'aberta' && !podeFecharAContagem && (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-4">
              Contar é seu; aplicar o acerto é de quem responde pela loja. Cada item que você digita
              já fica gravado nesta contagem — ela continua aberta, e o gerente da loja ou da
              oficina aplica (ou cancela) quando conferir.
            </p>
          )}

          {atual.status === 'aplicada' && atual.apply_reason && (
            <p className="text-[length:var(--gs-text-sm)] mt-3">
              Aplicado com o motivo: <strong>{atual.apply_reason}</strong>
            </p>
          )}
        </Card>
      )}

      <Card title="Contagens">
        {lista === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : lista.length === 0 ? (
          <EmptyState
            title="Nenhuma contagem"
            description="Abra uma contagem para conferir a prateleira contra o saldo do sistema."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Escopo</th>
                  <th className="py-2">Local</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2">Aberta em</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{c.number}</td>
                    <td className="py-2">{c.scope_note ?? '—'}</td>
                    <td className="py-2">{c.location_name ?? 'Empresa inteira'}</td>
                    <td className="py-2">
                      <Badge tone={TOM[c.status]}>{ROTULO[c.status]}</Badge>
                    </td>
                    <td className="py-2">
                      {dataBR(c.opened_at)}
                    </td>
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

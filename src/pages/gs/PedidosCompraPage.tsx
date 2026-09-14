/**
 * Compras › Pedidos de compra.
 *
 * O QUE ESTA TELA NÃO FAZ: dar entrada no estoque.
 *
 * O pedido é o combinado; a nota é o que chegou. O fornecedor manda o que ele
 * manda — falta item, vem quantidade diferente, vem produto trocado. Se o
 * pedido somasse ao estoque, o sistema afirmaria que a mercadoria chegou
 * porque alguém digitou que ia chegar, e a diferença só apareceria no
 * inventário, meses depois, como sumiço sem explicação.
 *
 * Quem dá entrada continua sendo a conferência da nota, em Entrada de notas.
 * Aqui se compara: pedido de 10, chegaram 4 — e a coluna diz isso.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { TitulosDoDocumento } from '@/components/gs/TitulosDoDocumento';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type FinanceEntry,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type PurchaseOrderItemInput,
  type PurchaseOrderStatus,
  type Supplier,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';
import { PARAM_DO_PEDIDO_DE_COMPRA, origemDaNota, rotaDaNotaDeEntrada } from '@/lib/rotasDeOrigem';
import { Paginacao } from '@/components/gs/Paginacao';
import { paginaDePedidosDeCompra, type Pagina } from '@/lib/api/paginas';
import { useHasProfile } from '@/hooks/useSession';
import { salvarArquivo } from '@/lib/download';
import { pedidoDeCompraApi } from '@/lib/api/pedidoDeCompra';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TOM: Record<PurchaseOrderStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  rascunho: 'neutral',
  enviado: 'info',
  recebido_parcial: 'warning',
  recebido: 'success',
  cancelado: 'danger',
};

const ROTULO: Record<PurchaseOrderStatus, string> = {
  rascunho: 'Rascunho',
  enviado: 'Enviado',
  recebido_parcial: 'Recebido em parte',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

/**
 * A linha do pedido em digitação.
 *
 * ## Por que ela carrega `productId` (GAP-V16)
 *
 * A conciliação pedido×nota casa por PRODUTO (`recalcReceived` no servidor):
 * item sem `product_id` soma ZERO recebido, e o pedido criado só com texto
 * livre ficava preso em "enviado" para sempre — mesmo com notas amarradas e
 * confirmadas. A tela era a única porta de criação e não oferecia o catálogo;
 * o backend sempre aceitou `productId`, e todos os testes verdes o usavam por
 * API. A busca abaixo liga o fio.
 *
 * A descrição LIVRE continua caminho legítimo: comprar embalagem ou café não
 * obriga a criar produto de revenda (decisão documentada no serviço) — mas aí
 * a linha não entra no confronto item a item, e isso é escolha de quem digita.
 */
interface LinhaNova {
  /** Produto do catálogo, quando a linha é mercadoria de revenda. */
  productId: string | null;
  internalCode: string | null;
  /** O termo digitado na busca do catálogo — vive por linha. */
  busca: string;
  resultados: Product[];
  description: string;
  quantity: string;
  unitCost: string;
}

const LINHA_VAZIA: LinhaNova = {
  productId: null,
  internalCode: null,
  busca: '',
  resultados: [],
  description: '',
  quantity: '1',
  unitCost: '0',
};

export default function PedidosCompraPage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const [pedidos, setPedidos] = useState<PurchaseOrder[] | null>(null);
  const [fornecedores, setFornecedores] = useState<Supplier[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<PurchaseOrderDetail | null>(null);

  const [criando, setCriando] = useState(false);
  const [fornecedorId, setFornecedorId] = useState('');
  const [observacao, setObservacao] = useState('');
  const [linhas, setLinhas] = useState<LinhaNova[]>([{ ...LINHA_VAZIA }]);
  const [salvando, setSalvando] = useState(false);

  /*
    A LISTA EM PÁGINA (GAP-PRD-164): parava em 200, e o 201º pedido sumia
    sem aviso. A primeira página vai sem parâmetro — o padrão do servidor já
    é 200 —, e o rodapé conta e anda.
  */
  const [pagina, setPagina] = useState<Pagina<PurchaseOrder> | null>(null);
  const [offset, setOffset] = useState(0);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const recebida = await paginaDePedidosDeCompra({ offset: offset || undefined });
      setPedidos(recebida.items);
      setPagina(recebida);
      setFornecedores(await coreApi.listSuppliers());
    } catch (err) {
      setPedidos(null);
      setPagina(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar pedidos.');
    }
  }, [offset]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * OS TÍTULOS DESTE PEDIDO — a VOLTA da rastreabilidade, do lado da compra.
   *
   * Nulo é "ainda não chegou"; vazio é "nenhuma nota deste pedido gerou dívida"
   * (pedido em rascunho, nota ainda em conferência). O erro em estado próprio
   * pelo mesmo motivo de sempre: falha lida como lista vazia diria "este pedido
   * não custou nada".
   */
  const [titulos, setTitulos] = useState<FinanceEntry[] | null>(null);
  const [erroTitulos, setErroTitulos] = useState<string | null>(null);

  const abrir = useCallback(async (id: string) => {
    setErro(null);
    try {
      setDetalhe(await coreApi.getPurchaseOrder(id));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o pedido.');
    }
  }, []);

  /*
    O PEDIDO QUE VEIO PELO LINK — `/sistema/compras/pedidos?pedido=<id>`.

    Mesmo desenho das outras fichas desta rodada: o endereço descreve o
    documento, e abrir pela lista escreve o parâmetro. O carregador é o MESMO
    `abrir` do botão — um segundo caminho para a mesma pergunta é como duas
    telas passam a divergir.
  */
  const [paramsDaUrl, setParamsDaUrl] = useSearchParams();
  const pedidoPedido = paramsDaUrl.get(PARAM_DO_PEDIDO_DE_COMPRA);
  /*
    Qual parâmetro já foi honrado. Sem a marca, o clique em "Abrir" carregaria
    o pedido DUAS vezes — uma pelo clique, outra pelo efeito, quando o
    parâmetro que o clique acabou de escrever chegasse. Ref e não estado
    porque isto não desenha nada.
  */
  const urlJaHonrada = useRef<string | null>(null);
  useEffect(() => {
    if (!pedidoPedido || urlJaHonrada.current === pedidoPedido) return;
    urlJaHonrada.current = pedidoPedido;
    void abrir(pedidoPedido);
  }, [pedidoPedido, abrir]);

  /*
    O QUE ESTE PEDIDO JÁ CUSTOU — e por que a pergunta é sobre as NOTAS.

    O pedido de compra NÃO gera lançamento financeiro: ele é o combinado.
    Quem gera é a NOTA que chega contra ele — é por isso que perguntar por
    `originType = 'purchase_order'` devolveria vazio para sempre, um bloco
    bonito que nunca mostraria nada.

    UMA PERGUNTA POR NOTA, com a ESPÉCIE que o servidor mandou. A NF-e grava
    origem 'nfe_entrada' e a compra digitada grava 'entrada_manual' (GAP-V17),
    e `origemDaNota` traduz uma na outra — a MESMA função que a tela de Entrada
    de notas usa.

    Antes eram DUAS perguntas por nota, uma por espécie, porque `inboundNotes`
    não trazia `doc_type`: a ficha ficava com a união e descobria a espécie por
    eliminação. Era barato e funcionava, e guardava aqui uma SEGUNDA definição
    de "o que é entrada manual" — no dia em que a régua do servidor mudasse
    (uma terceira espécie, um recibo de produtor rural), esta tela continuaria
    adivinhando pela regra velha, e a soma continuaria fechando por acidente.
    Agora a espécie vem na resposta do pedido e a régua vive num lugar só.
  */
  useEffect(() => {
    if (!detalhe) {
      setTitulos(null);
      setErroTitulos(null);
      return;
    }
    const notas = detalhe.inboundNotes;
    let vivo = true;
    setTitulos(null);
    setErroTitulos(null);
    void Promise.all(
      notas.map((n) =>
        coreApi.listFinanceEntries({ originType: origemDaNota(n.doc_type), originId: n.id }),
      ),
    )
      .then((respostas) => {
        // Um id só entra uma vez. As respostas são disjuntas (cada nota tem uma
        // espécie só), mas a lista é desenhada por `id` — repetir um deles
        // seria a mesma chave duas vezes no React, com linha somada em dobro
        // no total logo abaixo.
        const porId = new Map(respostas.flatMap((r) => r.items).map((t) => [t.id, t]));
        if (vivo) setTitulos([...porId.values()]);
      })
      .catch((err) => {
        if (!vivo) return;
        setTitulos([]);
        setErroTitulos(
          err instanceof ApiRequestError
            ? err.message
            : 'Falha ao consultar os títulos deste pedido.',
        );
      });
    return () => {
      vivo = false;
    };
  }, [detalhe]);

  /** Abrir pela lista também escreve o endereço: a URL descreve a tela. */
  const abrirEEnderecar = useCallback(
    async (id: string) => {
      // O efeito acima não repete o que este clique já está fazendo.
      urlJaHonrada.current = id;
      setParamsDaUrl({ [PARAM_DO_PEDIDO_DE_COMPRA]: id }, { replace: true });
      await abrir(id);
    },
    [abrir, setParamsDaUrl],
  );

  const criar = async () => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const items: PurchaseOrderItemInput[] = linhas
        .filter((l) => l.productId !== null || l.description.trim() !== '')
        .map((l) => ({
          // O CONSERTO do GAP-V16: a linha com produto viaja amarrada ao
          // catálogo — é o que faz o "Recebido" do pedido andar quando a
          // nota confirmar. Sem produto, viaja só a descrição, sem vínculo
          // inventado.
          ...(l.productId ? { productId: l.productId } : {}),
          description: l.description.trim() || undefined,
          quantity: Number(l.quantity) || 0,
          unitCostCents: Math.round((Number(l.unitCost) || 0) * 100),
        }));

      const pedido = await coreApi.createPurchaseOrder({
        supplierId: fornecedorId,
        items,
        notes: observacao || null,
      });
      setAviso(`Pedido #${pedido.number} criado como rascunho.`);
      setCriando(false);
      setLinhas([{ ...LINHA_VAZIA }]);
      setObservacao('');
      setFornecedorId('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao criar o pedido.');
    } finally {
      setSalvando(false);
    }
  };

  /*
    O RÓTULO DIZ O QUE O BOTÃO FAZ (GAP-PRD-090).

    "Enviar ao fornecedor" só mudava o status — nada saía do sistema, e o
    comprador achava que o fornecedor tinha recebido. Agora são três gestos com
    três nomes: IMPRIMIR (o A4), ENVIAR POR E-MAIL (a fila, com o A4 anexado) e
    MARCAR COMO ENVIADO (quem mandou por fora registra e trava os itens).
  */
  const marcarComoEnviado = async (id: string) => {
    setErro(null);
    try {
      await coreApi.sendPurchaseOrder(id);
      setAviso(
        'Pedido marcado como enviado. Os itens não mudam mais — o sistema não mandou nada '
          + 'ao fornecedor: use Imprimir ou Enviar por e-mail se ele ainda não recebeu.',
      );
      await carregar();
      if (detalhe?.id === id) await abrir(id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao marcar como enviado.');
    }
  };

  /** Quem manda o combinado ao fornecedor — o recorte de `/send` e `/email`. */
  const gerencia = useHasProfile('gerente_loja', 'gerente_oficina');
  const [imprimindo, setImprimindo] = useState(false);
  const [enviandoEmail, setEnviandoEmail] = useState(false);

  /**
   * O PEDIDO EM PAPEL — o documento vem PRONTO do servidor, em A4, como a OS.
   * A janela do navegador oferece "Salvar como PDF"; pop-up bloqueado vira
   * download do arquivo, e a frase só afirma o download se ele aconteceu.
   */
  const imprimir = async (id: string) => {
    setErro(null);
    setImprimindo(true);
    try {
      const papel = await pedidoDeCompraApi.impressao(id);
      const janela = window.open('', '_blank');
      if (janela) {
        janela.document.write(papel.html);
        janela.document.close();
        return;
      }
      try {
        salvarArquivo(new Blob([papel.html], { type: 'text/html' }), `pedido-compra-${papel.numero}.html`);
        setAviso(
          'O navegador bloqueou a janela de impressão: o pedido foi baixado como arquivo. '
            + 'Abra o arquivo e use Imprimir (ou Salvar como PDF).',
        );
      } catch {
        setErro(
          'O navegador bloqueou a janela de impressão E o download. Libere pop-ups para este '
            + 'endereço e clique de novo.',
        );
      }
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao montar o pedido para impressão.');
    } finally {
      setImprimindo(false);
    }
  };

  /**
   * O PEDIDO POR E-MAIL — e a frase diz o que aconteceu DE VERDADE.
   *
   * Sem SMTP configurado, a mensagem fica na fila: dizer "enviado" faria o
   * comprador esperar um fornecedor que não recebeu nada.
   */
  const enviarPorEmail = async (id: string) => {
    setErro(null);
    setAviso(null);
    setEnviandoEmail(true);
    try {
      const r = await pedidoDeCompraApi.enviarPorEmail(id);
      if (!r.queued) {
        setAviso(
          `Já existe um e-mail deste pedido aguardando na fila para ${r.toAddress}. `
            + 'Nada novo foi enfileirado.',
        );
      } else if (r.readiness === 'READY') {
        setAviso(
          `Pedido enviado por e-mail para ${r.toAddress}, com o pedido em anexo. `
            + 'Os itens não mudam mais.',
        );
      } else {
        setAviso(
          `O e-mail para ${r.toAddress} ficou na fila: o envio de e-mail ainda não está `
            + 'configurado neste servidor. Ele sai sozinho quando a credencial existir — se o '
            + 'fornecedor precisa do pedido agora, use Imprimir. Os itens já não mudam mais.',
        );
      }
      await carregar();
      await abrir(id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao enviar o pedido por e-mail.');
    } finally {
      setEnviandoEmail(false);
    }
  };

  const cancelar = async (id: string) => {
    const motivo = await pedirMotivo({
      titulo: 'Cancelar este pedido de compra?',
      rotulo: 'Motivo do cancelamento',
      minimo: 3,
      confirmar: 'Cancelar o pedido',
      perigoso: true,
    });
    if (!motivo) return;
    setErro(null);
    try {
      await coreApi.cancelPurchaseOrder(id, motivo);
      await carregar();
      if (detalhe?.id === id) await abrir(id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cancelar.');
    }
  };

  const alterarLinha = (i: number, campo: keyof LinhaNova, valor: string) =>
    setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));

  /**
   * A busca no catálogo, por linha — o padrão das outras telas
   * (MovimentacoesEstoquePage, OrcamentosPage). Digitar solta o vínculo
   * anterior: termo novo é intenção nova.
   */
  const procurarProduto = async (i: number, termo: string) => {
    setLinhas((atual) =>
      atual.map((l, idx) =>
        idx === i ? { ...l, busca: termo, productId: null, internalCode: null } : l,
      ),
    );
    if (termo.trim().length < 2) {
      setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, resultados: [] } : l)));
      return;
    }
    try {
      const encontrados = await coreApi.searchProducts(termo.trim());
      setLinhas((atual) =>
        atual.map((l, idx) => (idx === i ? { ...l, resultados: encontrados } : l)),
      );
    } catch {
      // Busca que falha não derruba o formulário: a descrição livre continua
      // aberta, e o erro real apareceria no envio com a frase do servidor.
      setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, resultados: [] } : l)));
    }
  };

  const escolherProduto = (i: number, p: Product) =>
    setLinhas((atual) =>
      atual.map((l, idx) =>
        idx === i
          ? {
              ...l,
              productId: p.id,
              internalCode: p.internal_code,
              description: p.name,
              busca: '',
              resultados: [],
              // O custo do CADASTRO é sugestão, não algema: o combinado com o
              // fornecedor é de quem compra, e o campo continua editável.
              unitCost: String(p.cost_cents / 100),
            }
          : l,
      ),
    );

  const soltarProduto = (i: number) =>
    setLinhas((atual) =>
      atual.map((l, idx) =>
        idx === i
          ? { ...l, productId: null, internalCode: null, busca: '', resultados: [] }
          : l,
      ),
    );

  const totalPrevisto = linhas.reduce(
    (soma, l) => soma + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0),
    0,
  );

  return (
    <AppShell>
      {dialogoDeMotivo}
      <PageHeader
        breadcrumb={['Compras', 'Pedidos']}
        title="Pedidos de compra"
        subtitle="O combinado com o fornecedor — a entrada no estoque continua sendo pela nota"
        actions={
          <Button onClick={() => setCriando((v) => !v)} disabled={fornecedores.length === 0}>
            Novo pedido
          </Button>
        }
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {fornecedores.length === 0 && (
        <Card title="Antes de comprar, cadastre de quem">
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            Nenhum fornecedor ativo. O pedido precisa saber para quem vai, e o prazo de entrega do
            fornecedor é o que dá a previsão de chegada.
          </p>
        </Card>
      )}

      {criando && (
        <Card title="Novo pedido">
          <div className="grid gap-4 md:grid-cols-2 mb-4">
            <Field label="Fornecedor" required>
              {(p) => (
                <select
                  {...p}
                  value={fornecedorId}
                  onChange={(e) => setFornecedorId(e.target.value)}
                  className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
                >
                  <option value="">Selecione…</option>
                  {fornecedores.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.trade_name || f.name}
                      {f.delivery_days > 0 ? ` — entrega em ${f.delivery_days} dias` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Observação" hint="Vai no pedido, para o fornecedor">
              {(p) => (
                <Input
                  {...p}
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  placeholder="Entregar pela porta dos fundos"
                />
              )}
            </Field>
          </div>

          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0">
            Busque o produto no catálogo para o pedido ganhar o confronto item a item com a nota
            (a coluna “Recebido” só anda em item com produto). A descrição livre continua valendo
            para o que não é revenda — embalagem, café — e fica fora dessa comparação.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Item</th>
                  <th className="py-2 w-28">Qtd.</th>
                  <th className="py-2 w-36">Custo unit. (R$)</th>
                  <th className="py-2 w-28 text-right">Total</th>
                  <th className="py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">
                      {l.productId ? (
                        /*
                          A LINHA VINCULADA mostra o vínculo — e tem como sair
                          dele: quem escolheu errado solta e volta ao texto
                          livre, sem apagar a linha inteira.
                        */
                        <span className="inline-flex items-center gap-2 flex-wrap">
                          <Badge tone="info">{l.internalCode ?? 'catálogo'}</Badge>
                          <span>{l.description}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remover produto do item ${i + 1}`}
                            onClick={() => soltarProduto(i)}
                          >
                            ×
                          </Button>
                        </span>
                      ) : (
                        <span className="flex flex-col gap-1">
                          <Input
                            aria-label={`Produto do catálogo do item ${i + 1}`}
                            value={l.busca}
                            onChange={(e) => void procurarProduto(i, e.target.value)}
                            placeholder="Buscar no catálogo (nome, código, barras)"
                          />
                          {l.resultados.length > 0 && (
                            <span className="flex flex-col gap-1">
                              {l.resultados.slice(0, 6).map((r) => (
                                <Button
                                  key={r.id}
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => escolherProduto(i, r)}
                                >
                                  {r.name} · {r.internal_code}
                                </Button>
                              ))}
                            </span>
                          )}
                          <Input
                            aria-label={`Descrição livre do item ${i + 1}`}
                            value={l.description}
                            onChange={(e) => alterarLinha(i, 'description', e.target.value)}
                            placeholder="…ou descrição livre (fora do confronto item a item)"
                          />
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        aria-label={`Quantidade do item ${i + 1}`}
                        value={l.quantity}
                        onChange={(e) => alterarLinha(i, 'quantity', e.target.value)}
                      />
                    </td>
                    <td className="py-2">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Custo unitário do item ${i + 1} (R$)`}
                        value={l.unitCost}
                        onChange={(e) => alterarLinha(i, 'unitCost', e.target.value)}
                      />
                    </td>
                    <td className="py-2 text-right font-semibold">
                      {formatCents(
                        Math.round((Number(l.quantity) || 0) * (Number(l.unitCost) || 0) * 100),
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {linhas.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setLinhas((a) => a.filter((_, idx) => idx !== i))}
                        >
                          ×
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLinhas((a) => [...a, { ...LINHA_VAZIA }])}
            >
              Adicionar item
            </Button>
            <span className="ml-auto font-bold">
              Total previsto: {formatCents(Math.round(totalPrevisto * 100))}
            </span>
          </div>

          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => void criar()}
              loading={salvando}
              disabled={
                !fornecedorId
                || linhas.every((l) => l.productId === null && !l.description.trim())
              }
            >
              Criar rascunho
            </Button>
            <Button variant="ghost" onClick={() => setCriando(false)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {detalhe && (
        <Card title={`Pedido #${detalhe.number} · ${detalhe.supplier?.name ?? ''}`}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <Badge tone={TOM[detalhe.status]}>{ROTULO[detalhe.status]}</Badge>
            {detalhe.expected_at && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Previsão: {dataBR(detalhe.expected_at)}
              </span>
            )}
            {detalhe.notes && (
              <span className="text-[length:var(--gs-text-sm)]">Obs.: {detalhe.notes}</span>
            )}
            {detalhe.cancel_reason && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                Cancelado: {detalhe.cancel_reason}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Pedido</th>
                  <th className="py-2 text-right">Recebido</th>
                  <th className="py-2 text-right">Custo unit.</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.items.map((i) => {
                  const falta = i.quantity - i.received_quantity;
                  return (
                    <tr key={i.id} className="border-t border-[var(--gs-border)]">
                      <td className="py-2">
                        {i.description}
                        {/* O código diz que a linha está no confronto item a
                            item; a linha livre avisa que fica de fora. */}
                        {i.internal_code ? (
                          <span className="ml-2 font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                            {i.internal_code}
                          </span>
                        ) : i.product_id ? null : (
                          <span className="ml-2 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                            (descrição livre — fora do confronto)
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right">{i.quantity}</td>
                      <td className="py-2 text-right">
                        <span className={falta > 0 ? 'text-[var(--gs-warning)] font-semibold' : ''}>
                          {i.received_quantity}
                        </span>
                        {falta > 0 && detalhe.status !== 'rascunho' && (
                          <span className="text-[var(--gs-muted)]"> (faltam {falta})</span>
                        )}
                      </td>
                      <td className="py-2 text-right">{formatCents(i.unit_cost_cents)}</td>
                      <td className="py-2 text-right">{formatCents(i.total_cents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            A coluna “Recebido” sai das notas confirmadas contra este pedido — não é digitada.
            Enquanto a nota não passa pela conferência, nada entra no estoque nem aparece aqui.
          </p>

          {detalhe.inboundNotes.length > 0 && (
            <p className="text-[length:var(--gs-text-sm)] m-0 flex flex-wrap items-center gap-2">
              <span>Notas deste pedido:</span>
              {/*
                A NOTA É LINK, não texto. O número da nota estava aqui desde
                sempre e ninguém conseguia CHEGAR nela a partir do pedido:
                quem queria conferir o que chegou tinha de ir à Entrada de
                notas e procurar pelo número na mão.
              */}
              {detalhe.inboundNotes.map((n) => (
                <Link
                  key={n.id}
                  to={rotaDaNotaDeEntrada(n.id)}
                  className="text-[var(--gs-purple-700)] underline"
                >
                  {n.number || n.access_key.slice(-8)}
                </Link>
              ))}
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-4">
            <Button
              variant="secondary"
              loading={imprimindo}
              onClick={() => void imprimir(detalhe.id)}
            >
              Imprimir pedido
            </Button>
            {gerencia
              && detalhe.status !== 'cancelado'
              && detalhe.status !== 'recebido' && (
                <Button loading={enviandoEmail} onClick={() => void enviarPorEmail(detalhe.id)}>
                  Enviar por e-mail ao fornecedor
                </Button>
              )}
            {gerencia && detalhe.status === 'rascunho' && (
              <Button variant="ghost" onClick={() => void marcarComoEnviado(detalhe.id)}>
                Marcar como enviado
              </Button>
            )}
            {detalhe.status !== 'cancelado' && detalhe.status !== 'recebido' && (
              <Button variant="ghost" onClick={() => void cancelar(detalhe.id)}>
                Cancelar pedido
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setDetalhe(null);
                // Fechar a ficha apaga o parâmetro: o endereço não pode
                // continuar prometendo um pedido que não está mais na tela.
                setParamsDaUrl({}, { replace: true });
              }}
            >
              Fechar
            </Button>
          </div>
        </Card>
      )}

      {/*
        O QUE ESTE PEDIDO JÁ CUSTOU — a VOLTA da rastreabilidade do lado da
        compra. A tela dizia quanto foi PEDIDO e quanto foi RECEBIDO, e nada
        sobre o que a loja passou a DEVER: a dívida vive nas notas, e ninguém
        conseguia somá-la sem sair daqui.
      */}
      {detalhe && (
        <TitulosDoDocumento
          titulos={titulos}
          erro={erroTitulos}
          titulo={`O que o pedido #${detalhe.number} gerou no financeiro`}
          subtitulo="O pedido não cria dívida: quem cria é cada nota confirmada contra ele. É a soma delas que aparece aqui."
        />
      )}

      <Card title="Pedidos">
        {pedidos === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : pedidos.length === 0 ? (
          <EmptyState
            title="Nenhum pedido de compra"
            description="O pedido registra o que foi combinado com o fornecedor. A entrada no estoque continua sendo pela conferência da nota."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Fornecedor</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2">Previsão</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{p.number}</td>
                    <td className="py-2">{p.supplier_trade_name || p.supplier_name}</td>
                    <td className="py-2">
                      <Badge tone={TOM[p.status]}>{ROTULO[p.status]}</Badge>
                    </td>
                    <td className="py-2">
                      {dataBR(p.expected_at)}
                    </td>
                    <td className="py-2 text-right">{formatCents(p.total_cents)}</td>
                    <td className="py-2 text-right">
                      {/* Abrir pela lista escreve `?pedido=` na URL: o
                          endereço passa a descrever o que está na tela. */}
                      <Button size="sm" variant="ghost" onClick={() => void abrirEEnderecar(p.id)}>
                        Abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacao
          pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
          rotulo={{ singular: 'pedido', plural: 'pedidos' }}
          onMudar={setOffset}
        />
      </Card>
    </AppShell>
  );
}

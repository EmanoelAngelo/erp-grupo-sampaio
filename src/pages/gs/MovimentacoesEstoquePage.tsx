/**
 * Estoque › Movimentações — a história do saldo.
 *
 * A tabela existe para responder uma pergunta: "por que este produto está com
 * esta quantidade?". Por isso mostra saldo ANTERIOR e POSTERIOR lado a lado —
 * com os dois, o gestor confere a conta na hora; só com o posterior, ele
 * precisa acreditar.
 *
 * Entrada e saída ficam em colunas separadas, como em livro de estoque: ler
 * sinal de menos no meio de uma coluna só é fonte de erro.
 *
 * Reserva aparece, mas não se mistura com o físico. Uma pré-venda que segura
 * mercadoria mostra a linha com quantidade zero e a reserva destacada — porque
 * a peça continua na prateleira.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type MovementKindOption,
  type Product,
  type ProductBatch,
  type StockLocation,
  type StockMovement,
} from '@/lib/api/core';
import { hojeNaLoja } from '@/lib/datas';
import { paginaDeMovimentos } from '@/lib/api/paginas';
import { uuid } from '@/lib/uuid';
import { TentativaJaRegistrada } from '@/components/gs/TentativaJaRegistrada';
import { ehTentativaJaRegistrada } from '@/lib/api/tentativaJaRegistrada';

/** Entrada, saída ou apenas reserva — define a cor e a coluna. */
function direcao(m: StockMovement): 'entrada' | 'saida' | 'reserva' {
  if (m.movement_type === 'reserve' || m.movement_type === 'release') return 'reserva';
  return m.quantity >= 0 ? 'entrada' : 'saida';
}

function dataHora(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const HOJE = hojeNaLoja();

/** Linhas por página do histórico. Ver o comentário de `pagina`. */
const POR_PAGINA = 50;

/**
 * Os lançamentos que esta tela produz — e SÓ eles.
 *
 * O vocabulário espelha `REFERENCIAS_MANUAIS` do servidor, que é fechado de
 * propósito: o rótulo decide o destino da plaquinha em produto serializado, e
 * `sale` dá dono. A tela não oferece o que o servidor recusaria — nem deixa o
 * operador inventar rótulo.
 */
const TIPOS_DE_LANCAMENTO = {
  entrada: { rotulo: 'Entrada avulsa', movementType: 'in', referenceType: 'entrada' },
  perda: { rotulo: 'Saída — perda', movementType: 'out', referenceType: 'perda' },
  uso_interno: { rotulo: 'Saída — uso interno', movementType: 'out', referenceType: 'uso_interno' },
  saida: { rotulo: 'Saída — outro motivo', movementType: 'out', referenceType: 'manual' },
  ajuste: { rotulo: 'Ajuste de saldo (±)', movementType: 'adjust', referenceType: 'ajuste' },
} as const;

type TipoDeLancamento = keyof typeof TIPOS_DE_LANCAMENTO;

const SELECT_CLASSES =
  'h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white '
  + 'text-[length:var(--gs-text-base)]';

/**
 * O formulário de lançamento manual — o fio que faltava ligar.
 *
 * ============================================================================
 * O DEFEITO QUE ISTO CONSERTA
 * ============================================================================
 *
 * `POST /core/stock/movements` estava pronta, testada e auditada — motivo
 * obrigatório na saída, rótulo fechado, idempotência por referência — e
 * NENHUMA tela da loja a chamava: `coreApi.addStockMovement` existia sem um
 * único chamador. Pior: o formulário de produto mandava o usuário "lançar um
 * movimento em Estoque › Movimentações", e esta tela era só leitura. Perda,
 * uso interno e carga avulsa eram impossíveis pela UI — promessa de tela que
 * o sistema não cumpria.
 *
 * O formulário NUNCA edita saldo direto: ele lança um MOVIMENTO, e o saldo é a
 * consequência — a mesma regra de todo o resto do sistema.
 *
 * ## A referência estável
 *
 * `referenceId` nasce com o formulário e SÓ troca depois de um sucesso. É a
 * idempotência da rota em uso real: a retentativa depois de uma falha de rede
 * leva a MESMA identidade, e o servidor responde o saldo corrente em vez de
 * duplicar a baixa. Gerar id novo a cada clique jogaria essa proteção fora.
 *
 * ## O motivo obrigatório, espelhado
 *
 * O servidor recusa saída e AJUSTE (nos dois sentidos — o +20 sem uma palavra
 * era sobra sem explicação, B-estoque-entrada-13) sem motivo. A tela repete a regra
 * ANTES de enviar — descobrir a recusa depois de preencher tudo é o tipo de
 * atrito que ensina o operador a desconfiar da tela.
 */
function LancamentoManual({ aoLancar }: { aoLancar: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [tipo, setTipo] = useState<TipoDeLancamento>('entrada');
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<Product[]>([]);
  const [produto, setProduto] = useState<Product | null>(null);
  const [quantidade, setQuantidade] = useState('');
  const [motivo, setMotivo] = useState('');
  const [custo, setCusto] = useState('');
  const [localId, setLocalId] = useState('');
  const [locais, setLocais] = useState<StockLocation[]>([]);
  /*
    LOTE E VALIDADE (GAP-V35) — e os três campos abaixo só existem na tela
    quando o produto ESCOLHIDO controla lote. Perguntar lote para um parafuso é
    exatamente o que a regra do opt-in existe para impedir: produto sem
    controle não ganha campo nenhum aqui.
  */
  const [lotesDoProduto, setLotesDoProduto] = useState<ProductBatch[]>([]);
  /** Na ENTRADA é o código digitado; na SAÍDA, o id escolhido na lista. */
  const [loteCodigo, setLoteCodigo] = useState('');
  const [loteId, setLoteId] = useState('');
  const [loteValidade, setLoteValidade] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  /** O servidor recusou a referência por já ter lançado OUTRO movimento com ela (422, R2-IDEM). */
  const [tentativaReusada, setTentativaReusada] = useState(false);

  /**
   * A identidade do lançamento. Ver o comentário do componente: só muda
   * depois do sucesso, para a retentativa não virar movimento duplicado.
   */
  const [referencia, setReferencia] = useState(() => uuid());

  useEffect(() => {
    if (!aberto) return;
    // A lista de locais é conveniência: se a leitura falhar, o lançamento
    // continua possível — sem local declarado, o servidor usa o padrão.
    void coreApi
      .listStockLocations()
      .then(setLocais)
      .catch(() => setLocais([]));
  }, [aberto]);

  const procurar = async (termo: string) => {
    setBusca(termo);
    setProduto(null);
    if (termo.trim().length < 2) {
      setResultados([]);
      return;
    }
    try {
      /*
        O MODELO COM SALDO PRESO ENTRA NESTA BUSCA, E SÓ NESTA (P00-prod-05).

        O modelo de grade fica fora da busca de produto porque quem sai da
        prateleira é o tamanho. Mas o banco antigo tem modelos com mercadoria
        presa — de antes de a geração da grade recusar isso —, e o servidor
        passou a permitir a SAÍDA que regulariza esse saldo. Esta tela é a que
        faz essa saída: sem o interruptor, a permissão existiria e nenhuma tela
        chegaria nela, e o gestor veria a mercadoria na posição de estoque sem
        conseguir sequer selecioná-la.
      */
      setResultados(await coreApi.searchProducts(termo.trim(), { comSaldoPreso: true }));
    } catch {
      // Busca que falha não derruba o formulário; o erro real apareceria no
      // envio, com a mensagem do servidor.
      setResultados([]);
    }
  };

  const config = TIPOS_DE_LANCAMENTO[tipo];
  const qtd = Number(quantidade.replace(',', '.'));
  const tiraDoEstoque =
    config.movementType === 'out' || (config.movementType === 'adjust' && qtd < 0);
  /*
    O AJUSTE PEDE MOTIVO NOS DOIS SENTIDOS (B-estoque-entrada-13). O "+20" sem
    explicação passava e virava sobra muda no histórico; a entrada avulsa, que
    é mercadoria que CHEGOU, continua sem.
  */
  const exigeMotivo = tiraDoEstoque || config.movementType === 'adjust';
  const controlaLote = produto?.tracks_batches === 1;
  /*
    "Entra no estoque" NÃO é o complemento de `tiraDoEstoque`: o ajuste de
    saldo zero não é nem uma coisa nem outra, e derivar um do outro faria o
    ajuste positivo pedir código de lote e o negativo oferecer a lista ao mesmo
    tempo. Cada um é medido pelo que ele é.
  */
  const entraNoEstoque =
    config.movementType === 'in' || (config.movementType === 'adjust' && qtd > 0);

  /*
    Os lotes só são buscados quando o produto escolhido controla lote — e a
    lista inclui os ZERADOS de propósito: quem lança uma ENTRADA de reposição
    do mesmo lote precisa achá-lo mesmo que ele tenha acabado.
  */
  useEffect(() => {
    setLoteCodigo('');
    setLoteId('');
    setLoteValidade('');
    if (!produto || produto.tracks_batches !== 1) {
      setLotesDoProduto([]);
      return;
    }
    void coreApi
      .listBatches({ productId: produto.id, incluirZerados: true })
      .then(setLotesDoProduto)
      .catch(() => setLotesDoProduto([]));
  }, [produto]);

  const lancar = async (referenciaDoEnvio: string = referencia) => {
    setErro(null);
    setAviso(null);

    if (!produto) {
      setErro('Escolha o produto pela busca antes de lançar.');
      return;
    }
    if (!Number.isFinite(qtd) || qtd === 0) {
      setErro('Informe a quantidade do movimento.');
      return;
    }
    if (config.movementType !== 'adjust' && qtd < 0) {
      setErro('Quantidade deve ser positiva: em entrada e saída, o sinal é dado pelo tipo.');
      return;
    }
    // A MESMA regra do servidor, antes da viagem: o que desaparece precisa
    // de motivo — é o que explica a diferença quando a prateleira discordar.
    if (exigeMotivo && !motivo.trim()) {
      setErro(
        tiraDoEstoque
          ? 'Informe o motivo da saída — perda, uso interno, acerto de contagem. '
            + 'É o que explica a diferença quando a prateleira discordar do sistema.'
          : 'Informe o motivo do ajuste — mercadoria achada na contagem, lançamento anterior errado. '
            + 'Se é mercadoria que chegou, use "Entrada avulsa".',
      );
      return;
    }
    let custoCents: number | undefined;
    if (tipo === 'entrada' && custo.trim()) {
      const parsed = parseReaisToCents(custo);
      if (parsed === null) {
        setErro('Custo unitário inválido. Use o formato 12,34.');
        return;
      }
      custoCents = parsed;
    }

    setOcupado(true);
    try {
      const res = await coreApi.addStockMovement({
        productId: produto.id,
        movementType: config.movementType,
        quantity: qtd,
        referenceType: config.referenceType,
        referenceId: referenciaDoEnvio,
        reason: motivo.trim() || undefined,
        locationId: localId || undefined,
        unitCostCents: custoCents,
        /*
          O LOTE, e só para quem controla. Na ENTRADA vai o CÓDIGO (o servidor
          acha ou cria); na SAÍDA vai o ID escolhido na lista — e deixar em
          branco é legítimo: o servidor aplica FEFO e grava a escolha. Escolher
          é o gesto de quem está descartando AQUELE lote vencido.
        */
        batchId: controlaLote && !entraNoEstoque ? loteId || undefined : undefined,
        batchCode: controlaLote && entraNoEstoque ? loteCodigo.trim() || undefined : undefined,
        expiresOn: controlaLote && entraNoEstoque ? loteValidade || undefined : undefined,
      });
      setAviso(
        res.duplicated
          ? 'Este lançamento já tinha sido registrado — nada foi duplicado. '
            + `Saldo atual: ${formatQuantity(res.balance)}.`
          : `Movimento lançado. Saldo atual: ${formatQuantity(res.balance)}.`,
      );
      // Sucesso encerra a intenção: a PRÓXIMA ganha identidade nova.
      setReferencia(uuid());
      setProduto(null);
      setBusca('');
      setResultados([]);
      setQuantidade('');
      setMotivo('');
      setCusto('');
      setLoteCodigo('');
      setLoteId('');
      setLoteValidade('');
      aoLancar();
    } catch (err) {
      // A referência NÃO troca aqui: reenviar depois da falha é a mesma
      // intenção, e a idempotência do servidor cuida do resto.
      if (ehTentativaJaRegistrada(err)) {
        // ...a não ser que o servidor diga que ela JÁ lançou outro movimento:
        // aí reenviar é 422 para sempre, e lançar de novo é escolha da pessoa.
        setTentativaReusada(true);
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao lançar o movimento.');
    } finally {
      setOcupado(false);
    }
  };

  /** "Lançar como movimento novo": o MESMO formulário, com identidade nova — só por escolha. */
  const lancarComoNovo = () => {
    const nova = uuid();
    setReferencia(nova);
    setTentativaReusada(false);
    void lancar(nova);
  };

  return (
    <Card
      title="Lançamento manual"
      subtitle="Perda, uso interno e carga avulsa. Nada aqui edita saldo direto — todo gesto vira movimento no razão."
      className="mb-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setAberto(true)}>Lançar movimento</Button>
        {aberto && (
          <Button variant="ghost" onClick={() => setAberto(false)}>
            Fechar
          </Button>
        )}
      </div>

      {aviso && (
        <p className="mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">{aviso}</p>
      )}

      {tentativaReusada && (
        <TentativaJaRegistrada
          titulo="Esta tentativa já lançou um movimento"
          onVoltar={() => setTentativaReusada(false)}
          rotuloDoNovo="Lançar como movimento novo"
          onNovo={lancarComoNovo}
          ocupado={ocupado}
          testId="movimento-ja-lancado"
        >
          <p className="m-0">
            <strong>Esta tentativa já lançou um movimento de estoque, com outra quantidade ou outro custo.</strong>{' '}
            Nada foi lançado agora.
          </p>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Acontece quando a resposta do primeiro envio se perde e o formulário muda antes de lançar de novo. Se
            este é mesmo mais um movimento, lance como novo. Se era o mesmo lançamento corrigido, confira o histórico
            abaixo antes: lançar de novo mexeria no saldo duas vezes.
          </p>
        </TentativaJaRegistrada>
      )}

      {aberto && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Field
              label="Produto"
              hint={produto ? `Selecionado: ${produto.name} (${produto.internal_code})` : undefined}
            >
              {(p) => (
                <Input
                  {...p}
                  value={busca}
                  onChange={(e) => void procurar(e.target.value)}
                  placeholder="Nome, código ou barras"
                />
              )}
            </Field>
            {!produto && resultados.length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {resultados.slice(0, 8).map((r) => (
                  <Button
                    key={r.id}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setProduto(r);
                      setBusca(`${r.name} (${r.internal_code})`);
                      setResultados([]);
                    }}
                  >
                    {r.name} · {r.internal_code}
                    {r.saldo_preso === 1 && ' · saldo preso no modelo'}
                  </Button>
                ))}
              </div>
            )}
            {/*
              O QUE É AQUELA LINHA, dita antes de a pessoa digitar a quantidade.

              Sem esta frase, o modelo apareceria na lista como um produto
              qualquer e o gestor tentaria uma ENTRADA — que o servidor recusa,
              com razão. A tela diz o gesto certo no momento em que ele é
              possível: dar saída e relançar em cada tamanho.
            */}
            {produto?.saldo_preso === 1 && (
              <p className="mt-2 text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                Este é um modelo de grade com saldo preso: o balcão não vende esse saldo e a
                contagem não o alcança. A única coisa a fazer com ele é dar SAÍDA (ou ajuste
                negativo), com motivo, e lançar a entrada em cada tamanho.
              </p>
            )}
          </div>

          <Field label="Tipo do lançamento">
            {(p) => (
              <select
                {...p}
                className={SELECT_CLASSES}
                value={tipo}
                onChange={(e) => setTipo(e.target.value as TipoDeLancamento)}
              >
                {Object.entries(TIPOS_DE_LANCAMENTO).map(([valor, t]) => (
                  <option key={valor} value={valor}>
                    {t.rotulo}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            label="Quantidade"
            hint={
              config.movementType === 'adjust'
                ? 'Com sinal: +2 acha mercadoria, −2 tira'
                : 'Sempre positiva — o tipo dá a direção'
            }
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                step="any"
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
              />
            )}
          </Field>

          <div className="md:col-span-2">
            <Field
              label="Motivo"
              required={exigeMotivo}
              hint="Obrigatório no que sai e no ajuste de saldo — fica gravado no histórico"
            >
              {(p) => (
                <Input
                  {...p}
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Caixa danificada, uso na oficina, acerto…"
                />
              )}
            </Field>
          </div>

          {locais.length > 0 && (
            <Field label="Local" hint="Sem escolha, vale o local padrão">
              {(p) => (
                <select
                  {...p}
                  className={SELECT_CLASSES}
                  value={localId}
                  onChange={(e) => setLocalId(e.target.value)}
                >
                  <option value="">Local padrão</option>
                  {locais
                    .filter((l) => !l.is_default)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          )}

          {tipo === 'entrada' && (
            <Field label="Custo unitário (R$)" hint="Opcional — aparece no histórico da entrada">
              {(p) => (
                <Input
                  {...p}
                  value={custo}
                  onChange={(e) => setCusto(e.target.value)}
                  placeholder="12,34"
                />
              )}
            </Field>
          )}

          {/*
            LOTE E VALIDADE — só aparece para quem controla (GAP-V35). Duas
            formas, porque são dois gestos diferentes:

            ENTRADA: o conferente DIGITA o código impresso na embalagem, com a
            caixa na mão. O servidor acha o lote ou o cria — obrigá-lo a
            cadastrar antes o faria sair da tela no meio do trabalho.

            SAÍDA: ele ESCOLHE na lista, porque um código novo numa saída
            significa que alguém digitou errado, e criar o lote ali faria
            nascer um lote de saldo negativo. Deixar em branco é legítimo: o
            servidor tira do que vence primeiro.
          */}
          {controlaLote && entraNoEstoque && (
            <>
              <Field
                label="Lote"
                hint="O código impresso na embalagem. Em branco = sem lote declarado"
              >
                {(p) => (
                  <Input
                    {...p}
                    value={loteCodigo}
                    onChange={(e) => setLoteCodigo(e.target.value)}
                    placeholder="L2409"
                    list="lotes-conhecidos"
                  />
                )}
              </Field>
              <datalist id="lotes-conhecidos">
                {lotesDoProduto.map((l) => (
                  <option key={l.id} value={l.code} />
                ))}
              </datalist>
              <Field label="Validade" hint="Só vale no lote NOVO — o já cadastrado mantém a dele">
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={loteValidade}
                    onChange={(e) => setLoteValidade(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}

          {controlaLote && !entraNoEstoque && (
            <div className="md:col-span-2">
              <Field
                label="Lote"
                hint="Em branco, sai o que vence primeiro. Escolha para descartar um lote vencido"
              >
                {(p) => (
                  <select
                    {...p}
                    className={SELECT_CLASSES}
                    value={loteId}
                    onChange={(e) => setLoteId(e.target.value)}
                  >
                    <option value="">O que vence primeiro (FEFO)</option>
                    {lotesDoProduto
                      .filter((l) => l.quantity > 0)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code} · {l.expires_on ?? 'sem validade'} · {formatQuantity(l.quantity)}
                          {l.faixa === 'vencido' ? ' · VENCIDO' : ''}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            </div>
          )}

          <div className="md:col-span-3 flex flex-col gap-2">
            {erro && (
              <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
                {erro}
              </p>
            )}
            <div>
              <Button onClick={() => void lancar()} loading={ocupado}>
                Lançar
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function MovimentacoesEstoquePage() {
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  /** Quantos movimentos o filtro tem — nulo quando o servidor não contou. */
  const [totalDoFiltro, setTotalDoFiltro] = useState<number | null>(null);
  const [kinds, setKinds] = useState<MovementKindOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [documento, setDocumento] = useState('');

  /**
   * Produto vindo da URL (`?produto=...`).
   *
   * É o atalho da posição de estoque: clicar em "Histórico" numa linha traz
   * esta tela já filtrada. Sem ele, responder "por que tinha 10 e agora tem 7"
   * obrigaria a procurar o item no meio de todo o movimento da loja.
   */
  const [produtoId, setProdutoId] = useState<string>(() => {
    try {
      return new URLSearchParams(window.location.search).get('produto') ?? '';
    } catch {
      return '';
    }
  });

  /**
   * Paginação.
   *
   * O histórico só cresce: uma loja com um ano de movimento tem dezenas de
   * milhares de linhas, e a tela carregava TODAS. O primeiro a descobrir seria
   * quem tem mais tempo de casa — exatamente quem menos pode esperar.
   */
  const [pagina, setPagina] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const recebida = await paginaDeMovimentos({
        search: search || undefined,
        kind: kind || undefined,
        productId: produtoId || undefined,
        // O dia inteiro: sem a hora, "até 12/08" excluiria tudo que
        // aconteceu depois da meia-noite daquele dia.
        // A DATA VAI PURA: quem converte para instante é o servidor, que é
        // quem sabe o fuso da loja. Colar 'T00:00:00.000Z' aqui recortava o
        // dia em Greenwich e a movimentação das 21h30 caía no dia seguinte.
        from: from || undefined,
        to: to || undefined,
        document: documento || undefined,
        limit: POR_PAGINA,
        offset: pagina * POR_PAGINA,
      });
      setRows(recebida.items);
      setTotalDoFiltro(recebida.totalConhecido ? recebida.total : null);
    } catch (err) {
      setRows(null);
      setTotalDoFiltro(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar o histórico.');
    }
  }, [search, kind, from, to, documento, produtoId, pagina]);

  // Mudar qualquer filtro volta para a primeira página: continuar na página 4
  // de um resultado novo mostra uma tela vazia que parece "não achou nada".
  useEffect(() => {
    setPagina(0);
  }, [search, kind, from, to, documento, produtoId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void coreApi.listMovementKinds().then(setKinds).catch(() => setKinds([]));
  }, []);

  const limpar = useCallback(() => {
    setSearch('');
    setKind('');
    setFrom('');
    setTo('');
    setDocumento('');
    setProdutoId('');
    // O filtro veio da URL; limpar sem tirá-lo de lá faria o próximo F5
    // ressuscitar um filtro que a pessoa acabou de remover.
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      /* navegador sem history não impede o resto de funcionar */
    }
  }, []);

  const temFiltro = Boolean(search || kind || from || to || documento || produtoId);

  /*
    O ESPELHO EXATO do guarda de `POST /core/stock/movements`
    (`requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista',
    'operador_caixa_oficina')` — admin_geral e gestor passam pelo atalho). O
    caixa da LOJA saiu da rota (PJ-CAIXA): o login do PDV da Preço Justo
    lançava entrada e saída de estoque pela API. O atendente alcança esta tela
    pelo roteador (ROTA_GESTAO) e PODE ler o histórico — mas o formulário seria
    uma porta que o servidor bate na cara dele, então nem aparece.
  */
  const podeLancar = useHasProfile(
    'gerente_loja',
    'gerente_oficina',
    'estoquista',
    'operador_caixa_oficina',
  );

  // Totais do que está em tela, para o gestor conferir a soma sem calculadora.
  const totais = useMemo(() => {
    const lista = rows ?? [];
    return {
      entradas: lista.filter((m) => direcao(m) === 'entrada').reduce((a, m) => a + m.quantity, 0),
      saidas: lista
        .filter((m) => direcao(m) === 'saida')
        .reduce((a, m) => a + Math.abs(m.quantity), 0),
    };
  }, [rows]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Estoque', 'Movimentações']}
        title="Movimentações de estoque"
        subtitle="Cada linha explica por que o saldo mudou. Saldo anterior + movimento = saldo posterior."
      />

      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      {podeLancar && <LancamentoManual aoLancar={() => void load()} />}

      <Card title="Filtros">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <label className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Produto
            </span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome, código ou código de barras"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Tipo
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                text-[length:var(--gs-text-base)]"
            >
              <option value="">Todos</option>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              De
            </span>
            <Input type="date" max={HOJE} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Até
            </span>
            <Input type="date" max={HOJE} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Documento
            </span>
            <Input
              value={documento}
              onChange={(e) => setDocumento(e.target.value)}
              placeholder="NF-e, venda ou OS"
            />
          </label>

          <div className="flex gap-2 md:col-span-3">
            <Button onClick={() => void load()}>Aplicar</Button>
            {temFiltro && (
              <Button variant="ghost" onClick={limpar}>
                Limpar
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="mt-6">
        <Card
          title="Histórico"
          subtitle={
            rows === null
              ? undefined
              : `${rows.length} movimento(s) · entradas ${formatQuantity(totais.entradas)} · saídas ${formatQuantity(totais.saidas)}`
          }
          padded={false}
        >
          {rows === null ? (
            <p role="status" className="px-6 py-5 text-[var(--gs-muted)]">
              {error ? 'Não foi possível carregar.' : 'Carregando…'}
            </p>
          ) : rows.length === 0 ? (
            <div className="px-6 py-5">
              <EmptyState
                title={temFiltro ? 'Nada neste filtro' : 'Nenhuma movimentação'}
                description={
                  temFiltro
                    ? 'Ajuste o período ou o tipo para encontrar o lançamento.'
                    : 'Entradas, vendas, consumo de OS e ajustes aparecem aqui na ordem em que aconteceram.'
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className="py-2.5 px-4 font-semibold whitespace-nowrap">Data/hora</th>
                    <th className="py-2.5 px-4 font-semibold">Produto</th>
                    <th className="py-2.5 px-4 font-semibold">Código</th>
                    <th className="py-2.5 px-4 font-semibold">Tipo</th>
                    <th className="py-2.5 px-4 font-semibold">Documento</th>
                    {/*
                      O LOTE NA LINHA (GAP-V35). É esta coluna que responde ao
                      recall — "de qual lote saiu esta venda" —, e ela mostra o
                      CÓDIGO impresso na embalagem, nunca o id técnico.
                      Travessão é o normal: ou o produto não controla lote, ou
                      a mercadoria entrou sem lote declarado.
                    */}
                    <th className="py-2.5 px-4 font-semibold">Lote</th>
                    {/*
                      CUSTO NA LINHA, não em rodapé. O custo unitário das
                      entradas vivia num parágrafo com as TRÊS primeiras
                      linhas que tinham custo — quem investigava uma entrada
                      específica no meio do histórico não achava o número na
                      linha dela. O servidor já poda o valor para quem não
                      pode ver (mecânico): travessão aqui é "não há custo" ou
                      "não é para você ver", e os dois são honestos.
                    */}
                    <th className="py-2.5 px-4 font-semibold text-right">Custo unit.</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Entrada</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Saída</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Saldo ant.</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Saldo post.</th>
                    <th className="py-2.5 px-4 font-semibold">Usuário</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const dir = direcao(m);
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-[var(--gs-border)] last:border-0
                          hover:bg-[var(--gs-surface-hover)]"
                      >
                        <td className="py-3 px-4 whitespace-nowrap tabular-nums">
                          {dataHora(m.created_at)}
                        </td>
                        <td className="py-3 px-4">{m.product_name}</td>
                        <td className="py-3 px-4 font-mono text-[length:var(--gs-text-xs)]">
                          {m.internal_code}
                        </td>
                        <td className="py-3 px-4">
                          <Badge
                            tone={
                              dir === 'entrada' ? 'success' : dir === 'saida' ? 'warning' : 'neutral'
                            }
                          >
                            {m.kind_label}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">{m.document_number ?? m.reference_type}</td>
                        <td className="py-3 px-4 font-mono text-[length:var(--gs-text-xs)] whitespace-nowrap">
                          {m.batch_code ? (
                            <>
                              {m.batch_code}
                              {m.batch_expires_on && (
                                <span className="text-[var(--gs-text-soft)]">
                                  {' '}
                                  · {m.batch_expires_on}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-[var(--gs-muted)]">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums">
                          {m.unit_cost_cents === null ? (
                            <span className="text-[var(--gs-muted)]">—</span>
                          ) : (
                            formatCents(m.unit_cost_cents)
                          )}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums font-semibold text-[var(--gs-success)]">
                          {dir === 'entrada' ? formatQuantity(m.quantity) : ''}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums font-semibold text-[var(--gs-danger)]">
                          {dir === 'saida' ? formatQuantity(Math.abs(m.quantity)) : ''}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-[var(--gs-text-soft)]">
                          {m.quantity_before === null ? '—' : formatQuantity(m.quantity_before)}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums font-bold">
                          {formatQuantity(m.balance_after)}
                          {/* Reserva não mexe no físico: o saldo repete de
                              propósito, e a marca explica por quê. */}
                          {dir === 'reserva' && (
                            <span className="block text-[length:var(--gs-text-xs)] font-normal text-[var(--gs-text-soft)]">
                              reserva {m.reserved_delta > 0 ? '+' : ''}
                              {formatQuantity(m.reserved_delta)}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4">{m.user_name ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/*
        A CONTAGEM VEIO (GAP-PRD-070). Ela ficava de fora por medo de varrer a
        tabela que mais cresce; o servidor agora conta pelo índice do próprio
        movimento (sem JOIN quando não há busca por produto) e a tela diz
        "página 2 de 14". Servidor que não conta cai no critério antigo:
        "Próxima" some quando a página vem incompleta.
      */}
      {rows !== null
        && ((totalDoFiltro !== null ? totalDoFiltro > POR_PAGINA : rows.length === POR_PAGINA)
          || pagina > 0) && (
        <div className="flex items-center justify-between mt-4">
          <Button
            variant="ghost"
            disabled={pagina === 0}
            onClick={() => setPagina((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {totalDoFiltro !== null
              ? `Página ${pagina + 1} de ${Math.max(1, Math.ceil(totalDoFiltro / POR_PAGINA))} · ${totalDoFiltro.toLocaleString('pt-BR')} movimentos`
              : `Página ${pagina + 1}`}
          </span>
          <Button
            variant="ghost"
            disabled={
              totalDoFiltro !== null
                ? (pagina + 1) * POR_PAGINA >= totalDoFiltro
                : rows.length < POR_PAGINA
            }
            onClick={() => setPagina((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      )}

      {/*
        O parágrafo "Custo unitário das entradas" que vivia aqui morreu de
        propósito: mostrava só as 3 primeiras linhas com custo, e quem
        investigava uma entrada específica não a achava. O custo agora é
        coluna, na linha de cada movimento.
      */}
    </AppShell>
  );
}

/**
 * Página pública de um produto.
 *
 * Antes o card da vitrine jogava o item direto no carrinho. Quem compra
 * online quer ver o produto antes: foto, o que é, quanto custa, se chega em
 * casa. Comprar sem essa página é comprar às cegas.
 *
 * Duas honestidades que a página não abre mão:
 *
 *  - ENTREGA SÓ QUANDO DÁ. Sem peso e dimensões cadastrados não existe
 *    cotação; a página diz isso e oferece retirada, em vez de inventar uma
 *    caixa de meio quilo e mostrar um frete que o transportador não cobra.
 *  - ESTOQUE É DO SERVIDOR. O botão desabilita no limite do disponível, e
 *    quem decide de verdade continua sendo o backend no checkout.
 */
import { FotoDeProduto, LugarDaFoto } from '@/components/gs/LugarDaFoto';
import { coreApi } from '@/lib/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { contar, formatCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { AvaliacoesProduto } from '@/components/gs/AvaliacoesProduto';
import { CascaDaLoja, type MarcaDaLoja } from '@/components/gs/CascaDaLoja';
import { carrinhoApi } from '@/lib/api/carrinho';
import { tokenDoPortal } from '@/lib/portalSession';

interface Variante {
  id: string;
  name: string;
  barcode: string | null;
  attributes: Record<string, string>;
  priceCents: number;
  available: number;
}

interface ProdutoDetalhe {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  unit: string;
  imageUrl: string | null;
  images: { url: string; isPrimary: boolean }[];
  basePriceCents: number;
  priceCents: number;
  onSale: boolean;
  available: number;
  storeSlug: string;
  storeName: string;
  variants: Variante[];
  shippingReadiness: 'READY_FOR_SHIPPING' | 'SHIPPING_DATA_INCOMPLETE';
  missingShippingFields: string[];
  /** Se a loja faz retirada — a mesma fonte do selo "Retire na loja". */
  pickupEnabled?: boolean;
  /** A prateleira ao lado: mesma loja, mesmo departamento, sem ele mesmo. */
  related?: {
    id: string;
    name: string;
    imageUrl: string | null;
    priceCents: number;
    onSale: boolean;
    storeName: string;
    storeSlug: string;
  }[];
}

const CART_KEY = 'gs.loja.carrinho';

/**
 * Grava no MESMO carrinho da vitrine.
 *
 * O carrinho já existe e já agrupa por loja; recriar um aqui daria dois
 * carrinhos e um cliente perdido entre eles.
 */
function adicionarAoCarrinho(linha: {
  product: Record<string, unknown>;
  quantity: number;
}): void {
  let atual: { product: { id: string }; quantity: number }[] = [];
  try {
    atual = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as typeof atual;
  } catch {
    atual = [];
  }
  const alvo = (linha.product as { id: string }).id;
  const existente = atual.find((l) => l.product.id === alvo);
  const proximo = existente
    ? atual.map((l) =>
      l.product.id === alvo ? { ...l, quantity: l.quantity + linha.quantity } : l,
    )
    : [...atual, linha as unknown as { product: { id: string }; quantity: number }];
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(proximo));
  } catch {
    // Sem storage o carrinho não persiste; a compra ainda pode ser feita na
    // vitrine, que mantém o estado em memória.
  }
  /*
    Com conta, o carrinho mora NELA (GAP-PRD-193): o acréscimo vai também
    para o servidor, e o outro aparelho já abre com ele. Falhar aqui não
    perde nada — a vitrine funde a cópia do aparelho no próximo login.
  */
  const token = tokenDoPortal();
  if (token) {
    void carrinhoApi.acrescentar(token, { productId: alvo, quantity: linha.quantity }).catch(() => undefined);
  }
}

export default function ProdutoLojaPage() {
  const { storeSlug = '', productId = '' } = useParams();
  // A página do produto veste a marca da loja dona (rodada 40): paleta via
  // data-marca e logo no cabeçalho. O nome vem do produto; o logo, das lojas.
  const [marca, setMarca] = useState<MarcaDaLoja | null>(null);
  useEffect(() => {
    apiRequest<{ stores: { slug: string; tradeName: string; logoUrl?: string | null }[] }>(
      '/loja/stores',
      { anonymous: true },
    )
      .then((d) => {
        const s = d.stores.find((x) => x.slug === storeSlug);
        if (s) setMarca({ slug: s.slug, nome: s.tradeName, logoUrl: s.logoUrl ?? null });
      })
      .catch(() => undefined);
  }, [storeSlug]);
  const [produto, setProduto] = useState<ProdutoDetalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [varianteId, setVarianteId] = useState<string | null>(null);
  const [quantidade, setQuantidade] = useState(1);
  /*
    A foto escolhida é a URL, NÃO o índice (rodada 57).

    Com índice, a lista que encolhe embaixo troca a foto: galeria [A,B,C], o
    cliente clica em B (índice 1), a miniatura de A falha tarde (é lazy) e a
    lista vira [B,C] — o índice 1 agora é C, e a tela mostra sozinha uma foto
    que ninguém pediu, com a miniatura errada marcada. A URL não desliza.
  */
  const [fotoAtiva, setFotoAtiva] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /*
    As URLs que FALHARAM ao carregar (rodada 57). Foto morta — arquivo
    apagado, nome errado no lote — saía como o ícone de imagem quebrada do
    navegador na página onde o cliente decide a compra. A galeria descarta a
    morta e segue com as vivas; morrendo todas, volta ao lugar da foto.
  */
  const [fotosMortas, setFotosMortas] = useState<Set<string>>(new Set());

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const dados = await apiRequest<ProdutoDetalhe>(
        `/loja/stores/${storeSlug}/products/${productId}`,
        { anonymous: true },
      ).then((r) => exigirCampos(r, 'id', 'name', 'description', 'category', 'subcategory', 'brand', 'unit', 'imageUrl', 'images', 'basePriceCents', 'priceCents', 'onSale', 'available', 'storeSlug', 'storeName', 'variants', 'shippingReadiness', 'missingShippingFields'));
      setProduto(dados);
      // Grade: nada pré-selecionado. Escolher por quem compra evita mandar o
      // tamanho errado para o carrinho.
      setVarianteId(null);
      /*
        O RESTO DO ESTADO TAMBÉM É DO PRODUTO ANTERIOR (rodada 56).

        Até a prateleira "Também em X" existir, ninguém trocava de produto sem
        recarregar a página, e o estado morria junto. Agora dá para pular de um
        para o outro sem desmontar a tela, e cada um destes carregava lixo:

          fotoAtiva  — sair de um produto com três fotos na terceira e cair num
                       de uma só deixa `galeria[2]` indefinido, e a tela tenta
                       montar uma imagem sem endereço.
          aviso      — "Adicionado ao carrinho" continuava na tela do produto
                       SEGUINTE, que não está no carrinho.
          quantidade — três unidades escolhidas lá viravam três aqui, e podiam
                       passar do estoque deste.
      */
      setFotoAtiva(null);
      setAviso(null);
      setQuantidade(1);
      setFotosMortas(new Set());
    } catch (err) {
      setProduto(null);
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível carregar o produto.',
      );
    }
  }, [storeSlug, productId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const variante = useMemo(
    () => produto?.variants.find((v) => v.id === varianteId) ?? null,
    [produto, varianteId],
  );

  const temGrade = (produto?.variants.length ?? 0) > 0;
  const precoAtual = variante?.priceCents ?? produto?.priceCents ?? 0;
  const disponivel = variante?.available ?? produto?.available ?? 0;
  const precisaEscolher = temGrade && !variante;
  const esgotado = !precisaEscolher && disponivel <= 0;

  if (erro) {
    return (
      <CascaDaLoja marca={marca}>
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-lg)]">
          {erro}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/*
            A segunda chance que faltava: rede que piscou exigia recarregar a
            página no navegador. E a volta leva à LOJA do produto (o slug está
            na URL), não à home do grupo — o cliente estava na Gringa.
          */}
          <button
            type="button"
            onClick={() => void carregar()}
            className="bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
              rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
          >
            Tentar de novo
          </button>
          <Link to={`/${storeSlug}`} className="text-[var(--gs-purple-700)] underline">
            Voltar para a loja
          </Link>
        </div>
      </CascaDaLoja>
    );
  }

  if (!produto) {
    return (
      <CascaDaLoja marca={marca}>
        <p className="text-[var(--gs-muted)]">Carregando…</p>
      </CascaDaLoja>
    );
  }

  const galeriaBruta = produto.images.length > 0
    ? produto.images.map((i) => i.url)
    : produto.imageUrl
      ? [produto.imageUrl]
      : [];
  // Só as fotos que carregam entram na galeria; a morta some sem deixar
  // miniatura quebrada nem foto grande sem endereço.
  const galeria = galeriaBruta.filter((u) => !fotosMortas.has(u));
  // A escolhida, se ainda viva; senão a primeira que sobrou.
  const fotoVisivel =
    fotoAtiva && galeria.includes(fotoAtiva) ? fotoAtiva : galeria[0];

  return (
    <CascaDaLoja marca={marca}>
      <nav aria-label="Trilha" className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-4">
        <Link to="/loja" className="text-[var(--gs-purple-700)] no-underline hover:underline">
          Loja
        </Link>
        {' › '}
        <span>{produto.storeName}</span>
        {produto.category && ` › ${produto.category}`}
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          {galeria.length > 0 ? (
            <div className="aspect-square bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius-lg)] overflow-hidden flex items-center justify-center">
              <img
                key={fotoVisivel}
                src={coreApi.imageUrl(fotoVisivel)}
                alt={produto.name}
                /*
                  `contain`, não `cover`: na moldura quadrada, cover cortava
                  a parte de cima e a de baixo de qualquer foto em retrato —
                  o formato natural de roupa na Gringa e na Conceito. A página
                  de decisão mostra a peça INTEIRA. E é a foto que o cliente
                  veio ver: carrega na hora, sem lazy.
                */
                className="w-full h-full object-contain"
                /* A URL vem do EVENTO, não do render: o erro pode chegar
                   depois de a lista mudar, e reler `fotoVisivel` marcaria
                   como morta uma foto que está viva. */
                onError={(e) => {
                  const morta = e.currentTarget.dataset.url;
                  if (morta) setFotosMortas((prev) => new Set(prev).add(morta));
                }}
                data-url={fotoVisivel}
              />
            </div>
          ) : (
            /*
              O VAZIO DE TELA INTEIRA (rodada 56).

              Sem foto, este quadro ocupava a viewport inteira com um retângulo
              cinza e a frase "Sem foto cadastrada" no meio — e o cliente tinha
              de rolar uma tela cheia de nada para chegar ao nome e ao preço.
              Como ZERO dos produtos publicados do grupo tem foto, era o que
              acontecia em 100% das páginas de produto.

              A decisão de não inventar imagem continua: uma silhueta genérica
              faria o cliente achar que é outra coisa. O que muda é que o
              espaço passa a ser da MARCA, tem teto de altura, e diz que a foto
              vem — em vez de parecer que a página quebrou.
            */
            <div className="max-w-sm">
              <LugarDaFoto loja={produto.storeName} testId="sem-foto-do-produto" />
            </div>
          )}

          {galeria.length > 1 && (
            <ul className="list-none p-0 mt-3 flex gap-2 flex-wrap">
              {galeria.map((url, i) => (
                <li key={url}>
                  <button
                    type="button"
                    aria-label={`Foto ${i + 1}`}
                    aria-pressed={url === fotoVisivel}
                    onClick={() => setFotoAtiva(url)}
                    className={`w-16 h-16 rounded-[var(--gs-radius)] overflow-hidden border-2 cursor-pointer p-0 ${
                      url === fotoVisivel
                        ? 'border-[var(--gs-purple-700)]'
                        : 'border-[var(--gs-border)]'
                    }`}
                  >
                    <img
                      src={coreApi.imageUrl(url)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={() => setFotosMortas((prev) => new Set(prev).add(url))}
                      className="w-full h-full object-cover"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <span className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-purple-700)]">
              {produto.storeName}
            </span>
            {/* leading-tight como o h1 do herói da vitrine: 28px herdando o
                line-height 1.5 do corpo abria caixas de 42px por linha. */}
            <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] m-0 leading-tight">
              {produto.name}
            </h1>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-0">
              {[produto.brand, produto.category, produto.subcategory].filter(Boolean).join(' · ')}
            </p>
          </div>

          <div>
            {produto.onSale && (
              <span className="block text-[length:var(--gs-text-base)] text-[var(--gs-muted)] line-through">
                {formatCents(produto.basePriceCents)}
              </span>
            )}
            <strong
              /*
                O preço — o número mais importante da página — estava em 32px
                CRU, fora dos sete degraus. Entra no topo da escala (36): é o
                único número que merece o degrau máximo da página.
              */
              className={`text-[length:var(--gs-text-3xl)] leading-none ${
                produto.onSale ? 'text-[var(--gs-orange-600)]' : 'text-[var(--gs-purple-900)]'
              }`}
            >
              {formatCents(precoAtual)}
            </strong>
          </div>

          {produto.description && (
            <p className="text-[length:var(--gs-text-base)] text-[var(--gs-text-soft)] m-0 whitespace-pre-line">
              {produto.description}
            </p>
          )}

          {temGrade && (
            <fieldset className="border-0 p-0 m-0">
              <legend className="text-[length:var(--gs-text-sm)] font-semibold mb-2">
                Escolha a opção
              </legend>
              <div className="flex flex-wrap gap-2">
                {produto.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={v.available <= 0}
                    aria-pressed={v.id === varianteId}
                    onClick={() => {
                      setVarianteId(v.id);
                      setQuantidade(1);
                    }}
                    className={`px-4 py-2 rounded-[var(--gs-radius)] border cursor-pointer
                      disabled:opacity-40 disabled:cursor-not-allowed ${
                      v.id === varianteId
                        ? 'bg-[var(--gs-purple-700)] text-white border-transparent'
                        : 'bg-[var(--gs-surface)] border-[var(--gs-border-strong)]'
                    }`}
                  >
                    {Object.values(v.attributes).join(' · ') || v.name}
                    {v.available <= 0 && ' (esgotado)'}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <p className="text-[length:var(--gs-text-sm)] m-0">
            {precisaEscolher ? (
              <span className="text-[var(--gs-muted)]">Escolha uma opção para ver o estoque.</span>
            ) : esgotado ? (
              <strong className="text-[var(--gs-danger)]">ESGOTADO</strong>
            ) : (
              <span className="text-[var(--gs-muted)]">
                {/* "UN" é vocabulário do cadastro: "2 disponíveis · UN" não
                    diz nada a quem compra. Unidade só quando informa (KG, M…). */}
                {contar(disponivel, 'disponível', 'disponíveis')}
                {produto.unit && produto.unit !== 'UN' ? ` · ${produto.unit}` : ''}
              </span>
            )}
          </p>

          <EntregaOuRetirada produto={produto} />

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold">Quantidade</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, disponivel)}
                value={quantidade}
                onChange={(e) =>
                  setQuantidade(
                    Math.max(1, Math.min(disponivel || 1, Number(e.target.value) || 1)),
                  )
                }
                aria-label="Quantidade"
                className="w-24 px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              />
            </label>

            <button
              type="button"
              disabled={precisaEscolher || esgotado}
              onClick={() => {
                adicionarAoCarrinho({
                  product: {
                    id: variante?.id ?? produto.id,
                    name: variante ? `${produto.name} · ${variante.name}` : produto.name,
                    priceCents: precoAtual,
                    basePriceCents: produto.basePriceCents,
                    onSale: produto.onSale,
                    available: disponivel,
                    storeSlug: produto.storeSlug,
                    storeName: produto.storeName,
                    imageUrl: galeria[0] ?? null,
                  },
                  quantity: quantidade,
                });
                setAviso('Adicionado ao carrinho.');
              }}
              className="bg-[var(--gs-orange-500)] hover:bg-[var(--gs-orange-600)] text-white border-0
                rounded-[var(--gs-radius)] px-6 py-3 font-semibold cursor-pointer
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {precisaEscolher ? 'Escolha uma opção' : esgotado ? 'Esgotado' : 'Adicionar ao carrinho'}
            </button>
          </div>

          {aviso && (
            <p
              role="status"
              className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
                text-[length:var(--gs-text-sm)] text-[var(--gs-success)] m-0"
            >
              {aviso}{' '}
              {/*
                Para a LOJA em que o cliente está, com o carrinho já aberto —
                antes ia para a home do GRUPO (outra paleta, carrinho fechado):
                dois saltos de contexto para ver o que acabou de guardar.
              */}
              <Link
                to={`/${produto.storeSlug}?carrinho=1`}
                className="text-[var(--gs-success)] underline"
              >
                Ver carrinho
              </Link>
            </p>
          )}
        </section>
      </div>

      {/*
        A PRATELEIRA AO LADO (rodada 56).

        Vem entre a compra e as avaliações porque é onde ela serve: quem já
        viu preço e disponibilidade ou decidiu, ou quer ver o que mais tem
        parecido. Some quando o produto não tem departamento — "sem categoria"
        não é uma categoria, e relacionar tudo que não tem categoria juntaria
        batom com pneu.
      */}
      {(produto.related?.length ?? 0) > 0 && (
        /*
          mt-8, título xl: as duas seções empilhadas no fim da página
          (prateleira e avaliações) abriam com respiros e degraus diferentes
          por acidente — agora seção da loja é sempre xl semibold com o mesmo
          respiro.
        */
        <section aria-label="Também nesta prateleira" className="mt-8">
          <h2 className="text-[length:var(--gs-text-xl)] font-semibold text-[var(--gs-purple-900)] mb-3">
            Também em {produto.category}
          </h2>
          <ul className="list-none p-0 m-0 grid gap-4 grid-cols-2 md:grid-cols-4">
            {produto.related!.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/loja/${r.storeSlug}/produto/${r.id}`}
                  className="no-underline text-[var(--gs-text)] block"
                >
                  <FotoDeProduto
                    url={r.imageUrl}
                    alt={r.name}
                    loja={r.storeName}
                    testId={`sem-foto-${r.id}`}
                  />
                  <p className="text-[length:var(--gs-text-sm)] font-semibold mt-2 mb-0 line-clamp-2">
                    {r.name}
                  </p>
                  <p className="text-[length:var(--gs-text-base)] text-[var(--gs-orange-600)] font-bold m-0">
                    {formatCents(r.priceCents)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Abaixo da compra: quem chega aqui já viu preço e disponibilidade, e a
          avaliação é o que decide a dúvida que sobrou. */}
      <AvaliacoesProduto productId={produto.id} />
    </CascaDaLoja>
  );
}

/**
 * O que a loja consegue prometer sobre a entrega deste item.
 *
 * Produto sem medidas NÃO ganha um frete estimado: ganha a verdade, e a
 * retirada continua valendo.
 */
function EntregaOuRetirada({ produto }: { produto: ProdutoDetalhe }) {
  if (produto.shippingReadiness === 'READY_FOR_SHIPPING') {
    return <SimulacaoDeFrete produto={produto} />;
  }

  /*
    A tela pública falava com a pessoa ERRADA: "o envio depende de dados de
    embalagem que ainda não foram cadastrados (peso, altura, largura,
    comprimento)" é diagnóstico para o DONO — e ele já o recebe, na Prontidão
    Online e no aviso do painel da loja. O comprador não cadastra produto;
    para ele a informação é uma só: este item é retirada, por enquanto.

    E a retirada é AFIRMADA só quando a loja a oferece (`pickupEnabled`, a
    mesma fonte do selo "Retire na loja"). Prometer "retire sem custo" a quem
    compra numa loja com retirada desligada é a tela garantindo o que o
    cadastro nega — e o cliente descobre no fim do checkout, com o carrinho
    montado. Sem retirada, o aviso diz o que é verdade e para por aí.
  */
  if (produto.pickupEnabled === false) {
    return (
      <div
        role="status"
        className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
          text-[var(--gs-warning)]"
      >
        <strong className="block text-[length:var(--gs-text-sm)]">
          Entrega indisponível para este produto no momento
        </strong>
        <span className="text-[length:var(--gs-text-sm)]">
          Fale com a loja para combinar como receber.
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
        text-[var(--gs-warning)]"
    >
      <strong className="block text-[length:var(--gs-text-sm)]">
        Este produto é só retirada na loja, por enquanto
      </strong>
      <span className="text-[length:var(--gs-text-sm)]">
        A entrega em casa ainda não está liberada para este item. Retire sem custo — é só fechar o
        pedido escolhendo a retirada.
      </span>
    </div>
  );
}

/**
 * O contrato é o do adapter logístico (`LogisticsQuoteOptionResult`), campo a
 * campo. Já esteve diferente: a tela lia `priceCents` e `deliveryDays`, e o
 * servidor manda `priceInCents` e `estimatedDays` — o preço caía no fallback
 * e o cliente lia FRETE R$ 0,00, prazo nenhum. Só não apareceu porque nenhum
 * produto tem medidas ainda, então a cotação nunca devolvia opção. Nome de
 * campo divergente aqui é dinheiro errado na tela.
 */
interface OpcaoFrete {
  carrier?: string;
  serviceCode?: string;
  serviceName?: string;
  priceInCents?: number;
  estimatedDays?: number;
  simulated?: boolean;
}

/**
 * "Quanto custa para chegar aqui?"
 *
 * É ESTIMATIVA, e a tela diz isso. O frete que vale é o do checkout, sobre o
 * carrinho fechado — prometer aqui um valor definitivo seria cobrar diferente
 * depois, com o cliente já decidido.
 *
 * Nada é chamado sem CEP válido: oito dígitos, com ou sem hífen. CEP torto
 * volta com aviso, sem gastar chamada no provedor.
 */
function SimulacaoDeFrete({ produto }: { produto: ProdutoDetalhe }) {
  const [cep, setCep] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{
    options: OpcaoFrete[];
    simulated?: boolean;
    code?: string;
    message?: string;
  } | null>(null);

  const calcular = useCallback(async () => {
    const digitos = cep.replace(/\D/g, '');
    if (digitos.length !== 8) {
      setErro('Informe um CEP com 8 dígitos.');
      setResultado(null);
      return;
    }
    setOcupado(true);
    setErro(null);
    try {
      setResultado(
        await apiRequest(
          `/loja/stores/${produto.storeSlug}/products/${produto.id}/shipping-quote`,
          { method: 'POST', anonymous: true, body: { zip: digitos } },
        ),
      );
    } catch (err) {
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível calcular a entrega.',
      );
    } finally {
      setOcupado(false);
    }
  }, [cep, produto.id, produto.storeSlug]);

  return (
    <div className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] flex flex-col gap-3">
      <div>
        <strong className="block text-[length:var(--gs-text-sm)]">Entrega e retirada disponíveis</strong>
        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Retirada na loja sem custo. Para entrega, calcule pelo seu CEP.
        </span>
      </div>

      {/*
        <form> de verdade: o par vivia numa <div> e digitar o CEP + Enter — o
        gesto mais automático do teclado — não fazia nada.
      */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void calcular();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--gs-text-sm)] font-semibold">CEP de entrega</span>
          <input
            value={cep}
            onChange={(e) => setCep(e.target.value)}
            placeholder="00000-000"
            aria-label="CEP de entrega"
            inputMode="numeric"
            maxLength={9}
            className="w-36 px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
        </label>
        <button
          type="submit"
          disabled={ocupado}
          className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white border-0
            rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
        >
          {ocupado ? 'Calculando…' : 'Calcular'}
        </button>
      </form>

      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}

      {resultado && resultado.options.length === 0 && (
        <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] m-0">
          {resultado.code === 'ORIGIN_NOT_CONFIGURED'
            ? 'A loja ainda não cadastrou o endereço de origem. Retirada continua disponível.'
            : (resultado.message
              ?? 'Nenhuma transportadora disponível para este CEP no momento.')}
        </p>
      )}

      {resultado && resultado.options.length > 0 && (
        <div>
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {resultado.options.map((o, i) => (
              <li
                key={`${o.carrier ?? o.serviceCode ?? 'opcao'}-${i}`}
                className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)] last:border-0"
              >
                <span>
                  <strong className="text-[length:var(--gs-text-sm)]">
                    {o.serviceName ?? o.carrier ?? 'Entrega'}
                  </strong>
                  {Number.isFinite(o.estimatedDays) && (
                    <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {contar(o.estimatedDays as number, 'dia útil', 'dias úteis')} após a expedição
                    </span>
                  )}
                </span>
                <strong className="text-[length:var(--gs-text-base)]">
                  {/* Preço ausente NÃO vira R$ 0,00: frete grátis que não
                      existe é cobrança surpresa depois. */}
                  {Number.isFinite(o.priceInCents)
                    ? formatCents(o.priceInCents as number)
                    : 'valor a confirmar'}
                </strong>
              </li>
            ))}
          </ul>

          <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mt-2 mb-0">
            {resultado.simulated
              ? 'SIMULAÇÃO — a transportadora ainda não está conectada. '
              : ''}
            Estimativa: o valor final é confirmado no checkout.
          </p>
        </div>
      )}
    </div>
  );
}

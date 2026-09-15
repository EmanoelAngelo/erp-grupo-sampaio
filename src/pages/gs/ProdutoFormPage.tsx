/**
 * Cadastro de produto, em seções.
 *
 * O formulário plano de antes misturava preço, NCM e publicação na vitrine
 * numa coluna só — quem cadastra roupa nunca precisa de CFOP, e quem ajusta
 * tributação não quer rolar por campo de foto. As seções deixam cada pessoa
 * ir direto ao que lhe cabe.
 *
 * Não existe produto paralelo: é o mesmo `core_products` de sempre, com a
 * grade vinda do VariantService e o preço promocional do PricingService.
 * A vitrine consome exatamente este cadastro, este preço e esta foto.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, Input, PageHeader } from '@/components/gs/ui';
import { useConfirmar } from '@/components/gs/PerguntaDaTela';
import { useCan } from '@/hooks/useCan';
import { EtiquetaDoProduto } from '@/components/gs/EtiquetaDoProduto';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { miniaturaDaUrl, normalizeImage } from '@/lib/image';
import {
  coreApi,
  type ComponenteDoKit,
  type EventoDoProduto,
  type FaixaDePreco,
  type GrupoTributario,
  type Product,
  type ProductClassification,
  type ProductImage,
  type ReadinessState,
  type ResultadoDoTipo,
  type StockItem,
  type Supplier,
  type Taxonomy,
  type Unidade,
  type ValorPersonalizado,
  type VariantStock,
  type Workshop,
} from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';

/**
 * O estado da classificação, em português de tela.
 *
 * Vale a pena escrever a frase inteira e não só a palavra: "AUTO-DETECTADO"
 * sozinho não diz que ninguém assinou embaixo, e é exatamente isso que quem
 * confere precisa entender antes de emitir a primeira nota com aquele NCM.
 */
const ESTADO_DA_CLASSIFICACAO: Record<ReadinessState, string> = {
  CONFIRMADO: 'confirmado por uma pessoa',
  AUTO_DETECTADO: 'auto-detectado, sem confirmação humana',
  PENDENTE: 'ninguém informou ainda',
  DIVERGENTE: 'divergente — as fontes discordam',
  NAO_APLICAVEL: 'não se aplica a esta mercadoria',
  BLOQUEADO_EXTERNAMENTE: 'depende de resposta de fora',
};

type Secao =
  | 'geral'
  | 'fotos'
  | 'precos'
  | 'codigos'
  | 'etiqueta'
  | 'estoque'
  | 'fiscal'
  | 'ecommerce'
  | 'variantes'
  | 'personalizados'
  | 'historico';

const SECOES: { id: Secao; label: string }[] = [
  { id: 'geral', label: 'Dados gerais' },
  // Foto é atributo do PRODUTO, não do e-commerce. Estava enterrada na aba de
  // e-commerce e travada até salvar: quem cadastrava um produto novo não
  // encontrava onde colocar a foto.
  { id: 'fotos', label: 'Fotos' },
  { id: 'precos', label: 'Preços' },
  // Códigos e kit ficam juntos porque respondem à mesma pergunta — "o que
  // exatamente é este item quando alguém bipa ou vende".
  { id: 'codigos', label: 'Códigos e kit' },
  // A etiqueta do produto: modelo da loja, quantidade, prévia e impressão —
  // sem sair do cadastro. Imprimir etiqueta não mexe no estoque.
  { id: 'etiqueta', label: 'Etiqueta' },
  { id: 'estoque', label: 'Estoque' },
  { id: 'fiscal', label: 'Fiscal' },
  { id: 'ecommerce', label: 'E-commerce' },
  { id: 'variantes', label: 'Variantes' },
  // Campos próprios da operação (GAP-V07) e a trilha do cadastro (GAP-V05).
  // As duas ficam DEPOIS de tudo, e não misturadas em "Dados gerais", porque
  // são progressive disclosure de verdade: a esmagadora maioria dos cadastros
  // nunca precisa delas, e quem precisa sabe o que procura.
  { id: 'personalizados', label: 'Campos próprios' },
  { id: 'historico', label: 'Histórico' },
];

/** Campos do formulário, todos como texto — a conversão é feita ao salvar. */
interface Form {
  name: string;
  description: string;
  internalCode: string;
  /**
   * SKU do catálogo da loja (A-produto-24). A busca do PDV já casa por ele e a
   * etiqueta tem o campo; a tela não tinha onde digitá-lo. O servidor recusa
   * SKU repetido ou igual ao código interno/EAN de outro produto.
   */
  sku: string;
  barcode: string;
  brand: string;
  category: string;
  subcategory: string;
  weightGrams: string;
  heightCm: string;
  widthCm: string;
  lengthCm: string;
  unit: string;
  active: boolean;
  cost: string;
  price: string;
  minStock: string;
  ncm: string;
  cest: string;
  cfop: string;
  origin: string;
  /**
   * O CÓDIGO do grupo tributário deste produto (GAP-V01).
   *
   * Vazio = "usa o único grupo ativo da operação", que é o que os dezenove
   * produtos do banco real significam hoje. Com DOIS grupos ativos, vazio para
   * a emissão — e era exatamente isso que a mensagem de erro mandava resolver
   * num campo que não existia na tela.
   */
  taxProfile: string;
  publishOnline: boolean;
  onlineDescription: string;
  /** 'retail' (varejo) ou 'part' (peça de oficina). */
  kind: string;
  workshopId: string;
  supplierId: string;
  /** Código do fabricante — pelo qual se PEDE a peça. */
  reference: string;
  /** Piso: abaixo disto o produto não deve ser vendido. */
  minPrice: string;
  minMarkup: string;
  minMargin: string;
  /** Preço digitado na venda, não no cadastro. */
  openPrice: boolean;
  /** Kit: a venda registra as peças em vez do kit. */
  kitExplodeOnSale: boolean;
  /** O custo do kit vem da soma das peças. */
  kitCostFromComponents: boolean;
  /** Vendido por peso — entra no arquivo da balança. */
  weighable: boolean;
  /** O número pelo qual a balança acha o produto. Texto: zero à esquerda conta. */
  pluCode: string;
  /** Tara da embalagem em gramas, descontada pela balança. */
  tareGrams: string;
  /** Cada unidade tem identidade própria: chassi, IMEI, número de série. */
  serialized: boolean;
  /**
   * Controla LOTE E VALIDADE (GAP-V35). Iogurte tem; parafuso não tem.
   *
   * NÃO viaja no corpo do produto: vai por rota própria depois do salvar, e o
   * porquê está em `ajustarControleDeLote`.
   */
  tracksBatches: boolean;
  /**
   * O produto SAI DA PRATELEIRA? (GAP-V02)
   *
   * Desligado é o serviço de balcão — ajuste de bainha, instalação, película.
   * Nasce LIGADO porque é o que quase todo cadastro é, e porque é o que todo
   * produto já cadastrado significa.
   */
  stockControl: boolean;
  /** Quantas unidades vêm na embalagem de compra — "caixa com 12" (V06). */
  packFactor: string;
  /** Como a embalagem se chama na nota do fornecedor: CX, FD. */
  packUnit: string;
}

const VAZIO: Form = {
  name: '',
  description: '',
  internalCode: '',
  sku: '',
  barcode: '',
  brand: '',
  category: '',
  subcategory: '',
  weightGrams: '',
  heightCm: '',
  widthCm: '',
  lengthCm: '',
  unit: 'UN',
  active: true,
  cost: '',
  price: '',
  minStock: '0',
  ncm: '',
  cest: '',
  cfop: '',
  origin: '',
  taxProfile: '',
  publishOnline: false,
  onlineDescription: '',
  kind: 'retail',
  workshopId: '',
  supplierId: '',
  reference: '',
  minPrice: '',
  minMarkup: '',
  minMargin: '',
  openPrice: false,
  kitExplodeOnSale: true,
  kitCostFromComponents: false,
  weighable: false,
  pluCode: '',
  tareGrams: '',
  serialized: false,
  tracksBatches: false,
  stockControl: true,
  packFactor: '',
  packUnit: '',
};

/** Número do banco vira texto do formulário; nulo vira campo vazio. */
function numeroOuVazio(valor: unknown): string {
  return valor === null || valor === undefined ? '' : String(valor);
}

function reais(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

/**
 * O CUSTO DE R$ 1.500,00 VIRAVA ZERO.
 *
 * Esta função trocava só a PRIMEIRA vírgula por ponto: `"1.500,00"` virava
 * `"1.500.00"`, que é `NaN`, que caía no zero do final. Quem digita dinheiro
 * no Brasil escreve o separador de milhar — então o preço de custo do produto
 * mais caro do catálogo era o mais provável de ser gravado como zero. Custo
 * zero estraga margem, markup, relatório de lucro e, numa peça, o preço
 * derivado da rodada 55.
 *
 * O interpretador da casa (`parseReaisToCents`) já existia, com o histórico do
 * defeito que multiplicava por cem documentado nele — e este arquivo já
 * importava `formatCents` do mesmo módulo. Faltava usar a outra ponta.
 *
 * O zero fica como último recurso: `parseReaisToCents` devolve `null` quando
 * não consegue ler, e campo vazio de preço é legitimamente zero aqui.
 */
function centavos(valor: string): number {
  return parseReaisToCents(valor) ?? 0;
}

/**
 * Quantidade digitada no Brasil: "2,5" é dois e meio (A-produto-19).
 *
 * `Number(form.minStock) || 0` transformava "2,5" em NaN e o NaN em ZERO — o
 * alerta de estoque baixo nunca disparava. Vazio é zero; texto que não é número
 * devolve NaN, para o Salvar recusar em vez de gravar zero calado.
 */
function quantidadeDigitada(valor: string): number {
  const texto = valor.trim().replace(/\s/g, '');
  if (!texto) return 0;
  const normalizado = texto.includes(',') ? texto.replace(/\./g, '').replace(',', '.') : texto;
  return /^\d+(\.\d+)?$/.test(normalizado) ? Number(normalizado) : Number.NaN;
}

/**
 * Percentual digitado ("33,33" ou "30%"); vazio é nulo = "sem piso declarado".
 *
 * O DEFEITO (revisão do A-produto-03): "30%" dava `Number('30%')` = NaN, que o
 * JSON manda como `null` — e nulo, agora, é o pedido explícito de TIRAR o piso.
 * Quem digitava o símbolo de porcento apagava a política em silêncio, com
 * "Produto atualizado." na tela. O "%" é aceito; o resto que não é número
 * devolve NaN, e o Salvar recusa antes de gravar.
 */
function percentualDigitado(valor: string): number | null {
  const texto = valor.trim().replace(/\s/g, '').replace(/%$/, '');
  if (!texto) return null;
  const normalizado = texto.replace(',', '.');
  return /^\d+(\.\d+)?$/.test(normalizado) ? Number(normalizado) : Number.NaN;
}

/**
 * O CORPO DO SALVAR, montado de um formulário qualquer — o da tela ou o que foi
 * LIDO do banco. É a mesma função para os dois de propósito: é comparando um
 * com o outro que o Salvar descobre o que a pessoa mudou (A-produto-07).
 *
 * Os textos vão SEMPRE como texto, inclusive vazio (A-produto-03): o servidor
 * trata ausente como "preserve" e vazio como "limpe", e `|| undefined` fazia a
 * categoria, o CEST ou o EAN apagados voltarem ao salvar. Os pisos vazios vão
 * como NULO, que é "tirar o piso".
 */
function montarCorpo(f: Form): Record<string, unknown> {
  return {
    name: f.name.trim(),
    description: f.description,
    sku: f.sku.trim(),
    barcode: f.barcode.trim(),
    brand: f.brand,
    category: f.category,
    subcategory: f.subcategory,
    // Campo vazio vira ausente: o backend preserva a medida que já estava.
    // Zerar sem querer tiraria o produto da entrega sem ninguém pedir.
    weightGrams: f.weightGrams.trim() ? Number(f.weightGrams) : undefined,
    heightCm: f.heightCm.trim() ? Number(f.heightCm) : undefined,
    widthCm: f.widthCm.trim() ? Number(f.widthCm) : undefined,
    lengthCm: f.lengthCm.trim() ? Number(f.lengthCm) : undefined,
    unit: f.unit || 'UN',
    active: f.active,
    costCents: centavos(f.cost),
    priceCents: centavos(f.price),
    minStock: quantidadeDigitada(f.minStock),
    ncm: f.ncm.trim(),
    cest: f.cest.trim(),
    cfop: f.cfop.trim(),
    origin: f.origin.trim(),
    /*
      O GRUPO TRIBUTÁRIO, que a rota já aceitava e a tela nunca mandou
      (GAP-V01). Vai SEMPRE, inclusive vazio: a opção "usar o padrão da
      operação" do seletor é exatamente o vazio.
    */
    taxProfile: f.taxProfile,
    publishOnline: f.publishOnline,
    onlineDescription: f.onlineDescription,
    supplierId: f.supplierId,
    reference: f.reference,
    minPriceCents: f.minPrice.trim() ? centavos(f.minPrice) : null,
    minMarkupPercent: percentualDigitado(f.minMarkup),
    minMarginPercent: percentualDigitado(f.minMargin),
    openPrice: f.openPrice,
    weighable: f.weighable,
    // String vazia limpa o PLU no servidor — é como se tira um produto da
    // balança sem apagar o cadastro.
    pluCode: f.pluCode.trim(),
    tareGrams: f.tareGrams.trim() ? Number(f.tareGrams) : null,
    serialized: f.serialized,
    kitExplodeOnSale: f.kitExplodeOnSale,
    kitCostFromComponents: f.kitCostFromComponents,
    // O serviço de balcão (GAP-V02). O servidor recusa desligar quando ainda
    // há saldo, com o número na mensagem.
    stockControl: f.stockControl,
    // Embalagem (GAP-V06): vazio LIMPA — é como se diz "não vem mais em caixa".
    packFactor: f.packFactor.trim() ? Number(f.packFactor) : null,
    packUnit: f.packUnit.trim(),
  };
}

/**
 * SÓ O QUE A PESSOA MUDOU vai no PUT, e com o valor que ela VIU (A-produto-07).
 *
 * O formulário mandava o objeto inteiro: o gestor A abria o perfume a R$ 39,90,
 * o gestor B baixava para R$ 29,90 na Alteração rápida, e o Salvar de A — que
 * só corrigiu a descrição — revertia o preço em silêncio. Mandando só a
 * descrição, o preço de B fica. E `expected` leva o que A viu nos campos que
 * ele mudou: se B mexeu no MESMO campo, o servidor recusa com 409 em vez de
 * escolher um vencedor calado.
 */
function oQueMudou(
  lido: Record<string, unknown>,
  atual: Record<string, unknown>,
): { corpo: Record<string, unknown>; expected: Record<string, unknown> } {
  const corpo: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(atual)) {
    // Medida apagada vai como ausente (o servidor preserva): não há o que mandar.
    if (valor === undefined) continue;
    if (JSON.stringify(valor) === JSON.stringify(lido[chave])) continue;
    corpo[chave] = valor;
    expected[chave] = lido[chave] ?? null;
  }
  return { corpo, expected };
}

/** O que está abaixo do piso declarado — com o motivo, não só um alerta. */
function violacoesDoPiso(f: Form, precoCents: number): string[] {
  const motivos: string[] = [];
  const custoCents = centavos(f.cost);
  const minPreco = centavos(f.minPrice);
  if (minPreco > 0 && precoCents > 0 && precoCents < minPreco) {
    motivos.push(`preço abaixo do mínimo de ${reais(minPreco)}`);
  }
  const markup = custoCents > 0 ? ((precoCents - custoCents) / custoCents) * 100 : null;
  const margem =
    custoCents > 0 && precoCents > 0 ? ((precoCents - custoCents) / precoCents) * 100 : null;
  // O MESMO leitor do Salvar: "30%" é trinta aqui e lá — senão o aviso sumia
  // justamente quando a pessoa digitava o símbolo.
  const minMarkup = percentualDigitado(f.minMarkup) ?? Number.NaN;
  if (Number.isFinite(minMarkup) && markup !== null && markup < minMarkup) {
    motivos.push(`markup abaixo do mínimo de ${minMarkup.toFixed(2)}%`);
  }
  const minMargem = percentualDigitado(f.minMargin) ?? Number.NaN;
  if (Number.isFinite(minMargem) && margem !== null && margem < minMargem) {
    motivos.push(`margem abaixo do mínimo de ${minMargem.toFixed(2)}%`);
  }
  return motivos;
}

/** Onde a criação guarda o que não deu certo DEPOIS do produto nascer. */
const CHAVE_AVISOS_DA_CRIACAO = (productId: string) => `gs:produto-criado:${productId}`;

export default function ProdutoFormPage() {
  const { id } = useParams();
  const editando = Boolean(id);

  const [secao, setSecao] = useState<Secao>('geral');
  const [form, setForm] = useState<Form>(VAZIO);
  const [produto, setProduto] = useState<Product | null>(null);
  const [estoque, setEstoque] = useState<StockItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Fotos escolhidas ANTES de o produto existir.
   *
   * Ficam em memória e sobem logo depois da criação. É o que permite colocar
   * a foto no mesmo gesto do cadastro, em vez de mandar o usuário salvar,
   * voltar e procurar onde anexar.
   */
  const [fotosPendentes, setFotosPendentes] = useState<
    // `thumbDataUrl`: a miniatura do balcão, gerada junto (P0 da Preço Justo).
    { dataUrl: string; fileName: string; mimeType: string; thumbDataUrl?: string | null }[]
  >([]);
  /**
   * Códigos de barras ADICIONAIS — os que não são o principal.
   *
   * `codigosExtras` é o que o servidor já guarda; `codigosPendentes` é o que
   * foi digitado antes de o produto existir. A fila some no Salvar, igual à das
   * fotos: sem ela a pessoa digita três códigos e volta encontrando um.
   */
  const [codigosExtras, setCodigosExtras] = useState<string[]>([]);
  const [codigosPendentes, setCodigosPendentes] = useState<string[]>([]);
  /**
   * "Gerar código de barras" num produto que AINDA NÃO EXISTE: o EAN-13 interno
   * sai da sequência da loja, e ela só é gasta com o produto salvo.
   */
  const [gerarBarrasAoSalvar, setGerarBarrasAoSalvar] = useState(false);
  const [gerandoCodigo, setGerandoCodigo] = useState(false);
  const [novoCodigo, setNovoCodigo] = useState('');

  /** Composição do kit e a busca de peça. */
  const [kitComponentes, setKitComponentes] = useState<ComponenteDoKit[]>([]);
  const [kitCusto, setKitCusto] = useState(0);
  const [buscaPeca, setBuscaPeca] = useState('');
  const [achadosPeca, setAchadosPeca] = useState<Product[]>([]);

  /**
   * Só as bancadas que trabalham com estoque de peças.
   *
   * `capabilitiesFor` é regra do servidor e a conversão recusa bancada sem
   * `parts` (`CORE_WORKSHOP_WITHOUT_PARTS`). Oferecer a oficina errada no
   * seletor seria montar a recusa junto com a pessoa.
   */
  const [oficinas, setOficinas] = useState<Workshop[]>([]);
  const [taxonomia, setTaxonomia] = useState<Taxonomy | null>(null);

  /**
   * Os grupos tributários da operação (GAP-V01).
   *
   * Sem esta lista o campo não existia na tela — e a recusa da emissão mandava
   * "escolher o perfil no cadastro do produto", apontando para um lugar que não
   * existia. Empresa com DOIS grupos ativos travava a emissão de todo produto
   * sem perfil, sem saída pela interface.
   */
  const [gruposTributarios, setGruposTributarios] = useState<GrupoTributario[]>([]);

  /**
   * O VOCABULÁRIO DE UNIDADES e os FORNECEDORES da operação (A-produto-26 e
   * A-produto-10). Os dois eram texto livre: "Un", "UND" e "CX12" viravam três
   * unidades que nada governava, e o nome digitado do fornecedor era gravado
   * onde o sistema procura um id. Agora são seletores, como marca e categoria.
   */
  const [unidades, setUnidades] = useState<Unidade[]>([]);
  const [fornecedores, setFornecedores] = useState<Supplier[]>([]);

  /**
   * O FORMULÁRIO COMO FOI LIDO do banco (A-produto-07). É contra ele que o
   * Salvar descobre o que a pessoa mudou — e só isso vai no PUT.
   */
  const [formLido, setFormLido] = useState<Form>(VAZIO);

  /**
   * O que não deu certo DEPOIS de o produto nascer (A-produto-01): a foto que o
   * servidor recusou, o lote que não ligou. O produto já existe — são avisos,
   * mostrados na ficha dele, e não um erro que devolve a tela para "Novo".
   */
  const [avisosDaCriacao, setAvisosDaCriacao] = useState<string[]>([]);
  /** O id que o POST devolveu: um segundo clique em Salvar nunca cria outro. */
  const criadoAgora = useRef<string | null>(null);

  /**
   * O PREÇO QUE O SERVIDOR AINDA ESTÁ CALCULANDO (A-produto-16).
   *
   * Digitar a margem e clicar direto em Salvar: o blur pede o preço ao servidor
   * e o clique chega antes da resposta — o PUT levava o preço ANTIGO. O Salvar
   * espera esta promessa e usa o preço que ela devolver.
   */
  const precoEmCalculo = useRef<Promise<string | null> | null>(null);

  /** Faixas de preço por quantidade — "3 por R$ 10" (GAP-V04). */
  const [faixas, setFaixas] = useState<FaixaDePreco[]>([]);
  const [novaFaixa, setNovaFaixa] = useState({ quantidade: '', preco: '' });

  /** Campos próprios da operação, com o valor deste produto (GAP-V07). */
  const [personalizados, setPersonalizados] = useState<ValorPersonalizado[]>([]);
  /** Os valores como foram LIDOS: o Salvar só manda o que mudou (A-produto-18). */
  const [personalizadosLidos, setPersonalizadosLidos] = useState<Record<string, string>>({});

  /** A trilha do cadastro: o que mudou, de quanto para quanto (GAP-V05). */
  const [historico, setHistorico] = useState<EventoDoProduto[]>([]);

  /**
   * A PROCEDÊNCIA DA CLASSIFICAÇÃO FISCAL deste produto.
   *
   * Os campos NCM, CEST e origem podem ter chegado por dois caminhos que não
   * valem o mesmo: alguém digitou, ou o XML de um fornecedor declarou. Dentro
   * do mesmo <Input> os dois eram indistinguíveis — e quem abre esta aba para
   * conferir uma classificação precisa saber qual dos dois está olhando.
   */
  const [classificacao, setClassificacao] = useState<ProductClassification | null>(null);

  /**
   * O TIPO COMO ESTÁ GRAVADO, que é diferente do que está na tela.
   *
   * A comparação entre os dois é o que decide se a rota de conversão precisa
   * ser chamada. Sem esta cópia, salvar um produto sem tocar no tipo mandaria
   * uma conversão a cada clique em Salvar — e cada uma delas geraria um
   * registro de auditoria dizendo que alguém mudou o tipo, quando ninguém
   * mudou nada.
   */
  const [tipoGravado, setTipoGravado] = useState<{ kind: string; workshopId: string }>({
    kind: 'retail',
    workshopId: '',
  });

  /**
   * O controle de lote como está GRAVADO, para o Salvar só chamar a rota
   * quando mudou de verdade. Ligar o que já está ligado geraria auditoria de
   * uma decisão que ninguém tomou — o mesmo cuidado de `tipoGravado`.
   */
  const [loteGravado, setLoteGravado] = useState(false);

  /**
   * O que a conversão fez, contado pelo servidor.
   *
   * Estes campos só existem porque esta tela os MOSTRA. Guardar o resultado e
   * não exibir seria repetir o defeito que originou a rodada: campo com
   * escritor e sem leitor.
   */
  const [efeitosDoTipo, setEfeitosDoTipo] = useState<ResultadoDoTipo | null>(null);

  useEffect(() => {
    void coreApi
      .listWorkshops()
      .then((lista) => setOficinas(lista.filter((w) => w.capabilities.parts)))
      .catch(() => setOficinas([]));
    void coreApi.getTaxonomy().then(setTaxonomia).catch(() => setTaxonomia(null));
    /*
      Os grupos tributários e as definições de campo próprio vêm na abertura,
      e não ao entrar na aba: os dois alimentam SELETORES, e um seletor que
      carrega ao ser exibido pisca vazio no primeiro render — a pessoa vê "sem
      opções" e conclui que não há grupo cadastrado.

      Falha aqui não derruba o cadastro: lista vazia é um formulário sem aquele
      campo, não uma tela quebrada.
    */
    void coreApi.listTaxGroups().then(setGruposTributarios).catch(() => setGruposTributarios([]));
    // Unidade e fornecedor viram seletores (A-produto-26 e A-produto-10). Falha
    // aqui não derruba o cadastro: o seletor mostra o valor atual e mais nada.
    void coreApi
      .getCatalogAux()
      .then((aux) => setUnidades(aux.units ?? []))
      .catch(() => setUnidades([]));
    void coreApi
      .listSuppliers()
      .then((lista) => setFornecedores(lista ?? []))
      .catch(() => setFornecedores([]));
  }, []);

  /*
    A CLASSIFICAÇÃO SÓ FAZ SENTIDO PARA PRODUTO QUE JÁ EXISTE.

    Um cadastro novo não tem nota de entrada, não tem sugestão e não tem
    confirmação — perguntar por ele devolveria uma lista vazia e um 404 no
    console. Falha aqui não derruba a tela: sem procedência, a aba fiscal
    continua sendo o formulário que sempre foi.
  */
  useEffect(() => {
    if (!id) {
      setClassificacao(null);
      return;
    }
    void coreApi
      .listProductClassifications({ productId: id })
      .then((r) => setClassificacao(r.items[0] ?? null))
      .catch(() => setClassificacao(null));
  }, [id]);

  /** Subcategorias da categoria escolhida — mudar a categoria troca a lista. */
  const subcategorias =
    taxonomia?.categories.find(
      (c) => c.name.trim().toLowerCase() === form.category.trim().toLowerCase(),
    )?.children ?? [];

  const set = useCallback(<K extends keyof Form>(campo: K, valor: Form[K]) => {
    setForm((prev) => ({ ...prev, [campo]: valor }));
  }, []);

  /*
    OS AVISOS DA CRIAÇÃO chegam aqui depois do redirecionamento (A-produto-01):
    o produto nasceu, e o que falhou depois (foto, lote, EAN interno) é dito na
    ficha dele — nunca mais na tela de "Novo", onde o Salvar seguinte criaria o
    item de novo.
  */
  useEffect(() => {
    if (!id) return;
    try {
      const guardado = sessionStorage.getItem(CHAVE_AVISOS_DA_CRIACAO(id));
      if (guardado) {
        sessionStorage.removeItem(CHAVE_AVISOS_DA_CRIACAO(id));
        const lista = JSON.parse(guardado) as unknown;
        if (Array.isArray(lista)) setAvisosDaCriacao(lista.map(String));
      }
    } catch {
      // Armazenamento bloqueado: a ficha abre sem os avisos, e nada quebra.
    }
  }, [id]);

  const carregar = useCallback(async () => {
    if (!id) return;
    try {
      const p = await coreApi.getProduct(id);
      setProduto(p);
      const lido: Form = {
        name: p.name ?? '',
        description: (p as unknown as { description?: string }).description ?? '',
        internalCode: p.internal_code ?? '',
        sku: p.sku ?? '',
        barcode: p.barcode ?? '',
        brand: p.brand ?? '',
        category: p.category ?? '',
        subcategory: (p as unknown as { subcategory?: string }).subcategory ?? '',
        weightGrams: numeroOuVazio((p as unknown as Record<string, unknown>).weight_grams),
        heightCm: numeroOuVazio((p as unknown as Record<string, unknown>).height_cm),
        widthCm: numeroOuVazio((p as unknown as Record<string, unknown>).width_cm),
        lengthCm: numeroOuVazio((p as unknown as Record<string, unknown>).length_cm),
        unit: p.unit ?? 'UN',
        active: p.active !== 0,
        cost: reais(p.cost_cents),
        price: reais(p.price_cents),
        minStock: String(p.min_stock ?? 0),
        ncm: (p as unknown as { ncm?: string }).ncm ?? '',
        cest: (p as unknown as { cest?: string }).cest ?? '',
        cfop: (p as unknown as { cfop?: string }).cfop ?? '',
        origin: (p as unknown as { origin?: string }).origin ?? '',
        taxProfile: (p as unknown as { tax_profile?: string }).tax_profile ?? '',
        publishOnline: (p as unknown as { publish_online?: number }).publish_online === 1,
        onlineDescription: (p as unknown as { online_description?: string }).online_description ?? '',
        kind: (p as unknown as { kind?: string }).kind ?? 'retail',
        workshopId: (p as unknown as { workshop_id?: string }).workshop_id ?? '',
        supplierId: (p as unknown as { supplier_id?: string }).supplier_id ?? '',
        reference: (p as unknown as { reference?: string }).reference ?? '',
        // Mínimo zerado no banco é "não declarado" — não vira "0,00" na tela,
        // que pareceria uma política escrita por alguém.
        minPrice: (p as unknown as { min_price_cents?: number }).min_price_cents
          ? reais((p as unknown as { min_price_cents: number }).min_price_cents)
          : '',
        minMarkup: numeroOuVazio((p as unknown as Record<string, unknown>).min_markup_percent),
        minMargin: numeroOuVazio((p as unknown as Record<string, unknown>).min_margin_percent),
        openPrice: (p as unknown as { open_price?: number }).open_price === 1,
        weighable: (p as unknown as { weighable?: number }).weighable === 1,
        pluCode: (p as unknown as { plu_code?: string }).plu_code ?? '',
        tareGrams: numeroOuVazio((p as unknown as { tare_grams?: number }).tare_grams),
        serialized: (p as unknown as { serialized?: number }).serialized === 1,
        // Lote e validade: coluna nova, produto antigo lê como indefinido e
        // cai em `false` — que é a verdade de todo cadastro anterior a ela.
        tracksBatches: (p as unknown as { tracks_batches?: number }).tracks_batches === 1,
        // Desmembrar vem ligado por padrão no banco; produto antigo sem a
        // coluna lê como indefinido e cai no padrão certo.
        kitExplodeOnSale:
          (p as unknown as { kit_explode_on_sale?: number }).kit_explode_on_sale !== 0,
        kitCostFromComponents:
          (p as unknown as { kit_cost_from_components?: number }).kit_cost_from_components === 1,
        // Ausente lê como CONTROLA — o que todo cadastro anterior significa, e
        // o que um banco ainda sem a coluna devolve.
        stockControl: (p as unknown as { stock_control?: number }).stock_control !== 0,
        packFactor: numeroOuVazio((p as unknown as { pack_factor?: number }).pack_factor),
        packUnit: (p as unknown as { pack_unit?: string }).pack_unit ?? '',
      };
      setForm(lido);
      // A fotografia do que foi LIDO: o Salvar compara com ela para mandar só
      // o que a pessoa mudou (A-produto-07).
      setFormLido(lido);

      // A fotografia do tipo no momento em que o produto foi lido. É contra ela
      // que o Salvar decide se houve conversão de verdade.
      setTipoGravado({
        kind: (p as unknown as { kind?: string }).kind ?? 'retail',
        workshopId: (p as unknown as { workshop_id?: string }).workshop_id ?? '',
      });
      setLoteGravado((p as unknown as { tracks_batches?: number }).tracks_batches === 1);

      const lista = await coreApi.listStock({ search: p.internal_code });
      setEstoque(lista.find((s) => s.product_id === p.id) ?? null);

      // Códigos adicionais e composição do kit. Falha aqui não derruba o
      // cadastro: são seções da tela, não o produto.
      await Promise.all([
        coreApi
          .listProductBarcodes(String(p.id))
          .then((r) => setCodigosExtras(r.barcodes))
          .catch(() => setCodigosExtras([])),
        coreApi
          .getKit(String(p.id))
          .then((r) => {
            setKitComponentes(r.components);
            setKitCusto(r.costCents);
          })
          .catch(() => setKitComponentes([])),
        // Faixas, campos próprios e trilha entram na MESMA fila tolerante: são
        // seções da tela, e nenhuma delas pode impedir de corrigir o preço de
        // um produto se a rota dela falhar.
        coreApi
          .listPriceTiers(String(p.id))
          .then(setFaixas)
          .catch(() => setFaixas([])),
        coreApi
          .listProductCustomFields(String(p.id))
          .then((lista) => {
            setPersonalizados(lista);
            setPersonalizadosLidos(
              Object.fromEntries(lista.map((c) => [c.code, c.value ?? ''])),
            );
          })
          .catch(() => {
            setPersonalizados([]);
            setPersonalizadosLidos({});
          }),
        coreApi
          .productHistory(String(p.id))
          .then(setHistorico)
          .catch(() => setHistorico([])),
      ]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar o produto.');
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * As quatro medidas estão preenchidas?
   *
   * Derivado, nunca gravado: um segundo campo "pronto para envio" ficaria
   * desatualizado no primeiro cadastro corrigido.
   */
  const envioCompleto = [form.weightGrams, form.heightCm, form.widthCm, form.lengthCm].every(
    (v) => v.trim() !== '' && Number(v) > 0,
  );

  /** Preço promocional vigente, quando houver — vem calculado do servidor. */
  const promocao = useMemo(() => {
    const p = produto as unknown as { on_sale?: boolean; effective_price_cents?: number } | null;
    return p?.on_sale ? (p.effective_price_cents ?? null) : null;
  }, [produto]);

  /**
   * Markup e margem, calculados enquanto se digita.
   *
   * MARKUP é sobre o CUSTO — quanto se soma em cima do que se pagou.
   * MARGEM é sobre o PREÇO — quanto do que entra sobra.
   * Custo 100 e preço 150 dão markup de 50% e margem de 33,33%. Trocar um pelo
   * outro é como se precifica achando que ganha mais do que ganha, e por isso
   * os dois aparecem lado a lado em vez de um só.
   *
   * Nenhum dos dois é salvo: derivam de custo e preço, e uma cópia gravada
   * divergiria no primeiro reajuste.
   *
   * A conta aqui é de EXIBIÇÃO. Quando se digita um markup e se pede o preço,
   * quem calcula é o servidor (`pricingPreview`) — ali o resultado vira valor
   * salvo, e valor salvo tem uma implementação só.
   */
  const custoCents = centavos(form.cost);
  const precoCents = centavos(form.price);

  /**
   * O que a pessoa está digitando nos campos de percentual.
   *
   * `null` = ninguém está editando, então o campo mostra o valor calculado.
   * Sem isto, cada tecla seria sobrescrita pelo recálculo e ficaria impossível
   * digitar "33,33" — o campo voltaria ao valor antigo no primeiro dígito.
   */
  const [markupDigitado, setMarkupDigitado] = useState<string | null>(null);
  const [margemDigitada, setMargemDigitada] = useState<string | null>(null);

  const margem = useMemo(() => {
    if (custoCents <= 0 || precoCents <= 0) return null;
    return ((precoCents - custoCents) / precoCents) * 100;
  }, [custoCents, precoCents]);

  const markup = useMemo(() => {
    if (custoCents <= 0) return null;
    return ((precoCents - custoCents) / custoCents) * 100;
  }, [custoCents, precoCents]);

  /**
   * O que está abaixo do mínimo declarado — com o motivo, não só um alerta.
   * A mesma conta que o Salvar usa para pedir confirmação (A-produto-17).
   */
  const violacoes = useMemo(() => violacoesDoPiso(form, precoCents), [form, precoCents]);

  /**
   * Pede ao servidor o preço que produz o markup ou a margem digitados.
   *
   * A ida ao servidor é deliberada: o número que volta é o que vai ser salvo.
   * A promessa fica guardada em `precoEmCalculo` até responder (A-produto-16):
   * o clique em Salvar logo depois do blur espera por ela, e grava o preço que
   * a pessoa pediu — e não o antigo, que o formulário ainda mostrava.
   */
  const calcularPrecoPor = useCallback(
    (base: 'markup' | 'margem', valor: string): Promise<string | null> => {
      const numero = Number(valor.replace(',', '.'));
      if (!Number.isFinite(numero)) return Promise.resolve(null);
      const pedido = (async (): Promise<string | null> => {
        try {
          const r = await coreApi.pricingPreview({
            costCents: custoCents,
            ...(base === 'markup' ? { markupPercent: numero } : { marginPercent: numero }),
          });
          const preco = (r.priceCents / 100).toFixed(2);
          setForm((atual) => ({ ...atual, price: preco }));
          setError(null);
          return preco;
        } catch (err) {
          setError(err instanceof ApiRequestError ? err.message : 'Não foi possível calcular o preço.');
          return null;
        } finally {
          // Respondida, deixa de ser pendente: um preço digitado DEPOIS à mão
          // não pode ser sobrescrito por um cálculo antigo.
          if (precoEmCalculo.current === pedido) precoEmCalculo.current = null;
        }
      })();
      precoEmCalculo.current = pedido;
      return pedido;
    },
    [custoCents],
  );

  /**
   * Acrescenta um código adicional.
   *
   * Produto novo não tem id, então o código espera em fila e sobe no Salvar —
   * mesmo caminho das fotos. Produto salvo grava na hora, porque o servidor
   * precisa recusar código que já pertence a outro produto ANTES de a pessoa
   * digitar os próximos.
   */
  const acrescentarCodigo = useCallback(async () => {
    const codigo = novoCodigo.trim();
    if (!codigo) return;
    setError(null);

    if (!editando) {
      setCodigosPendentes((atual) => (atual.includes(codigo) ? atual : [...atual, codigo]));
      setNovoCodigo('');
      return;
    }

    try {
      const r = await coreApi.addProductBarcode(String(id), codigo);
      setCodigosExtras(r.barcodes);
      setNovoCodigo('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Falha ao acrescentar o código.',
      );
    }
  }, [novoCodigo, editando, id]);

  /**
   * Acrescenta (ou corrige) uma faixa de preço por quantidade — GAP-V04.
   *
   * Grava NA HORA, e não no Salvar do cadastro, pelo mesmo motivo do código de
   * barras adicional: o servidor precisa recusar a faixa incoerente (mais cara
   * que o preço de venda, a partir de 1, preço zero) ANTES de a pessoa digitar
   * a próxima. Guardar três faixas e descobrir no Salvar que a segunda é
   * inválida faria perder as três.
   */
  const acrescentarFaixa = useCallback(async () => {
    if (!id) return;
    const quantidade = Number(novaFaixa.quantidade);
    const precoCents = parseReaisToCents(novaFaixa.preco);
    if (!Number.isFinite(quantidade) || quantidade <= 1 || precoCents === null) {
      setError('Informe a quantidade mínima (a partir de 2) e o preço da faixa.');
      return;
    }
    setError(null);
    try {
      setFaixas(await coreApi.savePriceTier(id, quantidade, precoCents));
      setNovaFaixa({ quantidade: '', preco: '' });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar a faixa.');
    }
  }, [id, novaFaixa]);

  const removerFaixa = useCallback(
    async (minQuantity: number) => {
      if (!id) return;
      setError(null);
      try {
        setFaixas(await coreApi.removePriceTier(id, minQuantity));
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao remover a faixa.');
      }
    },
    [id],
  );

  /**
   * Grava a composição do kit inteira.
   *
   * O servidor SUBSTITUI a lista, não acumula — então a tela manda o estado
   * completo. Acumular faria peça removida na tela reaparecer no banco.
   */
  const salvarKit = useCallback(
    async (componentes: { componentId: string; quantity: number }[]) => {
      if (!id) return;
      setError(null);
      try {
        const r = await coreApi.setKit(id, componentes);
        setKitComponentes(r.components);
        setKitCusto(r.costCents);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar o kit.');
      }
    },
    [id],
  );

  /**
   * O TIPO NÃO VIAJA MAIS NO PUT — ele tem rota própria.
   *
   * O formulário oferecia "Peça de oficina" e a oficina dona desde sempre, e o
   * salvamento os descartava em silêncio: o mapa de campos de `atualizarProduto`
   * não incluía `kind` nem `workshop_id`, o PUT devolvia 200 e nada mudava. No
   * banco real, dezenove produtos, todos revenda, nenhum com oficina.
   *
   * Ligar o PUT resolveria a gravação e mentiria sobre o resto: trocar o tipo
   * TIRA o produto da vitrine, TIRA o destaque e muda de lado o saldo que a
   * loja contava como mercadoria. `POST /products/:id/tipo` é a única rota que
   * devolve essa conta (`efeitos`), e é por isso que a conversão passa por ela
   * e não por um campo a mais no corpo do PUT.
   *
   * Só chama quando MUDOU. Converter para o que já é geraria auditoria de uma
   * decisão que ninguém tomou.
   */
  const converterTipoSeMudou = useCallback(
    async (productId: string): Promise<void> => {
      const alvo = form.kind === 'part' ? 'part' : 'retail';
      const oficinaAlvo = alvo === 'part' ? form.workshopId : '';
      if (alvo === tipoGravado.kind && oficinaAlvo === tipoGravado.workshopId) return;

      // A recusa do servidor é a mesma frase que a tela precisaria escrever
      // ("peça sem oficina não aparece em lugar nenhum"), então ela sobe
      // inteira em vez de virar uma segunda versão aqui.
      const r = await coreApi.definirTipoProduto(productId, {
        kind: alvo,
        workshopId: alvo === 'part' ? form.workshopId || null : null,
      });
      setEfeitosDoTipo(r);
      setTipoGravado({ kind: r.kind, workshopId: r.workshopId ?? '' });
    },
    [form.kind, form.workshopId, tipoGravado],
  );

  /**
   * LIGA OU DESLIGA O CONTROLE DE LOTE — por rota própria, e só se mudou.
   *
   * `tracksBatches` NÃO viaja no corpo do produto de propósito. O módulo de
   * lote é dono do próprio interruptor e das próprias recusas — serializado
   * (já tem identidade por peça), serviço sem estoque (não há movimento para
   * carregar lote) e modelo de grade (quem tem saldo é a variante) —, e essas
   * recusas não pertencem ao cadastro geral. É o mesmo desenho da conversão de
   * tipo logo acima e do kit: fatos com regra própria têm porta própria.
   *
   * Vem DEPOIS do PUT pela mesma razão da conversão: o servidor decide sobre o
   * estado FINAL do produto — se esta gravação acabou de marcar "controlado por
   * unidade", a recusa é sobre o que a pessoa vai ter, não sobre um estado
   * intermediário que existiu por meio segundo.
   */
  const ajustarControleDeLote = useCallback(
    async (productId: string): Promise<void> => {
      if (form.tracksBatches === loteGravado) return;
      await coreApi.setBatchControl(productId, form.tracksBatches);
      setLoteGravado(form.tracksBatches);
    },
    [form.tracksBatches, loteGravado],
  );

  /*
    A pergunta da casa (sem `window.confirm`). Mora ANTES do Salvar porque ele
    também pergunta: trocar o EAN principal e gravar preço abaixo do piso.
  */
  const { confirmar, dialogoDeConfirmacao } = useConfirmar();

  /** O 409 de concorrência mostra a saída: recarregar o produto (A-produto-07). */
  const [desatualizado, setDesatualizado] = useState(false);

  const salvar = useCallback(async () => {
    if (!form.name.trim()) {
      setError('O nome do produto é obrigatório.');
      setSecao('geral');
      return;
    }
    // Recusa antes de gravar metade: peça sem bancada dona some do sistema —
    // não aparece na tela de peças nem na vitrine.
    if (form.kind === 'part' && !form.workshopId) {
      setError('Peça precisa de uma oficina dona. Sem bancada, ela não aparece em lugar nenhum.');
      setSecao('geral');
      return;
    }
    // "2,5" é dois e meio; "dois" não é número (A-produto-19). Antes o NaN
    // virava zero calado e o alerta de estoque baixo nunca disparava.
    if (Number.isNaN(quantidadeDigitada(form.minStock))) {
      setError('Estoque mínimo inválido: digite um número, como 2 ou 2,5.');
      setSecao('estoque');
      return;
    }
    /*
      PISO ILEGÍVEL NÃO VIRA "SEM PISO" (revisão do A-produto-03). Na edição,
      vazio/nulo passou a LIMPAR o piso; um "trinta" ou "25,00 reais" digitado
      virava NaN (JSON `null`) ou zero e apagava a política em silêncio.
      Recusa aqui, dizendo o campo e o formato.
    */
    const pisoIlegivel = [
      form.minPrice.trim() && parseReaisToCents(form.minPrice) === null
        ? 'Preço mínimo inválido: digite o valor em reais, como 25,00.'
        : null,
      Number.isNaN(percentualDigitado(form.minMarkup))
        ? 'Markup mínimo inválido: digite um número, como 30 ou 33,33.'
        : null,
      Number.isNaN(percentualDigitado(form.minMargin))
        ? 'Margem mínima inválida: digite um número, como 20 ou 22,5.'
        : null,
    ].find((m): m is string => Boolean(m));
    if (pisoIlegivel) {
      setError(pisoIlegivel);
      setSecao('precos');
      return;
    }
    setBusy(true);
    setError(null);
    setDesatualizado(false);
    try {
      /*
        O PREÇO QUE AINDA ESTÁ SENDO CALCULADO (A-produto-16): quem digita a
        margem e clica direto em Salvar dispara o blur e o clique juntos. O PUT
        esperava nada e levava o preço antigo; agora espera o cálculo e grava o
        preço que a pessoa pediu.
      */
      let precoTexto = form.price;
      const emCalculo = precoEmCalculo.current;
      if (emCalculo) {
        const calculado = await emCalculo;
        if (calculado !== null) precoTexto = calculado;
      }
      const formFinal: Form = { ...form, price: precoTexto };
      const payload = montarCorpo(formFinal);

      /*
        PREÇO ABAIXO DO PISO PEDE CONFIRMAÇÃO (A-produto-17). A tela diz "abaixo
        disto o produto não deve ser vendido", e o Salvar gravava o preço de
        tabela abaixo do piso só com um aviso amarelo. Vale na edição e no
        cadastro NOVO (a revisão achou a pergunta só na edição: o produto novo
        nascia abaixo do piso sem pergunta nenhuma). Devolve se pode seguir.
      */
      const abaixoDoPiso = violacoesDoPiso(formFinal, centavos(precoTexto));
      const podeGravarAbaixoDoPiso = async (): Promise<boolean> => {
        if (abaixoDoPiso.length === 0) return true;
        return confirmar({
          titulo: 'Preço abaixo do piso',
          mensagem: (
            <>
              <p className="m-0">O preço que vai ser gravado viola o piso deste produto:</p>
              <ul className="list-disc pl-5 mt-1 mb-0">
                {abaixoDoPiso.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              <p className="mt-2 mb-0 text-[var(--gs-text-soft)]">
                Grave só se a decisão for sua: o PDV passa a vender por este preço.
              </p>
            </>
          ),
          confirmar: 'Salvar mesmo assim',
        });
      };

      if (editando && id) {
        const lido = montarCorpo(formLido);
        const { corpo, expected } = oQueMudou(lido, payload);

        // Na edição, só pergunta quando a pessoa MEXEU na precificação: corrigir
        // a descrição de um produto que já estava abaixo não é decisão nova
        // sobre preço.
        const mexeuNoPreco = [
          'priceCents',
          'costCents',
          'minPriceCents',
          'minMarkupPercent',
          'minMarginPercent',
        ].some((chave) => chave in corpo);
        if (mexeuNoPreco && !(await podeGravarAbaixoDoPiso())) return;

        /*
          TROCAR O EAN PRINCIPAL PERGUNTA ANTES (A-produto-08). O servidor guarda
          o antigo como adicional — as etiquetas já coladas continuam bipando —,
          e a frase diz isso, para quem sobrescreveu por engano poder desistir.
        */
        const eanLido = String(lido.barcode ?? '');
        const eanNovo = String(payload.barcode ?? '');
        const trocouOEan = 'barcode' in corpo && eanLido !== '' && eanNovo !== '' && eanNovo !== eanLido;
        if (trocouOEan) {
          const segue = await confirmar({
            titulo: 'Trocar o código de barras principal',
            mensagem: (
              <>
                <p className="m-0">
                  O principal passa de <strong>{eanLido}</strong> para <strong>{eanNovo}</strong>.
                </p>
                <p className="mt-2 mb-0 text-[var(--gs-text-soft)]">
                  O código antigo continua valendo como adicional, para as etiquetas já coladas
                  continuarem bipando. Se ele estava errado, remova-o depois na aba Códigos.
                </p>
              </>
            ),
            confirmar: 'Trocar o código',
          });
          if (!segue) return;
        }

        // Só o que MUDOU, com o que a tela viu (A-produto-07). Sem mudança
        // nenhuma o PUT vai vazio — "salvar sem mexer" é resposta legítima.
        await coreApi.updateProduct(
          id,
          Object.keys(corpo).length > 0 ? { ...corpo, expected } : {},
        );
        /*
          A CONVERSÃO VEM DEPOIS DO PUT, e a ordem importa.

          O PUT pode estar ligando "pesável" ou dando PLU, e peça não pode ser
          nem uma coisa nem outra. Convertendo depois, o invariante do servidor
          decide sobre o estado FINAL do produto — que é o que a pessoa vai ter
          — e não sobre um estado intermediário que existiu por meio segundo.
        */
        // A frase do servidor NÃO se repete aqui: ela é o subtítulo do cartão de
        // efeitos logo abaixo. Dizer a mesma coisa em dois lugares faz a pessoa
        // procurar a diferença entre as duas versões.
        await converterTipoSeMudou(id);
        await ajustarControleDeLote(id);
        /*
          OS CAMPOS PRÓPRIOS VÃO NO MESMO SALVAR (GAP-V07), e não num botão
          separado.

          Eles são atributos do produto como qualquer outro: obrigar um segundo
          gesto faria a voltagem digitada se perder no primeiro Salvar, sem
          nenhum aviso. A rota é outra porque a tabela é outra — isso é detalhe
          do servidor, e não deve virar detalhe de quem cadastra.

          Só o que ESTA tela conhece é enviado: o mapa sai da lista carregada,
          então um campo criado por outra pessoa enquanto o formulário estava
          aberto não é apagado por omissão.
        */
        /*
          Só o campo próprio que MUDOU (A-produto-18). Mandar o mapa inteiro a
          cada Salvar gravava uma entrada no Histórico por salvar — ruído no
          meio de "quem mudou o preço".
        */
        const camposMudados = personalizados.filter(
          (c) => (c.value ?? '') !== (personalizadosLidos[c.code] ?? ''),
        );
        if (camposMudados.length > 0) {
          setPersonalizados(
            await coreApi.saveProductCustomFields(
              id,
              Object.fromEntries(camposMudados.map((c) => [c.code, c.value ?? ''])),
            ),
          );
        }
        setMessage(
          trocouOEan
            ? `Produto atualizado. O código antigo ${eanLido} continua valendo como adicional.`
            : 'Produto atualizado.',
        );
        await carregar();
      } else {
        // O POST já aconteceu e o redirecionamento ainda não: um segundo clique
        // não cria outro produto, só leva à ficha do que nasceu.
        if (criadoAgora.current) {
          window.location.href = `/sistema/produtos/${criadoAgora.current}`;
          return;
        }
        // O produto novo também não nasce abaixo do piso sem a pessoa dizer que
        // é decisão dela (A-produto-17, completado na revisão).
        if (!(await podeGravarAbaixoDoPiso())) return;
        // No cadastro NOVO o tipo vai no corpo mesmo: `createProduct` passa
        // pelo mesmo invariante, e não existe conversão a relatar — nada foi
        // despublicado nem mudou de gaveta, porque o produto acabou de nascer.
        const criado = await coreApi.createProduct({
          ...payload,
          kind: form.kind,
          workshopId: form.kind === 'part' ? form.workshopId || null : null,
          // Código em branco = a loja gera. Código informado é respeitado e
          // nunca sobrescrito.
          internalCode: form.internalCode.trim() || undefined,
          /*
            OS CÓDIGOS ADICIONAIS VÃO NO MESMO POST (A-produto-01). Subiam um a
            um DEPOIS da criação: um recusado (já pertence a outro produto)
            deixava o produto criado e a tela em "Novo" — e o Salvar seguinte
            criava o item de novo. Agora o servidor confere tudo na mesma
            transação: ou nasce com os códigos, ou não nasce.
          */
          extraBarcodes: codigosPendentes,
        });
        const novoId = String(criado.id);
        criadoAgora.current = novoId;

        /*
          DAQUI EM DIANTE O PRODUTO JÁ EXISTE (A-produto-01). Cada passo que
          falhar vira AVISO na ficha dele, e a tela vai para a ficha de qualquer
          jeito — nunca volta ao "Novo", que é onde nascia o duplicado.
        */
        const avisos: string[] = [];
        const motivo = (err: unknown) =>
          err instanceof ApiRequestError ? err.message : 'falha de comunicação';

        // As fotos escolhidas antes de salvar sobem agora. Sem isto, quem
        // cadastra um produto novo escolheria a foto e ela sumiria — o
        // produto ainda não existia quando o arquivo foi selecionado.
        for (const foto of fotosPendentes) {
          try {
            await coreApi.addProductImage(novoId, {
              dataUrl: foto.dataUrl,
              fileName: foto.fileName,
              mimeType: foto.mimeType,
              thumbDataUrl: foto.thumbDataUrl ?? null,
            });
          } catch (err) {
            avisos.push(`A foto "${foto.fileName}" não subiu (${motivo(err)}). Envie de novo na aba Fotos.`);
          }
        }

        // O interruptor de lote tem rota própria e precisa de um produto que já
        // exista para apontar.
        try {
          await ajustarControleDeLote(novoId);
        } catch (err) {
          avisos.push(
            `O controle de lote e validade não foi ligado (${motivo(err)}). Marque de novo em Preços › "Controla lote e validade" e salve.`,
          );
        }

        // Pediu código de barras interno e não digitou um do fabricante: gera agora,
        // com o produto existindo. Quem já tem EAN fica com o dele.
        if (gerarBarrasAoSalvar && !form.barcode.trim()) {
          try {
            await coreApi.generateInternalBarcode(novoId);
          } catch (err) {
            avisos.push(
              `O código de barras interno não foi gerado (${motivo(err)}). Use "Gerar código de barras" em Dados gerais.`,
            );
          }
        }

        if (avisos.length > 0) {
          try {
            sessionStorage.setItem(CHAVE_AVISOS_DA_CRIACAO(novoId), JSON.stringify(avisos));
          } catch {
            // Sem armazenamento, os avisos aparecem aqui mesmo antes de sair.
            setAvisosDaCriacao(avisos);
          }
        }
        setMessage(`Produto ${criado.internal_code} criado.`);
        window.location.href = `/sistema/produtos/${novoId}`;
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CORE_PRODUCT_STALE') {
        setDesatualizado(true);
      }
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
    // `codigosPendentes` entra aqui porque o Salvar o LÊ. Sem a dependência, a
    // função guardaria a lista de quando foi criada e subiria os códigos de
    // uma digitação anterior — ou nenhum.
  }, [
    form,
    formLido,
    gerarBarrasAoSalvar,
    editando,
    id,
    carregar,
    fotosPendentes,
    codigosPendentes,
    converterTipoSeMudou,
    ajustarControleDeLote,
    confirmar,
    // Mesma razão de `codigosPendentes`: o Salvar LÊ os campos próprios para
    // montar o mapa. Sem a dependência, ele enviaria o que estava na tela
    // quando a função foi criada — os valores antigos, por cima dos digitados.
    personalizados,
    personalizadosLidos,
  ]);

  /*
    EXCLUIR — SÓ O QUE NUNCA ACONTECEU.

    O servidor apaga o produto sem histórico e responde 409
    `CORE_PRODUCT_HAS_HISTORY` quando ele já foi vendido, comprado, movimentado
    ou usado em documento. O 409 não vira erro vermelho: vira o porquê, com a
    contagem, e a saída — inativar (arquivar), pelo mesmo PUT do cadastro.
    O botão é de quem responde pelo catálogo, o mesmo alcance do servidor.
  */
  const podeExcluir = useCan('products.catalog.admin');
  const [historicoQuePrende, setHistoricoQuePrende] = useState<{
    motivos: string[];
    mensagem: string;
    ativo: boolean;
  } | null>(null);

  const excluir = useCallback(async () => {
    if (!id) return;
    const ok = await confirmar({
      titulo: 'Excluir produto',
      mensagem: (
        <>
          <p className="m-0">
            Excluir <strong>{form.name || 'este produto'}</strong> de vez, com códigos, fotos, preços e
            variantes?
          </p>
          <p className="mt-2 mb-0 text-[var(--gs-text-soft)]">
            Só sai do sistema o produto que nunca foi vendido, comprado, movimentado nem usado em
            documento. Se ele já tiver histórico, a exclusão é recusada e você pode inativá-lo
            (arquivar).
          </p>
        </>
      ),
      confirmar: 'Excluir definitivamente',
      perigoso: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setHistoricoQuePrende(null);
    try {
      await coreApi.deleteProduct(id);
      window.location.href = '/sistema/produtos';
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CORE_PRODUCT_HAS_HISTORY') {
        const detalhes = (err.details ?? {}) as {
          historico?: { rotulo?: string }[];
          ativo?: boolean;
        };
        setHistoricoQuePrende({
          motivos: (detalhes.historico ?? []).map((h) => String(h.rotulo ?? '')).filter(Boolean),
          mensagem: err.message,
          ativo: detalhes.ativo !== false,
        });
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao excluir o produto.');
      }
    } finally {
      setBusy(false);
    }
  }, [id, confirmar, form.name]);

  const inativar = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      // Só `active`: o PUT preserva todo campo ausente, e o formulário aberto
      // pode ter alterações que a pessoa ainda não decidiu salvar.
      await coreApi.updateProduct(id, { active: false });
      setHistoricoQuePrende(null);
      setMessage(
        'Produto inativado (arquivado): saiu do PDV, da busca e da loja online. O histórico continua de pé, e ele pode ser reativado marcando "Produto ativo".',
      );
      await carregar();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao inativar o produto.');
    } finally {
      setBusy(false);
    }
  }, [id, carregar]);

  /*
    DEPOIS DE IMPRIMIR, O FORMULÁRIO RELÊ O CÓDIGO DE BARRAS (A-produto-25).

    A impressão da etiqueta grava um EAN interno em quem não tinha
    (`ensureBarcode`), e o formulário continuava dizendo "não informado" na aba
    Códigos — a pessoa concluía que a etiqueta saiu sem código, ou clicava em
    "Gerar código de barras" achando que faltava. Ao sair da aba Etiqueta, o
    código gravado volta para a tela. Só o código: o resto do que a pessoa já
    digitou e ainda não salvou fica onde está. E só se ela não tiver digitado
    outro código nesse meio-tempo.
  */
  const releCodigoDeBarras = useCallback(async () => {
    if (!id) return;
    try {
      const p = await coreApi.getProduct(id);
      setProduto(p);
      const gravado = p.barcode ?? '';
      setFormLido((lido) => {
        if (lido.barcode === gravado) return lido;
        setForm((atual) => (atual.barcode === lido.barcode ? { ...atual, barcode: gravado } : atual));
        return { ...lido, barcode: gravado };
      });
    } catch {
      // Sem resposta, a tela fica como estava: nada foi perdido.
    }
  }, [id]);

  return (
    <AppShell>
      {dialogoDeConfirmacao}
      <PageHeader
        breadcrumb={['Produtos', editando ? form.name || 'Produto' : 'Novo produto']}
        title={editando ? form.name || 'Produto' : 'Novo produto'}
        subtitle={
          produto
            ? `Código ${produto.internal_code}${produto.barcode ? ` · EAN ${produto.barcode}` : ''}`
            : 'O código interno é gerado automaticamente quando deixado em branco.'
        }
        actions={
          <div className="flex gap-2">
            {editando && podeExcluir && (
              <Button variant="ghost" disabled={busy} onClick={() => void excluir()}>
                Excluir
              </Button>
            )}
            <Button loading={busy} onClick={() => void salvar()}>Salvar</Button>
          </div>
        }
      />

      {historicoQuePrende && (
        <div
          data-testid="produto-tem-historico"
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-text)]"
        >
          <strong className="block">
            {historicoQuePrende.motivos.length > 0
              ? `Este produto não pode ser excluído porque já tem histórico: ${historicoQuePrende.motivos.join(', ')}.`
              : historicoQuePrende.mensagem}
          </strong>
          <span className="block mt-1 text-[length:var(--gs-text-sm)]">
            Excluir apagaria vendas, notas e movimentos que já aconteceram. Para tirá-lo de uso sem
            perder nada, inative (arquive): ele sai do PDV, da busca e da loja online, e continua
            aparecendo nas vendas e documentos antigos.
          </span>
          <div className="flex gap-2 mt-3">
            {historicoQuePrende.ativo ? (
              <Button disabled={busy} onClick={() => void inativar()}>
                Inativar (arquivar)
              </Button>
            ) : (
              <span className="text-[length:var(--gs-text-sm)] font-semibold">
                Ele já está inativo (arquivado).
              </span>
            )}
            <Button variant="ghost" onClick={() => setHistoricoQuePrende(null)}>
              Fechar
            </Button>
          </div>
        </div>
      )}

      {message && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {message}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
          {/* O 409 de concorrência (A-produto-07) diz o que houve; a saída é
              ver o valor que a outra pessoa gravou antes de refazer a mudança. */}
          {desatualizado && (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDesatualizado(false);
                  setError(null);
                  void carregar();
                }}
              >
                Recarregar o produto
              </Button>
            </div>
          )}
        </div>
      )}
      {/* O QUE FICOU PENDENTE DEPOIS DE O PRODUTO NASCER (A-produto-01): foto,
          lote, EAN interno. O produto existe; isto é aviso, e a saída está
          escrita em cada linha. */}
      {avisosDaCriacao.length > 0 && (
        <div
          role="alert"
          data-testid="avisos-da-criacao"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-text)]"
        >
          <strong className="block">Produto criado, mas algo ficou pendente:</strong>
          <ul className="list-disc pl-5 mt-1 mb-2 text-[length:var(--gs-text-sm)]">
            {avisosDaCriacao.map((aviso) => (
              <li key={aviso}>{aviso}</li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => setAvisosDaCriacao([])}>
            Entendi
          </Button>
        </div>
      )}

      {/*
        O QUE A TROCA DE TIPO FEZ.

        Fica FORA das seções, e no topo: a conversão mexe na vitrine, no
        destaque e em qual tela conta o saldo — três coisas que moram em abas
        diferentes deste mesmo formulário. Escondê-la dentro de "Dados gerais"
        faria a pessoa descobrir o efeito na aba errada, ou nunca.
      */}
      {efeitosDoTipo && (
        <Card
          title={
            efeitosDoTipo.kind === 'part'
              ? `Agora é peça de ${efeitosDoTipo.workshopName ?? 'oficina'}`
              : 'Agora é mercadoria de revenda'
          }
          subtitle={efeitosDoTipo.aviso ?? undefined}
          className="mb-5"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setEfeitosDoTipo(null)}>
              Entendi
            </Button>
          }
        >
          <ul className="list-disc pl-5 m-0 flex flex-col gap-1.5 text-[length:var(--gs-text-sm)]">
            {efeitosDoTipo.efeitos.despublicadoDaLoja && (
              <li>Saiu da vitrine: peça de bancada não é vendida ao consumidor.</li>
            )}
            {efeitosDoTipo.efeitos.destaqueRemovido && (
              <li>Saiu da régua de destaques da página inicial da loja.</li>
            )}
            {efeitosDoTipo.efeitos.saldoQueMudaDeLado > 0 && (
              // NÃO é movimento de estoque: nada entrou e nada saiu do razão. O
              // que muda é QUEM conta o mesmo saldo.
              <li>
                {efeitosDoTipo.kind === 'part'
                  ? `${formatQuantity(efeitosDoTipo.efeitos.saldoQueMudaDeLado)} em estoque passam a ser contadas na gaveta da bancada, e somem da busca do PDV.`
                  : `${formatQuantity(efeitosDoTipo.efeitos.saldoQueMudaDeLado)} em estoque voltam a contar como mercadoria da loja e aparecem na busca do PDV.`}{' '}
                Nada entrou nem saiu do estoque: mudou quem conta.
                {/*
                  O NÚMERO ACIMA É BRUTO, e sozinho ele promete demais.

                  Reservado é promessa de outro compromisso, e o lançamento da
                  peça na OS cobra o DISPONÍVEL — bruto menos reservado. Sem
                  esta frase, quem converte lê "12 na gaveta" e o mecânico
                  descobre que só há 4 com o aparelho aberto na bancada. As três
                  origens são nomeadas juntas porque culpar só o pedido online
                  descreveria o estado errado em dois dos três casos.
                */}
                {efeitosDoTipo.efeitos.reservadoEmAberto > 0 && (
                  <>
                    {' '}
                    <strong>
                      {formatQuantity(efeitosDoTipo.efeitos.reservadoEmAberto)} desse total já está
                      reservada
                    </strong>{' '}
                    para compromisso assumido (pedido da loja, orçamento ou contrato de locação):
                    esse pedaço não fica livre para a bancada usar.
                  </>
                )}
              </li>
            )}
            {efeitosDoTipo.efeitos.vendasAnteriores > 0 && (
              <li>
                Este item já saiu em {efeitosDoTipo.efeitos.vendasAnteriores} venda(s) de balcão. O
                histórico continua onde está.
              </li>
            )}
            {efeitosDoTipo.efeitos.semPrecoDeVenda && (
              // A ponta mais cara da corrente: produto criado pela importação
              // de XML nasce com preço zero de propósito.
              <li className="text-[var(--gs-danger)] font-semibold">
                Sem preço de venda. O lançamento desta peça numa OS vai ser RECUSADO até alguém
                definir o preço — senão ela entraria no conserto por R$ 0,00.
              </li>
            )}
            {efeitosDoTipo.kind === 'retail' && (
              <li>
                Volta ao catálogo despublicado. Republicar é um clique de quem cuida da loja, e não
                herança de antes.
              </li>
            )}
          </ul>
        </Card>
      )}

      {/* Abas das seções. Estoque, e-commerce e variantes só fazem sentido
          depois que o produto existe — antes disso não há o que mostrar. */}
      {/* Aba cinza sem explicação faz o usuário achar que o sistema quebrou.
          O motivo fica escrito, não só no title do botão. */}
      {!editando && (
        <p className="mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Estoque e Variantes abrem depois de salvar o produto. As fotos podem ser escolhidas
          agora — elas sobem junto.
        </p>
      )}

      <div className="flex gap-2 mb-6 flex-wrap" role="tablist" aria-label="Seções do cadastro">
        {SECOES.map((s) => {
          // Estoque e grade dependem de um produto que já exista. Fotos, não:
          // elas ficam em fila e sobem no Salvar.
          const bloqueada = !editando && ['estoque', 'variantes', 'etiqueta'].includes(s.id);
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={secao === s.id}
              disabled={bloqueada}
              title={bloqueada ? 'Salve o produto para liberar esta seção' : undefined}
              onClick={() => {
                // Saindo da Etiqueta: a impressão pode ter gravado um EAN
                // interno, e o formulário precisa mostrá-lo (A-produto-25).
                if (secao === 'etiqueta' && s.id !== 'etiqueta') void releCodigoDeBarras();
                setSecao(s.id);
              }}
              className={`px-4 py-2.5 rounded-[var(--gs-radius)] border font-semibold text-[length:var(--gs-text-sm)]
                disabled:opacity-40 disabled:cursor-not-allowed
                ${
                  secao === s.id
                    ? 'bg-[var(--gs-purple-800)] text-white border-[var(--gs-purple-800)]'
                    : 'bg-[var(--gs-surface)] text-[var(--gs-text)] border-[var(--gs-border)]'
                }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {secao === 'etiqueta' && editando && id && (
        <EtiquetaDoProduto
          productId={String(id)}
          // O SALDO QUE A FICHA JÁ CARREGOU (A-produto-15). Lia
          // `produto.stock_quantity`, que o GET /products/:id não devolve (o
          // saldo vem em `listStock`): o botão "Uma por unidade em estoque"
          // nunca aparecia.
          estoque={estoque?.quantity ?? null}
          // O CÓDIGO QUE A FOLHA GEROU APARECE JÁ (C-etiquetas-16). A tela só
          // relia o produto ao SAIR da aba Etiqueta: enquanto a pessoa estava
          // nela, o cabeçalho seguia sem "EAN" e o campo "EAN / GTIN" vazio,
          // embora a etiqueta tivesse saído com barras. Relê só o código — o
          // que foi digitado e não salvo fica onde está.
          onImpresso={() => void releCodigoDeBarras()}
        />
      )}

      {secao === 'geral' && (
        <Card title="Dados gerais">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="Nome" className="md:col-span-2">
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Campo>
            <Campo label="Descrição interna" className="md:col-span-2">
              <Input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Anotação para a equipe, não aparece na vitrine"
              />
            </Campo>
            <Campo
              label="Código interno"
              hint={editando ? 'Lido e digitado no PDV; sai na etiqueta' : 'Digite o seu, clique em Gerar — ou deixe em branco e a loja gera ao salvar'}
            >
              <div className="flex gap-2">
                <Input
                  value={form.internalCode}
                  onChange={(e) => set('internalCode', e.target.value)}
                  disabled={editando}
                  aria-label="Código interno"
                />
                {!editando && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={gerandoCodigo}
                    onClick={async () => {
                      setGerandoCodigo(true);
                      try {
                        const r = await coreApi.generateInternalCode();
                        set('internalCode', r.code);
                      } catch (err) {
                        setError(err instanceof ApiRequestError ? err.message : 'Não foi possível gerar o código.');
                      } finally {
                        setGerandoCodigo(false);
                      }
                    }}
                  >
                    Gerar código
                  </Button>
                )}
              </div>
            </Campo>
            <Campo
              label="EAN / GTIN"
              hint={
                gerarBarrasAoSalvar && !form.barcode.trim()
                  ? 'Um EAN-13 de uso interno (prefixo 2) será gerado ao salvar.'
                  : 'O do fabricante, se houver. Sem ele, gere um código interno da loja.'
              }
            >
              <div className="flex gap-2">
                <Input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} aria-label="EAN / GTIN" />
                {!form.barcode.trim() && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={gerandoCodigo}
                    onClick={async () => {
                      if (!editando) {
                        setGerarBarrasAoSalvar(true);
                        return;
                      }
                      setGerandoCodigo(true);
                      try {
                        const r = await coreApi.generateInternalBarcode(String(id));
                        set('barcode', r.barcode);
                        // O código que o servidor GRAVOU passa a ser o "lido": sem
                        // isto o Salvar seguinte o mandaria como mudança da tela e
                        // levaria um 409 por uma alteração da própria pessoa.
                        setFormLido((lido) => ({ ...lido, barcode: r.barcode }));
                        // `generated` falso = o produto JÁ tinha código (a impressão
                        // de etiqueta pode tê-lo gravado): dizer "gerado" mentiria
                        // (A-produto-25).
                        setMessage(
                          r.generated
                            ? `Código de barras interno gerado: ${r.barcode}.`
                            : `Este produto já tinha código de barras: ${r.barcode}. Nada foi gerado.`,
                        );
                      } catch (err) {
                        setError(err instanceof ApiRequestError ? err.message : 'Não foi possível gerar o código de barras.');
                      } finally {
                        setGerandoCodigo(false);
                      }
                    }}
                  >
                    {gerarBarrasAoSalvar && !editando ? 'Será gerado ao salvar' : 'Gerar código de barras'}
                  </Button>
                )}
              </div>
            </Campo>
            {/* O SKU QUE A BUSCA E A ETIQUETA JÁ USAVAM (A-produto-24): a tela
                não tinha onde digitá-lo. O servidor recusa o repetido e o que
                colide com o código interno ou o EAN de outro produto — senão o
                bipe acha dois itens e nenhum entra direto no carrinho. */}
            <Campo
              label="SKU"
              hint="Código do seu catálogo. Não pode repetir o SKU, o código interno nem o EAN de outro produto"
            >
              <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} aria-label="SKU" />
            </Campo>
            <Campo label="Marca" hint="Gerida em Produtos › Categorias e marcas">
              <select
                value={form.brand}
                onChange={(e) => set('brand', e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                  text-[length:var(--gs-text-base)]"
              >
                <option value="">Sem marca</option>
                {(taxonomia?.brands ?? []).map((b) => (
                  <option key={b.id} value={b.name}>
                    {b.name}
                  </option>
                ))}
                {form.brand && !(taxonomia?.brands ?? []).some((b) => b.name === form.brand) && (
                  <option value={form.brand}>{form.brand} (fora da lista)</option>
                )}
              </select>
            </Campo>
            {/* ESCOLHA DA LISTA, não texto livre (A-produto-26): "Un", "UND" e
                "CX12" viravam três unidades que nada governava. O valor atual
                fora da lista continua visível — escondê-lo apagaria o dado
                ao salvar —, marcado para ser trocado. */}
            <Campo label="Unidade" hint="Gerida em Catálogo › Auxiliares › Unidades">
              <select
                aria-label="Unidade"
                value={form.unit}
                onChange={(e) => set('unit', e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                  text-[length:var(--gs-text-base)]"
              >
                {unidades
                  .filter((u) => u.active !== 0)
                  .map((u) => (
                    <option key={u.id} value={u.code}>
                      {u.code} · {u.name}
                    </option>
                  ))}
                {form.unit && !unidades.some((u) => u.active !== 0 && u.code === form.unit) && (
                  <option value={form.unit}>
                    {form.unit}
                    {unidades.length > 0 ? ' (fora da lista — escolha uma unidade cadastrada)' : ''}
                  </option>
                )}
              </select>
            </Campo>
            {/* Escolha da lista, não texto livre: era assim que "Masculino" e
                "masculino" viravam duas categorias e o filtro da vitrine
                passava a mostrar metade das peças em cada uma. */}
            <Campo label="Categoria" hint="Gerida em Produtos › Categorias e marcas">
              <select
                value={form.category}
                onChange={(e) => {
                  set('category', e.target.value);
                  // Trocar a categoria invalida a subcategoria anterior.
                  set('subcategory', '');
                }}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                  text-[length:var(--gs-text-base)]"
              >
                <option value="">Sem categoria</option>
                {(taxonomia?.categories ?? []).map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
                {/* O valor atual pode ter entrado antes do vocabulário existir.
                    Escondê-lo apagaria o dado do produto ao salvar. */}
                {form.category &&
                  !(taxonomia?.categories ?? []).some((c) => c.name === form.category) && (
                    <option value={form.category}>{form.category} (fora da lista)</option>
                  )}
              </select>
            </Campo>

            <Campo
              label="Subcategoria"
              hint={form.category ? undefined : 'Escolha a categoria primeiro'}
            >
              <select
                value={form.subcategory}
                disabled={!form.category}
                onChange={(e) => set('subcategory', e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                  text-[length:var(--gs-text-base)] disabled:opacity-50"
              >
                <option value="">Sem subcategoria</option>
                {subcategorias.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
                {form.subcategory && !subcategorias.some((s) => s.name === form.subcategory) && (
                  <option value={form.subcategory}>{form.subcategory} (fora da lista)</option>
                )}
              </select>
            </Campo>
            <Campo
              label="Tipo do produto"
              hint={
                editando
                  ? 'Trocar o tipo tira o produto da vitrine e muda quem conta o saldo. O que aconteceu aparece no topo, depois de salvar.'
                  : undefined
              }
            >
              <select
                value={form.kind}
                onChange={(e) => set('kind', e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                  text-[length:var(--gs-text-base)]"
              >
                <option value="retail">Mercadoria de venda</option>
                <option value="part">Peça de oficina</option>
              </select>
            </Campo>

            {/* Peça pertence a UMA oficina: é isso que separa o estoque de
                celulares do de mobilidade. */}
            {form.kind === 'part' ? (
              <Campo
                label="Oficina"
                hint={
                  oficinas.length === 0
                    ? 'Nenhuma bancada desta empresa trabalha com estoque de peças.'
                    : 'Só aparecem as bancadas que guardam peça. Sem oficina dona, a peça não aparece em lugar nenhum.'
                }
              >
                <select
                  value={form.workshopId}
                  onChange={(e) => set('workshopId', e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                    text-[length:var(--gs-text-base)]"
                >
                  <option value="">Selecione a oficina</option>
                  {oficinas.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Campo>
            ) : (
              /* O FORNECEDOR É UM CADASTRO (A-produto-10). O campo era texto
                 livre ("Código ou nome do fornecedor") e o nome digitado ia
                 para onde o sistema procura um id: a sugestão de compra e a
                 reprecificação por fornecedor não achavam vínculo nenhum. */
              <Campo label="Fornecedor" hint="Gerido em Cadastros › Fornecedores">
                <select
                  aria-label="Fornecedor"
                  value={form.supplierId}
                  onChange={(e) => set('supplierId', e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
                    text-[length:var(--gs-text-base)]"
                >
                  <option value="">Sem fornecedor</option>
                  {fornecedores.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.trade_name || f.name}
                    </option>
                  ))}
                  {/* Cadastro antigo guardava o NOME no lugar do id: aparece para
                      ser trocado, e não some — escondê-lo apagaria o dado. */}
                  {form.supplierId && !fornecedores.some((f) => f.id === form.supplierId) && (
                    <option value={form.supplierId}>
                      {form.supplierId} (não é um fornecedor cadastrado — escolha da lista)
                    </option>
                  )}
                </select>
              </Campo>
            )}

            <label className="flex items-center gap-2 md:col-span-2">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set('active', e.target.checked)}
              />
              <span className="text-[length:var(--gs-text-sm)] font-semibold">Produto ativo</span>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                — desmarcado, fica inativo (arquivado): fora do PDV, da busca e da loja, com o
                histórico de pé.
              </span>
            </label>
          </div>
        </Card>
      )}

      {secao === 'fotos' && (
        <GaleriaCard
          productId={id ?? null}
          pendentes={fotosPendentes}
          onPendentes={setFotosPendentes}
          onChange={carregar}
        />
      )}

      {secao === 'precos' && (
        <Card
          title="Preços"
          subtitle="Promoção é regra própria, aplicada pelo PricingService — não altera o preço de tabela."
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Campo label="Preço de custo (R$)">
              <Input
                inputMode="decimal"
                value={form.cost}
                onChange={(e) => set('cost', e.target.value)}
              />
            </Campo>
            <Campo label="Preço de venda (R$)">
              <Input
                inputMode="decimal"
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
                disabled={form.openPrice}
              />
            </Campo>

            {/* Markup e margem lado a lado, e EDITÁVEIS: digitar o percentual
                e sair do campo recalcula o preço. Só exibir os dois deixaria a
                conta de cabeça com quem precifica, que é onde se erra. */}
            <Campo label="Markup (%)">
              <Input
                inputMode="decimal"
                value={markupDigitado ?? (markup === null ? '' : markup.toFixed(2))}
                onChange={(e) => setMarkupDigitado(e.target.value)}
                onBlur={() => {
                  if (markupDigitado !== null) {
                    void calcularPrecoPor('markup', markupDigitado);
                    setMarkupDigitado(null);
                  }
                }}
                disabled={custoCents <= 0 || form.openPrice}
                placeholder={custoCents <= 0 ? 'sem custo' : ''}
              />
            </Campo>
            <Campo label="Margem (%)">
              <Input
                inputMode="decimal"
                value={margemDigitada ?? (margem === null ? '' : margem.toFixed(2))}
                onChange={(e) => setMargemDigitada(e.target.value)}
                onBlur={() => {
                  if (margemDigitada !== null) {
                    void calcularPrecoPor('margem', margemDigitada);
                    setMargemDigitada(null);
                  }
                }}
                disabled={custoCents <= 0 || form.openPrice}
                placeholder={custoCents <= 0 ? 'sem custo' : ''}
              />
            </Campo>
          </div>

          {/* Sem custo lançado não há markup, e mostrar "0,00%" seria mentir:
              zero por cento afirma que se vende pelo custo. */}
          {custoCents <= 0 && (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0">
              Sem preço de custo não há markup nem margem para calcular.
            </p>
          )}
          {markup !== null && markup < 0 && (
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)] mt-3 mb-0">
              Venda abaixo do custo: markup de {markup.toFixed(2)}%.
            </p>
          )}

          {/*
            PREÇO POR QUANTIDADE (GAP-V04) — "3 por R$ 10".

            A tabela de preço da casa é por CLIENTE e exige alguém identificado
            e vinculado; quem chega no balcão levando doze não tem cadastro
            nenhum. A faixa é do PRODUTO e vale para qualquer comprador.

            ELA NÃO SOMA com promoção nem com tabela: entra na MESMA disputa
            deles, e vence o MENOR preço. A frase abaixo diz isso ao gerente,
            porque é a primeira dúvida de quem cria a faixa — e porque um
            desconto que se empilha sem aviso é erosão de margem que só aparece
            comparando o cupom com o cadastro à mão.
          */}
          <div className="mt-5 pt-5 border-t border-[var(--gs-border)]">
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text)] mt-0 mb-1">
              Preço por quantidade
            </p>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
              A partir da quantidade informada, cada unidade sai pelo preço da faixa. Não soma com
              promoção nem com tabela de preço: vale sempre o menor dos três.
            </p>

            {!editando ? (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
                Salve o produto para criar faixas de quantidade.
              </p>
            ) : (
              <>
                {faixas.length > 0 && (
                  <ul className="list-none p-0 m-0 mb-3 flex flex-col gap-1">
                    {faixas.map((f) => (
                      <li
                        key={f.id}
                        className="flex items-center gap-3 text-[length:var(--gs-text-sm)]"
                      >
                        <span className="tabular-nums">
                          A partir de {formatQuantity(f.min_quantity)}:{' '}
                          <strong>{formatCents(f.price_cents)}</strong> cada
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void removerFaixa(f.min_quantity)}
                        >
                          Remover
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <Campo label="A partir de (quantidade)" hint="Mínimo 2">
                    <Input
                      inputMode="numeric"
                      value={novaFaixa.quantidade}
                      onChange={(e) =>
                        setNovaFaixa((a) => ({ ...a, quantidade: e.target.value }))
                      }
                    />
                  </Campo>
                  <Campo label="Preço unitário na faixa (R$)">
                    <Input
                      inputMode="decimal"
                      value={novaFaixa.preco}
                      onChange={(e) => setNovaFaixa((a) => ({ ...a, preco: e.target.value }))}
                    />
                  </Campo>
                  <div className="h-10 flex items-center">
                    <Button variant="secondary" onClick={() => void acrescentarFaixa()}>
                      Salvar faixa
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-[var(--gs-border)]">
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text)] mt-0 mb-1">
              Piso de preço
            </p>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
              Abaixo disto o produto não deve ser vendido. É política, e por isso fica salva — ao
              contrário de markup e margem, que são conta e se recalculam sozinhos.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Preço mínimo (R$)">
                <Input
                  inputMode="decimal"
                  value={form.minPrice}
                  onChange={(e) => set('minPrice', e.target.value)}
                />
              </Campo>
              <Campo label="Markup mínimo (%)">
                <Input
                  inputMode="decimal"
                  value={form.minMarkup}
                  onChange={(e) => set('minMarkup', e.target.value)}
                />
              </Campo>
              <Campo label="Margem mínima (%)">
                <Input
                  inputMode="decimal"
                  value={form.minMargin}
                  onChange={(e) => set('minMargin', e.target.value)}
                />
              </Campo>
              <Campo label="Preço aberto">
                <label className="flex items-center gap-2 h-10">
                  <input
                    type="checkbox"
                    checked={form.openPrice}
                    onChange={(e) => set('openPrice', e.target.checked)}
                  />
                  <span className="text-[length:var(--gs-text-sm)]">Digitado na venda</span>
                </label>
              </Campo>
            </div>

            {/*
              BALANÇA. Pesável e PLU são coisas separadas de propósito: pesável
              é natureza do produto, PLU é o número que ESTA balança usa para
              achá-lo. Existe pesável ainda não cadastrado na balança, e tratar
              os dois como um só faria o arquivo de exportação sair com o campo
              vazio — que a balança recusa sem dizer por quê.
            */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
              <Campo label="Vendido por peso">
                <label className="flex items-center gap-2 h-10">
                  <input
                    type="checkbox"
                    checked={form.weighable}
                    disabled={form.serialized}
                    onChange={(e) => set('weighable', e.target.checked)}
                  />
                  <span className="text-[length:var(--gs-text-sm)]">Vai para a balança</span>
                </label>
              </Campo>
              <Campo label="PLU" hint="O número pelo qual a balança acha o produto">
                <Input
                  inputMode="numeric"
                  value={form.pluCode}
                  disabled={!form.weighable}
                  onChange={(e) => set('pluCode', e.target.value)}
                  placeholder="000123"
                />
              </Campo>
              <Campo label="Tara (g)" hint="Peso da embalagem, descontado pela balança">
                <Input
                  inputMode="numeric"
                  value={form.tareGrams}
                  disabled={!form.weighable}
                  onChange={(e) => set('tareGrams', e.target.value)}
                  placeholder="0"
                />
              </Campo>
              {/*
                CONTROLE POR UNIDADE. Excludente com "vendido por peso": o que
                se pesa não se conta uma a uma, e marcar os dois travaria a
                venda — a balança manda quantidade fracionada e a unidade exige
                inteiro. Por isso um desabilita o outro na própria tela, em vez
                de só o servidor recusar depois de o usuário preencher tudo.
              */}
              <Campo
                label="Controlado por unidade"
                hint="Moto, celular: cada peça tem chassi, IMEI ou nº de série"
              >
                <label className="flex items-center gap-2 h-10">
                  <input
                    type="checkbox"
                    checked={form.serialized}
                    disabled={form.weighable}
                    onChange={(e) => set('serialized', e.target.checked)}
                  />
                  <span className="text-[length:var(--gs-text-sm)]">Cada peça é única</span>
                </label>
              </Campo>
              {/*
                LOTE E VALIDADE (GAP-V35). Excludente com "controlado por
                unidade" pelo mesmo motivo que pesável e serializado o são: a
                unidade JÁ tem identidade individual, e sobrepor lote criaria
                duas escolhas concorrentes para a mesma saída — qual peça sai ×
                de qual lote sai — sem que nenhuma mande. A tela desabilita em
                vez de deixar o servidor recusar depois do formulário cheio.
              */}
              <Campo
                label="Controla lote e validade"
                hint="Alimento, cosmético, remédio: a caixa traz lote e data"
              >
                <label className="flex items-center gap-2 h-10">
                  <input
                    type="checkbox"
                    checked={form.tracksBatches}
                    disabled={form.serialized || !form.stockControl}
                    onChange={(e) => set('tracksBatches', e.target.checked)}
                  />
                  <span className="text-[length:var(--gs-text-sm)]">Tem validade</span>
                </label>
              </Campo>
            </div>

            {form.serialized && (
              <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Ao gravar, o saldo que já existe vira unidades sem identidade, e elas aparecem em{' '}
                <strong>Estoque › Unidades</strong> esperando o número. A venda passa a exigir que
                se escolha qual peça sai.
              </p>
            )}

            {form.tracksBatches && (
              <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                A entrada passa a aceitar o lote e a validade, e a venda tira do que vence primeiro
                (FEFO), gravando o lote no movimento. <strong>Lote vencido não é vendido</strong> —
                ele sai por perda. O saldo que já existe fica como &ldquo;sem lote declarado&rdquo;
                em <strong>Estoque › Validade</strong>, esperando a conferência: nada é inventado
                para o passado.
              </p>
            )}

            {violacoes.length > 0 && (
              <div
                role="alert"
                className="mt-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
              >
                <strong className="text-[length:var(--gs-text-sm)]">
                  O preço atual viola {violacoes.length === 1 ? 'o mínimo' : 'os mínimos'}:
                </strong>
                <ul className="list-disc pl-5 mt-1 mb-0 text-[length:var(--gs-text-sm)]">
                  {violacoes.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Promoção é regra separada, do PricingService. Mostrar aqui o
              preço que o cliente realmente paga evita a surpresa de o balcão
              cobrar diferente do cadastro — e o preço de tabela continua
              intocado, como deve ser: promoção acaba, o preço volta. */}
          {promocao && (
            <div className="mt-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]">
              <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-success)]">
                Promoção ativa: o PDV e a vitrine cobram {formatCents(promocao)}.
              </p>
              <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                O preço de tabela acima não foi alterado. Promoções são geridas em Produtos ›
                Promoções.
              </p>
            </div>
          )}
        </Card>
      )}

      {secao === 'codigos' && (
        <div className="flex flex-col gap-5">
          <Card
            title="Códigos de barras"
            subtitle="O leitor do balcão reconhece todos eles — o principal e os adicionais."
          >
            {/*
              O PRINCIPAL APARECE AQUI, ainda que ele se edite em Dados gerais.
              Sem mostrá-lo, a tela listaria dois códigos num produto que tem
              três, e a pessoa concluiria que o cadastro perdeu um.
            */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)]">
                <span className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)] w-24">
                  Principal
                </span>
                <span className="font-mono text-[length:var(--gs-text-base)]">
                  {form.barcode || <em className="text-[var(--gs-muted)]">não informado</em>}
                </span>
                <span className="ml-auto text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  é o que a etiqueta imprime · edite em Dados gerais
                </span>
              </div>

              {[...codigosExtras, ...codigosPendentes].map((codigo) => {
                const pendente = codigosPendentes.includes(codigo);
                return (
                  <div
                    key={codigo}
                    className="flex items-center gap-3 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
                  >
                    <span className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)] w-24">
                      Adicional
                    </span>
                    <span className="font-mono text-[length:var(--gs-text-base)]">{codigo}</span>
                    {pendente && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                        entra ao salvar
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => {
                        if (pendente) {
                          setCodigosPendentes((atual) => atual.filter((c) => c !== codigo));
                          return;
                        }
                        void coreApi
                          .removeProductBarcode(String(id), codigo)
                          .then((r) => setCodigosExtras(r.barcodes))
                          .catch((err) =>
                            setError(
                              err instanceof ApiRequestError ? err.message : 'Falha ao remover.',
                            ),
                          );
                      }}
                    >
                      Remover
                    </Button>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2 items-end mt-4">
              <div className="flex-1 max-w-xs">
                <Campo label="Novo código">
                  <Input
                    value={novoCodigo}
                    onChange={(e) => setNovoCodigo(e.target.value)}
                    placeholder="Bipe ou digite"
                    onKeyDown={(e) => {
                      // Enter acrescenta: quem usa leitor não tira a mão do
                      // aparelho para clicar num botão a cada código. E o
                      // leitor de código de barras TERMINA com Enter — sem
                      // isto, bipar não faria nada.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void acrescentarCodigo();
                      }
                    }}
                  />
                </Campo>
              </div>
              <Button disabled={!novoCodigo.trim()} onClick={() => void acrescentarCodigo()}>
                Acrescentar
              </Button>
            </div>
          </Card>

          <Card
            title="Kit"
            subtitle="Vende como um, baixa estoque como vários."
          >
            {!editando ? (
              <p className="text-[length:var(--gs-text-base)] text-[var(--gs-muted)] m-0">
                Salve o produto primeiro. As peças precisam de um kit que já exista para se
                vincular a ele.
              </p>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 mb-5">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={form.kitExplodeOnSale}
                      onChange={(e) => set('kitExplodeOnSale', e.target.checked)}
                    />
                    <span>
                      <strong className="text-[length:var(--gs-text-sm)]">
                        Desmembrar os itens na venda
                      </strong>
                      <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        Dá baixa em cada peça. Desligue só quando o kit tiver estoque próprio,
                        já montado.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={form.kitCostFromComponents}
                      onChange={(e) => set('kitCostFromComponents', e.target.checked)}
                    />
                    <span>
                      <strong className="text-[length:var(--gs-text-sm)]">
                        Usar a soma das peças como custo
                      </strong>
                      <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        Hoje as peças somam {formatCents(kitCusto)}.
                      </span>
                    </span>
                  </label>
                </div>

                {kitComponentes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-4">
                    {kitComponentes.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center gap-3 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
                      >
                        <span className="font-semibold">{c.name}</span>
                        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {c.internal_code} · {formatCents(c.cost_cents)}
                        </span>
                        <span className="ml-auto text-[length:var(--gs-text-sm)]">
                          {c.quantity} {c.unit}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void salvarKit(
                              kitComponentes
                                .filter((x) => x.id !== c.id)
                                .map((x) => ({
                                  componentId: x.component_id,
                                  quantity: x.quantity,
                                })),
                            )
                          }
                        >
                          Remover
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 items-end">
                  <div className="flex-1 max-w-md">
                    <Campo label="Acrescentar peça">
                      <Input
                        value={buscaPeca}
                        onChange={(e) => {
                          const termo = e.target.value;
                          setBuscaPeca(termo);
                          if (termo.trim().length < 2) {
                            setAchadosPeca([]);
                            return;
                          }
                          // `excludeKits` evita oferecer o que o servidor vai
                          // recusar: kit dentro de kit faria a baixa de estoque
                          // descer níveis e ciclar.
                          void coreApi
                            .searchProducts(termo, { excludeKits: true })
                            .then((r) => setAchadosPeca(r.filter((p) => String(p.id) !== id)))
                            .catch(() => setAchadosPeca([]));
                        }}
                        placeholder="Nome, código ou código de barras"
                      />
                    </Campo>
                  </div>
                </div>

                {achadosPeca.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1 max-w-md">
                    {achadosPeca.slice(0, 6).map((p) => (
                      <button
                        key={String(p.id)}
                        type="button"
                        onClick={() => {
                          void salvarKit([
                            ...kitComponentes.map((c) => ({
                              componentId: c.component_id,
                              quantity: c.quantity,
                            })),
                            { componentId: String(p.id), quantity: 1 },
                          ]);
                          setBuscaPeca('');
                          setAchadosPeca([]);
                        }}
                        className="text-left px-4 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                          bg-[var(--gs-surface)] hover:bg-[var(--gs-surface-hover)] cursor-pointer"
                      >
                        <span className="font-semibold">{p.name}</span>
                        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {' '}
                          · {p.internal_code}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {secao === 'estoque' && (
        <Card
          title="Estoque"
          subtitle="O saldo não é editável aqui: toda mudança de estoque passa por um movimento registrado."
        >
          {/*
            O SERVIÇO DE BALCÃO (GAP-V02).

            Ajuste de bainha, instalação de acessório, aplicação de película: o
            balcão vende isso, e até esta rodada não podia — toda linha da venda
            baixava estoque, e o saldo negativo era recusado pelo banco. O
            contorno real era lançar uma entrada fictícia, que suja o razão para
            sempre.

            O desligado vem PRIMEIRO na seção porque ele muda o significado de
            tudo o que vem abaixo: com o controle desligado, saldo, mínimo e
            embalagem não querem dizer nada.
          */}
          <label className="flex items-start gap-2 mb-4">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.stockControl}
              onChange={(e) => set('stockControl', e.target.checked)}
            />
            <span>
              <span className="text-[length:var(--gs-text-sm)] font-semibold">
                Este produto controla estoque
              </span>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Desmarque para serviços vendidos no balcão (ajuste de roupa, instalação,
                película): a venda não baixa saldo, não é recusada por falta e o item fica fora
                do inventário e da posição de estoque.
              </span>
            </span>
          </label>

          {form.stockControl ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Info rotulo="Em estoque" valor={formatQuantity(estoque?.quantity ?? 0)} />
                <Info rotulo="Reservado" valor={formatQuantity(estoque?.reserved ?? 0)} />
                <Info
                  rotulo="Disponível"
                  valor={formatQuantity((estoque?.quantity ?? 0) - (estoque?.reserved ?? 0))}
                  destaque
                />
                <Campo label="Estoque mínimo">
                  <Input
                    inputMode="numeric"
                    value={form.minStock}
                    onChange={(e) => set('minStock', e.target.value)}
                  />
                </Campo>
              </div>

              {/*
                A EMBALAGEM DE COMPRA (GAP-V06).

                O fator caixa→unidade vivia só na LINHA da nota de entrada e era
                redigitado a cada conferência. Um 1 no lugar de 12 multiplica
                estoque e custo em silêncio, e o erro só aparece no inventário
                seguinte. Aqui ele é aprendido uma vez e sugerido depois.
              */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                <Campo
                  label="Unidades por embalagem"
                  hint="Ex.: 12 para caixa com 12. Em branco, não vem em caixa."
                >
                  <Input
                    inputMode="numeric"
                    value={form.packFactor}
                    onChange={(e) => set('packFactor', e.target.value)}
                  />
                </Campo>
                <Campo label="Sigla da embalagem" hint="Como o fornecedor a chama: CX, FD">
                  <Input
                    value={form.packUnit}
                    onChange={(e) => set('packUnit', e.target.value.toUpperCase())}
                  />
                </Campo>
              </div>
              {form.packFactor.trim() && (
                <p className="mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                  Na entrada de nota, {form.packUnit || 'a embalagem'} deste produto vem sugerida
                  com {form.packFactor} {form.unit || 'UN'} por embalagem. O fator da linha da
                  nota continua mandando — o fornecedor pode mudar a caixa sem avisar.
                </p>
              )}

              <p className="mt-4 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Para ajustar o saldo, lance um movimento em Estoque › Movimentações. Assim a razão
                continua explicando por que a quantidade mudou.
              </p>
            </>
          ) : (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
              Serviço: sem saldo, sem mínimo e sem embalagem. Ele aparece normalmente na busca do
              PDV e na venda, e não entra em contagem de inventário nem no valor do estoque.
              {(estoque?.quantity ?? 0) !== 0 && (
                <strong className="block mt-2 text-[var(--gs-warning)]">
                  Este produto ainda tem {formatQuantity(estoque?.quantity ?? 0)} em estoque. Zere
                  o saldo por um movimento registrado antes de salvar — senão o saldo sumiria da
                  posição sem nenhum movimento que explicasse para onde foi.
                </strong>
              )}
            </p>
          )}
        </Card>
      )}

      {secao === 'fiscal' && (
        <Card
          title="Fiscal"
          subtitle="Campos usados na emissão. O sistema não deduz tributação sozinho."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/*
              O GRUPO TRIBUTÁRIO — o campo que a mensagem de erro mandava
              preencher e que não existia (GAP-V01).

              A emissão resolve CSOSN, CST, CFOP e origem a partir do grupo. Com
              UM grupo ativo, ele vale como padrão de quem não escolheu, e por
              isso o cadastro nunca doeu. Com DOIS, escolher seria adivinhar: a
              emissão recusa TODO produto sem perfil dizendo "escolha o perfil
              no cadastro do produto" — e este seletor é esse lugar.
            */}
            <Campo
              label="Grupo tributário"
              hint={
                gruposTributarios.filter((g) => g.active !== 0).length > 1
                  ? 'Com mais de um grupo ativo, o produto precisa dizer qual é o dele'
                  : 'Em branco, vale o único grupo ativo da operação'
              }
            >
              <select
                aria-label="Grupo tributário"
                value={form.taxProfile}
                onChange={(e) => set('taxProfile', e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)]"
              >
                <option value="">Padrão da operação</option>
                {/*
                  SÓ OS GRUPOS ATIVOS SÃO OFERECIDOS (A-produto-09). A emissão só
                  aceita grupo ativo; oferecer o inativo era montar a recusa junto
                  com a pessoa — "Produto atualizado." e toda venda desse item
                  travava a NFC-e. O grupo inativo que o produto JÁ tem continua
                  visível, marcado para ser trocado (o servidor recusa escolhê-lo
                  de novo, mas aceita mantê-lo enquanto se corrige outra coisa).
                */}
                {gruposTributarios
                  .filter((g) => g.active !== 0 || g.code === form.taxProfile)
                  .map((g) => (
                    <option key={g.id} value={g.code}>
                      {g.code} · {g.name}
                      {g.active === 0 ? ' (inativo — escolha outro)' : ''}
                    </option>
                  ))}
              </select>
            </Campo>
            <Campo label="NCM">
              <Input value={form.ncm} onChange={(e) => set('ncm', e.target.value)} />
            </Campo>
            <Campo label="CEST">
              <Input value={form.cest} onChange={(e) => set('cest', e.target.value)} />
            </Campo>
            <Campo label="CFOP padrão">
              <Input value={form.cfop} onChange={(e) => set('cfop', e.target.value)} />
            </Campo>
            <Campo label="Origem">
              <Input
                value={form.origin}
                onChange={(e) => set('origin', e.target.value)}
                placeholder="0 = nacional, 1 = importação direta…"
              />
            </Campo>
          </div>

          {/*
            ============================================================
            DE ONDE VEIO ESTA CLASSIFICAÇÃO
            ============================================================

            O bloco responde, campo a campo, o que a tela não sabia dizer:
            o valor foi digitado por alguém desta casa, ou foi lido do XML de
            um fornecedor? Alguém confirmou, e quando? Há outra nota dizendo
            coisa diferente?

            É a mesma pergunta que a tela fiscal responde para o catálogo
            inteiro, aqui recortada para UM produto — porque é nesta ficha que
            alguém para para conferir uma classificação específica.
          */}
          {classificacao && (
            <div
              className="mt-5 p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-muted)]
                border border-[var(--gs-border)]"
            >
              <p className="m-0 mb-2 text-[length:var(--gs-text-sm)] font-semibold">
                Procedência da classificação
              </p>
              {classificacao.confirmedAt ? (
                <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Confirmada por {classificacao.confirmedBy ?? 'alguém'} em{' '}
                  {dataHoraBR(classificacao.confirmedAt)}.
                </p>
              ) : (
                <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Nunca confirmada por uma pessoa. O que estiver preenchido veio do cadastro ou
                  do arquivo do fornecedor, e não de uma decisão registrada.
                </p>
              )}
              <ul className="list-none p-0 m-0 flex flex-col gap-2">
                {classificacao.fields.map((f) => (
                  <li
                    key={f.field}
                    className="text-[length:var(--gs-text-sm)] flex flex-wrap items-center gap-2"
                  >
                    <strong className="uppercase">{f.field}</strong>
                    <span className="text-[var(--gs-muted)]">
                      {f.current || 'em branco'} · {ESTADO_DA_CLASSIFICACAO[f.state]}
                    </span>
                    {f.evidence.map((e) => (
                      <span key={e.value} className="text-[var(--gs-muted)]">
                        · XML do fornecedor: <code>{e.value}</code> em {e.occurrences} nota(s)
                        {e.suppliers.length > 0 ? ` (${e.suppliers.join(', ')})` : ''}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                O XML do fornecedor descreve a MERCADORIA — nunca a tributação da nossa saída.
                CFOP, CSOSN e pCredSN continuam sendo decisão do contador. Para confirmar
                sugestões em lote, use Fiscal › Configuração.
              </p>
            </div>
          )}

          {gruposTributarios.length === 0 && (
            <p className="mt-4 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
              Esta operação ainda não tem grupo tributário cadastrado. Sem ele a emissão fiscal
              recusa todo produto — cadastre em Catálogo › Auxiliares › Grupos tributários.
            </p>
          )}

          {/*
            O IPI EXPLICADO NA TELA (GAP-V08).

            O XML levava <vIPI>0.00</vIPI> cravado, e o zero era uma promessa e
            não um resultado. Agora ele é a soma do que os itens declaram — e
            continua zero em toda empresa deste grupo, porque nenhuma declara
            IPI. Dizer isso aqui é o que impede a pergunta "por que a nota sai
            sem IPI" de virar suspeita de defeito.
          */}
          <p className="mt-4 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            <strong>IPI:</strong> quem define é o grupo tributário, não o produto. Sem CST de IPI
            no grupo, a nota sai com IPI zero — o padrão do varejo no Simples Nacional, que não
            industrializa. Para destacar, preencha o CST e a alíquota no grupo, em Catálogo ›
            Auxiliares.
          </p>
        </Card>
      )}

      {secao === 'ecommerce' && (
        <div className="flex flex-col gap-6">
          <Card
            title="E-commerce"
            subtitle="Mesmo produto, mesmo preço e mesmo estoque do balcão. Não há catálogo separado."
          >
            <div className="flex flex-col gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.publishOnline}
                  onChange={(e) => set('publishOnline', e.target.checked)}
                />
                <span className="text-[length:var(--gs-text-sm)] font-semibold">
                  Publicar na loja online
                </span>
              </label>
              <Campo label="Descrição da vitrine" hint="O que o cliente lê na loja">
                <Input
                  value={form.onlineDescription}
                  onChange={(e) => set('onlineDescription', e.target.value)}
                />
              </Campo>
              {form.publishOnline && (estoque?.quantity ?? 0) <= 0 && (
                <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
                  Sem saldo, o produto aparece na vitrine como indisponível.
                </p>
              )}
              {/* A mesma régua da prontidão e da vitrine (GAP-PRD-207): sem foto
                  publica, e é aviso — não bloqueio. */}
              {form.publishOnline && (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                  Sem foto, o produto aparece na vitrine como "Foto em breve" — é aviso, não
                  bloqueio. A foto se envia na seção Fotos.
                </p>
              )}
            </div>
          </Card>

          {/* Sem estes quatro números não há cotação de frete. A alternativa
              seria o sistema chutar uma caixa — e o transportador cobra pela
              real, com a venda já fechada. */}
          <Card
            title="Dados de envio"
            subtitle="Usados para calcular a entrega no e-commerce. Sem eles, o produto só sai por retirada."
          >
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Campo label="Peso (g)" hint="Em gramas">
                  <Input
                    inputMode="numeric"
                    value={form.weightGrams}
                    onChange={(e) => set('weightGrams', e.target.value)}
                  />
                </Campo>
                <Campo label="Altura (cm)">
                  <Input
                    inputMode="decimal"
                    value={form.heightCm}
                    onChange={(e) => set('heightCm', e.target.value)}
                  />
                </Campo>
                <Campo label="Largura (cm)">
                  <Input
                    inputMode="decimal"
                    value={form.widthCm}
                    onChange={(e) => set('widthCm', e.target.value)}
                  />
                </Campo>
                <Campo label="Comprimento (cm)">
                  <Input
                    inputMode="decimal"
                    value={form.lengthCm}
                    onChange={(e) => set('lengthCm', e.target.value)}
                  />
                </Campo>
              </div>

              <p
                role="status"
                className={`text-[length:var(--gs-text-sm)] font-semibold m-0 ${
                  envioCompleto ? 'text-[var(--gs-success)]' : 'text-[var(--gs-warning)]'
                }`}
              >
                {envioCompleto
                  ? 'ENVIO PRONTO — este produto pode ser entregue.'
                  : 'DADOS DE ENVIO INCOMPLETOS — o produto só sai por retirada.'}
              </p>
            </div>
          </Card>

          {/* A galeria vive na aba Fotos. Aqui só o lembrete de que é ela
              que a vitrine mostra. */}
          <Card title="Imagem da vitrine">
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              A vitrine usa exatamente a foto principal do produto. Para enviar, trocar a
              principal ou reordenar, abra a aba <strong>Fotos</strong>.
            </p>
          </Card>
        </div>
      )}

      {secao === 'variantes' && editando && id && <VariantesCard productId={id} />}

      {/*
        CAMPOS PRÓPRIOS DA OPERAÇÃO (GAP-V07).

        Voltagem, aro, prazo de garantia: atributo que só aquele negócio tem e
        que não cabe em descrição (texto solto não se filtra) nem em
        `variant_attributes` (aquele é da GRADE — cada valor dele vira um
        produto próprio com EAN e saldo).

        Seção RECOLHIDA, como as outras: a esmagadora maioria dos cadastros
        nunca precisa dela, e quem precisa sabe onde procurar.
      */}
      {secao === 'personalizados' && (
        <Card
          title="Campos próprios"
          subtitle="Atributos que só esta operação usa. Quem cria a lista é Catálogo › Auxiliares; aqui se preenche."
        >
          {!editando ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Salve o produto para preencher os campos próprios.
            </p>
          ) : personalizados.length === 0 ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Esta operação ainda não criou nenhum campo próprio. Crie em Catálogo › Auxiliares
              para que ele apareça no cadastro de todos os produtos.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {personalizados.map((campo) => (
                <Campo key={campo.field_id} label={campo.label}>
                  {campo.kind === 'select' ? (
                    <select
                      aria-label={campo.label}
                      value={campo.value ?? ''}
                      onChange={(e) =>
                        setPersonalizados((atual) =>
                          atual.map((c) =>
                            c.field_id === campo.field_id ? { ...c, value: e.target.value } : c,
                          ),
                        )
                      }
                      className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                        bg-[var(--gs-surface)]"
                    >
                      {/* Vazio é opção legítima: o atributo pode não se aplicar
                          a este produto, e limpar precisa ser possível. */}
                      <option value="">—</option>
                      {String(campo.options ?? '')
                        .split('\n')
                        .map((o) => o.trim())
                        .filter(Boolean)
                        .map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <Input
                      // O tipo do campo vira o teclado certo no celular do
                      // balcão, e a data usa o seletor nativo — que é o que
                      // garante o AAAA-MM-DD que o servidor exige.
                      type={campo.kind === 'date' ? 'date' : 'text'}
                      inputMode={campo.kind === 'number' ? 'decimal' : undefined}
                      value={campo.value ?? ''}
                      onChange={(e) =>
                        setPersonalizados((atual) =>
                          atual.map((c) =>
                            c.field_id === campo.field_id ? { ...c, value: e.target.value } : c,
                          ),
                        )
                      }
                    />
                  )}
                </Campo>
              ))}
            </div>
          )}
        </Card>
      )}

      {/*
        HISTÓRICO DO CADASTRO (GAP-V05).

        A trilha já registrava `product.update` — sem dizer O QUE mudou. "Quem
        baixou o preço de 39,90 para 29,90?" não tinha resposta em nenhum dos
        vinte registros do banco real.

        A aba mora AQUI, e não só na Auditoria, porque a Auditoria é restrita
        aos donos do grupo: quem cuida do catálogo precisa poder auditar o
        próprio catálogo.
      */}
      {secao === 'historico' && (
        <Card
          title="Histórico"
          subtitle="O que mudou neste cadastro, de quanto para quanto, por quem e quando."
        >
          {!editando ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              O histórico começa quando o produto existe.
            </p>
          ) : historico.length === 0 ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Nenhuma alteração registrada neste produto.
            </p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-4">
              {historico.map((evento) => (
                <li
                  key={evento.id}
                  className="border-b border-[var(--gs-border)] pb-3 last:border-0 last:pb-0"
                >
                  <p className="m-0 text-[length:var(--gs-text-sm)]">
                    <strong>{evento.user_name ?? 'Sistema'}</strong>{' '}
                    <span className="text-[var(--gs-muted)]">
                      · {new Date(evento.created_at).toLocaleString('pt-BR')} · {evento.action}
                    </span>
                  </p>
                  {/*
                    SÓ O QUE TEM FORMA DE MUDANÇA VIRA "DE → PARA" (A-produto-18).

                    Registros de campos próprios e da tela fiscal guardavam só os
                    CÓDIGOS, e cada um virava uma linha ": — → —" com chave
                    indefinida. O servidor já os filtra; a tela confere de novo
                    porque a trilha é append-only e tem de tudo.
                  */}
                  {(() => {
                    const mudancas = (evento.fields ?? []).filter(
                      (campo) => campo && typeof campo === 'object' && campo.label,
                    );
                    if (mudancas.length > 0) {
                      return (
                        <ul className="list-none p-0 m-0 mt-1 flex flex-col gap-0.5">
                          {mudancas.map((campo) => (
                            <li
                              key={campo.field}
                              className="text-[length:var(--gs-text-sm)] tabular-nums"
                            >
                              {campo.label}: <s className="text-[var(--gs-muted)]">{campo.from ?? '—'}</s>{' '}
                              → <strong>{campo.to ?? '—'}</strong>
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    if (evento.resumo) {
                      // Criação, EAN gerado, foto: o que aconteceu, em uma frase.
                      // Antes todos caíam em "registro anterior ao detalhamento",
                      // o que é falso para evento novo.
                      return (
                        <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {evento.resumo}
                        </p>
                      );
                    }
                    /*
                      A HONESTIDADE DO REGISTRO ANTIGO. As alterações gravadas
                      antes desta rodada não guardavam o diff, e não há como
                      recuperá-lo. Dizer "sem alterações" seria mentir; dizer o
                      que aconteceu é o que permite não procurar o dado.
                    */
                    return evento.action === 'product.update' ? (
                      <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Registro anterior ao detalhamento por campo — o que mudou não foi guardado.
                      </p>
                    ) : null;
                  })()}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </AppShell>
  );
}

// ------------------------------------------------------------------ auxiliares

function Campo({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
        {label}
      </span>
      {children}
      {hint && <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{hint}</span>}
    </label>
  );
}

function Info({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string;
  valor: string;
  destaque?: boolean;
}) {
  return (
    <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
      <p className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </p>
      <p
        className={`text-[length:var(--gs-text-xl)] font-bold ${
          destaque ? 'text-[var(--gs-success)]' : 'text-[var(--gs-purple-900)]'
        }`}
      >
        {valor}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- galeria

/**
 * Galeria de fotos do produto.
 *
 * Funciona ANTES de o produto existir: as fotos escolhidas ficam numa fila em
 * memória e sobem assim que o cadastro é salvo. Sem isso, quem criava um
 * produto novo escolhia a foto e ela desaparecia — o produto ainda não existia
 * quando o arquivo foi selecionado, e não havia onde anexá-lo.
 */
function GaleriaCard({
  productId,
  pendentes,
  onPendentes,
  onChange,
}: {
  /** Nulo enquanto o produto não foi salvo. */
  productId: string | null;
  pendentes: { dataUrl: string; fileName: string; mimeType: string; thumbDataUrl?: string | null }[];
  onPendentes: (
    fotos: { dataUrl: string; fileName: string; mimeType: string; thumbDataUrl?: string | null }[],
  ) => void;
  onChange: () => void;
}) {
  const [imagens, setImagens] = useState<ProductImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    if (!productId) return;
    try {
      setImagens(await coreApi.listProductImages(productId));
    } catch {
      setImagens([]);
    }
  }, [productId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    A MINIATURA QUE FALTA É GERADA AQUI, NA PRIMEIRA ABERTURA (P0 da Preço
    Justo — o preenchimento "preguiçoso").

    Foto enviada antes da miniatura existir aparece no PDV como o espaço
    neutro. Esta galeria já baixa os originais para desenhá-los: aproveitar a
    visita e gravar a miniatura das que não têm custa um canvas por foto, uma
    vez. Só para quem gere o catálogo (`products.manage`) — quem só consulta a
    ficha não escreve nada —, e cada foto é tentada UMA vez por abertura: a
    que falhar (original ausente, recusa) fica para "Gerar miniaturas" em
    Fotos em lote, sem laço.
  */
  const podePreencherMiniatura = useCan('products.manage');
  const miniaturasTentadas = useRef(new Set<string>());
  useEffect(() => {
    if (!productId || !podePreencherMiniatura) return;
    const faltando = imagens.filter((i) => !i.thumb_url && !miniaturasTentadas.current.has(i.id));
    if (faltando.length === 0) return;
    let viva = true;
    void (async () => {
      for (const img of faltando) {
        miniaturasTentadas.current.add(img.id);
        const mini = await miniaturaDaUrl(coreApi.imageUrl(img.url));
        if (!viva || !mini) continue;
        try {
          await coreApi.definirMiniatura(productId, img.id, mini.dataUrl);
        } catch {
          // 409 (outra aba preencheu) ou recusa: a fila de Fotos em lote sabe.
        }
      }
    })();
    return () => {
      viva = false;
    };
  }, [productId, imagens, podePreencherMiniatura]);

  const enviar = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setBusy(true);
      setError(null);
      try {
        const normalizadas: {
          dataUrl: string;
          fileName: string;
          mimeType: string;
          thumbDataUrl?: string | null;
        }[] = [];
        for (const file of Array.from(files)) {
          // Reduz e recomprime antes de subir: foto de celular chega com
          // vários megabytes que não servem para vitrine nenhuma. A mesma
          // leitura desenha a miniatura do balcão, que sobe junto.
          const n = await normalizeImage(file);
          normalizadas.push({
            dataUrl: n.dataUrl,
            fileName: file.name,
            mimeType: n.mimeType,
            thumbDataUrl: n.miniatura?.dataUrl ?? null,
          });
        }

        if (!productId) {
          // Produto ainda não existe: a foto espera o Salvar.
          onPendentes([...pendentes, ...normalizadas]);
        } else {
          for (const foto of normalizadas) {
            await coreApi.addProductImage(productId, foto);
          }
          await carregar();
          onChange();
        }
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao enviar a imagem.');
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [productId, pendentes, onPendentes, carregar, onChange],
  );

  const acao = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
        await carregar();
        onChange();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha na operação.');
      }
    },
    [carregar, onChange],
  );

  /** Move a foto uma posição para trás ou para a frente. */
  const mover = useCallback(
    (index: number, direcao: -1 | 1) => {
      const destino = index + direcao;
      if (!productId || destino < 0 || destino >= imagens.length) return;
      const ordem = imagens.map((i) => i.id);
      const anterior = ordem[index];
      ordem[index] = ordem[destino];
      ordem[destino] = anterior;
      void acao(() => coreApi.reorderProductImages(productId, ordem));
    },
    [productId, imagens, acao],
  );

  return (
    <Card
      title="Fotos"
      subtitle="A primeira foto é a principal — é exatamente ela que a vitrine mostra."
    >
      <div className="flex flex-col gap-4">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={(e) => void enviar(e.target.files)}
          className="text-[length:var(--gs-text-sm)] file:mr-3 file:px-4 file:py-2 file:rounded-[var(--gs-radius)]
            file:border-0 file:bg-[var(--gs-purple-100)] file:text-[var(--gs-purple-800)]
            file:font-semibold file:cursor-pointer"
        />
        <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
          JPEG, PNG ou WebP. A imagem é reduzida e recomprimida no seu navegador antes de subir.
        </p>

        {busy && (
          <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Preparando…
          </p>
        )}
        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {/* Produto novo: as fotos ficam em espera até o Salvar. O preview aqui
            evita a sensação de que o arquivo se perdeu. */}
        {!productId && pendentes.length > 0 && (
          <>
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
              {pendentes.length} foto(s) aguardando. Elas sobem quando você salvar o produto.
            </p>
            <ul className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {pendentes.map((foto, i) => (
                <li
                  key={`${foto.fileName}-${i}`}
                  className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] overflow-hidden"
                >
                  <img
                    src={foto.dataUrl}
                    alt=""
                    className="w-full aspect-square object-cover bg-[var(--gs-canvas)]"
                  />
                  <div className="p-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onPendentes(pendentes.filter((_, j) => j !== i))}
                    >
                      Remover
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {!productId && pendentes.length === 0 && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Escolha as fotos agora — elas sobem junto com o produto ao salvar.
          </p>
        )}

        {productId && imagens.length === 0 && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Nenhuma foto. Produto sem foto aparece na vitrine sem imagem — o sistema não coloca
            uma imagem genérica no lugar.
          </p>
        )}

        {productId && imagens.length > 0 && (
          <ul className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {imagens.map((img, i) => (
              <li
                key={img.id}
                className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] overflow-hidden
                  flex flex-col"
              >
                <img
                  src={coreApi.imageUrl(img.url)}
                  alt=""
                  className="w-full aspect-square object-cover bg-[var(--gs-canvas)]"
                />
                <div className="p-2 flex flex-col gap-2">
                  {img.is_primary === 1 ? (
                    <Badge tone="success">Principal</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void acao(() => coreApi.setPrimaryImage(productId, img.id))}
                    >
                      Tornar principal
                    </Button>
                  )}

                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={i === 0}
                      aria-label={`Mover ${i + 1} para trás`}
                      onClick={() => mover(i, -1)}
                    >
                      ←
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={i === imagens.length - 1}
                      aria-label={`Mover ${i + 1} para a frente`}
                      onClick={() => mover(i, 1)}
                    >
                      →
                    </Button>
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void acao(() => coreApi.removeProductImage(productId, img.id))}
                  >
                    Excluir
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------- variantes

function VariantesCard({ productId }: { productId: string }) {
  const [grade, setGrade] = useState<VariantStock | null>(null);
  const [tamanhos, setTamanhos] = useState('P, M, G, GG');
  const [cores, setCores] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setGrade(await coreApi.getVariants(productId));
    } catch {
      setGrade(null);
    }
  }, [productId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const gerar = useCallback(async () => {
    const eixos: Record<string, string[]> = {};
    const t = tamanhos.split(',').map((s) => s.trim()).filter(Boolean);
    const c = cores.split(',').map((s) => s.trim()).filter(Boolean);
    if (t.length) eixos.tamanho = t;
    if (c.length) eixos.cor = c;
    if (Object.keys(eixos).length === 0) {
      setError('Informe ao menos um eixo — tamanhos ou cores.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const r = await coreApi.generateVariants(productId, eixos);
      setMessage(
        r.created.length === 0
          ? 'Nenhuma combinação nova: a grade já estava completa.'
          : `${r.created.length} variante(s) criada(s), cada uma com EAN próprio.`,
      );
      await carregar();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao gerar a grade.');
    } finally {
      setBusy(false);
    }
  }, [productId, tamanhos, cores, carregar]);

  return (
    <Card
      title="Variantes"
      subtitle="Cada combinação vira uma peça com código e EAN próprios. Gerar de novo só acrescenta o que falta."
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <Campo label="Tamanhos" hint="Separados por vírgula">
            <Input value={tamanhos} onChange={(e) => setTamanhos(e.target.value)} />
          </Campo>
          <Campo label="Cores" hint="Opcional">
            <Input
              value={cores}
              onChange={(e) => setCores(e.target.value)}
              placeholder="Preto, Azul, Branco"
            />
          </Campo>
          <Button loading={busy} onClick={() => void gerar()}>
            Gerar grade
          </Button>
        </div>

        {message && (
          <p role="status" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-success)]">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {grade && grade.items.length > 0 && (
          <>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Total da grade: <strong>{formatQuantity(grade.totalQuantity)}</strong> peça(s). O
              modelo deixa de ser vendável — quem sai da prateleira é o tamanho.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className="py-2 pr-3 font-semibold">Variante</th>
                    <th className="py-2 pr-3 font-semibold">Código</th>
                    <th className="py-2 pr-3 font-semibold">EAN</th>
                    <th className="py-2 pr-3 font-semibold text-right">Preço</th>
                    <th className="py-2 font-semibold text-right">Estoque</th>
                  </tr>
                </thead>
                <tbody>
                  {grade.items.map((v) => (
                    <tr key={v.id} className="border-b border-[var(--gs-border)] last:border-0">
                      <td className="py-2.5 pr-3">
                        {v.name}
                        {/* O tamanho herda o modelo: modelo inativo (arquivado)
                            tira a grade inteira de venda sem reescrever cada linha. */}
                        {v.vendavel === 0 && (
                          <span className="ml-2">
                            <Badge tone="warning">fora de venda</Badge>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[length:var(--gs-text-xs)]">
                        {v.internal_code}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[length:var(--gs-text-xs)]">
                        {v.barcode ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {formatCents(v.price_cents)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-bold">
                        {formatQuantity(v.quantity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

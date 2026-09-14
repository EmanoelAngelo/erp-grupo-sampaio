/**
 * Entrada de notas — importação de XML de NF-e.
 *
 * Fluxo em duas etapas, como no balcão: importa o XML e mostra a conferência
 * item a item; o estoque só se move quando alguém confirma. Reimportar o
 * mesmo arquivo é detectado e não duplica entrada.
 *
 * ## ESTA É A PORTA PRINCIPAL DA PEÇA
 *
 * Peça de oficina quase nunca é cadastrada à mão: ela chega na nota do
 * fornecedor. A importação cria o produto que faltava e o cria como MERCADORIA
 * DE REVENDA, com preço zero de propósito — a nota traz o custo e o sistema não
 * inventa margem. O resultado, se ninguém corrige, é um item que não aparece na
 * gaveta de bancada nenhuma e que, se aparecesse, entraria na OS por R$ 0,00.
 *
 * Por isso o caminho de marcar como peça fica AQUI, no fim da conferência,
 * enquanto a pessoa ainda está olhando a carga que acabou de chegar — e não
 * numa visita futura ao cadastro de cada produto, que é a visita que nunca
 * acontece.
 *
 * Só depois de CONFIRMADA a entrada: antes disso, o item novo ainda não tem
 * produto, e não há o que marcar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from '@/components/gs/ui';
import { TitulosDoDocumento } from '@/components/gs/TitulosDoDocumento';
import { dataBR, mesAnoBR } from '@/lib/datas';
// `parseReaisToCents` é o MESMO interpretador de dinheiro do resto do
// sistema. Uma terceira implementação de parsing já causou um bug aqui.
import {
  formatCents,
  formatGramsAsKg,
  formatQuantity,
  parseReaisToCents,
} from '@/components/gs/format';
import { ApiRequestError, apiBinary, apiRequest, envelope, exigirCampos } from '@/lib/api/client';
import {
  coreApi,
  type FinanceEntry,
  type Product,
  type Supplier,
  type Workshop,
  type WorkshopPart,
} from '@/lib/api/core';
import { entradaNotasApi } from '@/lib/api/entradaNotas';
import { VincularItemDaNota } from '@/components/gs/VincularItemDaNota';
import { NotasSemContaAPagar } from '@/components/gs/NotasSemContaAPagar';
import { Paginacao } from '@/components/gs/Paginacao';
import { paginaDeNotasDeEntrada, type Pagina } from '@/lib/api/paginas';
import {
  PARAM_DA_NOTA,
  origemDaNota,
  rotaDaNovaDevolucaoAoFornecedor,
} from '@/lib/rotasDeOrigem';
import { salvarArquivo } from '@/lib/download';
import { uuid } from '@/lib/uuid';
import { TentativaJaRegistrada } from '@/components/gs/TentativaJaRegistrada';
import { ehTentativaJaRegistrada } from '@/lib/api/tentativaJaRegistrada';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { acessoPersonalizado, telaAbre } from '@/lib/acesso/acesso';
import { CaminhoDoAtoFiscal } from '@/components/gs/CaminhoDoAtoFiscal';
import { SenhaDoCertificadoDialog } from '@/components/gs/SenhaDoCertificadoDialog';
import type { PlanoDoAtoFiscal } from '@/lib/api/fiscalAtos';

interface NoteItem {
  description: string;
  barcode: string | null;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  quantity: number;
  unitCostCents: number;
  totalCents: number;
  productId: string | null;
  matchedBy: string | null;
  /**
   * O que o conferente CONTOU. Nulo enquanto ninguem conferiu — e ai vale a
   * quantidade da nota. Zero e diferente: e "conferi e nao veio nada".
   */
  receivedQuantity?: number | null;
  divergenceNote?: string | null;
  /** A unidade tributável da nota — a menor unidade do item. */
  unitTrib?: string | null;
  /** A quantidade NA unidade tributável. */
  quantityTrib?: number | null;
  /**
   * Quantas unidades do CADASTRO vêm em uma da NOTA.
   *
   * Nulo enquanto ninguém precisou dizer. O servidor recusa a entrada
   * quando a unidade da nota difere da do cadastro e nem a nota resolve —
   * é aqui que quem está com a caixa aberta responde.
   */
  conversionFactor?: number | null;
  /** O código do item NO FORNECEDOR (`cProd`) — é ele que o de-para lembra. */
  supplierCode?: string | null;
  /**
   * COM QUAL produto o item casou (GAP-PRD-015). "Vinculado" sem o nome do
   * produto obrigava a confiar às cegas no casamento por descrição — que é
   * exatamente o que erra. Opcionais: servidor anterior não os manda.
   */
  productName?: string | null;
  productInternalCode?: string | null;
  /**
   * Por que o item QUASE casou (modelo de grade, kit, inativo, homônimo). Vem
   * também na leitura da nota, refeito contra o catálogo de agora (M04).
   */
  matchNote?: string | null;
  /** O que o fornecedor declarou sobre a mercadoria (B-10). */
  cest?: string | null;
  origin?: string | null;
  productUnit?: string | null;
  /** O que o CADASTRO diz, para a conferência comparar com a nota (B-10). */
  productNcm?: string | null;
  productCest?: string | null;
  productOrigin?: string | null;
  /** O `cEAN` declarado como "SEM GTIN" — não é o mesmo que código ausente (B-10). */
  semGtin?: boolean;
  /** A relação nota × cadastro de cada dado fiscal (B-10). */
  fiscal?: {
    barcode: EstadoFiscal;
    ncm: EstadoFiscal;
    cest: EstadoFiscal;
    origin: EstadoFiscal;
  };
  /**
   * O fator que a confirmação aplicaria sem nada digitado (M05). Nulo: a
   * confirmação vai pedir. Ausente: servidor anterior, que não o calcula.
   */
  resolvedFactor?: number | null;
  /**
   * Key da linha na tabela: NOTA + POSIÇÃO, montada na renderização. Os
   * inputs de conferência são não-controlados; key estável entre notas
   * reaproveitaria o input sujo — e gravaria a contagem na nota errada.
   */
  chaveDaLinha?: string;
}

/** Documento devolvido pela Distribuição DF-e — a nota contra o nosso CNPJ. */
interface DfeDoc {
  nsu: string;
  /** O ambiente da consulta que o trouxe — a lista só traz o atual (DFE-AMBIENTE). */
  ambiente?: string;
  schemaType: string;
  accessKey: string | null;
  supplierCnpj: string | null;
  supplierName: string | null;
  totalCents: number | null;
  issuedAt: string | null;
  manifestStatus: string | null;
  importedNoteId: string | null;
  noteStatus: string | null;
  temXmlCompleto: boolean;
}

const NOME_DO_AMBIENTE_DFE: Record<string, string> = {
  homologation: 'homologação',
  production: 'produção',
};

/**
 * O AMBIENTE DA DISTRIBUIÇÃO (DFE-AMBIENTE). A SEFAZ numera homologação e
 * produção à parte, e o servidor lista só o ambiente fiscal atual. Quem
 * homologou com notas reais e virou para produção veria a lista "sumir" sem
 * saber por quê: a frase diz quantos documentos do outro ambiente ficaram
 * guardados fora dela, e por que não se age sobre eles. Nula quando não há.
 */
function avisoDoOutroAmbiente(
  atual: string | null,
  outro: { ambiente: string; total: number } | null,
): string | null {
  if (!outro || outro.total <= 0) return null;
  const nomeAtual = NOME_DO_AMBIENTE_DFE[atual ?? ''] ?? atual ?? 'ambiente atual';
  const nomeOutro = NOME_DO_AMBIENTE_DFE[outro.ambiente] ?? outro.ambiente;
  return (
    `Mostrando os documentos da ${nomeAtual}. ${outro.total} documento(s) da ${nomeOutro} ficam guardados `
    + `fora desta lista: a SEFAZ numera cada ambiente à parte, e documento da ${nomeOutro} não se manifesta `
    + `nem se importa na ${nomeAtual}.`
  );
}

/**
 * A ESPERA QUE A SEFAZ IMPÕE À DISTRIBUIÇÃO DF-e (R3-DFE, GAP-PRD-168).
 *
 * Em dia (cStat 137, ou ultNSU = maxNSU), a próxima consulta só depois de uma
 * hora — consultar antes é consumo indevido, e o cStat 656 bloqueia o CNPJ por
 * uma hora. O servidor guarda a espera por (empresa, ambiente) e a manda com a
 * lista; o botão diz a hora em vez de deixar clicar para tomar a recusa.
 */
interface EstadoDaDistribuicao {
  ultimoNsu: number;
  maxNsu: number | null;
  ultimoCStat: string | null;
  proximaConsultaEm: string | null;
  motivoDaEspera: 'em_dia' | 'consumo_indevido' | null;
}

function horaCurta(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** A espera que ainda vale; nula quando não há ou já passou. */
function esperaVigente(d: EstadoDaDistribuicao | null | undefined): EstadoDaDistribuicao | null {
  if (!d?.proximaConsultaEm) return null;
  return Date.parse(d.proximaConsultaEm) > Date.now() ? d : null;
}

function avisoDaEspera(d: EstadoDaDistribuicao): string {
  const hora = horaCurta(d.proximaConsultaEm ?? '');
  if (d.motivoDaEspera === 'consumo_indevido') {
    return (
      `A SEFAZ bloqueou as consultas deste CNPJ por consumo indevido (cStat 656) até as ${hora}. `
      + 'Consultar durante o bloqueio o renova: a próxima busca sai a partir desse horário.'
    );
  }
  return (
    `A SEFAZ já entregou tudo o que havia (até o NSU ${d.ultimoNsu}). Pela regra do Ambiente Nacional, `
    + `a próxima consulta só pode sair a partir das ${hora} — consultar antes bloqueia o CNPJ por uma hora (cStat 656).`
  );
}

/** O conhecimento do transporte, com as NF-e que ele carrega. */
interface CteDoc {
  id: string;
  accessKey: string;
  number: string | null;
  carrierName: string | null;
  freightCents: number;
  issuedAt: string | null;
  createdAt: string;
  notas: { accessKey: string; noteId: string | null; noteStatus: string | null }[];
}

/** Como o item casou com o catálogo — agora o método vem GRAVADO do servidor. */
const CASOU_POR: Record<string, string> = {
  barcode: 'código de barras',
  // O EAN da UNIDADE que o fornecedor declara no `cEANTrib` (B-05).
  barcode_trib: 'código de barras da unidade',
  internal_code: 'código interno',
  name: 'descrição',
  manual: 'vínculo manual',
  // O de-para aprendido numa conferência anterior deste fornecedor (GAP-PRD-015).
  supplier_code: 'código do fornecedor (vínculo anterior)',
};

const MANIFESTACAO: Record<string, string> = {
  ciencia: 'Ciência registrada',
  confirmacao: 'Operação confirmada',
  desconhecimento: 'Desconhecimento',
  nao_realizada: 'Operação não realizada',
};

/**
 * O que a nota fez com o preço de um produto.
 *
 * A conta vem do servidor, de `Pricing.ts` — a mesma que o cadastro de produto
 * usa. Refazer markup e margem aqui criaria dois números para a mesma coisa.
 */
interface SugestaoDePreco {
  productId: string;
  name: string;
  internalCode: string;
  custoAtualCents: number;
  precoAtualCents: number;
  markupPercent: number | null;
  margemPercent: number | null;
  abaixoDoCusto: boolean;
  abaixoDoMinimo: boolean;
  motivos: string[];
  precoSugeridoCents: number | null;
}

interface Note {
  id: string;
  access_key: string;
  number: string | null;
  series: string | null;
  supplier_name: string | null;
  total_cents: number;
  status: string;
  created_at: string;
  /**
   * O transporte, lido do grupo <transp> do XML.
   *
   * Nulo é normal e frequente: retirada no balcão não declara transporte
   * nenhum. É ausência de fato, não campo por preencher.
   */
  carrier_name_xml: string | null;
  freight_mode: string | null;
  volumes_qty: number | null;
  gross_weight_grams: number | null;
  vehicle_plate: string | null;
  /**
   * A nota tem o arquivo do fornecedor guardado? (1 sim, 0 não)
   *
   * É um booleano e não o XML de propósito: a lista traz 200 linhas, e cada
   * XML tem dezenas de kilobytes. Enquanto a consulta do servidor era
   * `SELECT n.*`, acrescentar a coluna teria feito esta tela arrastar
   * megabytes a cada carregamento. O arquivo só viaja quando alguém clica.
   *
   * Opcional porque a resposta antiga não o trazia — ausente é lido como
   * "não tem", que é a verdade de toda nota anterior à rodada 27.
   */
  tem_xml?: number;
  /**
   * A data de EMISSÃO, do arquivo. É ela que datilografa a frase da nota sem
   * arquivo — ver `mesDaNota`. Nulo cai para `created_at`.
   */
  issued_at?: string | null;
  /**
   * QUEM conferiu/recebeu a carga, pelo nome — e quando.
   *
   * `received_by` era gravado na confirmação da entrada e nenhuma tela o
   * nomeava. "Quem conferiu esta nota" é a pergunta de quando a doca recebeu
   * 4 e a nota dizia 10 — o nome vem do servidor por JOIN com `core_users`,
   * porque um id não responde a ninguém. Nulos para nota ainda em
   * conferência, e opcionais porque a resposta anterior à rodada 32 não os
   * trazia.
   */
  received_at?: string | null;
  received_by_name?: string | null;
  /**
   * A ESPÉCIE do documento: 'nfe' (XML importado) ou 'manual' (compra
   * digitada, SEM nota fiscal — GAP-V17). Opcional porque a resposta antiga
   * não a trazia — ausente lê-se 'nfe', a verdade de toda nota anterior.
   */
  doc_type?: string;
  /** Quando a entrada confirmada foi DESFEITA (status 'estornada', GAP-V20). */
  reversed_at?: string | null;
  /** Quem desfez, pelo nome — id não responde a ninguém. */
  reversed_by_name?: string | null;
  /** Por que a entrada foi desfeita — a linha conta sem abrir a Auditoria. */
  reversal_reason?: string | null;
  /**
   * PARA QUEM a nota foi emitida (B-02). A conferência mostra: é o aviso
   * visível na empresa que ainda não configurou o CNPJ, onde a trava de
   * destinatário não tem com o que comparar.
   */
  recipient_document?: string | null;
  recipient_name?: string | null;
  /** Por que a nota entrou SEM conta a pagar (remessa sem ônus, B-03). */
  finance_waiver_reason?: string | null;
}

/** O estado de um dado fiscal na conferência — o mesmo vocabulário do servidor (B-10). */
type EstadoFiscal = 'AUTO_DETECTADO' | 'CONFIRMADO' | 'PENDENTE' | 'DIVERGENTE' | 'NAO_APLICAVEL';

const ROTULO_FISCAL: Record<EstadoFiscal, { texto: string; tom: 'success' | 'warning' | 'info' | 'neutral' | 'danger' }> = {
  CONFIRMADO: { texto: 'confere com o cadastro', tom: 'success' },
  DIVERGENTE: { texto: 'diverge do cadastro', tom: 'danger' },
  AUTO_DETECTADO: { texto: 'da nota (a confirmar)', tom: 'info' },
  PENDENTE: { texto: 'pendente', tom: 'neutral' },
  NAO_APLICAVEL: { texto: 'não se aplica', tom: 'neutral' },
};

/**
 * O valor declarado na nota com o estado dele embaixo (B-10). O DIVERGENTE diz
 * o que o CADASTRO tem — "diverge" sem o outro número obrigaria a abrir a
 * ficha do produto no meio da conferência.
 */
function DadoFiscal({
  valor,
  estado,
  doCadastro,
}: {
  valor: string;
  estado?: EstadoFiscal;
  doCadastro?: string | null;
}) {
  if (!estado) return <>{valor}</>;
  const rotulo = ROTULO_FISCAL[estado];
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span>{valor}</span>
      <Badge tone={rotulo.tom}>
        {estado === 'DIVERGENTE' && doCadastro ? `cadastro: ${doCadastro}` : rotulo.texto}
      </Badge>
    </span>
  );
}

/**
 * O mês da nota, em pt-BR, para a frase da nota SEM arquivo.
 *
 * Esta função é o motivo de `issued_at` estar na lista. A alternativa — "notas
 * anteriores a abril de 2026 não têm XML" escrito no código — envelheceria em
 * silêncio: bastaria a migração rodar noutra data, ou alguém restaurar um
 * banco antigo, para a tela passar a afirmar uma data que nunca existiu. A
 * data sai do DADO, e cada linha conta a própria história.
 */
function mesDaNota(nota: Note): string {
  const bruto = nota.issued_at ?? nota.created_at;
  return mesAnoBR(bruto, 'antes');
}

/**
 * O que o dígito do <modFrete> quer dizer numa nota de COMPRA.
 *
 * O layout da NF-e fala pela ótica do EMITENTE, e numa nota de entrada o
 * emitente é o FORNECEDOR. Repetir o texto do layout diria ao lojista que ele
 * pagou o frete quando quem pagou foi quem vendeu — por isso a tradução é
 * feita aqui, do lado de quem recebe.
 */
const MODALIDADE_DE_FRETE: Record<string, string> = {
  '0': 'Frete pago pelo fornecedor',
  '1': 'Frete por nossa conta',
  '2': 'Frete por conta de terceiros',
  '3': 'Veículo do próprio fornecedor',
  '4': 'Buscamos com veículo próprio',
  '9': 'Sem frete (retirada)',
};

/** Uma linha do formulário de entrada manual: SEMPRE produto do catálogo. */
interface LinhaManual {
  productId: string | null;
  internalCode: string | null;
  nome: string | null;
  busca: string;
  resultados: Product[];
  quantidade: string;
  /** Em reais, como digitado — vira centavos INTEIROS no envio. */
  custo: string;
}

const LINHA_MANUAL_VAZIA: LinhaManual = {
  productId: null,
  internalCode: null,
  nome: null,
  busca: '',
  resultados: [],
  quantidade: '1',
  custo: '',
};

/**
 * ENTRADA MANUAL — a compra SEM nota fiscal (GAP-V17).
 *
 * Feira, autônomo, produtor rural: o fornecedor que não emite NF-e (e que o
 * cadastro aceita sem documento, de propósito). Antes disto a compra entrava
 * por movimento avulso de estoque — sem documento, sem dívida no financeiro,
 * invisível no histórico do fornecedor.
 *
 * O formulário cria um documento de espécie própria que NUNCA finge ser NF-e
 * (o rótulo diz "sem nota fiscal" com todas as letras) e o despeja no MESMO
 * funil de conferência da tela: quem lança revisa os itens e clica "Dar
 * entrada no estoque" — estoque, custo, prazo do fornecedor e contas a pagar
 * andam pela régua já provada da NF-e.
 *
 * A `idempotencyKey` nasce quando o formulário abre e SÓ troca depois do
 * sucesso: reenviar após falha de rede é a mesma intenção, e o servidor
 * devolve a mesma nota em vez de duplicar (o desenho do LancamentoManual de
 * MovimentacoesEstoquePage).
 */
function EntradaManualCard({
  aoLancar,
}: {
  aoLancar: (noteId: string, duplicated: boolean) => Promise<void>;
}) {
  const [fornecedores, setFornecedores] = useState<Supplier[]>([]);
  const [fornecedorId, setFornecedorId] = useState('');
  const [documento, setDocumento] = useState('');
  const [linhas, setLinhas] = useState<LinhaManual[]>([{ ...LINHA_MANUAL_VAZIA }]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuid());
  /** O servidor recusou a chave por já ter registrado OUTRA entrada com ela (422, R2-IDEM). */
  const [tentativaReusada, setTentativaReusada] = useState(false);

  useEffect(() => {
    void coreApi
      .listSuppliers()
      .then(setFornecedores)
      .catch(() => setFornecedores([]));
  }, []);

  const procurar = async (i: number, termo: string) => {
    setLinhas((atual) =>
      atual.map((l, idx) =>
        idx === i ? { ...l, busca: termo, productId: null, internalCode: null, nome: null } : l,
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
      setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, resultados: [] } : l)));
    }
  };

  const escolher = (i: number, p: Product) =>
    setLinhas((atual) =>
      atual.map((l, idx) =>
        idx === i
          ? {
              ...l,
              productId: p.id,
              internalCode: p.internal_code,
              nome: p.name,
              busca: '',
              resultados: [],
              // O custo do cadastro como ponto de partida — quem pagou outro
              // preço na feira sobrescreve.
              custo: (p.cost_cents / 100).toFixed(2).replace('.', ','),
            }
          : l,
      ),
    );

  const alterar = (i: number, campo: 'quantidade' | 'custo', valor: string) =>
    setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));

  const lancar = async (chaveDoEnvio: string = idempotencyKey) => {
    setErro(null);
    if (!fornecedorId) {
      setErro('Escolha o fornecedor — a dívida precisa de um credor de verdade.');
      return;
    }
    const items: { productId: string; quantity: number; unitCostCents: number }[] = [];
    for (const [i, l] of linhas.entries()) {
      if (!l.productId) {
        if (linhas.length === 1 || l.busca.trim() || l.quantidade !== '1' || l.custo.trim()) {
          setErro(`Escolha o produto do catálogo no item ${i + 1} — entrada manual é de mercadoria da prateleira.`);
          return;
        }
        continue; // linha em branco no fim: ignorada
      }
      const qtd = Number(String(l.quantidade).replace(',', '.'));
      if (!Number.isFinite(qtd) || qtd <= 0) {
        setErro(`Informe a quantidade do item ${i + 1}.`);
        return;
      }
      const custoCents = parseReaisToCents(l.custo);
      if (custoCents === null || custoCents < 0) {
        setErro(`Custo unitário inválido no item ${i + 1}. Use o formato 12,34.`);
        return;
      }
      items.push({ productId: l.productId, quantity: qtd, unitCostCents: custoCents });
    }
    if (items.length === 0) {
      setErro('A entrada manual precisa de ao menos um item do catálogo.');
      return;
    }

    setOcupado(true);
    try {
      const r = await coreApi.createManualInboundEntry({
        supplierId: fornecedorId,
        documentNumber: documento.trim() || null,
        idempotencyKey: chaveDoEnvio,
        items,
      });
      // Sucesso encerra a intenção: a PRÓXIMA entrada ganha identidade nova.
      setIdempotencyKey(uuid());
      setLinhas([{ ...LINHA_MANUAL_VAZIA }]);
      setDocumento('');
      setFornecedorId('');
      await aoLancar(r.noteId, r.duplicated);
    } catch (err) {
      // A chave NÃO troca aqui: reenviar depois da falha é a mesma intenção,
      // e a idempotência do servidor devolve a mesma nota.
      if (ehTentativaJaRegistrada(err)) {
        // ...a não ser que ela já tenha registrado OUTRA entrada: aí reenviar é
        // 422 para sempre, e registrar de novo é escolha de quem lança.
        setTentativaReusada(true);
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao lançar a entrada manual.');
    } finally {
      setOcupado(false);
    }
  };

  /** "Registrar como entrada nova": os mesmos itens, com chave nova — só por escolha. */
  const lancarComoNova = () => {
    const nova = uuid();
    setIdempotencyKey(nova);
    setTentativaReusada(false);
    void lancar(nova);
  };

  return (
    <Card
      title="Entrada manual (sem nota fiscal)"
      subtitle="Compra de fornecedor que não emite NF-e — feira, autônomo, produtor. Cria o documento, a dívida no prazo do fornecedor e a entrada no estoque pelo mesmo funil de conferência."
      className="mb-5"
    >
      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {tentativaReusada && (
        <TentativaJaRegistrada
          titulo="Esta tentativa já registrou uma entrada"
          onVoltar={() => setTentativaReusada(false)}
          rotuloDoNovo="Registrar como entrada nova"
          onNovo={lancarComoNova}
          ocupado={ocupado}
          testId="entrada-manual-ja-registrada"
        >
          <p className="m-0">
            <strong>Esta tentativa já registrou outra entrada manual, com outros itens ou outro fornecedor.</strong>{' '}
            Nada foi lançado agora.
          </p>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Acontece quando a resposta do primeiro envio se perde e o formulário muda antes de lançar de novo. Se
            esta é mesmo outra compra, registre como entrada nova. Se era a mesma compra corrigida, confira a lista de
            notas antes: a entrada anterior já está lá, e registrar de novo criaria outra dívida com o fornecedor.
          </p>
        </TentativaJaRegistrada>
      )}
      <div className="grid gap-4 md:grid-cols-2 mb-4">
        <Field label="Fornecedor" required>
          {(p) => (
            <select
              {...p}
              aria-label="Fornecedor da entrada manual"
              value={fornecedorId}
              onChange={(e) => setFornecedorId(e.target.value)}
              className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
            >
              <option value="">Selecione…</option>
              {fornecedores.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.trade_name || f.name}
                  {f.payment_term_days > 0 ? ` — ${f.payment_term_days} dias de prazo` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Nº do recibo/pedido" hint="Opcional — sem ele, o documento ganha número próprio">
          {(p) => (
            <Input
              {...p}
              value={documento}
              onChange={(e) => setDocumento(e.target.value)}
              placeholder="RECIBO-17"
            />
          )}
        </Field>
      </div>

      {linhas.map((l, i) => (
        <div key={i} className="grid gap-3 md:grid-cols-4 mb-3 items-start">
          <div className="md:col-span-2">
            {l.productId ? (
              <span className="inline-flex items-center gap-2 flex-wrap">
                <Badge tone="info">{l.internalCode ?? 'catálogo'}</Badge>
                <span>{l.nome}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remover produto do item ${i + 1} da entrada manual`}
                  onClick={() =>
                    setLinhas((atual) =>
                      atual.map((x, idx) =>
                        idx === i
                          ? { ...x, productId: null, internalCode: null, nome: null, busca: '' }
                          : x,
                      ),
                    )
                  }
                >
                  ×
                </Button>
              </span>
            ) : (
              <>
                <Input
                  aria-label={`Produto do catálogo do item ${i + 1} da entrada manual`}
                  value={l.busca}
                  onChange={(e) => void procurar(i, e.target.value)}
                  placeholder="Buscar produto (nome, código, barras)"
                />
                {l.resultados.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1">
                    {l.resultados.slice(0, 6).map((r) => (
                      <Button key={r.id} size="sm" variant="ghost" onClick={() => escolher(i, r)}>
                        {r.name} · {r.internal_code}
                      </Button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <Field label={i === 0 ? 'Quantidade' : ''}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="any"
                aria-label={`Quantidade do item ${i + 1} da entrada manual`}
                value={l.quantidade}
                onChange={(e) => alterar(i, 'quantidade', e.target.value)}
              />
            )}
          </Field>
          <Field label={i === 0 ? 'Custo unitário (R$)' : ''}>
            {(p) => (
              <Input
                {...p}
                aria-label={`Custo unitário do item ${i + 1} da entrada manual`}
                value={l.custo}
                onChange={(e) => alterar(i, 'custo', e.target.value)}
                placeholder="0,45"
              />
            )}
          </Field>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setLinhas((a) => [...a, { ...LINHA_MANUAL_VAZIA }])}
        >
          Adicionar item
        </Button>
        <span className="ml-auto" />
        <Button loading={ocupado} onClick={() => void lancar()}>
          Lançar entrada manual
        </Button>
      </div>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-0">
        O lançamento fica EM CONFERÊNCIA: nada entra no estoque até alguém revisar os itens e dar
        entrada — a mesma régua da nota importada.
      </p>
    </Card>
  );
}

export default function EntradaNotasPage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [items, setItems] = useState<NoteItem[] | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** Só o que precisa de atenção depois da entrada. Vazio é bom sinal. */
  const [sugestoes, setSugestoes] = useState<SugestaoDePreco[]>([]);
  const [precosEditados, setPrecosEditados] = useState<Record<string, number>>({});

  /**
   * OS TÍTULOS DESTA NOTA — a VOLTA da rastreabilidade, que faltava aqui.
   *
   * Nulo é "ainda não chegou"; lista vazia é "não gerou título", que é resposta
   * legítima (nota em conferência, nota de bonificação). O erro fica em estado
   * PRÓPRIO porque falha de rede lida como lista vazia diria "esta nota não
   * cobra nada" — exatamente o contrário do que aconteceu.
   */
  const [titulos, setTitulos] = useState<FinanceEntry[] | null>(null);
  const [erroTitulos, setErroTitulos] = useState<string | null>(null);

  /*
    QUEM MARCA PEÇA.

    Exatamente os perfis que a rota de conversão aceita (mais `admin_geral` e
    `gestor`, que passam em tudo). O ATENDENTE alcança esta tela pelo roteador e
    NÃO está nessa lista: para ele a coluna simplesmente não existe, em vez de
    existir e responder 403. Os operadores de caixa não entram na conta porque
    não chegam aqui — `/sistema/compras/entrada-notas` é `ROTA_GESTAO`, e eles
    vivem no ambiente do PDV.
  */
  const marcaPeca = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');

  /**
   * QUEM ESTORNA — só gerência, o MESMO recorte da rota
   * (POST /purchases/notes/:id/estornar). Desfazer entrada confirmada
   * reescreve estoque E financeiro; para quem não pode, o botão nem existe —
   * a tela não promete o que o servidor nega.
   */
  const estorna = useHasProfile('gerente_loja', 'gerente_oficina');

  /**
   * QUEM ABRE AS ETIQUETAS DA ENTRADA (B-estoque-entrada-07).
   *
   * A tela de Etiquetas já monta a fila da nota (`?origem=nota&nota=<id>`), e
   * daqui não havia caminho até ela: quem recebia a carga tinha de ir à outra
   * tela, escolher "nota de entrada" e achar a nota de novo. Os perfis de hoje
   * que chegam aqui (ROTA_GESTAO) chegam lá também; o acesso PERSONALIZADO é
   * decidido pela capability da tela de Etiquetas — o botão não oferece o que
   * vai dar "acesso negado".
   */
  const sessao = useSession();
  const abreEtiquetas =
    !acessoPersonalizado(sessao) || telaAbre(sessao?.access?.capabilities ?? [], '/sistema/etiquetas') !== false;

  /**
   * QUEM LANÇA ENTRADA MANUAL — o recorte da rota POST /purchases/manual:
   * digitar compra cria dívida a partir de teclado, e isso é da gestão do
   * estoque (os operadores de caixa nem chegam a esta tela).
   */
  const lancaManual = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');
  const [manualAberta, setManualAberta] = useState(false);

  /**
   * QUEM VINCULA ITEM A PRODUTO — o recorte exato de
   * `POST /purchases/notes/:id/link` (GAP-PRD-015). O atendente alcança esta
   * tela e não vincula: para ele o botão não existe, em vez de existir e
   * responder 403.
   */
  const vincula = useHasProfile(
    'gerente_loja',
    'gerente_oficina',
    'estoquista',
    // O caixa da LOJA saiu (PJ-CAIXA): o login do PDV da Preço Justo não recebe mercadoria.
    'operador_caixa_oficina',
  );
  /** A linha cuja busca no catálogo está aberta. Nulo = nenhuma. */
  const [vinculando, setVinculando] = useState<number | null>(null);
  /**
   * O PEDIDO DE CONFIRMAÇÃO DOS PRODUTOS NOVOS.
   *
   * O botão de entrada mandava `createMissing: true` sempre: todo item sem
   * casamento virava produto novo com preço zero, sem ninguém ser perguntado.
   * Agora cadastrar é um segundo gesto, com a lista do que vai nascer na tela.
   */
  const [confirmandoNovos, setConfirmandoNovos] = useState(false);
  /**
   * O RESUMO DAS DIVERGÊNCIAS ANTES DA ENTRADA (B-estoque-entrada-M03).
   *
   * A linha com "chegou" diferente do faturado entrava no primeiro clique: o
   * campo apagado e esquecido virava "chegou zero", as peças não entravam e a
   * dívida saía cheia, sem ninguém ser perguntado. Com divergência, a entrada
   * é um segundo gesto, com a lista na tela.
   */
  const [confirmandoDivergencias, setConfirmandoDivergencias] = useState(false);
  const [divergenciasAceitas, setDivergenciasAceitas] = useState(false);
  /**
   * A NOTA ESTORNADA QUE O MESMO XML PODE REABRIR (B-estoque-entrada-08): o
   * servidor pergunta antes (`CORE_NOTE_REVERSED_REOPENABLE`) e a tela guarda o
   * arquivo lido para a resposta não exigir escolher o arquivo de novo.
   */
  const [estornadaParaReabrir, setEstornadaParaReabrir] = useState<{ xml: string; texto: string } | null>(
    null,
  );
  /*
    AS CONFERÊNCIAS EM VOO (B-estoque-entrada-15).

    O campo "Chegou" grava no blur, e o clique em "Dar entrada" disparava a
    confirmação em paralelo, sem esperar: se a gravação falhasse (rede, 400),
    o erro aparecia e a entrada seguia com a quantidade do XML — a falta de 2
    sumia e o saldo mentia. A confirmação espera as gravações e recusa se
    alguma linha não foi gravada.
  */
  const conferenciasEmVoo = useRef(new Set<Promise<boolean>>());
  /*
    A falha é da LINHA E DO CAMPO (`<índice>:chegou|fator|motivo`) — revisão do
    B-15. Com a chave só por linha, quem via o 400, desistia e redigitava o valor
    que já estava gravado (o blur sem mudança não viaja, B-18) ficava preso: a
    marca de falha nunca saía e "Dar entrada" recusava para sempre, embora a tela
    e o servidor já dissessem o mesmo.
  */
  const linhasQueFalharam = useRef(new Set<string>());
  /** Os itens mais novos, sem esperar a renderização — é o que a confirmação lê. */
  const itensAtuais = useRef<NoteItem[] | null>(null);
  itensAtuais.current = items;

  /** Bancadas que guardam peça — as únicas que a conversão aceita. */
  const [oficinas, setOficinas] = useState<Workshop[]>([]);
  /**
   * O que JÁ é peça, por produto.
   *
   * Sem isto a coluna ofereceria "marcar como peça" para o que já é peça, e a
   * pessoa marcaria de novo sem saber que não precisava. A lista vem de
   * `listParts`, que é o mesmo endereço da tela de Peças: uma segunda consulta
   * de "o que é peça" seria uma segunda definição de peça.
   */
  const [jaSaoPecas, setJaSaoPecas] = useState<Record<string, string>>({});
  /** Item em conversão e a bancada escolhida. Nulo = ninguém marcando nada. */
  const [marcando, setMarcando] = useState<{ productId: string; workshopId: string } | null>(null);

  /** As notas contra o nosso CNPJ, direto da SEFAZ (rodada 44). */
  const [dfe, setDfe] = useState<DfeDoc[]>([]);
  const [buscandoDfe, setBuscandoDfe] = useState(false);
  /** Justificativa em digitação para "operação não realizada". */
  const [justificando, setJustificando] = useState<{ chave: string; texto: string } | null>(null);
  /** Manifestar é ato fiscal: só gerência vê os botões. */
  const manifesta = useHasProfile('gerente_loja', 'gerente_oficina');
  /**
   * COMO A CONSULTA E A MANIFESTAÇÃO VÃO À SEFAZ (GAP-PRD-168) — o plano que
   * o servidor manda junto com a lista: a mesma política dos atos (cofre ou
   * senha a cada ato). Nulo = o servidor não disse; o pedido sai e ele decide.
   */
  const [planoDfe, setPlanoDfe] = useState<PlanoDoAtoFiscal | null>(null);
  const [avisoDfe, setAvisoDfe] = useState<string | null>(null);
  /** A espera da SEFAZ que ainda vale (R3-DFE) — o botão mostra a hora. */
  const [esperaDfe, setEsperaDfe] = useState<EstadoDaDistribuicao | null>(null);
  /** O ato com a SEFAZ à espera da senha do A1 — só quando a política a pede. */
  const [pedindoSenha, setPedindoSenha] = useState<{
    descricao: string;
    aviso: string | null;
    enviar: (senha: string) => void;
  } | null>(null);
  const dfePedeSenha = planoDfe?.caminho === 'SEFAZ' && planoDfe.senha === 'OBRIGATORIA';
  const dfeBloqueado = planoDfe?.caminho === 'BLOQUEADO';

  /** Os fretes (CT-e) e o input de arquivo próprio deles. */
  const [ctes, setCtes] = useState<CteDoc[]>([]);
  const cteFileRef = useRef<HTMLInputElement>(null);

  /*
    A LISTA EM PÁGINA — GAP-PRD-164.

    A lista parava em 200 e a 201ª nota sumia sem aviso: o estorno ou a
    consulta de uma nota antiga exigia saber que ela existia e ir ao
    relatório. Agora o rodapé diz "mostrando 1–200 de 1.340", anda de página,
    e a busca (número, chave ou fornecedor) acha a antiga sem folhear.

    A primeira página vai SEM parâmetro: o padrão do servidor já é 200, e a
    listagem "de sempre" continua sendo o mesmo pedido de sempre.
  */
  const [paginaNotas, setPaginaNotas] = useState<Pagina<Note> | null>(null);
  const [offsetNotas, setOffsetNotas] = useState(0);
  const [buscaDigitada, setBuscaDigitada] = useState('');
  const [buscaNotas, setBuscaNotas] = useState('');
  useEffect(() => {
    // Espera a pessoa parar de digitar: uma ida por tecla na lista que mais
    // cresce é desperdício — e outra busca volta para a primeira página.
    const timer = window.setTimeout(() => {
      setBuscaNotas(buscaDigitada.trim());
      setOffsetNotas(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [buscaDigitada]);

  const loadNotes = useCallback(async () => {
    try {
      const pagina = await paginaDeNotasDeEntrada<Note>({
        search: buscaNotas || undefined,
        offset: offsetNotas || undefined,
      });
      setNotes(pagina.items);
      setPaginaNotas(pagina);
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao listar as notas.',
      });
    }
  }, [buscaNotas, offsetNotas]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const carregarDfe = useCallback(async () => {
    try {
      const data = await apiRequest<{
        items: DfeDoc[];
        plano?: PlanoDoAtoFiscal | null;
        ambiente?: string | null;
        outroAmbiente?: { ambiente: string; total: number } | null;
        distribuicao?: EstadoDaDistribuicao | null;
      }>('/core/purchases/dfe').then((r) => exigirCampos(r, 'items'));
      setDfe(data.items);
      setPlanoDfe(data.plano ?? null);
      setAvisoDfe(avisoDoOutroAmbiente(data.ambiente ?? null, data.outroAmbiente ?? null));
      setEsperaDfe(esperaVigente(data.distribuicao));
    } catch {
      // O radar da SEFAZ é um extra: sem ele a entrada continua inteira.
      setDfe([]);
      setPlanoDfe(null);
      setAvisoDfe(null);
      setEsperaDfe(null);
    }
  }, []);

  // Vencida a espera, a lista volta a perguntar ao servidor — e o botão reabre.
  useEffect(() => {
    if (!esperaDfe?.proximaConsultaEm) return undefined;
    const faltam = Date.parse(esperaDfe.proximaConsultaEm) - Date.now();
    const timer = window.setTimeout(() => void carregarDfe(), Math.min(Math.max(faltam, 0) + 1000, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [esperaDfe, carregarDfe]);

  const carregarCtes = useCallback(async () => {
    try {
      const data = await apiRequest<{ items: CteDoc[] }>('/core/purchases/cte').then((r) => exigirCampos(r, 'items'));
      setCtes(data.items);
    } catch {
      setCtes([]);
    }
  }, []);

  useEffect(() => {
    void carregarDfe();
    void carregarCtes();
  }, [carregarDfe, carregarCtes]);

  /**
   * O servidor pediu a senha do A1 que não foi mandada? (GAP-PRD-168)
   *
   * O plano pode estar velho — o dono mudou a política com a tela aberta. Aí
   * a recusa não vira mensagem vermelha: vira o diálogo, com o motivo dele.
   */
  const servidorPediuSenha = (err: unknown, senha?: string): err is ApiRequestError =>
    !senha && err instanceof ApiRequestError && err.code === 'CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED';

  const DESCRICAO_DA_BUSCA = 'Buscar na SEFAZ as notas emitidas contra o CNPJ desta empresa.';

  /**
   * Pergunta à SEFAZ o que foi emitido contra o CNPJ desde o último NSU.
   * A senha do A1 só viaja quando a política a pede — e não fica guardada.
   */
  const buscarNaSefaz = async (senha?: string) => {
    setBuscandoDfe(true);
    setMessage(null);
    try {
      const r = await apiRequest<{ novos: number; restamDocumentos?: boolean }>('/core/purchases/dfe/consultar', {
        method: 'POST',
        body: senha ? { certificatePassword: senha } : {},
      }).then((r) => exigirCampos(r, 'novos'));
      const base =
        r.novos > 0
          ? `${r.novos} documento(s) novo(s) da SEFAZ.`
          : 'Nenhum documento novo — a caixa da SEFAZ está em dia.';
      setMessage({
        tone: 'ok',
        // O teto por clique (R3-DFE): o resto vem no próximo clique, sem espera.
        text: r.restamDocumentos ? `${base} Ainda há documentos na SEFAZ — clique em Buscar agora de novo.` : base,
      });
      await carregarDfe();
    } catch (err) {
      if (servidorPediuSenha(err, senha)) {
        setPedindoSenha({
          descricao: DESCRICAO_DA_BUSCA,
          aviso: err.message,
          enviar: (s) => void buscarNaSefaz(s),
        });
        return;
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao consultar a SEFAZ.',
      });
      // A SEFAZ mandou esperar (ou bloqueou): o botão passa a dizer até quando.
      if (err instanceof ApiRequestError && ['CORE_DFE_AGUARDE_A_SEFAZ', 'CORE_DFE_CONSUMO_INDEVIDO'].includes(err.code)) {
        await carregarDfe();
      }
    } finally {
      setBuscandoDfe(false);
    }
  };

  const manifestar = async (chave: string, tipo: string, justification?: string, senha?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(`/core/purchases/dfe/${chave}/manifestar`, {
        method: 'POST',
        body: senha ? { tipo, justification, certificatePassword: senha } : { tipo, justification },
      });
      setJustificando(null);
      setMessage({ tone: 'ok', text: `Manifestação registrada: ${MANIFESTACAO[tipo] ?? tipo}.` });
      await carregarDfe();
    } catch (err) {
      if (servidorPediuSenha(err, senha)) {
        setPedindoSenha({
          descricao: `Manifestar: ${MANIFESTACAO[tipo] ?? tipo}.`,
          aviso: err.message,
          enviar: (s) => void manifestar(chave, tipo, justification, s),
        });
        return;
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao manifestar.',
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * O clique: com o cofre, o pedido sai direto; com a política de senha a
   * cada ato, o diálogo da casa pede a senha antes — nada de `window.prompt`.
   */
  const pedirBusca = () => {
    if (dfePedeSenha) {
      setPedindoSenha({ descricao: DESCRICAO_DA_BUSCA, aviso: null, enviar: (s) => void buscarNaSefaz(s) });
      return;
    }
    void buscarNaSefaz();
  };

  const pedirManifestacao = (chave: string, tipo: string, justification?: string) => {
    if (dfePedeSenha) {
      setPedindoSenha({
        descricao: `Manifestar: ${MANIFESTACAO[tipo] ?? tipo}.`,
        aviso: null,
        enviar: (s) => void manifestar(chave, tipo, justification, s),
      });
      return;
    }
    void manifestar(chave, tipo, justification);
  };

  /**
   * As bancadas e o que já é peça.
   *
   * Só para quem pode converter: pedir a lista para quem não vai ver a coluna
   * seria uma consulta a mais sem leitor — e, para perfis de fora, um 403 no
   * console que assusta sem motivo.
   */
  const carregarPecas = useCallback(async () => {
    if (!marcaPeca) return;
    try {
      const [bancadas, pecas] = await Promise.all([
        coreApi.listWorkshops(),
        coreApi.listParts(),
      ]);
      setOficinas(bancadas.filter((w) => w.capabilities.parts));
      setJaSaoPecas(
        Object.fromEntries(
          pecas.map((p: WorkshopPart) => [p.id, p.workshop_name ?? 'oficina']),
        ),
      );
    } catch {
      // A marcação é um extra desta tela: se falhar, a entrada da nota
      // continua funcionando inteira.
      setOficinas([]);
    }
  }, [marcaPeca]);

  useEffect(() => {
    void carregarPecas();
  }, [carregarPecas]);

  /**
   * MERCADORIA -> PEÇA, com a carga ainda na mesa.
   *
   * O servidor devolve os EFEITOS, e eles vão para a mensagem: despublicar da
   * vitrine e mudar o lado do saldo são consequências que a pessoa precisa ler
   * — e a falta de preço de venda é a mais cara delas, porque é a que faria a
   * peça sair de graça na próxima OS.
   */
  const marcarComoPeca = async (productId: string, workshopId: string, descricao: string) => {
    if (!workshopId) {
      setMessage({ tone: 'error', text: 'Escolha a oficina dona da peça.' });
      return;
    }
    setBusy(true);
    try {
      const r = await coreApi.definirTipoProduto(productId, { kind: 'part', workshopId });
      setMarcando(null);
      await carregarPecas();
      const semPreco = r.efeitos.semPrecoDeVenda
        ? ' Atenção: está SEM preço de venda — a peça não pode ser lançada em OS até alguém definir o preço.'
        : '';
      setMessage({
        tone: r.efeitos.semPrecoDeVenda ? 'info' : 'ok',
        text: `${descricao}: agora é peça de ${r.workshopName ?? 'oficina'}.${
          r.aviso ? ` ${r.aviso}` : ''
        }${semPreco}`,
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao marcar como peça.',
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Registra o que chegou de verdade.
   *
   * O estoque entra com ESTE número, não com o do arquivo: fornecedor que
   * fatura 10 e descarrega 8 faria o saldo mentir sobre a prateleira, e a
   * mentira só apareceria na contagem seguinte, sem ninguém saber a origem.
   */
  /*
    SÓ O QUE A PESSOA MEXEU VIAJA (B-estoque-entrada-18).

    O blur do campo de fator mandava `receivedQuantity = quantity` junto, e o
    blur de "Chegou" sempre enviava: só atravessar os campos com Tab gravava
    "chegou tudo" em itens que ninguém contou, e a coluna passava a dizer
    "Conferido". Agora cada campo manda só o dele — e só quem o campo mudou.
  */
  const conferir = (
    indice: number,
    envio: { receivedQuantity?: string; divergenceNote?: string; conversionFactor?: string },
  ): Promise<boolean> => {
    if (!noteId) return Promise.resolve(false);
    const body: Record<string, unknown> = { itemIndex: indice };
    if (envio.receivedQuantity !== undefined) {
      const texto = String(envio.receivedQuantity).trim();
      const valor = Number(texto.replace(',', '.'));
      if (texto === '' || !Number.isFinite(valor) || valor < 0) return Promise.resolve(false);
      body.receivedQuantity = valor;
      /*
        O motivo VIAJA junto — e quando só a quantidade muda, o motivo já
        gravado é reenviado: com a quantidade, o servidor grava o motivo que
        recebe, e omiti-lo apagaria a explicação que o conferente escreveu.
      */
      body.divergenceNote =
        envio.divergenceNote !== undefined
          ? envio.divergenceNote.trim() || undefined
          : (itensAtuais.current?.[indice]?.divergenceNote ?? undefined);
    } else if (envio.divergenceNote !== undefined) {
      body.divergenceNote = envio.divergenceNote.trim();
    }
    /*
      O FATOR: vazio significa "não mexi nisso" e o valor gravado permanece;
      zero ou negativo o servidor recusa.
    */
    if (envio.conversionFactor !== undefined && String(envio.conversionFactor).trim() !== '') {
      body.conversionFactor = Number(String(envio.conversionFactor).replace(',', '.'));
    }
    const notaDaConferencia = noteId;
    const falha = `${indice}:${
      envio.conversionFactor !== undefined ? 'fator' : envio.divergenceNote !== undefined ? 'motivo' : 'chegou'
    }`;
    const pedido = (async () => {
      try {
        const r = await apiRequest<{ items: NoteItem[] }>(
          `/core/purchases/notes/${notaDaConferencia}/conferir`,
          { method: 'POST', body },
        ).then((r) => exigirCampos(r, 'items'));
        linhasQueFalharam.current.delete(falha);
        itensAtuais.current = r.items;
        setItems(r.items);
        return true;
      } catch (err) {
        linhasQueFalharam.current.add(falha);
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao registrar a conferência.',
        });
        return false;
      }
    })();
    conferenciasEmVoo.current.add(pedido);
    void pedido.finally(() => conferenciasEmVoo.current.delete(pedido));
    return pedido;
  };

  /**
   * A entrada só sai com as conferências GRAVADAS (B-15): espera as que estão a
   * caminho e recusa se alguma linha não foi gravada — o estoque entraria com a
   * quantidade do XML no lugar da contagem que a pessoa digitou.
   */
  const conferenciasGravadas = async (): Promise<boolean> => {
    const emVoo = [...conferenciasEmVoo.current];
    if (emVoo.length > 0) await Promise.all(emVoo);
    if (linhasQueFalharam.current.size === 0) return true;
    const indices = [...new Set([...linhasQueFalharam.current].map((chave) => Number(chave.split(':')[0])))];
    const linhas = indices.map((i) => `"${itensAtuais.current?.[i]?.description ?? `linha ${i + 1}`}"`);
    setMessage({
      tone: 'error',
      text: `A conferência de ${linhas.join(', ')} não foi gravada, e a entrada NÃO foi feita: o estoque `
        + 'entraria com a quantidade da nota. Corrija o campo dessa linha (ou digite de novo) e tente outra vez.',
    });
    return false;
  };

  /**
   * "1 UND = 1 UN" DE UMA VEZ SÓ (B-estoque-entrada-19). O fornecedor que
   * escreve outra sigla para a mesma unidade travava a nota de 60 linhas até
   * alguém digitar "1" em cada uma. Quem confere declara a equivalência uma vez
   * para as linhas daquele par — e as próximas notas do mesmo fornecedor e
   * código já entram sem pergunta (o servidor lembra o fator).
   */
  const declararUmPorUm = async (indices: number[]) => {
    setBusy(true);
    try {
      for (const i of indices) {
        const ok = await conferir(i, { conversionFactor: '1' });
        if (!ok) break;
      }
    } finally {
      setBusy(false);
    }
  };

  const importarDaSefaz = async (chave: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiRequest<{ duplicated: boolean }>(
        `/core/purchases/dfe/${chave}/importar`,
        { method: 'POST', body: {} },
      ).then((r) => exigirCampos(r, 'duplicated'));
      setMessage({
        tone: 'ok',
        text: r.duplicated
          ? 'Esta nota já estava no funil de conferência.'
          : 'Nota importada — está na lista de notas, em conferência.',
      });
      await Promise.all([loadNotes(), carregarDfe()]);
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao importar a nota.',
      });
    } finally {
      setBusy(false);
    }
  };

  /** O conhecimento do frete entra pelo MESMO gesto do XML da nota. */
  const onCteFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const xml = await file.text();
      const r = await apiRequest<{ duplicated: boolean; freightCents: number }>(
        '/core/purchases/cte/import',
        { method: 'POST', body: { xml } },
      ).then((r) => exigirCampos(r, 'duplicated', 'freightCents'));
      setMessage({
        tone: 'ok',
        text: r.duplicated
          ? 'Este CT-e já havia sido importado.'
          : `Frete de ${formatCents(r.freightCents)} registrado.`,
      });
      await carregarCtes();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao importar o CT-e.',
      });
    } finally {
      setBusy(false);
      if (cteFileRef.current) cteFileRef.current.value = '';
    }
  };

  /**
   * O XML do fornecedor, como ele chegou.
   *
   * O arquivo vem por `apiBinary` e não por um link: `authMiddleware` lê o
   * token só do cabeçalho `Authorization`, e um `<a href>` para esta rota
   * receberia 401 em vez do arquivo.
   *
   * Os dois "não existe" do servidor têm códigos diferentes, e é aqui que essa
   * diferença serve para alguma coisa: `CORE_INBOUND_NOTE_XML_AUSENTE` é a
   * nota antiga, cujo arquivo nunca foi guardado e não tem como voltar — a
   * mensagem do servidor já diz isso, e repeti-la com outras palavras aqui
   * criaria duas versões da mesma verdade. `CORE_INBOUND_NOTE_NOT_FOUND` é
   * outra coisa: a lista está velha, e o gesto certo é recarregá-la.
   */
  const baixarXml = async (nota: Note) => {
    setMessage(null);
    try {
      const arquivo = await apiBinary(
        `/core/purchases/notes/${nota.id}/xml`,
        `${nota.access_key}-nfe.xml`,
      );
      salvarArquivo(arquivo.blob, arquivo.nomeArquivo);
    } catch (err) {
      const codigo = err instanceof ApiRequestError ? err.code : '';
      if (codigo === 'CORE_INBOUND_NOTE_NOT_FOUND') {
        await loadNotes();
        setMessage({
          tone: 'error',
          text: 'Esta nota não está mais nesta operação. A lista foi recarregada.',
        });
        return;
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao baixar o XML da nota.',
      });
    }
  };

  /**
   * ESTORNO da entrada confirmada (GAP-V20).
   *
   * O motivo é pedido ANTES de qualquer viagem — o servidor o exige, e mandar
   * requisição para tomar 400 ensinaria a pessoa a desconfiar do botão. As
   * recusas do servidor (dívida baixada, mercadoria que já saiu) chegam com a
   * frase dele, e a tela só a repete.
   */
  const estornar = async (nota: Note) => {
    const motivo = await pedirMotivo({
      titulo: 'Estornar esta entrada confirmada?',
      explicacao: 'O estoque desce pelo movimento contrário e o motivo fica registrado na nota.',
      rotulo: 'Motivo do estorno',
      minimo: 3,
      confirmar: 'Estornar a entrada',
      perigoso: true,
    });
    if (!motivo || !motivo.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await coreApi.estornarInboundNote(nota.id, motivo.trim());
      setMessage(
        r.alreadyReversed
          ? { tone: 'info', text: 'Esta nota já estava estornada. Nada mudou.' }
          : {
              tone: 'ok',
              text:
                `Entrada estornada: o estoque desceu pelo movimento contrário${
                  r.financeCancelled ? ' e a dívida aberta foi cancelada' : ''
                }. O razão guarda a entrada E o estorno.`,
            },
      );
      // A conferência aberta da nota estornada sai da mesa: documento morto.
      if (noteId === nota.id) {
        setNoteId(null);
        setItems(null);
      }
      await loadNotes();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao estornar a entrada.',
      });
    } finally {
      setBusy(false);
    }
  };

  const openNote = useCallback(async (id: string) => {
    setNoteId(id);
    /*
      A conferência da nota ANTERIOR some antes de a nova chegar. Sem isto,
      a tabela velha renderizava por um instante sob o noteId novo — e como
      os inputs são não-controlados, o campo nascia com o defaultValue da
      nota errada e ali ficava. Visto no teste da troca de notas.
    */
    setItems(null);
    // A busca aberta e o pedido de cadastro são DA NOTA ANTERIOR.
    setVinculando(null);
    setConfirmandoNovos(false);
    // A divergência aceita e a linha que falhou são DA NOTA ANTERIOR.
    setConfirmandoDivergencias(false);
    setDivergenciasAceitas(false);
    linhasQueFalharam.current.clear();
    const data = await apiRequest<{ items: NoteItem[] }>(`/core/purchases/notes/${id}/items`).then((r) => exigirCampos(r, 'items'));
    itensAtuais.current = data.items;
    setItems(data.items);
  }, []);

  const importarXml = async (xml: string, reabrirEstornada = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiRequest<{
        noteId: string;
        duplicated: boolean;
        items: NoteItem[];
        reabriuEstornada?: string;
      }>('/core/purchases/nfe/import', {
        method: 'POST',
        body: reabrirEstornada ? { xml, reabrirEstornada: true } : { xml },
      }).then((r) => exigirCampos(r, 'noteId', 'duplicated', 'items'));

      setEstornadaParaReabrir(null);
      setNoteId(result.noteId);
      itensAtuais.current = result.items;
      setItems(result.items);
      setVinculando(null);
      setConfirmandoNovos(false);
      setConfirmandoDivergencias(false);
      setDivergenciasAceitas(false);
      linhasQueFalharam.current.clear();
      setMessage(
        result.duplicated
          ? { tone: 'info', text: 'Esta nota já havia sido importada. Nada foi duplicado.' }
          : result.reabriuEstornada
            ? {
                tone: 'ok',
                text: 'Nova conferência aberta com o mesmo XML — a nota estornada continua no histórico. '
                  + 'Confira os itens antes de dar entrada.',
              }
            : { tone: 'ok', text: 'Nota importada. Confira os itens antes de dar entrada.' },
      );
      await loadNotes();
    } catch (err) {
      /*
        A NOTA ESTORNADA COM O MESMO XML (B-08): o servidor pergunta, e a tela
        oferece a nova conferência com o arquivo que já leu.
      */
      if (err instanceof ApiRequestError && err.code === 'CORE_NOTE_REVERSED_REOPENABLE') {
        setEstornadaParaReabrir({ xml, texto: err.message });
        return;
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao ler o arquivo XML.',
      });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await importarXml(await file.text());
    } catch {
      setMessage({ tone: 'error', text: 'Falha ao ler o arquivo XML.' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /**
   * O ITEM DA NOTA LIGADO AO PRODUTO QUE JÁ EXISTE (GAP-PRD-015).
   *
   * O servidor devolve a nota inteira de novo, e é ela que vai para a tabela:
   * a linha ganha o nome do produto escolhido e o método "vínculo manual", e a
   * contagem de pendentes desce sozinha.
   */
  const vincularItem = async (indice: number, produto: Product, lembrar: boolean) => {
    if (!noteId) return;
    setBusy(true);
    setMessage(null);
    try {
      const novos = await entradaNotasApi.linkInboundNoteItem(noteId, {
        itemIndex: indice,
        productId: produto.id,
        lembrar,
      });
      setItems(novos);
      setVinculando(null);
      setMessage({
        tone: 'ok',
        text: `"${items?.[indice]?.description ?? 'Item'}" vinculado a ${produto.name}.${
          lembrar ? ' As próximas notas deste fornecedor com o mesmo código casam sozinhas.' : ''
        }`,
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao vincular o item.',
      });
    } finally {
      setBusy(false);
    }
  };

  /** Desfaz o casamento que errou: o item volta para "sem produto". */
  const desvincularItem = async (indice: number) => {
    if (!noteId) return;
    setBusy(true);
    setMessage(null);
    try {
      setItems(await entradaNotasApi.unlinkInboundNoteItem(noteId, indice));
      setMessage({
        tone: 'info',
        text: `"${items?.[indice]?.description ?? 'Item'}" ficou sem produto. Vincule ao produto certo ou deixe que a entrada o cadastre como novo.`,
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao desfazer o vínculo.',
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * A ENTRADA — e o cadastro de produto novo como gesto SEPARADO.
   *
   * `autorizarNovos` só é verdadeiro quando a pessoa leu a lista do que vai
   * nascer e clicou em "cadastrar". Sem item pendente, a entrada vai sem
   * autorização nenhuma — e se a lista da tela estiver velha, o servidor
   * recusa com CORE_UNMATCHED_ITEMS em vez de cadastrar em silêncio.
   */
  const confirm = async (autorizarNovos = false, divergenciasOk = false) => {
    if (!noteId) return;
    // As contagens digitadas vão para o servidor ANTES da entrada (B-15).
    if (!(await conferenciasGravadas())) return;
    const atuais = itensAtuais.current ?? [];
    const divergentes = atuais.filter(
      (i) => i.receivedQuantity !== null && i.receivedQuantity !== undefined && i.receivedQuantity !== i.quantity,
    );
    if (divergentes.length > 0 && !divergenciasOk && !divergenciasAceitas) {
      setVinculando(null);
      setConfirmandoNovos(false);
      setConfirmandoDivergencias(true);
      return;
    }
    const semProduto = atuais.filter((i) => !i.productId).length;
    if (semProduto > 0 && !autorizarNovos) {
      setVinculando(null);
      setConfirmandoNovos(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiRequest<{
        createdProducts: number;
        movedItems: number;
        alreadyReceived: boolean;
        semContaAPagar?: string | null;
        aviso?: string | null;
      }>(`/core/purchases/notes/${noteId}/confirm`, {
        method: 'POST',
        body: { createMissing: autorizarNovos },
      }).then((r) => exigirCampos(r, 'createdProducts', 'movedItems', 'alreadyReceived'));
      setConfirmandoNovos(false);
      setConfirmandoDivergencias(false);
      setMessage(
        result.alreadyReceived
          ? { tone: 'info', text: 'Esta nota já havia sido recebida.' }
          : {
              // A nota mista e a remessa sem ônus dizem o que houve com a dívida (B-03).
              tone: result.aviso ? 'info' : 'ok',
              text: `Entrada concluída: ${result.movedItems} item(ns) no estoque, ${result.createdProducts} produto(s) cadastrado(s).${
                result.semContaAPagar ? ` ${result.semContaAPagar}` : ''
              }${result.aviso ? ` ${result.aviso}` : ''}`,
            },
      );
      await loadNotes();
      await openNote(noteId);
      /*
        O QUE A NOTA FEZ COM O PREÇO.

        A confirmação atualiza o CUSTO e deixa o preço onde estava. O
        fornecedor aumenta, a margem encolhe, e sem este passo ninguém percebe
        até o fechamento do mês.
      */
      await carregarSugestoes(noteId);
    } catch (err) {
      /*
        A tela achava que estava tudo vinculado e o servidor discorda (lista
        velha: outra pessoa desfez um vínculo). A nota é relida e o pedido de
        cadastro aparece com a lista VERDADEIRA — nada nasce sem ser mostrado.
      */
      if (err instanceof ApiRequestError && err.code === 'CORE_UNMATCHED_ITEMS') {
        try {
          await openNote(noteId);
          setConfirmandoNovos(true);
        } catch {
          // Sem a releitura, a frase do servidor abaixo ainda diz o que fazer.
        }
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao confirmar a entrada.',
      });
    } finally {
      setBusy(false);
    }
  };

  const carregarSugestoes = async (id: string) => {
    try {
      const r = await apiRequest<{ suggestions: SugestaoDePreco[] }>(
        `/core/purchases/notes/${id}/repricing`,
      ).then((r) => exigirCampos(r, 'suggestions'));
      // Só o que precisa de atenção. Listar o catálogo inteiro afogaria o
      // que importa.
      setSugestoes(r.suggestions.filter((s) => s.abaixoDoCusto || s.abaixoDoMinimo));
      setPrecosEditados({});
    } catch {
      // O assistente é um extra: se ele falhar, a entrada continua feita.
      setSugestoes([]);
    }
  };

  const aplicarPrecos = async () => {
    const prices = sugestoes
      .map((s) => ({
        productId: s.productId,
        priceCents:
          precosEditados[s.productId] ?? s.precoSugeridoCents ?? s.precoAtualCents,
      }))
      .filter((p, i) => p.priceCents !== sugestoes[i].precoAtualCents);

    if (prices.length === 0) return;
    setBusy(true);
    try {
      const r = await apiRequest<{ atualizados: number }>('/core/purchases/repricing/apply', {
        method: 'POST',
        body: { prices, noteId },
      }).then((r) => exigirCampos(r, 'atualizados'));
      setMessage({ tone: 'ok', text: `${r.atualizados} preço(s) atualizado(s).` });
      if (noteId) await carregarSugestoes(noteId);
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao aplicar os preços.',
      });
    } finally {
      setBusy(false);
    }
  };

  const pending = items?.filter((i) => !i.productId).length ?? 0;
  /*
    A COLUNA DE PEÇA SÓ EXISTE DEPOIS DA ENTRADA.

    Antes de confirmar, o item novo ainda não tem produto: não há id para
    converter, e o botão só poderia mentir. Depois de confirmada, todo item tem
    produto — inclusive os que a confirmação acabou de criar.
  */
  /*
    A NOTA ABERTA FORA DA PÁGINA (GAP-PRD-164).

    A ficha lê espécie, status e fornecedor da LINHA da lista. Com a lista em
    página, a nota antiga que chega pelo link do contas a pagar (ou pela
    busca, depois apagada) pode não estar entre as que vieram — e a ficha
    abria sem saber se podia vincular, estornar ou de onde vinham os títulos.
    Nesse caso, e só nele, a tela pergunta pela nota em si (`?id=`), pela
    MESMA consulta da lista.
  */
  const [notaForaDaPagina, setNotaForaDaPagina] = useState<Note | null>(null);
  const naPagina = notes.find((n) => n.id === noteId) ?? null;
  useEffect(() => {
    if (!noteId || naPagina || !paginaNotas) {
      setNotaForaDaPagina(null);
      return;
    }
    let vivo = true;
    paginaDeNotasDeEntrada<Note>({ id: noteId })
      .then((p) => {
        if (vivo) setNotaForaDaPagina(p.items.find((n) => n.id === noteId) ?? null);
      })
      .catch(() => {
        if (vivo) setNotaForaDaPagina(null);
      });
    return () => {
      vivo = false;
    };
  }, [noteId, naPagina, paginaNotas]);
  const notaAberta = naPagina ?? (notaForaDaPagina?.id === noteId ? notaForaDaPagina : null);
  const podeMarcarPecas = marcaPeca && notaAberta?.status === 'recebida';
  /*
    VINCULAR SÓ EM CONFERÊNCIA — o mesmo recorte do servidor (GAP-PRD-085).
    Na nota recebida ou estornada o item não troca mais de produto, e oferecer
    o botão seria prometer o que a rota recusa com 409.
  */
  const podeVincular = vincula && notaAberta?.status === 'conferencia';
  const semProduto = items?.filter((i) => !i.productId) ?? [];
  /*
    NOTA RECEBIDA OU ESTORNADA NÃO SE CONFERE (B-estoque-entrada-18): os campos
    "Chegou", fator e motivo ficavam editáveis em qualquer status, e passar por
    eles com Tab numa nota recebida trazia o 409 do servidor em vermelho. O
    botão de entrada também sai — ele só serve à nota em conferência. Enquanto
    a linha da nota não chegou, vale o que o servidor decidir.
  */
  const somenteLeitura = Boolean(notaAberta) && notaAberta?.status !== 'conferencia';
  const divergentesDaTela = (items ?? []).filter(
    (i) => i.receivedQuantity !== null && i.receivedQuantity !== undefined && i.receivedQuantity !== i.quantity,
  );
  /*
    As linhas que a confirmação vai recusar por unidade (M05 diz: fator nulo),
    agrupadas pelo par de siglas — "UND" contra "UN" é UMA pergunta, não
    sessenta (B-19).
  */
  const paresSemFator = (() => {
    const pares = new Map<string, { daNota: string; doCadastro: string; indices: number[] }>();
    (items ?? []).forEach((r, i) => {
      if (!r.productId || r.resolvedFactor !== null || r.conversionFactor) return;
      const daNota = String(r.unit ?? '').trim().toUpperCase();
      const doCadastro = String(r.productUnit ?? '').trim().toUpperCase();
      if (!daNota || !doCadastro || daNota === doCadastro) return;
      const chave = `${daNota}→${doCadastro}`;
      const par = pares.get(chave) ?? { daNota, doCadastro, indices: [] };
      par.indices.push(i);
      pares.set(chave, par);
    });
    return [...pares.values()];
  })();

  /*
    A NOTA QUE VEIO PELO LINK — `/sistema/compras/entrada-notas?nota=<id>`.

    O título do contas a pagar já dizia "Nota 4711 — Distribuidora Alfa" e
    navegava até AQUI: a lista inteira, com a 4711 perdida entre duzentas
    linhas. O parâmetro fecha o último passo, e pelo MESMO `openNote` do clique
    — um segundo carregador teria de aprender tudo o que aquele já sabe (limpar
    a conferência anterior antes de trocar de nota, entre outras coisas).

    Roda uma vez por id: `openNote` é estável e o efeito só dispara quando o
    parâmetro muda. O parâmetro NÃO é consumido — abrir nota não destrói nada, e
    um F5 tem de continuar mostrando a mesma nota.
  */
  const [paramsDaUrl, setParamsDaUrl] = useSearchParams();
  const notaPedida = paramsDaUrl.get(PARAM_DA_NOTA);
  /*
    QUAL PARÂMETRO JÁ FOI HONRADO — e por que um ref, e não um estado.

    Sem esta marca, o clique em "Abrir" abriria a nota DUAS vezes: uma pelo
    próprio clique e outra pelo efeito, quando o parâmetro que o clique acabou
    de escrever chegasse. Duas leituras da mesma nota é desperdício visível
    (dois GETs) e um piscar de tabela vazia entre elas.

    Ref e não estado porque isto não desenha nada: guardar em `useState`
    provocaria uma renderização a mais só para registrar o que já aconteceu.
  */
  const urlJaHonrada = useRef<string | null>(null);
  useEffect(() => {
    if (!notaPedida || urlJaHonrada.current === notaPedida) return;
    urlJaHonrada.current = notaPedida;
    void openNote(notaPedida).catch(() => {
      setMessage({ tone: 'error', text: 'Não foi possível abrir a nota deste link.' });
    });
  }, [notaPedida, openNote]);

  /*
    OS TÍTULOS DA NOTA ABERTA.

    A ORIGEM depende da ESPÉCIE do papel: a NF-e grava 'nfe_entrada' e a compra
    digitada grava 'entrada_manual' (GAP-V17), de propósito, e as duas moram na
    mesma tabela. Perguntar sempre com a mesma origem devolveria lista vazia
    para metade das notas — e vazio, aqui, é indistinguível de "não gerou
    dívida". `origemDaNota` é o mesmo `doc_type === 'manual'` que o servidor usa
    para escrever.

    Depende de `notaAberta` e não de `noteId` porque é dela que sai o
    `doc_type`: enquanto a lista não chegou, não há como saber a espécie, e
    chutar seria perguntar errado.
  */
  useEffect(() => {
    if (!notaAberta) {
      setTitulos(null);
      setErroTitulos(null);
      return;
    }
    let vivo = true;
    setTitulos(null);
    setErroTitulos(null);
    void coreApi
      .listFinanceEntries({
        originType: origemDaNota(notaAberta.doc_type),
        originId: notaAberta.id,
      })
      /*
        `envelope('items')` e não `r.items` cru: um 200 com corpo sem `items`
        (servidor anterior, proxy que reescreve, rota trocada) fazia
        `titulos.length` estourar num `TypeError` e derrubar a ficha INTEIRA —
        tela branca, longe da causa. O desembrulho oficial transforma isso na
        falha declarada que o bloco já sabe desenhar.
      */
      .then(envelope('items'))
      .then((items) => {
        if (vivo) setTitulos(items);
      })
      .catch((err) => {
        if (!vivo) return;
        setTitulos([]);
        setErroTitulos(
          err instanceof ApiRequestError
            ? err.message
            : 'Falha ao consultar os títulos desta nota.',
        );
      });
    return () => {
      vivo = false;
    };
  }, [notaAberta]);

  /** Abrir pela lista também escreve o endereço: a URL descreve a tela. */
  const abrirEEnderecar = useCallback(
    async (id: string) => {
      // O efeito acima não repete o que este clique já está fazendo.
      urlJaHonrada.current = id;
      setParamsDaUrl({ [PARAM_DA_NOTA]: id }, { replace: true });
      await openNote(id);
    },
    [openNote, setParamsDaUrl],
  );

  return (
    <AppShell>
      {dialogoDeMotivo}
      <PageHeader
        breadcrumb={['Estoque', 'Entrada de notas']}
        title="Entrada de notas"
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".xml,text/xml,application/xml"
              onChange={(e) => void onFile(e)}
              className="sr-only"
              id="nfe-file"
            />
            {/* A compra SEM nota fiscal tem porta própria — nunca disfarçada
                de importação (GAP-V17). */}
            {lancaManual && (
              <Button variant="secondary" onClick={() => setManualAberta((v) => !v)}>
                Entrada manual
              </Button>
            )}
            <Button onClick={() => fileRef.current?.click()} loading={busy}>
              Importar XML
            </Button>
          </>
        }
      />

      {message && (
        <div
          role="status"
          className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] ${
            message.tone === 'ok'
              ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
              : message.tone === 'info'
                ? 'bg-[var(--gs-info-bg)] text-[var(--gs-info)]'
                : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
          }`}
        >
          {message.text}
        </div>
      )}

      {/*
        A NOTA ESTORNADA QUE O MESMO XML REABRE (B-08). O servidor já disse o
        que houve (quando, por quê); a tela oferece o gesto — uma conferência
        NOVA, com a estornada preservada no histórico.
      */}
      {estornadaParaReabrir && (
        <div
          role="alertdialog"
          aria-label="Nota estornada"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
            text-[length:var(--gs-text-sm)] flex flex-col gap-2"
        >
          <p className="text-[var(--gs-text)]">{estornadaParaReabrir.texto}</p>
          <span className="flex gap-2 flex-wrap">
            <Button
              variant="success"
              loading={busy}
              onClick={() => void importarXml(estornadaParaReabrir.xml, true)}
            >
              Abrir nova conferência com este XML
            </Button>
            <Button variant="ghost" onClick={() => setEstornadaParaReabrir(null)}>
              Cancelar
            </Button>
          </span>
        </div>
      )}

      {manualAberta && (
        <EntradaManualCard
          aoLancar={async (noteId, duplicated) => {
            setManualAberta(false);
            setMessage(
              duplicated
                ? { tone: 'info', text: 'Esta entrada manual já havia sido lançada. Nada foi duplicado.' }
                : {
                    tone: 'ok',
                    text: 'Entrada manual lançada — está em conferência. Revise os itens e dê entrada no estoque.',
                  },
            );
            await loadNotes();
            await openNote(noteId);
          }}
        />
      )}

      {items && (
        <Card
          title="Conferência da nota"
          className="mb-5"
          padded={false}
          actions={
            somenteLeitura ? (
              /*
                A NOTA RECEBIDA LEVA ÀS ETIQUETAS DO QUE ENTROU (B-estoque-entrada-07).
                Só a recebida: a nota em conferência ainda não pôs nada na
                prateleira, e a estornada tirou o que tinha posto.
              */
              notaAberta?.status === 'recebida' && abreEtiquetas && noteId ? (
                <Link
                  to={`/sistema/etiquetas?origem=nota&nota=${encodeURIComponent(noteId)}`}
                  className="inline-flex items-center rounded-[var(--gs-radius)] border border-[var(--gs-border)] px-3 py-1.5 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-purple-700)] hover:bg-[var(--gs-surface-muted)]"
                >
                  Imprimir etiquetas desta entrada
                </Link>
              ) : undefined
            ) : (
              <Button variant="success" onClick={() => void confirm()} loading={busy}>
                Dar entrada no estoque
              </Button>
            )
          }
        >
          <div className="px-5 py-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] border-b border-[var(--gs-border)]">
            {/*
              A FRASE ANTIGA PROMETIA O ERRO: "serão cadastrados na confirmação".
              Era a única saída que a tela oferecia, e o produto que já existia
              ganhava um gêmeo de preço zero (GAP-PRD-015). Agora ela aponta o
              caminho certo primeiro.
            */}
            {pending > 0
              ? podeVincular
                ? `${pending} item(ns) sem produto no catálogo. Se o produto já existe, use "Vincular" na linha — o que ficar sem vínculo só vira produto novo (preço de venda zero) se você autorizar na entrada.`
                : `${pending} item(ns) sem produto no catálogo — a entrada pede autorização antes de cadastrá-los como produtos novos.`
              : 'Todos os itens já estão vinculados a produtos do catálogo.'}
            {/*
              O aviso é o que transforma a coluna nova em caminho conhecido: o
              produto criado pela nota nasce como mercadoria de revenda e com
              preço zero, e quem recebeu a carga é quem sabe que aquilo ali é
              peça de bancada.
            */}
            {podeMarcarPecas && (
              <>
                {' '}
                O que for peça de bancada pode ser marcado na última coluna — o produto criado pela
                nota nasce como mercadoria de revenda.
              </>
            )}
            {/* PARA QUEM a nota foi emitida (B-02) — a conferência de que ela é desta loja. */}
            {notaAberta?.recipient_document && (
              <>
                {' '}
                Destinatário da nota: {notaAberta.recipient_name ? `${notaAberta.recipient_name} — ` : ''}
                {notaAberta.recipient_document}.
              </>
            )}
            {/* A remessa sem ônus que entrou sem conta a pagar, e por quê (B-03). */}
            {notaAberta?.finance_waiver_reason && <> {notaAberta.finance_waiver_reason}</>}
            {!somenteLeitura && paresSemFator.length > 0 && (
              <span className="flex gap-2 flex-wrap mt-2">
                {paresSemFator.map((par) => (
                  <Button
                    key={`${par.daNota}-${par.doCadastro}`}
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onClick={() => void declararUmPorUm(par.indices)}
                  >
                    {`Declarar 1 ${par.daNota} = 1 ${par.doCadastro} (${par.indices.length} linha(s))`}
                  </Button>
                ))}
              </span>
            )}
          </div>
          {/*
            AS DIVERGÊNCIAS, ANTES DA ENTRADA (M03): o que chegou diferente do
            faturado vira estoque pelo que CHEGOU e dívida pelo total da nota —
            e isso é mostrado, não descoberto depois.
          */}
          {confirmandoDivergencias && divergentesDaTela.length > 0 && (
            <div
              role="alertdialog"
              aria-label="Conferir divergências"
              className="px-5 py-4 border-b border-[var(--gs-border)] bg-[var(--gs-warning-bg)]
                text-[length:var(--gs-text-sm)] flex flex-col gap-2"
            >
              <p className="text-[var(--gs-text)]">
                <strong>{divergentesDaTela.length} item(ns) chegaram diferente da nota.</strong> O estoque
                entra com o que CHEGOU; a conta a pagar sai pelo total da nota:
              </p>
              <ul className="list-disc pl-5 text-[var(--gs-text)]">
                {divergentesDaTela.map((i, n) => (
                  <li key={`${noteId}-dif-${n}`}>
                    {i.description}: nota {formatQuantity(i.quantity)}, chegou{' '}
                    {formatQuantity(i.receivedQuantity ?? 0)}
                  </li>
                ))}
              </ul>
              <span className="flex gap-2 flex-wrap">
                <Button
                  variant="success"
                  loading={busy}
                  onClick={() => {
                    setDivergenciasAceitas(true);
                    setConfirmandoDivergencias(false);
                    void confirm(false, true);
                  }}
                >
                  Dar entrada com o que chegou
                </Button>
                <Button variant="ghost" onClick={() => setConfirmandoDivergencias(false)}>
                  Voltar e conferir
                </Button>
              </span>
            </div>
          )}
          {/*
            O CADASTRO DE PRODUTO NOVO É UM SEGUNDO GESTO, COM A LISTA NA TELA.

            Antes, "Dar entrada no estoque" mandava `createMissing: true` sempre.
            Quem clicava não era avisado de que três itens estavam prestes a virar
            cadastros novos — e um deles era o cabo que já estava na prateleira.
          */}
          {confirmandoNovos && semProduto.length > 0 && (
            <div
              role="alertdialog"
              aria-label="Cadastrar produtos novos"
              className="px-5 py-4 border-b border-[var(--gs-border)] bg-[var(--gs-warning-bg)]
                text-[length:var(--gs-text-sm)] flex flex-col gap-2"
            >
              <p className="text-[var(--gs-text)]">
                <strong>
                  {semProduto.length} item(ns) sem vínculo vão virar produtos NOVOS no catálogo
                </strong>
                , com o custo da nota e preço de venda zero:
              </p>
              <ul className="list-disc pl-5 text-[var(--gs-text)]">
                {semProduto.map((i, n) => (
                  <li key={`${noteId}-novo-${n}`}>
                    {i.description}
                    {i.supplierCode ? ` (código do fornecedor ${i.supplierCode})` : ''}
                  </li>
                ))}
              </ul>
              <p className="text-[var(--gs-text-soft)]">
                Se algum deles já existe no catálogo, volte e vincule: senão o saldo sobe num segundo
                cadastro e o produto verdadeiro fica com o saldo velho.
              </p>
              <span className="flex gap-2 flex-wrap">
                <Button variant="success" loading={busy} onClick={() => void confirm(true, true)}>
                  Cadastrar {semProduto.length} e dar entrada
                </Button>
                <Button variant="ghost" onClick={() => setConfirmandoNovos(false)}>
                  Voltar e vincular
                </Button>
              </span>
            </div>
          )}
          <DataTable
            columns={[
              { header: 'Descrição', render: (r: NoteItem) => r.description },
              /*
                O ESTADO DE CADA DADO FISCAL (B-10): o NCM da nota diferente do
                cadastro passava sem aviso, "SEM GTIN" aparecia igual a código
                ausente, e o CEST e a origem declarados nunca eram vistos.
              */
              {
                header: 'EAN',
                render: (r: NoteItem) => (
                  <DadoFiscal
                    valor={r.barcode ?? (r.semGtin ? 'SEM GTIN' : '—')}
                    estado={r.fiscal?.barcode}
                  />
                ),
              },
              {
                header: 'NCM',
                render: (r: NoteItem) => (
                  <DadoFiscal valor={r.ncm ?? '—'} estado={r.fiscal?.ncm} doCadastro={r.productNcm} />
                ),
              },
              {
                header: 'CEST',
                render: (r: NoteItem) => (
                  <DadoFiscal valor={r.cest ?? '—'} estado={r.fiscal?.cest} doCadastro={r.productCest} />
                ),
              },
              {
                header: 'Origem',
                render: (r: NoteItem) => (
                  <DadoFiscal valor={r.origin ?? '—'} estado={r.fiscal?.origin} doCadastro={r.productOrigin} />
                ),
              },
              { header: 'CFOP', render: (r: NoteItem) => r.cfop ?? '—' },
              { header: 'Un.', render: (r: NoteItem) => r.unit ?? '—' },
              {
                /*
                  A CONVERSÃO, onde quem confere a enxerga.

                  Fornecedor fatura em CX, a loja vende em UN, e o sistema
                  não tem como saber quantas vêm dentro. Quando a própria
                  nota diz (o par tributável), a coluna já mostra o número
                  e ninguém digita nada. Quando não diz, o servidor recusa
                  a entrada — e é este campo que destrava.
                */
                header: 'Un. do cadastro por un. da nota',
                align: 'right',
                render: (r: NoteItem, i: number) => {
                  /*
                    O PLACEHOLDER É O QUE A CONFIRMAÇÃO VAI APLICAR (M05). Era
                    `qTrib/qCom` sempre: prometia "12" onde o servidor aplica 1 e
                    "1" onde ele recusa. Nulo = a confirmação vai pedir o número,
                    e o campo diz isso com a borda de alerta.
                  */
                  const precisaInformar = r.resolvedFactor === null && !r.conversionFactor;
                  const sugerido =
                    r.resolvedFactor !== undefined
                      ? r.resolvedFactor === null
                        ? 'informe'
                        : String(r.resolvedFactor)
                      : r.quantityTrib && r.quantity
                        ? String(r.quantityTrib / r.quantity)
                        : '1';
                  return (
                    <input
                      // O valor gravado vira o novo padrão do campo (a declaração
                      // "1 UND = 1 UN" em lote aparece na linha).
                      key={`${r.chaveDaLinha ?? i}-${r.conversionFactor ?? ''}`}
                      type="number"
                      min="0"
                      step="any"
                      aria-label={`Quantas unidades do cadastro vêm em uma da nota, em ${r.description}`}
                      placeholder={sugerido}
                      disabled={somenteLeitura}
                      defaultValue={r.conversionFactor ?? ''}
                      onBlur={(e) => {
                        const digitado = e.target.value.trim();
                        // Só o que MUDOU viaja (B-18); vazio é "não mexi".
                        if (digitado === '' || digitado === String(r.conversionFactor ?? '')) {
                          e.target.value = String(r.conversionFactor ?? '');
                          // O campo voltou ao gravado: a falha dele não vale mais.
                          linhasQueFalharam.current.delete(`${i}:fator`);
                          return;
                        }
                        void conferir(i, { conversionFactor: digitado });
                      }}
                      className={`w-24 px-2 py-1 text-right rounded-[var(--gs-radius)] border ${
                        precisaInformar
                          ? 'border-[var(--gs-warning)]'
                          : 'border-[var(--gs-border-strong)]'
                      }`}
                    />
                  );
                },
              },
              {
                header: 'Qtd.',
                align: 'right',
                render: (r: NoteItem) => formatQuantity(r.quantity),
              },
              {
                header: 'Chegou',
                align: 'right',
                render: (r: NoteItem, i: number) => (
                  <input
                    type="number"
                    min="0"
                    step="any"
                    aria-label={`Quantidade recebida de ${r.description}`}
                    defaultValue={r.receivedQuantity ?? r.quantity}
                    disabled={somenteLeitura}
                    onBlur={(e) => {
                      const padrao = String(r.receivedQuantity ?? r.quantity);
                      const digitado = e.target.value.trim();
                      /*
                        CAMPO APAGADO NÃO É "CHEGOU ZERO" (M03). `Number('')` é 0:
                        apagar o 10 para redigitar e sair do campo gravava "contei
                        e não veio nada", as peças não entravam e a dívida saía
                        cheia. Vazio volta ao que estava, e nada viaja.
                      */
                      if (digitado === '') {
                        e.target.value = padrao;
                        linhasQueFalharam.current.delete(`${i}:chegou`);
                        return;
                      }
                      // Só o que MUDOU viaja (B-18): atravessar o campo com Tab
                      // não marca "Conferido" num item que ninguém contou. E o
                      // valor que voltou ao gravado tira a marca de falha.
                      if (Number(digitado.replace(',', '.')) === Number(padrao)) {
                        linhasQueFalharam.current.delete(`${i}:chegou`);
                        return;
                      }
                      void conferir(i, { receivedQuantity: digitado });
                    }}
                    className="w-24 px-2 py-1 text-right rounded-[var(--gs-radius)]
                      border border-[var(--gs-border-strong)]"
                  />
                ),
              },
              {
                header: 'Diferença',
                align: 'right',
                render: (r: NoteItem, i: number) => {
                  if (r.receivedQuantity === null || r.receivedQuantity === undefined) {
                    return <span className="text-[var(--gs-muted)]">—</span>;
                  }
                  const dif = r.receivedQuantity - r.quantity;
                  if (dif === 0) return <Badge tone="success">Conferido</Badge>;
                  // A diferença salta aos olhos ANTES de confirmar — e ganha
                  // um MOTIVO: avaria e falta são a conversa com o fornecedor,
                  // e conversa sem registro morre no telefone.
                  return (
                    <span className="inline-flex flex-col items-end gap-1">
                      <Badge tone="warning">
                        {dif > 0 ? '+' : ''}
                        {formatQuantity(dif)}
                      </Badge>
                      <input
                        type="text"
                        aria-label={`Motivo da diferença de ${r.description}`}
                        placeholder="avaria, falta…"
                        defaultValue={r.divergenceNote ?? ''}
                        disabled={somenteLeitura}
                        onBlur={(e) => {
                          if (e.target.value.trim() === (r.divergenceNote ?? '').trim()) {
                            linhasQueFalharam.current.delete(`${i}:motivo`);
                            return;
                          }
                          void conferir(i, {
                            receivedQuantity: String(r.receivedQuantity),
                            divergenceNote: e.target.value,
                          });
                        }}
                        className="w-32 px-2 py-1 text-right text-[length:var(--gs-text-xs)]
                          rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                      />
                    </span>
                  );
                },
              },
              {
                header: 'Custo un.',
                align: 'right',
                render: (r: NoteItem) => formatCents(r.unitCostCents),
              },
              {
                header: 'Situação',
                render: (r: NoteItem, i: number) => {
                  /*
                    A BUSCA NO CATÁLOGO ABRE NA PRÓPRIA LINHA (GAP-PRD-015).

                    É o gesto que faltava: o item que o casamento automático não
                    reconheceu ia direto para "produto novo". Aqui ele encontra o
                    produto que já existe — ou troca o casamento automático que
                    errou (o nome igual que pegou o homônimo).
                  */
                  if (podeVincular && vinculando === i) {
                    return (
                      <VincularItemDaNota
                        descricao={r.description}
                        codigoDoFornecedor={r.supplierCode ?? null}
                        ocupado={busy}
                        aoEscolher={(produto, lembrar) => vincularItem(i, produto, lembrar)}
                        aoCancelar={() => setVinculando(null)}
                      />
                    );
                  }
                  return r.productId ? (
                    <span className="inline-flex flex-col items-start gap-0.5">
                      <Badge tone="success">Vinculado</Badge>
                      {/* COM QUAL produto — o id sozinho não diz nada a quem
                          confere, e o casamento por descrição erra calado. */}
                      {r.productName && (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text)]">
                          {r.productName}
                          {r.productInternalCode ? ` · ${r.productInternalCode}` : ''}
                        </span>
                      )}
                      {/* O MÉTODO agora vem gravado — a leitura antiga fabricava
                          "código de barras" para todo item vinculado. */}
                      {r.matchedBy && (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          por {CASOU_POR[r.matchedBy] ?? r.matchedBy}
                        </span>
                      )}
                      {podeVincular && (
                        <span className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Trocar o produto de ${r.description}`}
                            onClick={() => {
                              setConfirmandoNovos(false);
                              setVinculando(i);
                            }}
                          >
                            Trocar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy}
                            aria-label={`Desfazer o vínculo de ${r.description}`}
                            onClick={() => void desvincularItem(i)}
                          >
                            Desfazer
                          </Button>
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-start gap-0.5">
                      <Badge tone="warning">Sem produto no catálogo</Badge>
                      {/* Por que QUASE casou (modelo de grade, kit): a frase diz
                          o que escolher em vez de deixar nascer um gêmeo. */}
                      {r.matchNote && (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                          {r.matchNote}
                        </span>
                      )}
                      {podeVincular && (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Vincular ${r.description} a um produto do catálogo`}
                          onClick={() => {
                            setConfirmandoNovos(false);
                            setVinculando(i);
                          }}
                        >
                          Vincular
                        </Button>
                      )}
                    </span>
                  );
                },
              },
              /*
                O ITEM VIRA PEÇA AQUI.

                A coluna inteira some para quem não pode converter e para nota
                ainda em conferência — coluna vazia em toda linha ensina a
                pessoa a ignorar aquele pedaço da tabela.
              */
              ...(podeMarcarPecas
                ? [
                    {
                      header: 'Peça de oficina',
                      render: (r: NoteItem) => {
                        if (!r.productId) {
                          return <span className="text-[var(--gs-muted)]">—</span>;
                        }
                        const bancada = jaSaoPecas[r.productId];
                        if (bancada) {
                          return <Badge tone="info">Peça · {bancada}</Badge>;
                        }
                        if (marcando?.productId === r.productId) {
                          return (
                            <span className="inline-flex items-center gap-2 flex-wrap">
                              <select
                                aria-label={`Oficina dona de ${r.description}`}
                                value={marcando.workshopId}
                                onChange={(e) =>
                                  setMarcando({
                                    productId: r.productId!,
                                    workshopId: e.target.value,
                                  })
                                }
                                className="h-9 px-2 rounded-[var(--gs-radius)]
                                  border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                                  text-[length:var(--gs-text-sm)]"
                              >
                                <option value="">Escolha a oficina</option>
                                {oficinas.map((w) => (
                                  <option key={w.id} value={w.id}>
                                    {w.name}
                                  </option>
                                ))}
                              </select>
                              <Button
                                size="sm"
                                loading={busy}
                                onClick={() =>
                                  void marcarComoPeca(
                                    r.productId!,
                                    marcando.workshopId,
                                    r.description,
                                  )
                                }
                              >
                                Confirmar
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setMarcando(null)}>
                                Cancelar
                              </Button>
                            </span>
                          );
                        }
                        if (oficinas.length === 0) {
                          // Nenhuma bancada guarda peça nesta empresa: oferecer
                          // o botão levaria a um seletor vazio.
                          return <span className="text-[var(--gs-muted)]">—</span>;
                        }
                        return (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setMarcando({
                                productId: r.productId!,
                                // Uma bancada só: já vem escolhida, porque
                                // perguntar o óbvio é um clique a mais no meio
                                // da conferência da carga.
                                workshopId: oficinas.length === 1 ? oficinas[0].id : '',
                              })
                            }
                          >
                            Marcar como peça
                          </Button>
                        );
                      },
                    },
                  ]
                : []),
            ]}
            /*
              A REVISÃO MORDEU AQUI: a key era descrição+EAN, e os inputs de
              conferência são NÃO-CONTROLADOS (defaultValue). Abrir outra nota
              com o mesmo produto reaproveitava o <input> sujo — a contagem
              digitada na nota A aparecia (e, no blur, ERA GRAVADA) na nota B.
              A key amarra NOTA e POSIÇÃO: trocou a nota, trocou o input.
            */
            rows={items.map((r, i) => ({ ...r, chaveDaLinha: `${noteId}-${i}` }))}
            keyOf={(r) => r.chaveDaLinha ?? r.description}
          />
        </Card>
      )}

      {/*
        O QUE ESTA NOTA COBRA — a VOLTA da rastreabilidade (V22/V18).

        A consulta existia no servidor desde a rodada do `originId`, com teste
        próprio, e nenhuma tela a chamava: para saber se a dívida da nota já
        tinha sido paga, a pessoa saía daqui, ia ao contas a pagar e procurava
        pelo número — o gesto que a rastreabilidade existe para apagar.

        Só aparece com nota ABERTA: sem documento na mesa, não há origem pela
        qual perguntar.
      */}
      {notaAberta && (
        <TitulosDoDocumento
          titulos={titulos}
          erro={erroTitulos}
          titulo="O que esta nota gerou no financeiro"
          subtitulo={
            notaAberta.status === 'recebida'
              ? 'A dívida nasce na confirmação da entrada, no prazo do fornecedor.'
              : 'A dívida só nasce quando a entrada for confirmada — até lá, nada é cobrado.'
          }
        />
      )}

      {/*
        O QUE A NOTA FEZ COM O SEU PREÇO.

        Aparece só quando há algo a decidir. A entrada atualiza o CUSTO e deixa
        o preço onde estava — sem este passo, o aumento do fornecedor come a
        margem em silêncio até o fechamento do mês.

        O botão NÃO aplica sozinho ao confirmar a nota: preço é decisão de
        dono. Às vezes se absorve o aumento para não perder o cliente.
      */}
      {sugestoes.length > 0 && (
        <Card
          title="Revisar preços depois desta entrada"
          subtitle="O custo mudou. Estes produtos ficaram abaixo do que você mesmo declarou como mínimo."
          className="mb-5"
          actions={
            <Button variant="success" loading={busy} onClick={() => void aplicarPrecos()}>
              Aplicar os preços
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2.5 px-4 font-semibold">Produto</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Custo</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Preço hoje</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Margem</th>
                  <th className="py-2.5 px-4 font-semibold">O que houve</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Preço novo</th>
                </tr>
              </thead>
              <tbody>
                {sugestoes.map((s) => (
                  <tr key={s.productId} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-3 px-4">
                      <span className="font-semibold">{s.name}</span>
                      <span className="block font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {s.internalCode}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {formatCents(s.custoAtualCents)}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {formatCents(s.precoAtualCents)}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {s.margemPercent === null ? '—' : `${s.margemPercent.toFixed(1)}%`}
                    </td>
                    <td className="py-3 px-4">
                      {/* Vender abaixo do custo é o alarme mais alto que existe. */}
                      {s.abaixoDoCusto ? (
                        <Badge tone="danger">abaixo do custo</Badge>
                      ) : (
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          {s.motivos.join('; ')}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {s.precoSugeridoCents === null ? (
                        // Sem mínimo declarado não há o que sugerir: inventar
                        // um número seria opinar sobre um negócio que não é
                        // nosso.
                        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          defina um mínimo no produto
                        </span>
                      ) : (
                        <input
                          inputMode="decimal"
                          aria-label={`Preço novo de ${s.name}`}
                          defaultValue={(
                            (precosEditados[s.productId] ?? s.precoSugeridoCents) / 100
                          ).toFixed(2)}
                          onChange={(e) => {
                            const n = parseReaisToCents(e.target.value);
                            if (n !== null) {
                              setPrecosEditados((p) => ({ ...p, [s.productId]: n }));
                            }
                          }}
                          className="h-9 w-28 px-2 text-right rounded-[var(--gs-radius-sm)]
                            border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* GAP-PRD-088: a nota que entrou antes de o financeiro nascer junto
          espera a decisão do dono — só a gerência vê. */}
      <NotasSemContaAPagar onDecidiu={() => void loadNotes()} />

      <Card title="Notas importadas" padded={false}>
        <div className="px-4 pt-3 max-w-md">
          <Field label="Buscar nota">
            {(p) => (
              <Input
                {...p}
                value={buscaDigitada}
                onChange={(e) => setBuscaDigitada(e.target.value)}
                placeholder="Número, chave de acesso ou fornecedor"
              />
            )}
          </Field>
        </div>
        <DataTable
          columns={[
            { header: 'Nº', render: (r: Note) => `${r.number ?? '—'}/${r.series ?? '—'}` },
            { header: 'Fornecedor', render: (r: Note) => r.supplier_name ?? '—' },
            {
              header: 'Chave',
              render: (r: Note) =>
                r.doc_type === 'manual' ? (
                  /*
                    A entrada manual NÃO tem chave de acesso — a dela é
                    sintética, e exibir o rabo dela vestiria a compra digitada
                    de NF-e. O selo diz a espécie (GAP-V17).
                  */
                  <Badge tone="neutral">Entrada manual</Badge>
                ) : (
                  <span className="font-mono text-[length:var(--gs-text-sm)]">
                    …{r.access_key.slice(-12)}
                  </span>
                ),
            },
            {
              /*
                O que a doca precisa antes de abrir a carga: quem trouxe,
                quantos volumes esperar e quanto deveriam pesar. Estava no
                arquivo desde sempre e era descartado na importação.
              */
              header: 'Transporte',
              render: (r: Note) => {
                if (!r.carrier_name_xml && !r.volumes_qty && !r.freight_mode) return '—';
                const partes = [
                  r.carrier_name_xml,
                  r.volumes_qty ? `${r.volumes_qty} vol.` : null,
                  formatGramsAsKg(r.gross_weight_grams) === '—'
                    ? null
                    : formatGramsAsKg(r.gross_weight_grams),
                  r.vehicle_plate,
                ].filter(Boolean);
                return (
                  <span className="text-[length:var(--gs-text-sm)]">
                    {partes.join(' · ') || '—'}
                    {r.freight_mode && (
                      <>
                        <br />
                        <span className="opacity-70">
                          {MODALIDADE_DE_FRETE[r.freight_mode] ?? `Modalidade ${r.freight_mode}`}
                        </span>
                      </>
                    )}
                  </span>
                );
              },
            },
            { header: 'Total', align: 'right', render: (r: Note) => formatCents(r.total_cents) },
            {
              /*
                A situação e QUEM a produziu, juntas: "Recebida" sem nome é
                meia informação — quando a doca recebeu 4 e a nota dizia 10, a
                primeira pergunta é quem conferiu. O nome estava gravado
                (`received_by`) desde que a confirmação existe; só não tinha
                leitor. Nota antiga confirmada antes de a coluna ser gravada
                mostra só o selo, sem inventar autor.
              */
              header: 'Situação',
              render: (r: Note) =>
                r.status === 'estornada' ? (
                  /*
                    O terceiro estado (GAP-V20). Antes dele, a nota estornada
                    cairia no ramo "Conferência" — uma mentira que convidaria
                    alguém a conferi-la de novo. O selo diz o que houve, e a
                    data diz quando.
                  */
                  <span className="inline-flex flex-col gap-0.5">
                    <Badge tone="danger">Estornada</Badge>
                    {(r.reversed_by_name || r.reversed_at) && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {r.reversed_by_name ? `por ${r.reversed_by_name}` : ''}
                        {r.reversed_at ? ` em ${dataBR(r.reversed_at)}` : ''}
                      </span>
                    )}
                    {r.reversal_reason && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {r.reversal_reason}
                      </span>
                    )}
                  </span>
                ) : r.status === 'recebida' ? (
                  <span className="inline-flex flex-col gap-0.5">
                    <Badge tone="success">Recebida</Badge>
                    {r.received_by_name && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        por {r.received_by_name}
                        {r.received_at
                          ? ` em ${dataBR(r.received_at)}`
                          : ''}
                      </span>
                    )}
                  </span>
                ) : (
                  <Badge tone="warning">Conferência</Badge>
                ),
            },
            {
              /*
                O ARQUIVO DO FORNECEDOR — e a coluna que às vezes só tem uma
                frase.

                O botão só aparece quando o arquivo existe. Oferecê-lo sempre
                daria um clique que termina em 404 para toda nota anterior à
                rodada 27, e a pessoa procuraria um defeito que não existe: o
                XML daquelas notas foi lido, virou linha e foi descartado, e não
                há backfill possível — a nota é do fornecedor, assinada por ele,
                e ninguém pode remontá-la.

                No lugar do botão fica a data DA PRÓPRIA NOTA. Ver `mesDaNota`
                para por que a data não pode estar escrita no código.
              */
              header: 'XML',
              render: (r: Note) =>
                r.doc_type === 'manual' ? (
                  // Não é a nota antiga sem arquivo: é compra digitada — nunca
                  // houve XML, e a frase diz isso em vez de sugerir perda.
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    entrada manual — sem nota fiscal
                  </span>
                ) : r.tem_xml === 1 ? (
                  <Button size="sm" variant="secondary" onClick={() => void baixarXml(r)}>
                    Baixar XML
                  </Button>
                ) : (
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    sem arquivo — entrou em {mesDaNota(r)}, antes de o sistema guardar o XML
                  </span>
                ),
            },
            {
              header: '',
              render: (r: Note) => (
                <span className="inline-flex items-center gap-1">
                  {/* Abrir pela lista escreve `?nota=` na URL: o endereço passa
                      a descrever o que está na tela, e o link fica colável. */}
                  <Button size="sm" variant="secondary" onClick={() => void abrirEEnderecar(r.id)}>
                    Abrir
                  </Button>
                  {/* O estorno só existe onde ele é possível: entrada
                      CONFIRMADA, e só para a gerência — o mesmo recorte do
                      servidor (GAP-V20). */}
                  {estorna && r.status === 'recebida' && (
                    <Button size="sm" variant="ghost" onClick={() => void estornar(r)}>
                      Estornar
                    </Button>
                  )}
                  {/* PARTE da compra volta ao fornecedor (GAP-PRD-089) — o
                      estorno desfaz a nota inteira; a devolução não. Mesmo
                      recorte do registro: gerência. */}
                  {estorna && r.status === 'recebida' && (
                    <Link
                      to={rotaDaNovaDevolucaoAoFornecedor(r.id)}
                      className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] underline px-2"
                    >
                      Devolver
                    </Link>
                  )}
                </span>
              ),
            },
          ]}
          rows={notes}
          keyOf={(r) => r.id}
          empty={
            buscaNotas ? (
              <EmptyState
                title="Nenhuma nota encontrada"
                description={`Nada casa com “${buscaNotas}” — confira o número ou procure pelo fornecedor.`}
              />
            ) : (
              <EmptyState
                title="Nenhuma nota importada"
                description="Importe o XML da NF-e do fornecedor para dar entrada no estoque."
              />
            )
          }
        />
        <Paginacao
          pagina={paginaNotas ? { ...paginaNotas, quantidade: paginaNotas.items.length } : null}
          rotulo={{ singular: 'nota', plural: 'notas' }}
          onMudar={setOffsetNotas}
          dica="A busca acha a nota antiga pelo número, pela chave ou pelo fornecedor."
        />
      </Card>

      {/*
        O RADAR DA SEFAZ (rodada 44): o que foi emitido CONTRA o CNPJ da
        empresa, antes de o caminhão chegar. Manifestar é ato fiscal — os
        botões só existem para gerência; o estoquista vê o estado.
      */}
      <Card
        title="Notas contra o seu CNPJ (SEFAZ)"
        subtitle="Busca pela Distribuição DF-e. Manifeste a ciência para a SEFAZ liberar a nota completa."
        className="mt-5"
        padded={false}
        actions={
          <Button
            variant="secondary"
            onClick={pedirBusca}
            loading={buscandoDfe}
            disabled={dfeBloqueado || esperaDfe !== null}
          >
            {esperaDfe?.proximaConsultaEm ? `Buscar às ${horaCurta(esperaDfe.proximaConsultaEm)}` : 'Buscar agora'}
          </Button>
        }
      >
        {/*
          O CAMINHO DO CERTIFICADO (GAP-PRD-168), como nos atos com a SEFAZ:
          para onde a busca e a manifestação vão, e se a senha do A1 vai ser
          pedida. Só o caminho — a senha, quando pedida, vem no diálogo do ato.
        */}
        {planoDfe && (
          <div className="px-5 pt-4">
            <CaminhoDoAtoFiscal
              estado={{ plano: planoDfe, erro: null, carregando: false }}
              pedirSenha={false}
            />
          </div>
        )}
        {avisoDfe && (
          <p className="px-5 pt-3 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{avisoDfe}</p>
        )}
        {esperaDfe && (
          <p className="px-5 pt-3 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{avisoDaEspera(esperaDfe)}</p>
        )}
        <DataTable
          columns={[
            {
              header: 'Fornecedor',
              render: (r: DfeDoc) => (
                <span className="inline-flex flex-col">
                  <span>{r.supplierName ?? '—'}</span>
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] font-mono">
                    {r.supplierCnpj ?? r.accessKey ?? ''}
                  </span>
                </span>
              ),
            },
            {
              header: 'Valor',
              align: 'right',
              render: (r: DfeDoc) =>
                r.totalCents === null ? '—' : formatCents(r.totalCents),
            },
            {
              header: 'Situação',
              render: (r: DfeDoc) =>
                r.manifestStatus ? (
                  <Badge tone={r.manifestStatus === 'confirmacao' ? 'success' : 'info'}>
                    {MANIFESTACAO[r.manifestStatus] ?? r.manifestStatus}
                  </Badge>
                ) : (
                  <Badge tone="warning">Aguardando manifestação</Badge>
                ),
            },
            {
              header: 'Nota',
              render: (r: DfeDoc) =>
                r.importedNoteId ? (
                  <Badge tone="success">No funil</Badge>
                ) : r.temXmlCompleto ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onClick={() => r.accessKey && void importarDaSefaz(r.accessKey)}
                  >
                    Importar
                  </Button>
                ) : (
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    só o resumo — a ciência libera a nota completa
                  </span>
                ),
            },
            ...(manifesta
              ? [
                  {
                    header: 'Manifestar',
                    render: (r: DfeDoc) => {
                      if (!r.accessKey) return <span className="text-[var(--gs-muted)]">—</span>;
                      const chave = r.accessKey;
                      // Definitivas não voltam atrás pelo botão.
                      if (r.manifestStatus && r.manifestStatus !== 'ciencia') {
                        return <span className="text-[var(--gs-muted)]">—</span>;
                      }
                      if (justificando?.chave === chave) {
                        return (
                          <span className="inline-flex items-center gap-2 flex-wrap">
                            <input
                              type="text"
                              aria-label={`Justificativa da operação não realizada de ${chave}`}
                              placeholder="Por que a operação não aconteceu (15+ letras)"
                              value={justificando.texto}
                              onChange={(e) =>
                                setJustificando({ chave, texto: e.target.value })
                              }
                              className="w-64 px-2 py-1 rounded-[var(--gs-radius)]
                                border border-[var(--gs-border-strong)] text-[length:var(--gs-text-sm)]"
                            />
                            <Button
                              size="sm"
                              loading={busy}
                              disabled={dfeBloqueado || justificando.texto.trim().length < 15}
                              onClick={() =>
                                pedirManifestacao(chave, 'nao_realizada', justificando.texto)
                              }
                            >
                              Confirmar
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setJustificando(null)}>
                              Cancelar
                            </Button>
                          </span>
                        );
                      }
                      return (
                        <span className="inline-flex items-center gap-1 flex-wrap">
                          {!r.manifestStatus && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busy}
                              disabled={dfeBloqueado}
                              onClick={() => pedirManifestacao(chave, 'ciencia')}
                            >
                              Ciência
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            disabled={dfeBloqueado}
                            onClick={() => pedirManifestacao(chave, 'confirmacao')}
                          >
                            Confirmar operação
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy}
                            disabled={dfeBloqueado}
                            onClick={() => pedirManifestacao(chave, 'desconhecimento')}
                          >
                            Desconheço
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={dfeBloqueado}
                            onClick={() => setJustificando({ chave, texto: '' })}
                          >
                            Não realizada
                          </Button>
                        </span>
                      );
                    },
                  },
                ]
              : []),
          ]}
          rows={dfe}
          keyOf={(r) => r.nsu}
          empty={
            <EmptyState
              title="Nada buscado ainda"
              description="Use o Buscar agora: a SEFAZ devolve as notas emitidas contra o CNPJ desta empresa."
            />
          }
        />
      </Card>

      {/*
        A SENHA DO A1, SÓ QUANDO A POLÍTICA PEDE (GAP-PRD-168): o diálogo da
        casa, com o foco preso. A senha vive nele e some quando ele fecha.
      */}
      {pedindoSenha && (
        <SenhaDoCertificadoDialog
          plano={planoDfe}
          descricao={pedindoSenha.descricao}
          aviso={pedindoSenha.aviso}
          onFechar={() => setPedindoSenha(null)}
          onEnviar={(senha) => {
            const ato = pedindoSenha;
            setPedindoSenha(null);
            ato.enviar(senha);
          }}
        />
      )}

      {/*
        O DOCUMENTO DO TRANSPORTE (rodada 44). O frete tem dono e valor; o
        vínculo com as NF-e transportadas é derivado por chave — nada a manter
        à mão.
      */}
      <Card
        title="Fretes (CT-e)"
        subtitle="O conhecimento de transporte da transportadora, amarrado às notas que ele carrega."
        className="mt-5"
        padded={false}
        actions={
          <>
            <input
              ref={cteFileRef}
              type="file"
              accept=".xml,text/xml,application/xml"
              className="hidden"
              aria-label="Arquivo XML do CT-e"
              onChange={(e) => void onCteFile(e.target.files?.[0] ?? null)}
            />
            <Button variant="secondary" loading={busy} onClick={() => cteFileRef.current?.click()}>
              Importar CT-e
            </Button>
          </>
        }
      >
        <DataTable
          columns={[
            {
              header: 'Transportadora',
              render: (r: CteDoc) => (
                <span className="inline-flex flex-col">
                  <span>{r.carrierName ?? '—'}</span>
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] font-mono">
                    CT-e {r.number ?? ''} · {r.accessKey.slice(0, 10)}…
                  </span>
                </span>
              ),
            },
            {
              header: 'Frete',
              align: 'right',
              render: (r: CteDoc) => formatCents(r.freightCents),
            },
            {
              header: 'Notas transportadas',
              render: (r: CteDoc) => {
                if (r.notas.length === 0) {
                  return (
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      o XML não referencia NF-e
                    </span>
                  );
                }
                const noFunil = r.notas.filter((x) => x.noteId).length;
                return (
                  <span className="inline-flex flex-col gap-0.5">
                    <Badge tone={noFunil === r.notas.length ? 'success' : 'warning'}>
                      {noFunil} de {r.notas.length} no funil
                    </Badge>
                    {r.notas.map((x) => (
                      <span
                        key={x.accessKey}
                        className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] font-mono"
                      >
                        …{x.accessKey.slice(-10)} {x.noteId ? `· ${x.noteStatus}` : '· não importada'}
                      </span>
                    ))}
                  </span>
                );
              },
            },
          ]}
          rows={ctes}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhum frete registrado"
              description="Importe o XML do CT-e que a transportadora enviou — por aqui ou pelo e-mail de entrada."
            />
          }
        />
      </Card>
    </AppShell>
  );
}

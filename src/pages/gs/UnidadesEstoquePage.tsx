/**
 * Estoque › Unidades — QUAL peça, e não quantas.
 *
 * Moto e celular têm identidade individual: chassi, número do motor, IMEI.
 * Vender "uma moto" não diz nada — o que se vende é AQUELA moto, e o cliente
 * leva um documento com o chassi.
 *
 * ## A fila de trabalho
 *
 * A unidade nasce SEM identidade, porque a nota de entrada traz "3 motos"
 * muito antes de alguém ir ao pátio ler os chassis. Esta tela existe para
 * fechar essa lacuna: as peças sem identidade aparecem primeiro, em destaque,
 * porque são elas que impedem a rastreabilidade de valer alguma coisa.
 *
 * ## Baixa é diferente de venda
 *
 * Perda, quebra e devolução ao fornecedor tiram a peça do estoque sem vender.
 * A unidade não some da tabela — o chassi já circulou em documento e alguém
 * vai perguntar por ele daqui a dois anos.
 *
 * ## A plaquinha da oficina
 *
 * A mesma moto é uma UNIDADE aqui e um EQUIPAMENTO com plaquinha e QR na
 * oficina — que é OUTRA EMPRESA do grupo. Enquanto os dois cadastros não se
 * conhecem, o balcão vende, a unidade vira "vendida" e a plaquinha continua sem
 * dono: quem comprou raspa o QR e o portal responde vazio.
 *
 * Vincular é o que fecha isso, e é decisão de gente — por isso mora nesta tela,
 * ao lado da identidade, e não num processo automático que casaria motos
 * parecidas pelas costas.
 *
 * ## O adesivo do lote da PJ Motors (P0 das plaquinhas)
 *
 * A PJ gera, imprime e libera o lote em Plaquinhas — e o adesivo não tinha
 * onde entrar: só o cadastro de máquina o associava, e a PJ não tem bancada. O
 * QR colado na moto respondia 404 para sempre. Aqui a gestão da PJ
 * (`inventory.units.manage`) cola o adesivo liberado na moto do estoque, solta
 * (moto errada, ainda no pátio), troca o adesivo estragado e reimprime. O
 * caixa do PDV vê o número, e não os botões: PDV não administra.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo, useConfirmar } from '@/components/gs/PerguntaDaTela';
import { Badge, Button, Card, EmptyState, Input, PageHeader, SearchInput } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { escreverFolha, plaquinhaDaMaquinaApi, type PlaquinhaLivre } from '@/lib/api/plaquinhaDaMaquina';
import { useHasProfile } from '@/hooks/useSession';
import { useCan } from '@/hooks/useCan';
import { useEmpresaTemPlaquinha } from '@/hooks/useEmpresaTemPlaquinha';
import {
  coreApi,
  type PlaquinhaCandidata,
  type ProductUnit,
  type StockItem,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';

/**
 * A moto que saiu VENDIDA sem plaquinha (balcão ou loja online) — a que ainda
 * ganha a plaquinha com o mesmo número pelo vínculo tardio (GAP-PRD-108).
 */
function vendidaSemPlaquinha(u: ProductUnit): boolean {
  return (
    u.status === 'sold'
    && !u.equipment_id
    // A moto que saiu com o adesivo da PJ colado já tem plaquinha (P0).
    && !u.plaquinhaDoPool
    && (u.exit_reference_type === 'sale' || u.exit_reference_type === 'ecommerce_order')
  );
}

/** A identidade da moto numa linha, para o painel dizer em qual moto se mexe. */
function identidadeEmLinha(u: ProductUnit): string {
  return [u.chassis, u.motor_number, u.plate, u.imei, u.serial_number].filter(Boolean).join(' · ') || 'sem identidade';
}
const TH = 'py-2.5 px-3 font-semibold';
const TD = 'py-2.5 px-3';

/** Os cinco campos de identidade, na ordem em que a tela pergunta. */
const CAMPOS = [
  { chave: 'chassis', rotulo: 'Chassi' },
  { chave: 'motorNumber', rotulo: 'Motor' },
  { chave: 'plate', rotulo: 'Placa' },
  { chave: 'imei', rotulo: 'IMEI' },
  { chave: 'serialNumber', rotulo: 'Nº de série' },
] as const;

type CampoChave = (typeof CAMPOS)[number]['chave'];

/** O que a unidade tem gravado, no formato do formulário. */
function doBanco(u: ProductUnit): Record<CampoChave, string> {
  return {
    chassis: u.chassis ?? '',
    motorNumber: u.motor_number ?? '',
    plate: u.plate ?? '',
    imei: u.imei ?? '',
    serialNumber: u.serial_number ?? '',
  };
}

function temIdentidade(u: ProductUnit): boolean {
  return Boolean(u.chassis || u.motor_number || u.plate || u.imei || u.serial_number);
}

/**
 * A divergência que o servidor devolveu, guardada para virar pergunta na tela.
 *
 * Não é erro final: é a única situação em que os dois cadastros discordam sobre
 * QUAL máquina é, e só quem está com a moto na frente sabe qual número vale.
 */
interface Divergencia {
  plaquinha: PlaquinhaCandidata;
  mensagem: string;
  campo: string;
  naUnidade: string;
  naPlaquinha: string;
}

export default function UnidadesEstoquePage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const { confirmar: confirmarNaTela, dialogoDeConfirmacao } = useConfirmar();
  /*
    O VÍNCULO COM A PLAQUINHA É DA PJ MOTORS (P0 das plaquinhas).

    Esta tela serve toda loja com produto controlado por unidade — a Preço
    Justo com celular, inclusive —, e mostrava a todas a fila "sem plaquinha
    da oficina", a coluna Plaquinha e os botões de vincular, reimprimir e
    desfazer. Vincular, desvincular e reimprimir são gestão de plaquinha, e o
    servidor os recusa com 403 fora da PJ. Aqui, fora dela, nada disso aparece:
    a tela fica sendo a de identidade da unidade (chassi, IMEI, série, baixa).
  */
  const temPlaquinha = useEmpresaTemPlaquinha();
  /*
    QUEM ADMINISTRA O ADESIVO DA PJ (P0 das plaquinhas): a capability das rotas
    POST/DELETE /units/:id/tag e /tag/replace. O caixa do PDV não a tem — vê o
    número, sem botão. Sessão antiga sem `access` responde falso até o próximo
    login; o servidor recusa de qualquer jeito.
  */
  const podeGerirPlaquinha = useCan('inventory.units.manage');
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<StockItem[]>([]);
  const [produto, setProduto] = useState<StockItem | null>(null);
  const [unidades, setUnidades] = useState<ProductUnit[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Edição de identidade: uma linha por vez.
  const [editando, setEditando] = useState<string | null>(null);
  const [form, setForm] = useState<Record<CampoChave, string>>({
    chassis: '',
    motorNumber: '',
    plate: '',
    imei: '',
    serialNumber: '',
  });
  const [salvando, setSalvando] = useState(false);

  // Busca direta por identidade — o caminho de quem bipa no balcão.
  const [porIdentidade, setPorIdentidade] = useState('');
  const [achadoDireto, setAchadoDireto] = useState<ProductUnit[] | null>(null);

  /*
    Vínculo com a plaquinha: uma unidade por vez.

    Guarda a UNIDADE INTEIRA, e não só o id, porque o painel pode ser aberto de
    dois lugares — da busca por identidade (com a moto na frente) e da tabela do
    produto. Com só o id, o painel teria que procurar a unidade na lista do
    produto, e a lista do produto não existe quando se chegou pela identidade.
  */
  const [vinculando, setVinculando] = useState<ProductUnit | null>(null);
  const [buscaPlaquinha, setBuscaPlaquinha] = useState('');
  const [candidatas, setCandidatas] = useState<PlaquinhaCandidata[] | null>(null);
  const [ligando, setLigando] = useState(false);
  const [divergencia, setDivergencia] = useState<Divergencia | null>(null);

  /*
    O PAINEL DO ADESIVO DA PJ — separado do painel da máquina de propósito.

    O da máquina lista MÁQUINAS da Oficina (candidatas, identidade, vínculo
    tardio); este lista ADESIVOS livres do pool da PJ, pelo número. Misturar os
    dois num estado só faria a busca de um alimentar a lista do outro.
  */
  const [adesivo, setAdesivo] = useState<{ unidade: ProductUnit; modo: 'colar' | 'trocar' } | null>(null);
  const [buscaAdesivo, setBuscaAdesivo] = useState('');
  const [livres, setLivres] = useState<PlaquinhaLivre[] | null>(null);
  const [adesivoNovo, setAdesivoNovo] = useState('');
  const [motivoDaTroca, setMotivoDaTroca] = useState('');
  const [gravandoAdesivo, setGravandoAdesivo] = useState(false);

  /*
    A FILA DA EMPRESA INTEIRA, VINDA DO SERVIDOR.

    O contador que já existia é por produto escolhido — e escolher o produto é
    justamente o passo difícil, porque exige adivinhar de qual cadastro saiu a
    moto que se tem na mão. Enquanto o número dependesse desse passo, a fila não
    aparecia: ninguém vincula o que não vê, e tudo o que o vínculo entrega — o
    comprador virar dono, o QR responder, a garantia ter a quem pertencer —
    ficava parado sem ninguém ter recusado nada.

    Não dá para somar aqui: a tela nunca tem a empresa inteira carregada. O que
    ela tem é um produto por vez, ou o punhado que casou com o termo bipado.

    `null` enquanto não respondeu, e continua `null` se a chamada falhar — o
    banner some em vez de afirmar zero. Zero inventado é a pior resposta
    possível: diz "não há trabalho" exatamente quando não se sabe.
  */
  const [fila, setFila] = useState<number | null>(null);
  /*
    O RESTO DO RETRATO DA EMPRESA, na mesma chamada: as vendidas sem plaquinha
    (a fila do vínculo tardio, GAP-PRD-108) e o dia 1 da operação de motos
    (GAP-PRD-112) — produto controlado por unidade e moto sem número nenhum.
    Servidor antigo não manda os campos, e aí nada disto aparece.
  */
  const [resumo, setResumo] = useState<{
    vendidasSemPlaquinha: number | null;
    produtosSerializados: number | null;
    semIdentidade: number | null;
  } | null>(null);

  const carregarFila = useCallback(async () => {
    try {
      const r = await coreApi.unitsSummary();
      setFila(r.semPlaquinha);
      setResumo({
        vendidasSemPlaquinha: r.vendidasSemPlaquinha ?? null,
        produtosSerializados: r.produtosSerializados ?? null,
        semIdentidade: r.semIdentidade ?? null,
      });
    } catch {
      setFila(null);
      setResumo(null);
    }
  }, []);

  useEffect(() => {
    void carregarFila();
  }, [carregarFila]);

  const carregar = useCallback(async (produtoId: string) => {
    setErro(null);
    try {
      setUnidades(await coreApi.listUnits(produtoId));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar as unidades.');
      setUnidades([]);
    }
  }, []);

  useEffect(() => {
    if (busca.trim().length < 2) {
      setAchados([]);
      return;
    }
    const t = setTimeout(() => {
      void coreApi
        .listStock({ search: busca.trim() })
        .then((r) => setAchados(r.slice(0, 8)))
        .catch(() => setAchados([]));
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  /*
    A busca por identidade, refeita à mão.

    Existe como função, e não só como efeito, porque vincular a plaquinha MUDA
    o que esta lista mostra: a peça acabou de ganhar `equipment_id`, e o botão
    "Vincular" tem que sumir. Sem esta rechamada, quem vinculou pela identidade
    continuaria vendo o botão e tentaria vincular de novo, para levar um 409.
  */
  const buscarPorIdentidade = useCallback(async (termo: string) => {
    try {
      setAchadoDireto(await coreApi.searchUnit(termo));
    } catch {
      setAchadoDireto([]);
    }
  }, []);

  useEffect(() => {
    if (porIdentidade.trim().length < 3) {
      setAchadoDireto(null);
      return;
    }
    const t = setTimeout(() => {
      void buscarPorIdentidade(porIdentidade.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [porIdentidade, buscarPorIdentidade]);

  // A busca refaz a lista de candidatas com o painel já aberto. Sem termo, volta
  // a lista inteira — em vez de esvaziar a tela quando o operador apaga o texto.
  useEffect(() => {
    if (!vinculando) return undefined;
    const termo = buscaPlaquinha.trim();
    const t = setTimeout(() => {
      // A unidade vai junto: vendida, o servidor traz só a plaquinha com o
      // mesmo número (vínculo tardio, GAP-PRD-108).
      void coreApi
        .listPlaquinhasVinculaveis(termo || undefined, vinculando.id)
        .then(setCandidatas)
        .catch(() => setCandidatas([]));
    }, 300);
    return () => clearTimeout(t);
  }, [buscaPlaquinha, vinculando]);

  // Os adesivos livres da PJ, pelo número digitado — só com o painel aberto,
  // e só para quem administra (fora disso a tela nem pergunta ao pool).
  useEffect(() => {
    if (!adesivo || !temPlaquinha || !podeGerirPlaquinha) return undefined;
    const termo = buscaAdesivo.trim();
    const t = setTimeout(() => {
      void plaquinhaDaMaquinaApi
        .livres(termo || undefined)
        .then((r) => setLivres(r.items))
        .catch(() => setLivres([]));
    }, 300);
    return () => clearTimeout(t);
  }, [buscaAdesivo, adesivo, temPlaquinha, podeGerirPlaquinha]);

  function escolher(item: StockItem) {
    setProduto(item);
    setAchados([]);
    setBusca('');
    setUnidades(null);
    setEditando(null);
    void carregar(item.product_id);
  }

  function abrirEdicao(u: ProductUnit) {
    setEditando(u.id);
    setForm(doBanco(u));
    setErro(null);
    setAviso(null);
  }

  async function salvar(u: ProductUnit) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.identifyUnit(u.id, form);
      setEditando(null);
      setAviso('Identidade gravada.');
      if (produto) await carregar(produto.product_id);
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível gravar.');
    } finally {
      setSalvando(false);
    }
  }

  async function darBaixa(u: ProductUnit) {
    const motivo = await pedirMotivo({
      titulo: 'Dar baixa nesta unidade?',
      explicacao: 'A unidade sai do estoque sem venda: não gera nota nem garantia.',
      rotulo: 'Por que ela está saindo do estoque? (perda, quebra, devolução ao fornecedor)',
      confirmar: 'Dar baixa',
      perigoso: true,
    });
    if (!motivo?.trim()) return;
    setErro(null);
    setAviso(null);
    try {
      await coreApi.writeOffUnit(u.id, motivo.trim());
      setAviso('Unidade baixada.');
      if (produto) await carregar(produto.product_id);
      // A baixa tira a peça de `in_stock`, que é o corte da fila: sem plaquinha
      // e baixada, ela deixou de ser trabalho pendente.
      await carregarFila();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível dar baixa.');
    }
  }

  /**
   * Abre o painel de vínculo. Quem carrega as candidatas é o efeito acima.
   *
   * A lista começa SEM termo de busca porque, no caso normal, a oficina acabou
   * de montar duas ou três motos: mostrar todas é mais rápido do que fazer o
   * operador adivinhar o que digitar.
   */
  function abrirVinculo(u: ProductUnit) {
    setVinculando(u);
    setBuscaPlaquinha('');
    setCandidatas(null);
    setDivergencia(null);
    setErro(null);
    setAviso(null);
  }

  /**
   * Refaz o que está na tela depois de vincular ou desvincular.
   *
   * As DUAS listas, porque o vínculo pode ter saído de qualquer uma delas e a
   * outra pode estar mostrando a mesma peça. Recarregar só a de origem deixaria
   * a outra afirmando o contrário do que acabou de acontecer.
   */
  async function recarregarListas() {
    if (produto) await carregar(produto.product_id);
    if (porIdentidade.trim().length >= 3) await buscarPorIdentidade(porIdentidade.trim());
    // A fila junto: vincular e desvincular são exatamente o que muda o total da
    // empresa. Sem esta linha, o banner do topo continuaria afirmando o número
    // de antes — e é ele que diz se ainda há trabalho.
    await carregarFila();
  }

  /**
   * Liga a unidade à plaquinha.
   *
   * A DIVERGÊNCIA DE IDENTIDADE NÃO É ERRO FINAL, É PERGUNTA. O servidor recusa
   * com `CORE_UNIT_EQUIPMENT_IDENTITY_MISMATCH` e devolve os dois números; a
   * tela mostra os dois LADO A LADO e pergunta qual vale. Só o operador sabe se
   * o dígito errado foi digitado na bancada ou aqui.
   *
   * A pergunta é um bloco na tela e não um `confirm()` do navegador: o que se
   * compara são dezessete caracteres de chassi, e num alerta de sistema eles
   * saem numa fonte proporcional, sem alinhamento, impossíveis de conferir
   * caractere a caractere — que é exatamente o que a pergunta pede.
   *
   * Confirmando, a unidade manda e a plaquinha é corrigida — com o valor antigo
   * guardado no histórico do equipamento. Sem esta pergunta, o erro de digitação
   * na oficina viraria beco sem saída: o vínculo é o único caminho de conserto
   * da plaquinha.
   */
  async function ligar(u: ProductUnit, plaquinha: PlaquinhaCandidata, confirmar = false) {
    setLigando(true);
    setErro(null);
    setAviso(null);
    // A divergência anterior sai de cena antes da nova tentativa: a plaquinha
    // que ela citava pode não ser a que está sendo tentada agora, e pergunta
    // sobre a escolha errada é pior do que pergunta nenhuma.
    setDivergencia(null);
    try {
      await coreApi.linkUnitEquipment(u.id, plaquinha.id, confirmar);
      setVinculando(null);
      setDivergencia(null);
      setAviso(`Plaquinha ${plaquinha.publicIdLabel} vinculada a esta unidade.`);
      await recarregarListas();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'CORE_UNIT_EQUIPMENT_IDENTITY_MISMATCH') {
        const d = e.details as
          | { campo?: string; unidade?: string; plaquinha?: string }
          | undefined;
        setDivergencia({
          plaquinha,
          mensagem: e.message,
          campo: d?.campo ?? 'Identidade',
          naUnidade: d?.unidade ?? '—',
          naPlaquinha: d?.plaquinha ?? '—',
        });
      } else {
        setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível vincular.');
      }
    } finally {
      setLigando(false);
    }
  }

  /** Os perfis de `POST /units/:id/equipment/sheet` (GAP-PRD-190). */
  const podeReimprimir = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');

  /**
   * REIMPRIME a plaquinha da moto pela unidade (GAP-PRD-190).
   *
   * O adesivo descolado no pátio exigia ir à Oficina: as rotas de etiqueta
   * procuram o equipamento pela empresa da sessão, e ele vive lá. A folha sai
   * com o MESMO número e o MESMO QR — reimprimir não é trocar.
   */
  async function reimprimirPlaquinha(u: ProductUnit) {
    setErro(null);
    setAviso(null);
    // A janela abre dentro do clique: depois do `await`, o navegador bloqueia.
    const janela = window.open('', '_blank');
    try {
      const folha = await plaquinhaDaMaquinaApi.reimprimirPelaUnidade(u.id);
      if (!escreverFolha(janela, folha.html)) {
        setErro('O navegador bloqueou a janela da folha. Libere pop-ups para este endereço e tente de novo.');
        return;
      }
      setAviso(`Folha da plaquinha ${folha.publicIdLabel} aberta para imprimir — mesmo número e mesmo QR.`);
    } catch (e) {
      janela?.close();
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível gerar a folha da plaquinha.');
    }
  }

  /** Abre o painel do adesivo da PJ para colar (moto sem plaquinha) ou trocar. */
  function abrirAdesivo(u: ProductUnit, modo: 'colar' | 'trocar') {
    setAdesivo({ unidade: u, modo });
    setBuscaAdesivo('');
    setLivres(null);
    setAdesivoNovo('');
    setMotivoDaTroca('');
    setVinculando(null);
    setErro(null);
    setAviso(null);
  }

  /** Cola o adesivo liberado nesta moto — e o QR dele passa a abrir a página dela. */
  async function colarAdesivo(u: ProductUnit, tag: PlaquinhaLivre) {
    setGravandoAdesivo(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await plaquinhaDaMaquinaApi.colarNaUnidade(u.id, tag.id);
      setAdesivo(null);
      setAviso(`Plaquinha ${r.plaquinha?.publicIdLabel ?? tag.publicIdLabel} colada nesta moto — o QR já abre a página dela.`);
      await recarregarListas();
    } catch (e) {
      setErro(
        e instanceof ApiRequestError && e.code === 'CORE_TAG_NOT_RELEASED'
          ? 'Imprima e libere o lote em Plaquinhas antes de colar.'
          : e instanceof ApiRequestError
            ? e.message
            : 'Não foi possível colar a plaquinha.',
      );
    } finally {
      setGravandoAdesivo(false);
    }
  }

  /** Troca o adesivo estragado: o antigo deixa de valer no mesmo instante. */
  async function trocarAdesivo(u: ProductUnit) {
    if (!adesivoNovo || !motivoDaTroca.trim()) return;
    setGravandoAdesivo(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await plaquinhaDaMaquinaApi.trocarNaUnidade(u.id, {
        novaTagId: adesivoNovo,
        motivo: motivoDaTroca.trim(),
      });
      setAdesivo(null);
      setAviso(`Plaquinha ${r.anterior} trocada por ${r.atual} — o adesivo antigo deixou de valer.`);
      await recarregarListas();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível trocar o adesivo.');
    } finally {
      setGravandoAdesivo(false);
    }
  }

  /** Solta o adesivo da moto errada (só no pátio): ele volta livre no pool. */
  async function soltarAdesivo(u: ProductUnit) {
    if (
      !(await confirmarNaTela({
        titulo: `Soltar a plaquinha ${u.plaquinhaDoPool?.publicIdLabel ?? ''} desta moto?`,
        mensagem:
          'A plaquinha volta a ficar livre no pool da PJ Motors e o QR deixa de abrir a página desta moto até ser colada de novo.',
        confirmar: 'Soltar plaquinha',
        perigoso: true,
      }))
    ) {
      return;
    }
    setErro(null);
    setAviso(null);
    try {
      await plaquinhaDaMaquinaApi.soltarDaUnidade(u.id);
      setAviso(`Plaquinha ${u.plaquinhaDoPool?.publicIdLabel ?? ''} solta — ela voltou a ficar livre.`);
      await recarregarListas();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível soltar a plaquinha.');
    }
  }

  async function desligar(u: ProductUnit) {
    if (
      !(await confirmarNaTela({
        titulo: `Desfazer o vínculo com a plaquinha ${u.plaquinha?.publicIdLabel ?? ''}?`,
        mensagem: 'A plaquinha volta a ficar disponível para outra unidade do grupo.',
        confirmar: 'Desfazer o vínculo',
        perigoso: true,
      }))
    ) {
      return;
    }
    setErro(null);
    setAviso(null);
    try {
      await coreApi.unlinkUnitEquipment(u.id);
      setAviso('Vínculo desfeito.');
      await recarregarListas();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível desfazer o vínculo.');
    }
  }

  /*
    As peças SEM identidade vêm primeiro.

    São elas que impedem a rastreabilidade de valer alguma coisa: uma moto sem
    chassi cadastrado é indistinguível da moto do lado. Ordenar assim faz a
    tela virar fila de trabalho em vez de relatório.
  */
  const ordenadas = useMemo(() => {
    if (!unidades) return null;
    const emEstoque = unidades.filter((u) => u.status === 'in_stock');
    const resto = unidades.filter((u) => u.status !== 'in_stock');
    const semId = emEstoque.filter((u) => !temIdentidade(u));
    const comId = emEstoque.filter(temIdentidade);
    return [...semId, ...comId, ...resto];
  }, [unidades]);

  const pendentes = useMemo(
    () => (unidades ?? []).filter((u) => u.status === 'in_stock' && !temIdentidade(u)).length,
    [unidades],
  );
  const emEstoque = useMemo(
    () => (unidades ?? []).filter((u) => u.status === 'in_stock').length,
    [unidades],
  );

  /*
    QUANTAS AINDA NÃO TÊM PLAQUINHA — o número que faz a tela virar fila.

    Sem ele, o vínculo é um botão que ninguém procura, e tudo o que depende dele
    (o comprador virar dono, o QR responder, a garantia ter a quem pertencer)
    simplesmente não acontece: não por recusa, por ninguém ter olhado.

    Conta só o que está EM ESTOQUE. A peça vendida sem plaquinha tem fila
    própria desde o vínculo tardio (GAP-PRD-108): ela ainda ganha a plaquinha
    com o mesmo número, e somá-la aqui misturaria o trabalho do pátio com o da
    moto que já está com o cliente.
  */
  const semPlaquinha = useMemo(
    // A moto com o adesivo da PJ colado já tem plaquinha (P0 das plaquinhas).
    () => (unidades ?? []).filter((u) => u.status === 'in_stock' && !u.equipment_id && !u.plaquinhaDoPool).length,
    [unidades],
  );

  /*
    O PAINEL DE VÍNCULO, FORA DAS DUAS LISTAS.

    Fica no meio da página, e não dentro de uma linha de tabela, porque a escolha
    precisa de espaço: quem decide compara chassi da unidade com chassi da
    plaquinha, e uma célula esconderia justamente o número que está sendo
    conferido. Fora das listas também é o que deixa os dois caminhos — o da
    identidade bipada e o da tabela do produto — abrirem o MESMO painel.

    É uma variável, e não um componente aninhado: componente declarado dentro do
    corpo da página é recriado a cada render, e o React desmontaria o painel
    inteiro a cada tecla digitada na busca de plaquinha.

    ## O QUE O SUBTÍTULO PROMETE — E SÓ ISSO

    Ele prometia "o histórico de montagem no portal", e o portal não mostra
    isso. A OS de montagem interna nasce SEM cliente (equipamento do grupo é
    proibido de ter dono antes da venda), e o portal lista ordem filtrando por
    `customer_id` do dono. O comprador veria a moto e ZERO ordens — promessa
    quebrada no primeiro uso, logo com o cliente novo.

    Quem foi corrigido foi o TEXTO, não o filtro. Mostrar ordem de `customer_id`
    nulo reabriria a porta que a rodada 17 fechou de propósito — o dono de hoje
    lendo o que o dono anterior escreveu — e ainda poria o custo interno de
    montagem na frente do cliente.
  */
  const painelDeVinculo = vinculando && temPlaquinha ? (
    <Card
      title="Vincular plaquinha da oficina"
      subtitle="A plaquinha vive na oficina, que é outra empresa do grupo. Vinculada, ela acompanha a
        moto na venda: o comprador vira o dono e passa a ver esta moto no portal, com as ordens que
        ELE abrir dali em diante. O que a oficina fez antes da venda não vai junto."
      className="mb-5"
      actions={
        <Button variant="ghost" onClick={() => setVinculando(null)}>
          Fechar
        </Button>
      }
    >
      {vinculando.status === 'sold' && (
        <p
          role="note"
          className="m-0 mb-3 p-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
        >
          Esta moto já foi vendida. Só aparece a plaquinha com o MESMO chassi, número do motor ou
          série — e, ao vincular, quem comprou vira o dono no portal, com a data da venda contando a
          garantia. O número da moto não muda: ele já está no documento do cliente.
        </p>
      )}
      <p className="m-0 mb-3 text-[length:var(--gs-text-sm)]">
        Peça:{' '}
        <span className="font-mono">
          {[
            vinculando.chassis,
            vinculando.motor_number,
            vinculando.plate,
            vinculando.imei,
            vinculando.serial_number,
          ]
            .filter(Boolean)
            .join(' · ') || 'sem identidade'}
        </span>
      </p>

      {/*
        A DIVERGÊNCIA, EM CIMA DA LISTA.

        Aparece acima das candidatas porque, enquanto ela estiver aberta, é a
        única coisa a decidir — escolher outra plaquinha antes de responder
        deixaria a pergunta pendurada sobre uma escolha que já mudou.
      */}
      {divergencia && (
        <div className="mb-4 p-4 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]">
          <p className="m-0 font-semibold">{divergencia.mensagem}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div className="p-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface)]">
              <p className={`m-0 ${ROTULO}`}>{divergencia.campo} nesta unidade</p>
              <p className="m-0 font-mono break-all">{divergencia.naUnidade}</p>
            </div>
            <div className="p-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface)]">
              <p className={`m-0 ${ROTULO}`}>
                {divergencia.campo} na plaquinha {divergencia.plaquinha.publicIdLabel}
              </p>
              <p className="m-0 font-mono break-all">{divergencia.naPlaquinha}</p>
            </div>
          </div>
          <p className="mt-3 mb-3 text-[length:var(--gs-text-sm)]">
            Se o número certo é o desta unidade, a plaquinha é corrigida e o valor antigo fica no
            histórico do equipamento. Se o certo é o da plaquinha, feche isto e conserte a
            identidade da unidade em <strong>Identificar</strong>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              loading={ligando}
              onClick={() => void ligar(vinculando, divergencia.plaquinha, true)}
            >
              A unidade está certa — corrigir a plaquinha
            </Button>
            <Button variant="ghost" onClick={() => setDivergencia(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      <SearchInput
        value={buscaPlaquinha}
        onChange={setBuscaPlaquinha}
        placeholder="Nº da plaquinha (#0007), marca, modelo ou chassi"
      />

      {candidatas === null ? (
        <p className="mt-3 text-[var(--gs-text-soft)]">Carregando…</p>
      ) : candidatas.length === 0 ? (
        <p className="mt-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Nenhuma plaquinha disponível. Só aparece aqui a moto interna que a oficina cadastrou,
          ainda não vendida e ainda sem outra unidade vinculada.
        </p>
      ) : (
        <ul className="list-none m-0 mt-3 p-0 border border-[var(--gs-border)] rounded-[var(--gs-radius)] divide-y divide-[var(--gs-border)]">
          {candidatas.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-[length:var(--gs-text-sm)]"
            >
              <div>
                <span className="font-mono">{c.publicIdLabel}</span>{' '}
                <strong>{[c.brand, c.model].filter(Boolean).join(' ') || 'sem modelo'}</strong>
                <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  {c.workshopName} · {c.workshopCompanyName}
                  {c.chassis ? ` · chassi ${c.chassis}` : ' · sem chassi'}
                </div>
              </div>
              <Button variant="ghost" loading={ligando} onClick={() => void ligar(vinculando, c)}>
                Vincular
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  ) : null;

  /*
    O PAINEL DO ADESIVO DA PJ, fora das listas pelo mesmo motivo do painel da
    máquina: os dois caminhos (identidade bipada e tabela do produto) abrem o
    MESMO painel. Só existe na PJ e para quem administra.
  */
  const painelDoAdesivo = adesivo && temPlaquinha && podeGerirPlaquinha ? (
    <Card
      title={
        adesivo.modo === 'colar'
          ? 'Colar plaquinha do lote'
          : `Trocar o adesivo ${adesivo.unidade.plaquinhaDoPool?.publicIdLabel ?? ''}`
      }
      subtitle={
        adesivo.modo === 'colar'
          ? 'Escolha o adesivo liberado que está colado nesta moto: o QR dele passa a abrir a página da moto.'
          : 'O adesivo novo passa a responder por esta moto, e o antigo deixa de valer na hora.'
      }
      className="mb-5"
      actions={
        <Button variant="ghost" onClick={() => setAdesivo(null)}>
          Fechar
        </Button>
      }
    >
      <p className="m-0 mb-3 text-[length:var(--gs-text-sm)]">
        Moto: <span className="font-mono">{identidadeEmLinha(adesivo.unidade)}</span>
      </p>
      <SearchInput value={buscaAdesivo} onChange={setBuscaAdesivo} placeholder="Nº do adesivo (#0042)" />

      {livres === null ? (
        <p className="mt-3 text-[var(--gs-text-soft)]">Carregando…</p>
      ) : livres.length === 0 ? (
        <p className="mt-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Nenhuma plaquinha livre com esse número. Gere, imprima e libere um lote em Plaquinhas.
        </p>
      ) : adesivo.modo === 'colar' ? (
        <ul className="list-none m-0 mt-3 p-0 border border-[var(--gs-border)] rounded-[var(--gs-radius)] divide-y divide-[var(--gs-border)]">
          {livres.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-[length:var(--gs-text-sm)]"
            >
              <span className="font-mono">{t.publicIdLabel}</span>
              <Button
                variant="ghost"
                loading={gravandoAdesivo}
                onClick={() => void colarAdesivo(adesivo.unidade, t)}
              >
                Colar nesta moto
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={ROTULO}>Adesivo novo</span>
            <select
              value={adesivoNovo}
              onChange={(e) => setAdesivoNovo(e.target.value)}
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)]"
            >
              <option value="">Escolha o adesivo livre</option>
              {livres.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.publicIdLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={ROTULO}>Motivo da troca</span>
            <Input
              value={motivoDaTroca}
              onChange={(e) => setMotivoDaTroca(e.target.value)}
              placeholder="Descascou no sol, rasgou, QR ilegível…"
            />
          </label>
          <div>
            <Button
              loading={gravandoAdesivo}
              disabled={!adesivoNovo || !motivoDaTroca.trim()}
              onClick={() => void trocarAdesivo(adesivo.unidade)}
            >
              Trocar o adesivo
            </Button>
          </div>
        </div>
      )}
    </Card>
  ) : null;

  return (
    <AppShell>
      {dialogoDeMotivo}
      {dialogoDeConfirmacao}
      <PageHeader
        breadcrumb={['Estoque', 'Unidades']}
        title="Unidades"
        subtitle="Peças com identidade própria: chassi, motor, placa, IMEI ou número de série."
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

      {/*
        A FILA, ANTES DE QUALQUER ESCOLHA.

        Fica acima das duas buscas porque é a única coisa nesta tela que se lê
        sem saber nada: sem produto escolhido e sem chassi bipado, é ele que diz
        se há trabalho. O número por produto continua existindo mais abaixo, e é
        outra pergunta — aquele diz quanto falta NESTE produto, este diz quanto
        falta na empresa.

        Zero não vira banner. "Nada pendente" é a situação normal do estoque de
        celular e acessório, e um aviso permanente nessa situação treinaria o
        operador a passar os olhos por cima justamente do dia em que o número
        subir.
      */}
      {temPlaquinha && fila !== null && fila > 0 && (
        <div className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-sm)]">
          <strong>
            {fila} peça(s) em estoque ainda sem plaquinha da oficina, em toda a empresa.
          </strong>{' '}
          Sendo moto montada pela oficina, vincular é o que faz o comprador virar dono no portal ao
          fechar a venda. Bipe o chassi em <strong>Achar pela identidade</strong> para vincular sem
          precisar adivinhar o cadastro de produto. Peça que não passa pela bancada — celular,
          acessório — não precisa de plaquinha e pode ficar assim.
        </div>
      )}

      {/*
        O DIA 1 DA OPERAÇÃO DE MOTOS (GAP-PRD-112).

        O banco da loja nasceu sem nenhum produto controlado por unidade: a moto
        vende como item comum — sem chassi, sem plaquinha, sem dono no portal —
        e nada na tela dizia isso. A configuração é do dono (marcar o produto,
        ler o chassi no pátio); o que o sistema faz é dizer o que falta, aqui,
        com o número.
      */}
      {resumo && (resumo.produtosSerializados === 0 || (resumo.semIdentidade ?? 0) > 0) && (
        <section
          aria-label="Dia 1 da operação de motos"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
        >
          <strong>Antes da primeira moto sair pelo balcão:</strong>
          <ul className="m-0 mt-2 pl-5">
            {resumo.produtosSerializados === 0 && (
              <li>
                Nenhum produto desta empresa é <strong>controlado por unidade</strong>. Sem isso a moto
                vende como item comum — sem chassi, {temPlaquinha ? 'sem plaquinha e ' : ''}sem dono no
                portal. Marque cada
                produto-moto no cadastro de produtos (&ldquo;Controlado por unidade&rdquo;): as
                unidades do saldo nascem na hora.
              </li>
            )}
            {(resumo.semIdentidade ?? 0) > 0 && (
              <li>
                {resumo.semIdentidade} moto(s) no pátio sem chassi nem número: escolha o produto
                abaixo e use <strong>Identificar</strong> com a moto na frente.
              </li>
            )}
          </ul>
        </section>
      )}

      {/*
        AS VENDIDAS SEM PLAQUINHA (GAP-PRD-108) — a fila que antes não existia,
        porque o vínculo depois da venda não existia.
      */}
      {temPlaquinha && resumo && (resumo.vendidasSemPlaquinha ?? 0) > 0 && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-sm)]"
        >
          <strong>{resumo.vendidasSemPlaquinha} moto(s) vendida(s) sem plaquinha da oficina.</strong>{' '}
          Bipe o chassi em <strong>Achar pela identidade</strong> e use{' '}
          <strong>Vincular plaquinha (já vendida)</strong>: só entra a plaquinha com o mesmo número, e
          quem comprou passa a ver a moto no portal.
        </div>
      )}

      {/*
        O CAMINHO CERTO PARA VINCULAR.

        Quem acabou de bipar o chassi no pátio está com a moto na frente e sabe,
        sem dúvida nenhuma, QUAL peça é aquela. O outro caminho — escolher o
        produto e depois a linha — obriga a adivinhar de qual cadastro de produto
        aquela moto saiu, e é onde o vínculo errado nasce.

        Por isso a ação de vincular mora aqui, e não só na tabela: a tela mostrava
        o resultado e não deixava agir sobre ele, então o gesto natural terminava
        num beco.
      */}
      <Card
        title="Achar pela identidade"
        subtitle="Bipe ou digite o chassi, o IMEI, a placa ou o número de série."
        className="mb-5"
      >
        <SearchInput
          value={porIdentidade}
          onChange={setPorIdentidade}
          placeholder="Chassi, IMEI, placa ou número de série"
        />
        {achadoDireto !== null && (
          <div className="mt-3">
            {achadoDireto.length === 0 ? (
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Nenhuma peça com essa identidade.
              </p>
            ) : (
              <ul className="list-none m-0 p-0 text-[length:var(--gs-text-sm)]">
                {achadoDireto.map((u) => (
                  <li
                    key={u.id}
                    className="flex flex-wrap items-center gap-2 py-2
                      border-b border-[var(--gs-border)] last:border-0"
                  >
                    <span className="font-mono">
                      {u.chassis ?? u.imei ?? u.plate ?? u.serial_number ?? u.motor_number}
                    </span>
                    <Badge
                      tone={
                        u.status === 'in_stock'
                          ? 'success'
                          : u.status === 'sold'
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {u.status === 'in_stock'
                        ? 'em estoque'
                        : u.status === 'sold'
                          ? 'vendida'
                          : 'baixada'}
                    </Badge>

                    {/*
                      A plaquinha decide o que aparece aqui.

                      Esta busca vem da rota de identidade, que devolve a unidade
                      crua — tem `equipment_id`, e não o bloco da plaquinha com o
                      `#000N`. Então o que se afirma é só o que se sabe: que já
                      existe vínculo. O número, quem mostra é a tabela do produto,
                      que consulta a plaquinha inteira.
                    */}
                    {!temPlaquinha ? null : u.equipment_id || u.plaquinhaDoPool ? (
                      <Badge tone="info">com plaquinha</Badge>
                    ) : u.status === 'in_stock' || vendidaSemPlaquinha(u) ? (
                      <>
                        <Badge tone="warning">sem plaquinha</Badge>
                        <Button variant="ghost" size="sm" onClick={() => abrirVinculo(u)}>
                          {u.status === 'sold' ? 'Vincular plaquinha (já vendida)' : 'Vincular plaquinha'}
                        </Button>
                        {/* O adesivo do lote da PJ, com a moto na frente (P0). */}
                        {u.status === 'in_stock' && podeGerirPlaquinha && (
                          <Button variant="ghost" size="sm" onClick={() => abrirAdesivo(u, 'colar')}>
                            Colar plaquinha do lote
                          </Button>
                        )}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      {painelDeVinculo}
      {painelDoAdesivo}

      <Card
        title="Unidades do produto"
        subtitle={
          produto && unidades
            ? `${emEstoque} em estoque` +
              (pendentes > 0 ? ` · ${pendentes} sem identidade` : '') +
              (temPlaquinha && semPlaquinha > 0 ? ` · ${semPlaquinha} sem plaquinha` : '')
            : undefined
        }
        className="mb-5"
      >
        <label className="flex flex-col gap-1.5 mb-4">
          <span className={ROTULO}>Produto</span>
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Nome ou código do produto"
          />
        </label>

        {achados.length > 0 && (
          <ul className="mb-4 border border-[var(--gs-border)] rounded-[var(--gs-radius)] divide-y divide-[var(--gs-border)] list-none p-0">
            {achados.map((a) => (
              <li key={a.product_id}>
                <button
                  type="button"
                  onClick={() => escolher(a)}
                  className="w-full text-left px-4 py-2.5 bg-transparent border-0 cursor-pointer
                    hover:bg-[var(--gs-surface-hover)]"
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
            description="Só produtos marcados como controlados por unidade têm peças aqui."
          />
        ) : ordenadas === null ? (
          <p className="text-[var(--gs-text-soft)]">Carregando…</p>
        ) : ordenadas.length === 0 ? (
          <EmptyState
            title="Nenhuma unidade"
            description="Marque o produto como controlado por unidade no cadastro, ou dê entrada por nota."
          />
        ) : (
          <>
            <p className="font-semibold mb-3">{produto.name}</p>
            {pendentes > 0 && (
              <div className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]">
                <strong>{pendentes} peça(s) sem identidade.</strong> Enquanto o número não for
                preenchido, elas são indistinguíveis entre si — e a garantia não tem como ser
                atribuída.
              </div>
            )}

            {/*
              O SEGUNDO AVISO, EM TOM MAIS BAIXO QUE O PRIMEIRO.

              Falta de identidade é defeito em qualquer peça. Falta de plaquinha
              NÃO É: o celular do estoque nunca vai ter uma, e pintar isso de
              amarelo treinaria o operador a ignorar o amarelo justamente na
              tela onde ele importa.

              Para a moto, porém, é a diferença entre o comprador ter portal e
              garantia rastreável ou raspar o QR e não achar nada — por isso o
              número aparece, com a ressalva de que nem toda peça precisa.
            */}
            {temPlaquinha && semPlaquinha > 0 && (
              <div className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-sm)]">
                <strong>{semPlaquinha} peça(s) sem plaquinha da oficina.</strong> Sendo moto montada
                pela oficina, vincular é o que faz o comprador virar dono no portal ao fechar a
                venda. Peça que não passa pela bancada — celular, acessório — não precisa de
                plaquinha e pode ficar assim.
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Identidade</th>
                    <th className={TH}>Situação</th>
                    {temPlaquinha && <th className={TH}>Plaquinha</th>}
                    <th className={`${TH} text-right`}>Custo</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {ordenadas.map((u) =>
                    editando === u.id ? (
                      <tr key={u.id} className="border-b border-[var(--gs-border)]">
                        <td className={TD} colSpan={temPlaquinha ? 5 : 4}>
                          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                            {CAMPOS.map((c) => (
                              <label key={c.chave} className="flex flex-col gap-1.5">
                                <span className={ROTULO}>{c.rotulo}</span>
                                <Input
                                  value={form[c.chave]}
                                  onChange={(e) =>
                                    setForm((p) => ({ ...p, [c.chave]: e.target.value }))
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-2 mt-3">
                            <Button onClick={() => void salvar(u)} loading={salvando}>
                              Gravar
                            </Button>
                            <Button variant="ghost" onClick={() => setEditando(null)}>
                              Cancelar
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={u.id}
                        className="border-b border-[var(--gs-border)] last:border-0 hover:bg-[var(--gs-surface-hover)]"
                      >
                        <td className={TD}>
                          {temIdentidade(u) ? (
                            <span className="font-mono text-[length:var(--gs-text-xs)]">
                              {[u.chassis, u.motor_number, u.plate, u.imei, u.serial_number]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          ) : (
                            <Badge tone="warning">sem identidade</Badge>
                          )}
                        </td>
                        <td className={TD}>
                          <Badge
                            tone={
                              u.status === 'in_stock'
                                ? 'success'
                                : u.status === 'sold'
                                  ? 'info'
                                  : 'neutral'
                            }
                          >
                            {u.status === 'in_stock'
                              ? 'em estoque'
                              : u.status === 'sold'
                                ? 'vendida'
                                : 'baixada'}
                          </Badge>
                        </td>
                        {/*
                          A PLAQUINHA, E O QUE ELA MUDA NO BALCÃO.

                          Com plaquinha, esta moto tem histórico de montagem e um
                          QR que o comprador vai raspar. `ordensAbertas` aparece
                          porque é a diferença entre vender e não conseguir
                          vender: moto na bancada está DESMONTADA, e o servidor
                          recusa a baixa. Ver aqui evita a descoberta no 409, com
                          o cliente na frente.
                        */}
                        {temPlaquinha && (
                        <td className={TD}>
                          {u.plaquinha ? (
                            <div className="flex flex-col gap-1">
                              <span className="font-mono text-[length:var(--gs-text-xs)]">
                                {u.plaquinha.publicIdLabel}
                              </span>
                              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                                {u.plaquinha.workshopName} · {u.plaquinha.workshopCompanyName}
                              </span>
                              {u.plaquinha.ordensAbertas > 0 && (
                                <Badge tone="warning">na bancada</Badge>
                              )}
                              {podeReimprimir && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void reimprimirPlaquinha(u)}
                                >
                                  Reimprimir plaquinha
                                </Button>
                              )}
                            </div>
                          ) : u.plaquinhaDoPool ? (
                            /*
                              O ADESIVO DO LOTE DA PJ (P0 das plaquinhas): o número
                              para todos da PJ; os gestos só para quem administra.
                              Soltar só no pátio; trocar também na vendida — o
                              adesivo descasca na garagem do comprador.
                            */
                            <div className="flex flex-col gap-1">
                              <span className="font-mono text-[length:var(--gs-text-xs)]">
                                {u.plaquinhaDoPool.publicIdLabel}
                              </span>
                              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                                adesivo da PJ Motors
                              </span>
                              {podeGerirPlaquinha && (
                                <>
                                  <Button variant="ghost" size="sm" onClick={() => void reimprimirPlaquinha(u)}>
                                    Reimprimir plaquinha
                                  </Button>
                                  {(u.status === 'in_stock' || u.status === 'sold') && (
                                    <Button variant="ghost" size="sm" onClick={() => abrirAdesivo(u, 'trocar')}>
                                      Trocar adesivo
                                    </Button>
                                  )}
                                  {u.status === 'in_stock' && (
                                    <Button variant="ghost" size="sm" onClick={() => void soltarAdesivo(u)}>
                                      Soltar plaquinha
                                    </Button>
                                  )}
                                </>
                              )}
                            </div>
                          ) : (
                            <span className="text-[var(--gs-muted)]">—</span>
                          )}
                        </td>
                        )}
                        <td className={`${TD} text-right tabular-nums`}>
                          {u.cost_cents ? formatCents(u.cost_cents) : '—'}
                        </td>
                        <td className={`${TD} text-right whitespace-nowrap`}>
                          {/* A moto que saiu vendida sem plaquinha ainda ganha a
                              plaquinha com o mesmo número (GAP-PRD-108). */}
                          {temPlaquinha && vendidaSemPlaquinha(u) && (
                            <Button variant="ghost" onClick={() => abrirVinculo(u)}>
                              Vincular plaquinha (já vendida)
                            </Button>
                          )}
                          {/* Peça que já saiu não se edita: o número dela está
                              no documento do cliente. */}
                          {u.status === 'in_stock' && (
                            <>
                              <Button variant="ghost" onClick={() => abrirEdicao(u)}>
                                Identificar
                              </Button>
                              {/* A decisão é por `equipment_id`, que é o campo
                                  que o servidor grava; `plaquinha` é só o bloco
                                  de exibição. Se um dia a consulta do bloco
                                  falhar, o botão errado não aparece. */}
                              {/* Com o adesivo da PJ colado, a moto já tem
                                  plaquinha: os gestos dele moram na coluna. */}
                              {!temPlaquinha ? null : u.equipment_id ? (
                                <Button variant="ghost" onClick={() => void desligar(u)}>
                                  Desvincular
                                </Button>
                              ) : u.plaquinhaDoPool ? null : (
                                <>
                                  <Button variant="ghost" onClick={() => abrirVinculo(u)}>
                                    Vincular plaquinha
                                  </Button>
                                  {podeGerirPlaquinha && (
                                    <Button variant="ghost" onClick={() => abrirAdesivo(u, 'colar')}>
                                      Colar plaquinha do lote
                                    </Button>
                                  )}
                                </>
                              )}
                              <Button variant="ghost" onClick={() => void darBaixa(u)}>
                                Dar baixa
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>

          </>
        )}
      </Card>
    </AppShell>
  );
}

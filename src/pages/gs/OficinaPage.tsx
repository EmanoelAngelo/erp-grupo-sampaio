/**
 * Oficina — Kanban de ordens de serviço.
 *
 * É onde o mecânico cai ao entrar. O estado das colunas vem do banco central,
 * então mover um cartão persiste: recarregar a página ou abrir em outro
 * computador mostra a mesma posição.
 *
 * Arrastar usa HTML5 drag-and-drop nativo; há também um seletor de situação
 * em cada cartão, para quem opera por teclado ou em tela sensível ao toque.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { Link } from 'react-router-dom';
import { coreApi } from '@/lib/api/core';
import { formatCents } from '@/components/gs/format';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { CampoBancada } from '@/components/gs/BancadaDeEntrada';
import { useBancadasDeEntrada } from '@/hooks/useBancadasDeEntrada';
import { avisoDeMotoDoEstoque, motoDoEstoque } from '@/lib/api/fronteiraOficina';
import { precisaEscolherBancada } from '@/lib/api/oficinaEntrada';

interface ServiceOrder {
  id: string;
  number: number;
  customer_name: string | null;
  equipment: string | null;
  plate: string | null;
  complaint: string | null;
  status: string;
  mechanic_id: string | null;
  total_cents: number;
  updated_at: string;
  /** Prioridade do quadro (rodada 51): decide a ordem da coluna e a régua. */
  priority: string;
  /** Prazo prometido ao cliente, ou nulo. Badge no card quando existe. */
  due_date: string | null;
  /** Quando a OS ENTROU na coluna — a base do relógio do SLA. */
  status_changed_at: string | null;
  /**
   * O que o servidor já resolveu, e que a tela NÃO deve recalcular.
   *
   * Com o vínculo, `equipment` (texto livre) fica nulo — quem sabe o nome do
   * aparelho é o cadastro. O cartão que continuasse lendo `equipment` ficaria
   * em branco justamente nas OS bem preenchidas.
   */
  customer_display: string | null;
  customer_vinculado: number;
  equipment_display: string | null;
  mechanic_name: string | null;
  workshop_name: string | null;
  /**
   * O que está fora das regras nesta OS (GAP-PRD-188), calculado no servidor:
   * `sem_bancada` (OS antiga, de antes da bancada existir) e
   * `sem_responsavel` (coluna de trabalho sem ninguém que a tenha assumido).
   */
  irregularidades?: string[];
}

const IRREGULARIDADE_ROTULO: Record<string, string> = {
  sem_bancada: 'sem bancada',
  sem_responsavel: 'sem responsável',
};

interface Workshop {
  id: string;
  name: string;
}

/**
 * Chamado do proprietário, aberto pelo portal.
 *
 * NÃO é uma OS: significa "quero levar", e não "o aparelho está aqui". Vira OS
 * quando a oficina recebe o equipamento — por isso o botão diz "Recebi o
 * aparelho", e não "Abrir OS".
 */
interface ChamadoDaFila {
  id: string;
  description: string;
  equipment_public_id: number;
  brand: string | null;
  model: string | null;
  customer_name: string;
  customer_phone: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  em_aberto: 'Em aberto',
  em_andamento: 'Em andamento',
  aguardando_peca: 'Aguardando peça',
  manutencao_externa: 'Manutenção externa',
  parada_setor: 'Parada no setor',
  aguardando_pagamento: 'Aguardando pagamento',
  finalizada: 'Finalizada',
};

/**
 * AS COLUNAS DO QUADRO, na ordem em que elas aparecem.
 *
 * A lista vive AQUI e não é derivada do que o servidor devolveu, porque é
 * ela que decide quantas requisições saem — e a primeira requisição é a que
 * traz `statuses` do servidor. Uma tela que precisa da resposta para saber
 * o que pedir não sai do lugar.
 *
 * Se o servidor ganhar um estado novo, a coluna dele não aparece até entrar
 * aqui — e `estados-nas-duas-pontas` (a varredura que compara o vocabulário
 * do servidor com as listas das telas) é quem cobra isso. Um estado que
 * ninguém pediu ficaria com a coluna vazia, que é ruim; um estado inventado
 * aqui pediria uma lista que o servidor recusa, que é pior. Ordem operacional,
 * a mesma de `ORDER_STATUSES` no servidor.
 */
const COLUNAS_DO_QUADRO = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
  'aguardando_pagamento',
  'finalizada',
] as const;

/**
 * Quantos cards uma coluna carrega.
 *
 * Explícito de propósito: depender do padrão do servidor foi exatamente
 * como a OS antiga sumiu. Sessenta é folgado para uma coluna operacional de
 * oficina e continua sendo um número — quando a coluna tiver mais, o
 * cabeçalho diz "60 de 400" em vez de fingir que são todas.
 */
const CARDS_POR_COLUNA = 60;

/**
 * O teto do servidor por pedido (`searchOrders` corta em 300). Recarregar o
 * quadro depois de um movimento pede de novo o que a coluna já mostrava — até
 * este teto —, para o "carregar mais" não se desfazer a cada card movido.
 */
const TETO_POR_PEDIDO = 300;

/**
 * A ORDEM DA COLUNA vem do servidor (GAP-PRD-187).
 *
 * As colunas de trabalho pedem `ordem=quadro` — prioridade e a MAIS ANTIGA
 * primeiro, a mesma ordem do card. Pedindo pelo número DESC, a coluna com mais
 * de 60 cortava justamente as antigas, que são as de SLA estourado. A coluna de
 * finalizadas é histórico: ali o que interessa é a mais recente.
 */
const COLUNAS_PELA_ANTIGUIDADE = new Set<string>(
  COLUNAS_DO_QUADRO.filter((s) => s !== 'finalizada'),
);

/** Colunas que o técnico move na mão depois de assumir a OS. */
const MOVABLE = new Set([
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
]);

// ------------------------------------------ prioridade e SLA (rodada 51)

/** A ordem do quadro: urgente em cima, baixa embaixo — como no sistema antigo. */
const PRIORITY_RANK: Record<string, number> = { urgente: 0, alta: 1, media: 2, baixa: 3 };
const PRIORITY_LABELS: Record<string, string> = {
  urgente: 'Urgente',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};
/** Chip da prioridade — semânticos do tema, não cores soltas. */
const PRIORITY_CHIP: Record<string, string> = {
  urgente: 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]',
  alta: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  media: 'bg-[var(--gs-surface-muted)] text-[var(--gs-text-soft)]',
  baixa: 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]',
};

type SlaMatrix = Record<string, Record<string, number>>;

/**
 * O estado do relógio do card: quantas horas na coluna contra a régua.
 *
 * Só as colunas com régua alarmam (em andamento, manutenção externa, parada
 * no setor, aguardando peça) — as outras devolvem null e o card fica limpo.
 * A base é `status_changed_at` (a ENTRADA na coluna); o fallback para
 * `updated_at` cobre OS de antes da rodada 51.
 */
function estadoDoSla(
  order: ServiceOrder,
  sla: SlaMatrix | null,
): { horas: number; limite: number; estourado: boolean } | null {
  const regua = sla?.[order.status]?.[order.priority] ?? sla?.[order.status]?.media;
  if (!regua) return null;
  const base = order.status_changed_at ?? order.updated_at;
  const horas = (Date.now() - new Date(base).getTime()) / 3_600_000;
  if (Number.isNaN(horas) || horas < regua * 0.75) return null;
  return { horas: Math.floor(horas), limite: regua, estourado: horas >= regua };
}

/** O prazo prometido, como o card fala: atraso em vermelho, aperto em âmbar. */
function estadoDoPrazo(dueDate: string | null): {
  texto: string;
  classes: string;
  title: string;
} | null {
  if (!dueDate) return null;
  /*
    DIAS DE CALENDÁRIO, no fuso de quem lê.

    `new Date('2026-08-30')` é meia-noite UTC; comparar isso com `Date.now()`
    no Brasil (UTC-3) fazia "hoje" virar "1d atraso" das 21h em diante — o
    card mentia toda noite. A conta é entre DIAS locais: o prazo do dia é o
    dia inteiro, para quem está na oficina às 22h também.
    */
  const [ano, mes, dia] = dueDate.slice(0, 10).split('-').map(Number);
  if (!ano || !mes || !dia) return null;
  const hoje = new Date();
  const meiaNoiteHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
  const dias = Math.round((new Date(ano, mes - 1, dia).getTime() - meiaNoiteHoje) / 86_400_000);
  if (Number.isNaN(dias)) return null;
  if (dias < 0) {
    return {
      texto: `${Math.abs(dias)}d atraso`,
      classes: 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]',
      title: `Prazo prometido: ${dueDate.slice(0, 10)} — vencido`,
    };
  }
  if (dias === 0) {
    return {
      texto: 'Hoje',
      classes: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
      title: `Prazo prometido: ${dueDate.slice(0, 10)}`,
    };
  }
  return {
    texto: `${dias}d`,
    classes:
      dias <= 2
        ? 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
        : 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]',
    title: `Prazo prometido: ${dueDate.slice(0, 10)}`,
  };
}

export default function OficinaPage() {
  const session = useSession();
  const [statuses, setStatuses] = useState<string[]>([]);
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  /**
   * Quantas OS existem em cada coluna — não quantas couberam nela.
   *
   * Sem este número o quadro FINGE que o que veio é tudo o que há. Numa
   * oficina que fecha 15 por dia, "Finalizada" com 60 cards parece a
   * semana inteira e é meio dia.
   */
  const [totalPorColuna, setTotalPorColuna] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    customerName: '',
    customerId: '' as string,
    equipment: '',
    equipmentId: '' as string,
    plate: '',
    complaint: '',
    priority: 'media',
    dueDate: '',
  });
  const [clientes, setClientes] = useState<{ id: string; name: string }[]>([]);
  const [equipamentos, setEquipamentos] = useState<
    {
      id: string;
      brand: string | null;
      model: string | null;
      public_id: number;
      origin?: string;
      sale_status?: string;
      estoque?: { companyName: string } | null;
    }[]
  >([]);
  /*
    A MOTO DO ESTOQUE ESCOLHIDA PARA A OS (GAP-PRD-109): plaquinha interna
    ainda não vendida. A OS é de montagem interna, sem cliente do cadastro — o
    servidor recusa o vínculo, e a tela diz antes.
  */
  const [motoEstoque, setMotoEstoque] = useState<{ loja: string | null } | null>(null);
  const [busca, setBusca] = useState('');
  const [oficinas, setOficinas] = useState<Workshop[]>([]);
  const [oficinaFiltro, setOficinaFiltro] = useState('');
  /*
    ONDE A OS NOVA ENTRA (GAP-PRD-099): a lista é a do servidor — o atendente
    alcança toda bancada da empresa, o mecânico só as dele — e só é pedida
    quando o formulário abre. Com uma bancada, o campo não aparece.
  */
  const bancadasDeEntrada = useBancadasDeEntrada(creating);
  const [bancadaNova, setBancadaNova] = useState('');
  // Vale só enquanto o equipamento escolhido é o que a gerou.
  const estoqueDaOs = form.equipmentId ? motoEstoque : null;
  const [chamados, setChamados] = useState<ChamadoDaFila[]>([]);
  // A régua do SLA vem junto do quadro (rodada 51) — mesma para todo mundo.
  const [sla, setSla] = useState<SlaMatrix | null>(null);
  /**
   * O movimento pendente de OBSERVAÇÃO (rodada 51): soltar o card abre o
   * bloco de observação em vez de mover na hora — o card só anda quando a
   * observação for confirmada, então não há estado otimista para reverter.
   */
  const [movimento, setMovimento] = useState<{
    orderId: string;
    numero: number;
    toStatus: string;
    assumindo: boolean;
    /**
     * O RETRATO que o card mostrava quando a pessoa pediu o movimento
     * (GAP-PRD-183). Vai junto no POST: se outra pessoa moveu a OS nesse
     * meio-tempo, o servidor recusa com 409 em vez de o último clique ganhar.
     */
    statusVisto: string;
    statusChangedAtVisto: string | null;
  } | null>(null);
  /** A coluna em que o "carregar mais" está buscando a próxima página. */
  const [carregandoMais, setCarregandoMais] = useState<string | null>(null);
  const [observacao, setObservacao] = useState('');
  const [movendo, setMovendo] = useState(false);
  // O editor da régua (gestão): null = fechado; senão, a matriz em edição.
  const [editorSla, setEditorSla] = useState<SlaMatrix | null>(null);
  const [salvandoSla, setSalvandoSla] = useState(false);
  const podeEditarSla = useHasProfile('gerente_oficina');

  /** A lista de UMA coluna, com o filtro da tela, o limite escrito e a ordem. */
  const carregarColuna = useCallback(
    (status: string, pagina: { limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      qs.set('status', status);
      qs.set('limit', String(pagina.limit ?? CARDS_POR_COLUNA));
      if (pagina.offset) qs.set('offset', String(pagina.offset));
      if (COLUNAS_PELA_ANTIGUIDADE.has(status)) qs.set('ordem', 'quadro');
      if (busca.trim()) qs.set('q', busca.trim());
      if (oficinaFiltro) qs.set('workshopId', oficinaFiltro);
      return apiRequest<{
        statuses: string[];
        workshops: Workshop[];
        items: ServiceOrder[];
        total: number;
        sla: SlaMatrix;
      }>(`/core/workshop/orders?${qs.toString()}`).then((r) => exigirCampos(r, 'statuses', 'workshops', 'items', 'total', 'sla'));
    },
    [busca, oficinaFiltro],
  );

  /**
   * Quantos cards cada coluna já mostra — lido no recarregamento, para o
   * quadro não encolher de volta a 60 depois de um "carregar mais". Vale só
   * para o MESMO filtro: trocar a busca ou a oficina começa do zero.
   */
  const carregadosPorColuna = useRef<{ chave: string; contagem: Record<string, number> }>({
    chave: '',
    contagem: {},
  });
  const chaveDoFiltro = `${busca.trim()}|${oficinaFiltro}`;

  const load = useCallback(async (manterErro = false) => {
    setLoading(true);
    if (!manterErro) setError(null);
    const memoria =
      carregadosPorColuna.current.chave === chaveDoFiltro
        ? carregadosPorColuna.current.contagem
        : {};
    const tamanho = (status: string) =>
      Math.min(TETO_POR_PEDIDO, Math.max(CARDS_POR_COLUNA, memoria[status] ?? 0));
    try {
      /*
        ================================================================
        CADA COLUNA PEDE A SUA LISTA
        ================================================================

        Isto pedia `/core/workshop/orders` sem situação e sem limite. O
        servidor tem um padrão — 100 — e ordena por número DESC: o quadro
        recebia as CEM OS DE NÚMERO MAIS ALTO, finalizadas incluídas, e
        distribuía o que veio pelas sete colunas.

        Numa oficina que fecha 15 por dia, a centésima é de uma semana
        atrás. A OS parada em "Aguardando peça" desde segunda tem número
        baixo, fica fora das cem, e não aparece em coluna nenhuma — sem
        aviso, sem contagem, sem nada. E o relógio do SLA continua
        correndo: card que não existe não acende, então a OS mais
        atrasada da oficina é justo a que ninguém vê.

        O mecanismo se realimenta: quanto mais a oficina fecha, mais
        fundo a antiga afunda. Some primeiro na oficina movimentada.

        Uma lista por coluna resolve pela raiz — nenhuma engole a cota da
        outra —, e cada uma volta com o próprio total, que o cabeçalho
        mostra quando há mais do que coube.
      */
      const primeiro = await carregarColuna(COLUNAS_DO_QUADRO[0], {
        limit: tamanho(COLUNAS_DO_QUADRO[0]),
      });
      setStatuses(primeiro.statuses);
      setOficinas(primeiro.workshops ?? []);
      setSla(primeiro.sla ?? null);

      const demais = await Promise.all(
        COLUNAS_DO_QUADRO.slice(1).map((status) =>
          carregarColuna(status, { limit: tamanho(status) }),
        ),
      );
      const respostas = [primeiro, ...demais];
      carregadosPorColuna.current = {
        chave: chaveDoFiltro,
        contagem: Object.fromEntries(
          COLUNAS_DO_QUADRO.map((s, i) => [s, respostas[i].items.length]),
        ),
      };

      setOrders(respostas.flatMap((r) => r.items));
      setTotalPorColuna(
        Object.fromEntries(COLUNAS_DO_QUADRO.map((s, i) => [s, respostas[i].total])),
      );

      // A fila é carregada junto, e uma falha nela NÃO derruba o quadro: o
      // mecânico precisa do kanban mesmo que o chamado esteja indisponível.
      try {
        const f = await apiRequest<{ items: ChamadoDaFila[] }>('/core/workshop/chamados').then((r) => exigirCampos(r, 'items'));
        setChamados(f.items);
      } catch {
        setChamados([]);
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Falha ao carregar as ordens de serviço.',
      );
    } finally {
      setLoading(false);
    }
  }, [carregarColuna, chaveDoFiltro]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * CARREGAR MAIS de uma coluna (GAP-PRD-187): a próxima página, a partir de
   * onde a coluna parou. Como o servidor ordena igual ao card (prioridade e a
   * mais antiga primeiro), a página nova entra no FIM da coluna, sem
   * embaralhar o que a pessoa já estava lendo.
   */
  const carregarMais = useCallback(
    async (status: string) => {
      const jaTem = orders.filter((o) => o.status === status).length;
      setCarregandoMais(status);
      try {
        const r = await carregarColuna(status, { offset: jaTem });
        setOrders((atuais) => {
          const vistos = new Set(atuais.map((o) => o.id));
          return [...atuais, ...r.items.filter((o) => !vistos.has(o.id))];
        });
        setTotalPorColuna((t) => ({ ...t, [status]: r.total }));
        carregadosPorColuna.current = {
          chave: chaveDoFiltro,
          contagem: { ...carregadosPorColuna.current.contagem, [status]: jaTem + r.items.length },
        };
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.message : 'Não foi possível carregar mais cards.',
        );
      } finally {
        setCarregandoMais(null);
      }
    },
    [orders, carregarColuna, chaveDoFiltro],
  );

  /**
   * FASE 1 do movimento (rodada 51): escolher o destino abre o bloco de
   * observação — nada anda ainda. Era um `window.prompt` só no assumir; agora
   * TODO movimento pede a observação (regra do servidor), num bloco na tela,
   * como o resto do projeto pergunta as coisas.
   */
  const pedirMovimento = useCallback(
    (orderId: string, toStatus: string) => {
      const order = orders.find((o) => o.id === orderId);
      if (!order || order.status === toStatus) return;

      const assumindo = order.status === 'em_aberto';
      if (assumindo && !MOVABLE.has(toStatus)) {
        setError(
          'Ao assumir, mova para em andamento, manutenção externa, parada no setor ou aguardando peça.',
        );
        return;
      }
      setError(null);
      setObservacao('');
      setMovimento({
        orderId,
        numero: order.number,
        toStatus,
        assumindo,
        statusVisto: order.status,
        statusChangedAtVisto: order.status_changed_at ?? null,
      });
    },
    [orders],
  );

  /** FASE 2: a observação confirmada é o que faz o card andar. */
  const confirmarMovimento = useCallback(async () => {
    if (!movimento || !observacao.trim()) return;
    setMovendo(true);
    try {
      await apiRequest(
        `/core/workshop/orders/${movimento.orderId}/${movimento.assumindo ? 'assume' : 'move'}`,
        {
          method: 'POST',
          body: {
            status: movimento.toStatus,
            comment: observacao.trim(),
            expectedStatus: movimento.statusVisto,
            expectedStatusChangedAt: movimento.statusChangedAtVisto,
          },
        },
      );
      setMovimento(null);
      setObservacao('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível mover a OS.');
      setMovimento(null);
      /*
        A OS MUDOU NA MÃO DE OUTRA PESSOA (GAP-PRD-183): o quadro desta tela
        está velho. Recarregar põe o card na coluna em que ele está de
        verdade — e a mensagem do servidor, que diz onde e quem, fica na tela.
      */
      if (err instanceof ApiRequestError && err.code === 'CORE_ORDER_STALE') {
        await load(true);
      }
    } finally {
      setMovendo(false);
    }
  }, [movimento, observacao, load]);

  /** Salva a régua inteira; o servidor apaga o que for igual ao padrão. */
  const salvarSla = useCallback(
    async (reset: boolean) => {
      if (!editorSla && !reset) return;
      setSalvandoSla(true);
      try {
        const r = await apiRequest<{ matrix: SlaMatrix }>('/core/workshop/sla', {
          method: 'PUT',
          body: reset ? { reset: true } : { matrix: editorSla },
        }).then((r) => exigirCampos(r, 'matrix'));
        setSla(r.matrix);
        setEditorSla(null);
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.message : 'Não foi possível salvar os tempos.',
        );
      } finally {
        setSalvandoSla(false);
      }
    },
    [editorSla],
  );

  /**
   * A busca de cadastro é oferecida, nunca exigida.
   *
   * O vínculo é o que faz o mesmo cliente escrito de três jeitos ser uma pessoa
   * só, e é o que monta o histórico do aparelho. Mas a oficina atende quem
   * chega: quem não está cadastrado entra pelo texto livre, e a OS abre igual.
   */
  const buscarCadastros = useCallback(async (termo: string) => {
    if (termo.trim().length < 2) {
      setClientes([]);
      setEquipamentos([]);
      return;
    }
    try {
      const [cs, es] = await Promise.all([
        coreApi.listCustomers(termo),
        coreApi.listEquipment(termo),
      ]);
      setClientes(cs.slice(0, 6) as { id: string; name: string }[]);
      setEquipamentos(es.slice(0, 6));
    } catch {
      // Falha de busca não pode travar a abertura: o texto livre continua lá.
      setClientes([]);
      setEquipamentos([]);
    }
  }, []);

  /**
   * Atender o chamado: receber o aparelho (vira OS) ou encerrar.
   *
   * "Recebi o aparelho" é o ato que autoriza a OS a existir — antes disso a
   * moto está na garagem do dono, e uma OS aberta faria a plaquinha dele
   * anunciar que a oficina já está com ela.
   */
  const atenderChamado = useCallback(
    async (id: string, acao: 'converter' | 'encerrar') => {
      setError(null);
      try {
        await apiRequest(`/core/workshop/chamados/${id}/${acao}`, { method: 'POST' });
        await load();
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.message : 'Não foi possível atender o chamado.',
        );
      }
    },
    [load],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    // Mais de uma bancada no alcance: a escolha é obrigatória, e barrar aqui
    // poupa o atendente de ler a mesma frase vinda do servidor.
    if (precisaEscolherBancada(bancadasDeEntrada) && !bancadaNova) {
      setError('Escolha a bancada onde a OS vai entrar.');
      return;
    }
    try {
      await apiRequest('/core/workshop/orders', {
        method: 'POST',
        body: {
          workshopId: precisaEscolherBancada(bancadasDeEntrada) ? bancadaNova : undefined,
          customerName: form.customerName,
          // String vazia não é id: mandar '' faria o servidor procurar um
          // cliente de id vazio e recusar a OS com 404. Moto do estoque não
          // leva cliente do cadastro (GAP-PRD-109).
          customerId: estoqueDaOs ? null : form.customerId || null,
          equipment: form.equipment,
          equipmentId: form.equipmentId || null,
          plate: form.plate,
          complaint: form.complaint,
          priority: form.priority,
          dueDate: form.dueDate || null,
        },
      });
      setForm({
        customerName: '',
        customerId: '',
        equipment: '',
        equipmentId: '',
        plate: '',
        complaint: '',
        priority: 'media',
        dueDate: '',
      });
      setClientes([]);
      setEquipamentos([]);
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a OS.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Ordens de serviço']}
        title={session ? `Oficina · ${session.company.tradeName}` : 'Oficina'}
        actions={
          <div className="flex gap-2">
            {podeEditarSla && (
              <Button
                variant="secondary"
                onClick={() => setEditorSla(sla ? structuredClone(sla) : null)}
              >
                Tempos de resposta
              </Button>
            )}
            <Button onClick={() => setCreating((v) => !v)}>
              {creating ? 'Fechar' : 'Nova OS'}
            </Button>
          </div>
        }
      />

      {/* O bloco de observação do movimento (rodada 51): o card só anda
          quando a observação for confirmada — é ela que explica a mudança a
          quem ler a OS depois, e o servidor a exige de qualquer caminho. */}
      {movimento && (
        <Card
          title={
            movimento.assumindo
              ? `Assumir a OS #${movimento.numero}`
              : `Mover a OS #${movimento.numero} para "${STATUS_LABELS[movimento.toStatus] ?? movimento.toStatus}"`
          }
          className="mb-5 border-[var(--gs-border-strong)]"
        >
          <Field
            label="Observação obrigatória"
            required
            hint="Fica registrada na linha do tempo da OS, visível para todos."
          >
            {(p) => (
              <textarea
                {...p}
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder={
                  movimento.assumindo
                    ? 'O que foi constatado: diagnóstico inicial, ação planejada, prazo estimado…'
                    : 'O motivo da mudança. Ex.: aguardando peça do fornecedor, enviado para manutenção externa…'
                }
                className="w-full px-3 py-2 border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] text-[length:var(--gs-text-base)]"
              />
            )}
          </Field>
          <div className="flex gap-2 mt-3">
            <Button
              onClick={() => void confirmarMovimento()}
              disabled={movendo || !observacao.trim()}
            >
              {movimento.assumindo ? 'Assumir e mover' : 'Confirmar mudança'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setMovimento(null);
                setObservacao('');
              }}
            >
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {/* O editor da régua do SLA (gestão): as horas por coluna × prioridade,
          por EMPRESA — não por navegador, como era no sistema antigo. */}
      {editorSla && (
        <Card title="Tempos de resposta (SLA)" className="mb-5">
          <p className="mt-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Horas que uma OS pode ficar em cada coluna antes de o card acender:
            75% da régua vira atenção, 100% vira estouro. Vale para a empresa
            inteira. De 1 a 720 horas.
          </p>
          <div className="overflow-x-auto">
            <table className="border-collapse text-[length:var(--gs-text-sm)]">
              <thead>
                <tr>
                  <th className="text-left pr-4 pb-2">Coluna</th>
                  {['urgente', 'alta', 'media', 'baixa'].map((p) => (
                    <th key={p} className="text-left pr-4 pb-2">
                      {PRIORITY_LABELS[p]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['em_andamento', 'manutencao_externa', 'parada_setor', 'aguardando_peca'].map(
                  (status) => (
                    <tr key={status}>
                      <td className="pr-4 py-1">{STATUS_LABELS[status]}</td>
                      {['urgente', 'alta', 'media', 'baixa'].map((p) => (
                        <td key={p} className="pr-4 py-1">
                          <input
                            type="number"
                            min={1}
                            max={720}
                            aria-label={`${STATUS_LABELS[status]} · ${PRIORITY_LABELS[p]}`}
                            value={editorSla[status]?.[p] ?? ''}
                            onChange={(e) =>
                              setEditorSla((atual) =>
                                atual
                                  ? {
                                      ...atual,
                                      [status]: {
                                        ...atual[status],
                                        [p]: Number(e.target.value),
                                      },
                                    }
                                  : atual,
                              )
                            }
                            className="w-20 px-2 py-1 border border-[var(--gs-border-strong)]
                              rounded-[var(--gs-radius-sm)] tabular-nums"
                          />
                        </td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-3">
            <Button onClick={() => void salvarSla(false)} disabled={salvandoSla}>
              Salvar tempos
            </Button>
            <Button variant="secondary" onClick={() => void salvarSla(true)} disabled={salvandoSla}>
              Restaurar padrão
            </Button>
            <Button variant="ghost" onClick={() => setEditorSla(null)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap gap-3 items-center">
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Número da OS, cliente, placa ou queixa"
          />
          {/*
            O seletor só aparece quando há mais de uma oficina na empresa —
            oferecer escolha de um item só é ruído.
          */}
          {oficinas.length > 1 && (
            <select
              aria-label="Oficina"
              value={oficinaFiltro}
              onChange={(e) => setOficinaFiltro(e.target.value)}
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
            >
              <option value="">Todas as oficinas</option>
              {oficinas.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </Card>

      {/*
        A FILA DE CHAMADOS.

        Fica acima do quadro de propósito: é gente esperando resposta, e no
        quadro ela não apareceria — chamado não é OS, e por isso não tem coluna.
        "Receber" é o ato de a moto chegar na bancada; só então vira OS.
      */}
      {chamados.length > 0 && (
        <Card title={`Chamados de clientes (${chamados.length})`} className="mb-5">
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {chamados.map((c) => (
              <li
                key={c.id}
                className="flex justify-between items-start gap-3 flex-wrap border-b border-[var(--gs-border)] pb-2 last:border-0"
              >
                <div>
                  <strong>{c.customer_name}</strong>{' '}
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {[c.brand, c.model].filter(Boolean).join(' ')} #{c.equipment_public_id}
                    {c.customer_phone ? ` · ${c.customer_phone}` : ''}
                  </span>
                  <p className="m-0 text-[length:var(--gs-text-sm)]">{c.description}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void atenderChamado(c.id, 'converter')}>
                    Recebi o aparelho
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void atenderChamado(c.id, 'encerrar')}
                  >
                    Encerrar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {creating && (
        <Card title="Nova ordem de serviço" className="mb-5">
          <form onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-4">
            <CampoBancada bancadas={bancadasDeEntrada} value={bancadaNova} onChange={setBancadaNova} />
            <Field
              label="Cliente"
              required
              hint={
                form.customerId
                  ? 'Vinculado ao cadastro'
                  : 'Digite para buscar no cadastro, ou siga sem cadastrar'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.customerName}
                  disabled={Boolean(estoqueDaOs)}
                  onChange={(e) => {
                    // Digitar de novo desfaz o vínculo: senão o nome na tela
                    // diria uma coisa e o id gravado diria outra.
                    setForm({ ...form, customerName: e.target.value, customerId: '' });
                    void buscarCadastros(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Equipamento" hint={form.equipmentId ? 'Vinculado ao cadastro' : undefined}>
              {(p) => (
                <Input
                  {...p}
                  value={form.equipment}
                  onChange={(e) => {
                    setForm({ ...form, equipment: e.target.value, equipmentId: '' });
                    setMotoEstoque(null);
                    void buscarCadastros(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Placa / identificação">
              {(p) => (
                <Input
                  {...p}
                  value={form.plate}
                  onChange={(e) => setForm({ ...form, plate: e.target.value })}
                />
              )}
            </Field>
            <Field label="Reclamação">
              {(p) => (
                <Input
                  {...p}
                  value={form.complaint}
                  onChange={(e) => setForm({ ...form, complaint: e.target.value })}
                />
              )}
            </Field>
            <Field label="Prioridade" hint="Decide a ordem no quadro e a régua do SLA">
              {(p) => (
                <select
                  {...p}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                >
                  {['urgente', 'alta', 'media', 'baixa'].map((prio) => (
                    <option key={prio} value={prio}>
                      {PRIORITY_LABELS[prio]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Prazo prometido" hint="Opcional — aparece no card">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                />
              )}
            </Field>
            {(clientes.length > 0 || equipamentos.length > 0) && (
              <div className="sm:col-span-4 flex flex-wrap gap-2">
                {!estoqueDaOs && clientes.map((c) => (
                  <Button
                    key={c.id}
                    type="button"
                    size="sm"
                    variant={form.customerId === c.id ? 'primary' : 'secondary'}
                    onClick={() => setForm({ ...form, customerId: c.id, customerName: c.name })}
                  >
                    👤 {c.name}
                  </Button>
                ))}
                {equipamentos.map((e) => (
                  <Button
                    key={e.id}
                    type="button"
                    size="sm"
                    variant={form.equipmentId === e.id ? 'primary' : 'secondary'}
                    onClick={() => {
                      // Moto do estoque: a OS é de montagem interna, sem cliente.
                      const estoque = motoDoEstoque(e);
                      setMotoEstoque(estoque);
                      setForm({
                        ...form,
                        equipmentId: e.id,
                        equipment: [e.brand, e.model].filter(Boolean).join(' '),
                        ...(estoque ? { customerId: '', customerName: 'Montagem interna' } : {}),
                      });
                    }}
                  >
                    🔧 #{e.public_id} {[e.brand, e.model].filter(Boolean).join(' ')}
                  </Button>
                ))}
              </div>
            )}
            {/* A moto do estoque, dita na abertura (GAP-PRD-109). */}
            {estoqueDaOs && (
              <p
                role="note"
                className="sm:col-span-4 m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                  text-[length:var(--gs-text-sm)]"
              >
                {avisoDeMotoDoEstoque(estoqueDaOs)}
              </p>
            )}
            <div className="sm:col-span-4">
              <Button type="submit">Abrir OS</Button>
            </div>
          </form>
        </Card>
      )}

      {loading && (
        <p role="status" className="text-[var(--gs-muted)]">
          Carregando…
        </p>
      )}

      {!loading && orders.length === 0 && (
        <Card>
          <EmptyState
            title="Nenhuma ordem de serviço"
            description="Abra a primeira OS para começar a acompanhar a oficina no quadro."
          />
        </Card>
      )}

      {!loading && orders.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-4 min-w-max">
            {statuses.map((status) => {
              // Urgente primeiro, e a mais antiga desempata — a ordem do
              // quadro antigo, a MESMA que o servidor usa para paginar
              // (GAP-PRD-187). Finalizadas são histórico: a mais recente em cima.
              const columnOrders = orders
                .filter((o) => o.status === status)
                .sort((a, b) =>
                  COLUNAS_PELA_ANTIGUIDADE.has(status)
                    ? (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
                      || a.number - b.number
                    : b.number - a.number,
                );
              const faltam = (totalPorColuna[status] ?? columnOrders.length) - columnOrders.length;
              return (
                <section
                  key={status}
                  aria-label={STATUS_LABELS[status] ?? status}
                  /*
                    SÓ COLUNA MÓVEL ACEITA O CARD.

                    O `select` do cartão já filtrava por `MOVABLE`; o arrasto
                    não filtrava nada — soltar em "Finalizada" ou na fila do
                    caixa abria o bloco de observação, a pessoa escrevia o
                    porquê e só então levava 409 do servidor. Duas portas para
                    a mesma ação precisam ter a mesma régua: sem `onDragOver`
                    aceitando, o navegador nem deixa soltar ali.
                  */
                  onDragOver={(e) => {
                    if (MOVABLE.has(status)) e.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragging && MOVABLE.has(status)) pedirMovimento(dragging, status);
                    setDragging(null);
                  }}
                  className="w-[280px] shrink-0 bg-[var(--gs-surface-muted)]
                    border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3"
                >
                  <header className="flex items-center justify-between mb-3">
                    <h2 className="text-[length:var(--gs-text-sm)] font-semibold uppercase tracking-wide text-[var(--gs-muted)] m-0">
                      {STATUS_LABELS[status] ?? status}
                    </h2>
                    {/*
                      O NÚMERO DIZ QUANTAS EXISTEM, e não quantas couberam.

                      Enquanto tudo cabe, é um número só — que é o caso de
                      toda coluna operacional numa oficina real. Quando não
                      cabe (a coluna de finalizadas de um ano), o "de N"
                      aparece: sem ele, quem olha conclui que a oficina
                      fechou 60 e ela fechou 400.
                    */}
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] tabular-nums">
                      {(totalPorColuna[status] ?? columnOrders.length) > columnOrders.length
                        ? `${columnOrders.length} de ${totalPorColuna[status]}`
                        : columnOrders.length}
                    </span>
                  </header>

                  <ul className="list-none p-0 m-0 flex flex-col gap-2 min-h-[80px]">
                    {columnOrders.map((order) => (
                      <li
                        key={order.id}
                        draggable
                        onDragStart={() => setDragging(order.id)}
                        onDragEnd={() => setDragging(null)}
                        className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
                          rounded-[var(--gs-radius)] shadow-[var(--gs-shadow-sm)] p-3 cursor-grab"
                      >
                        <div className="flex justify-between items-baseline gap-2">
                          {/*
                            O número abre a OS. Antes o cartão não levava a
                            lugar nenhum: o detalhe existia no servidor, com
                            peças, comentários e linha do tempo, e nenhuma tela
                            o consumia.
                          */}
                          <Link
                            to={`/sistema/oficina/os/${order.id}`}
                            className="text-[var(--gs-purple-800)] font-bold no-underline hover:underline"
                          >
                            OS #{order.number}
                          </Link>
                          <span className="text-[length:var(--gs-text-sm)] tabular-nums">
                            {formatCents(order.total_cents)}
                          </span>
                        </div>

                        {/* Prioridade, relógio do SLA e prazo (rodada 51). */}
                        <div className="flex flex-wrap gap-1 mt-1">
                          <span
                            className={`px-1.5 py-0.5 rounded-[var(--gs-radius-sm)] text-[length:var(--gs-text-xs)] font-semibold ${PRIORITY_CHIP[order.priority] ?? PRIORITY_CHIP.media}`}
                          >
                            {PRIORITY_LABELS[order.priority] ?? order.priority}
                          </span>
                          {(() => {
                            const alerta = estadoDoSla(order, sla);
                            if (!alerta) return null;
                            return (
                              <span
                                title={
                                  alerta.estourado
                                    ? `SLA estourado: ${alerta.horas}h nesta coluna (régua: ${alerta.limite}h)`
                                    : `Atenção: ${alerta.horas}h nesta coluna (régua: ${alerta.limite}h)`
                                }
                                className={`px-1.5 py-0.5 rounded-[var(--gs-radius-sm)] text-[length:var(--gs-text-xs)] font-semibold tabular-nums ${
                                  alerta.estourado
                                    ? 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] animate-pulse'
                                    : 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
                                }`}
                              >
                                ⏱ {alerta.horas}h/{alerta.limite}h
                              </span>
                            );
                          })()}
                          {(() => {
                            const prazo = estadoDoPrazo(order.due_date);
                            if (!prazo) return null;
                            return (
                              <span
                                title={prazo.title}
                                className={`px-1.5 py-0.5 rounded-[var(--gs-radius-sm)] text-[length:var(--gs-text-xs)] font-semibold tabular-nums ${prazo.classes}`}
                              >
                                📅 {prazo.texto}
                              </span>
                            );
                          })()}
                        </div>
                        <p className="m-0 mt-1 font-semibold text-[var(--gs-text)]">
                          {order.customer_display ?? 'Sem cliente'}
                          {order.customer_display && !order.customer_vinculado && (
                            <span
                              title="Digitado no balcão, sem vínculo com o cadastro"
                              className="ml-1 text-[length:var(--gs-text-xs)] font-normal text-[var(--gs-muted)]"
                            >
                              (sem cadastro)
                            </span>
                          )}
                        </p>
                        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {[order.equipment_display, order.plate].filter(Boolean).join(' · ') || '—'}
                        </p>
                        {order.mechanic_id && (
                          <p className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-purple-700)] font-semibold">
                            {order.mechanic_name ?? 'Responsável definido'}
                          </p>
                        )}
                        {/*
                          FORA DAS REGRAS (GAP-PRD-188): a OS antiga sem
                          bancada, ou parada numa coluna de trabalho sem
                          ninguém. O card diz o que falta, e o conserto mora
                          na ficha (gestão › Regularizar).
                        */}
                        {(order.irregularidades?.length ?? 0) > 0 && (
                          <Link
                            to={`/sistema/oficina/os/${order.id}`}
                            title="Abra a ficha: a gestão da oficina regulariza a OS por lá."
                            className="inline-block mt-1 px-1.5 py-0.5 rounded-[var(--gs-radius-sm)]
                              text-[length:var(--gs-text-xs)] font-semibold no-underline
                              bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
                          >
                            ⚠ Fora das regras:{' '}
                            {(order.irregularidades ?? [])
                              .map((i) => IRREGULARIDADE_ROTULO[i] ?? i)
                              .join(', ')}
                          </Link>
                        )}
                        {order.complaint && (
                          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                            {order.complaint}
                          </p>
                        )}

                        {/* Alternativa acessível ao arrastar. */}
                        <label className="sr-only" htmlFor={`status-${order.id}`}>
                          Situação da OS {order.number}
                        </label>
                        <select
                          id={`status-${order.id}`}
                          value={order.status}
                          disabled={
                            order.status === 'finalizada'
                            || order.status === 'aguardando_pagamento'
                          }
                          onChange={(e) => pedirMovimento(order.id, e.target.value)}
                          className="mt-2 w-full text-[length:var(--gs-text-sm)] px-2 py-1
                            border border-[var(--gs-border-strong)] rounded-[var(--gs-radius-sm)]
                            bg-[var(--gs-surface)] disabled:opacity-60"
                        >
                          {/* Só as colunas operacionais entram como escolha:
                              aguardando pagamento e finalizada são
                              consequência da conclusão técnica e da baixa no
                              PDV, não algo que se arrasta no quadro. */}
                          {statuses
                            .filter((s) => MOVABLE.has(s) || s === order.status)
                            .map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABELS[s] ?? s}
                              </option>
                            ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                  {faltam > 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2 w-full"
                      disabled={carregandoMais === status}
                      onClick={() => void carregarMais(status)}
                    >
                      {carregandoMais === status
                        ? 'Carregando…'
                        : `Carregar mais ${Math.min(faltam, CARDS_POR_COLUNA)} de ${faltam}`}
                    </Button>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </AppShell>
  );
}

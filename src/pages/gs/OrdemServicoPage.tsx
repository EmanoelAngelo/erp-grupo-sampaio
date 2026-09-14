/**
 * Oficina › a OS por dentro.
 *
 * ## Por que esta tela não existia
 *
 * O servidor já respondia tudo: `GET /core/workshop/orders/:id` devolve a
 * ordem, as peças aplicadas, os comentários e a linha do tempo de eventos.
 * Nenhuma tela consumia. O cartão do quadro não levava a lugar nenhum, e a
 * história da OS — quem assumiu, quando, o que constatou, que peça entrou —
 * ficava gravada e invisível.
 *
 * É o padrão que este projeto já pagou caro algumas vezes: código escrito,
 * testado e inalcançável. Aqui a metade que faltava era só a tela.
 *
 * ## O que ela mostra
 *
 * O cabeçalho responde as três perguntas do balcão — de quem é, qual aparelho,
 * em que pé está. Abaixo, a conta (mão de obra, peças, total) e a linha do
 * tempo, que é append-only: nada aqui é editável, porque nada aqui foi editado.
 *
 * ## A PEÇA CHEGA NA OS AQUI — e antes não chegava em lugar nenhum
 *
 * O card "Peças aplicadas" era só LEITURA. O servidor tinha
 * `POST /workshop/orders/:id/parts` desde a rodada da OS, o cliente de API
 * tinha apenas a DEVOLUÇÃO, e nenhuma tela chamava nenhum dos dois: a tabela
 * existia para mostrar "Nada saiu do estoque para esta OS" e não havia caminho
 * nenhum de fazer sair. O elo do meio da corrente — cadastrar a peça, LANÇAR na
 * OS, cobrar — não existia.
 *
 * ## O QUE ESTA TELA MOSTRA DE DINHEIRO, E O QUE ELA NUNCA MOSTRA
 *
 * Mostra o PREÇO da peça: é o que vai na conta do cliente, é o que soma no
 * total que já aparecia neste cabeçalho, e é o número que o mecânico precisa
 * ver para saber que o conserto está sendo cobrado.
 *
 * Nunca mostra o CUSTO. E não por escolha desta tela: `listParts` REMOVE
 * `cost_cents` da resposta quando quem pergunta não é gerente ou estoquista, e
 * é por isso que a busca daqui pede a peça pelo mesmo endereço da tela de Peças
 * em vez de ir pelo catálogo — o catálogo devolveria o custo para todo mundo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, SearchInput } from '@/components/gs/ui';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { coreApi, type WorkshopPart } from '@/lib/api/core';
import { oficinaCaixaApi } from '@/lib/api/oficinaCaixa';
import { printDocument } from '@/lib/print';
import { RecebimentoOsDialog } from '@/components/gs/RecebimentoOsDialog';
import { EstornoOsDialog } from '@/components/gs/EstornoOsDialog';
import { RegularizarOsCard } from '@/components/gs/RegularizarOsCard';
import { DocumentosFiscaisDaOs } from '@/components/gs/DocumentosFiscaisDaOs';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { salvarArquivo } from '@/lib/download';
import { dataHoraBR } from '@/lib/datas';

interface Parte {
  id: string;
  description: string | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  /**
   * Quanto desta linha já voltou para a gaveta.
   *
   * A devolução existia no servidor e nenhuma tela a usava; sem esta coluna, a
   * peça devolvida sumiria da vista e a linha continuaria dizendo que três
   * saíram — quando duas voltaram.
   */
  returned_quantity: number | null;
}

interface Comentario {
  id: string;
  /** 'proprietario' é a voz do cliente vinda do portal — rotulada diferente. */
  author_kind: string | null;
  author_name: string | null;
  body: string | null;
  created_at: string;
}

interface Evento {
  id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
}

interface Detalhe {
  id: string;
  number: number;
  status: string;
  /** A gaveta desta OS: a busca de peça só oferece o que é desta bancada. */
  workshop_id: string | null;
  /**
   * Quem assumiu. O servidor recusa peça de OS que é de outro técnico
   * (`CORE_ORDER_NOT_ASSIGNED_TO_YOU`) — inclusive para o gerente —, então a
   * tela não oferece o caminho a quem receberia a recusa.
   */
  mechanic_id: string | null;
  customer_display: string | null;
  customer_phone: string | null;
  customer_id: string | null;
  equipment_display: string | null;
  equipment_public_id: number | null;
  equipment_serial: string | null;
  plate: string | null;
  complaint: string | null;
  diagnosis: string | null;
  mechanic_name: string | null;
  workshop_name: string | null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
  /**
   * A venda que pagou a OS, e quando. Ausentes na OS que não foi cobrada — e
   * é por eles que a ficha oferece o comprovante e o estorno (GAP-PRD-105).
   * É também pela venda que a OS paga chega aos documentos fiscais — a NFC-e
   * das peças e a NFS-e da mão de obra (GAP-PRD-024).
   */
  sale_id?: string | null;
  paid_at?: string | null;
  opened_by_customer: number;
  /** Os dois tempos do orçamento (rodada 43): a oficina pede, o cliente decide. */
  approval_requested_at: string | null;
  approved_at: string | null;
  /** Prioridade e prazo do quadro (rodada 51). */
  priority: string;
  due_date: string | null;
  /** Quando a OS entrou na coluna — o retrato que o largar leva (GAP-PRD-183). */
  status_changed_at?: string | null;
  /** O que está fora das regras atuais (GAP-PRD-188), calculado no servidor. */
  irregularidades?: string[];
  created_at: string;
  parts: Parte[];
  comments: Comentario[];
  events: Evento[];
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

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  em_aberto: 'warning',
  em_andamento: 'info',
  aguardando_peca: 'warning',
  manutencao_externa: 'warning',
  parada_setor: 'warning',
  aguardando_pagamento: 'warning',
  finalizada: 'success',
};

/** Rótulos da prioridade (rodada 51) — os mesmos do quadro. */
const PRIORITY_LABELS: Record<string, string> = {
  urgente: 'Urgente',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};

// ------------------------------------- conferência e fotos (rodada 52)

interface ChecklistItem {
  id: string;
  item: string;
  answer: string;
  note: string | null;
  answered_at: string | null;
}

interface FotoDaOs {
  id: string;
  url: string;
  kind: string;
  caption: string | null;
  created_at: string;
}

const FOTO_ROTULO: Record<string, string> = {
  entrada: 'Entrada',
  defeito: 'Defeito',
  servico: 'Serviço',
  saida: 'Saída',
};

// ------------------------------------------ o que o cliente recebeu (GAP-PRD-036)

/**
 * O que a oficina mandou ao cliente por esta OS — `GET .../avisos`.
 *
 * O botão dizia "Enviar orçamento ao cliente" e a tela "enviado em …" sem
 * que nada saísse. Agora a tela conta o que o SERVIDOR sabe: a mensagem na
 * fila, se ela já saiu, e se o cliente sequer tem e-mail.
 */
interface AvisoDaOs {
  id: string;
  template: string;
  templateLabel: string;
  toAddress: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface AvisosDaOs {
  emailDoCliente: string | null;
  envioLigado: boolean;
  avisos: AvisoDaOs[];
}

/** A situação de UMA mensagem, em palavras de balcão. */
function situacaoDoAviso(a: AvisoDaOs, envioLigado: boolean): string {
  if (a.status === 'sent') return `enviado para ${a.toAddress} em ${quando(a.sentAt ?? a.createdAt)}`;
  if (a.status === 'failed') {
    return `não foi entregue a ${a.toAddress}${a.lastError ? ` (${a.lastError})` : ''} — veja em E-mails`;
  }
  return envioLigado
    ? `na fila para ${a.toAddress} — sai na próxima passada do carteiro`
    : `na fila para ${a.toAddress} — sai quando o envio de e-mail da loja for ligado (tela E-mails)`;
}

/**
 * A foto sai do celular com 12 MP; o servidor aceita 3 MB.
 *
 * Reduzir AQUI, antes de enviar, é o que faz a bancada conseguir registrar a
 * entrada com o telefone que ela tem — em vez de receber "imagem grande
 * demais" e desistir. O maior lado vai para 1600 px, que é mais do que
 * suficiente para mostrar um risco na carenagem.
 */
async function reduzirImagem(file: File): Promise<string> {
  const LADO_MAX = 1600;
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
  const largura = Math.round(bitmap.width * escala);
  const altura = Math.round(bitmap.height * escala);
  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Não foi possível preparar a imagem.');
  ctx.drawImage(bitmap, 0, 0, largura, altura);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

function quando(iso: string): string {
  return dataHoraBR(iso);
}

export default function OrdemServicoPage() {
  const { id } = useParams<{ id: string }>();
  const [os, setOs] = useState<Detalhe | null>(null);
  const [avisos, setAvisos] = useState<AvisosDaOs | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [convite, setConvite] = useState<string | null>(null);

  /*
    QUEM MEXE EM PEÇA.

    Os mesmos dois perfis que as rotas exigem: `POST .../parts` e
    `POST .../parts/:id/return` pedem `mecanico` ou `gerente_oficina`
    (`admin_geral` e `gestor` passam em tudo, e `useHasProfile` faz igual).
    Atendente e gerente de loja ABREM esta OS — a rota de leitura não pede
    perfil — e para eles o card continua sendo o que sempre foi: leitura.
    Oferecer o botão a quem levaria 403 é pior que não oferecer.
  */
  const mexeEmPeca = useHasProfile('mecanico', 'gerente_oficina');
  /*
    QUEM FOTOGRAFA é quem ATENDE a OS, não só quem mexe em peça.

    A rota das fotos aceita os mesmos quatro perfis de `podeComentar`, e com
    razão: quem recebe a moto no balcão é o ATENDENTE, e a foto que mais
    importa é a da entrada — tirada naquele instante, com o cliente na frente.
    O card nasceu gateado por `mexeEmPeca` (mecânico e gerente), a lista das
    rotas de PEÇA, copiada por proximidade: a pessoa certa, na hora certa, não
    tinha o botão.
  */
  const podeFotografar = useHasProfile(
    'mecanico',
    'gerente_oficina',
    'operador_caixa_oficina',
    'atendente',
  );
  /** Quem fala com o cliente pede a aprovação; quem opera o caixa cobra. */
  const pedeAprovacao = useHasProfile('mecanico', 'gerente_oficina', 'atendente');
  const caixaDaOficina = useHasProfile('operador_caixa_oficina', 'gerente_oficina');
  const podeComentar = useHasProfile(
    'mecanico',
    'gerente_oficina',
    'operador_caixa_oficina',
    'atendente',
  );
  const meuId = useSession()?.user.id ?? null;
  /** Gestão da oficina: replaneja e devolve OS de qualquer técnico (r51). */
  const gerenteDaOficina = useHasProfile('gerente_oficina');
  /**
   * Fala como TÉCNICO na linha do tempo — a voz com a trava de responsável
   * (GAP-PRD-102). O atendente e o caixa falam como balcão; a gerência, como
   * gestão; nenhum dos dois leva a trava.
   */
  const ehMecanico = useHasProfile('mecanico');
  const falaComoTecnico = ehMecanico && !gerenteDaOficina;

  // Prioridade/prazo em edição (rodada 51) e a devolução ao quadro.
  const [plano, setPlano] = useState<{ priority: string; dueDate: string } | null>(null);
  const [devolvendo, setDevolvendo] = useState(false);
  const [justificativa, setJustificativa] = useState('');

  // Conferência de entrada e fotos (rodada 52).
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [fotos, setFotos] = useState<FotoDaOs[]>([]);
  const [subindo, setSubindo] = useState(false);
  const [tipoDaFoto, setTipoDaFoto] = useState('servico');
  /** A foto aberta em tela cheia: endereço já montado e o mesmo texto da miniatura. */
  const [ampliada, setAmpliada] = useState<{ url: string; alt: string } | null>(null);
  /** O campo de arquivo escondido atrás do botão "Adicionar foto". */
  const escolherFoto = useRef<HTMLInputElement>(null);
  /** A OS virando papel (rodada 54). */
  const [imprimindo, setImprimindo] = useState(false);

  /** Busca na gaveta: aberta sob demanda, porque o normal é só conferir a OS. */
  const [buscandoPeca, setBuscandoPeca] = useState(false);
  const [buscaPeca, setBuscaPeca] = useState('');
  const [achados, setAchados] = useState<WorkshopPart[] | null>(null);
  const [quantidades, setQuantidades] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState(false);
  /**
   * A recusa da bancada, mostrada JUNTO da peça e não no topo da página.
   *
   * "Falta peça: Conector tem 1 na gaveta e a OS pediu 3" só serve se a pessoa
   * a ler onde ela acabou de clicar.
   */
  const [recusa, setRecusa] = useState<string | null>(null);
  /** Linha em devolução e quanto volta. Nulo = ninguém está devolvendo nada. */
  const [devolucao, setDevolucao] = useState<{ partId: string; quantidade: string } | null>(null);

  /** Mão de obra em reais, como o mecânico fala — convertida em centavos no envio. */
  const [maoDeObra, setMaoDeObra] = useState('');
  const [comentario, setComentario] = useState('');
  /** Formulário de conclusão técnica: só abre quando o responsável clica. */
  const [concluindo, setConcluindo] = useState(false);
  const [diagnostico, setDiagnostico] = useState('');
  const [temCusto, setTemCusto] = useState(true);
  const [motivoSemCusto, setMotivoSemCusto] = useState('garantia');
  /**
   * O caixa da OS (GAP-PRD-104/105): o recebimento com a cesta do PDV e o
   * estorno do recebimento, cada um no seu diálogo. A política do fiado vem
   * da fila do caixa, que é a rota que o caixa alcança.
   */
  const [recebendo, setRecebendo] = useState(false);
  const [estornando, setEstornando] = useState(false);
  const [faturamentoAPrazo, setFaturamentoAPrazo] = useState<
    { habilitado: boolean; prazoDias: number } | null
  >(null);
  /** O que o caixa acabou de fazer — recebido ou estornado —, dito em uma frase. */
  const [avisoCaixa, setAvisoCaixa] = useState<string | null>(null);
  /** Recusas do card de serviço, mostradas onde a pessoa clicou. */
  const [recusaServico, setRecusaServico] = useState<string | null>(null);
  /*
    Recusas de AÇÃO — e nenhuma delas é `erro`.

    `erro` troca a página inteira pelo vazio "Ordem de serviço não encontrada";
    ele é só para "não consegui abrir a OS". Cada recusa aqui aparece ao lado
    do que foi clicado: a da foto no card das fotos, a da conferência no card
    da conferência, e o resto no aviso do topo.
  */
  const [recusaAcao, setRecusaAcao] = useState<string | null>(null);
  /** A conferência não pôde ser lida — e "não sei" não é "não há pendência". */
  const [conferenciaIlegivel, setConferenciaIlegivel] = useState(false);
  const [recusaFoto, setRecusaFoto] = useState<string | null>(null);
  const [recusaConferencia, setRecusaConferencia] = useState<string | null>(null);

  /*
    `silencioso` existe por causa da conferência.

    Ligar `carregando` troca a árvore inteira por "Carregando…": o documento
    encolhe, a rolagem volta ao topo, e quem responde os 9 itens do molde de
    mobilidade rola de volta 9 vezes — no celular, que é onde a bancada
    confere, isso é a diferença entre usar a lista e ignorá-la. Só a PRIMEIRA
    carga mostra o esqueleto; releitura depois de uma ação acontece por baixo.
  */
  const carregar = useCallback(async (silencioso = false) => {
    if (!id) return;
    if (!silencioso) setCarregando(true);
    setErro(null);
    try {
      setOs(await apiRequest<Detalhe>(`/core/workshop/orders/${id}`));
      /*
        Conferência e fotos vêm em chamadas próprias, e a falha de UMA não
        derruba a outra nem a OS.

        `Promise.all` com um `catch` só fazia a queda das FOTOS apagar o
        checklist — e checklist vazio não é "não há pendência": é "não sei". A
        tela então escondia o card, calculava zero pendentes e LIBERAVA o botão
        de concluir, mandando a pessoa direto para o 409 do servidor, que é
        exatamente o beco do sistema anterior. Agora cada lista responde por
        si, e não saber a conferência mantém a conclusão travada, com o
        caminho de forçar à vista.
      */
      const [c, f, a] = await Promise.allSettled([
        apiRequest<{ items: ChecklistItem[] }>(`/core/workshop/orders/${id}/checklist`),
        apiRequest<{ items: FotoDaOs[] }>(`/core/workshop/orders/${id}/photos`),
        // O que foi (ou não) avisado ao cliente — GAP-PRD-036. Falhar aqui
        // não derruba a OS: a tela só deixa de afirmar o que não sabe.
        apiRequest<AvisosDaOs>(`/core/workshop/orders/${id}/avisos`),
      ]);
      setAvisos(
        a.status === 'fulfilled' && a.value && Array.isArray(a.value.avisos) ? a.value : null,
      );
      if (c.status === 'fulfilled') {
        setChecklist(c.value.items ?? []);
        setConferenciaIlegivel(false);
      } else {
        setChecklist([]);
        setConferenciaIlegivel(true);
      }
      setFotos(f.status === 'fulfilled' ? (f.value.items ?? []) : []);
    } catch (err) {
      setErro(
        err instanceof ApiRequestError ? err.message : 'Falha ao abrir a ordem de serviço.',
      );
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Escape fecha a foto ampliada — ver o comentário do diálogo lá embaixo.
  useEffect(() => {
    if (!ampliada) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAmpliada(null);
    };
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [ampliada]);

  // O campo abre já com o valor gravado: editar é o caso raro, conferir é o comum.
  useEffect(() => {
    if (os) setMaoDeObra(os.labor_cents ? (os.labor_cents / 100).toFixed(2).replace('.', ',') : '');
  }, [os]);

  /**
   * O que tem na gaveta DESTA bancada.
   *
   * `workshopId` vai amarrado ao da OS: sem ele, a bancada de celulares veria a
   * prateleira da mobilidade e escolheria uma peça que o servidor recusaria
   * depois (`CORE_PART_OTHER_WORKSHOP`). Recusar depois de escolher é pior do
   * que nunca ter oferecido.
   *
   * Busca vazia lista a gaveta inteira, que é o comportamento certo para quem
   * não sabe o nome exato do conector.
   */
  const procurarPecas = useCallback(async () => {
    if (!os) return;
    setRecusa(null);
    try {
      setAchados(
        await coreApi.listParts({
          workshopId: os.workshop_id ?? undefined,
          search: buscaPeca.trim() || undefined,
        }),
      );
    } catch (err) {
      setAchados([]);
      setRecusa(
        err instanceof ApiRequestError ? err.message : 'Falha ao consultar o estoque de peças.',
      );
    }
  }, [os, buscaPeca]);

  // Abrir o painel já traz a gaveta: obrigar a digitar antes de ver qualquer
  // coisa esconderia justamente o caso comum — "o que eu tenho aí?".
  useEffect(() => {
    if (buscandoPeca && achados === null) void procurarPecas();
  }, [buscandoPeca, achados, procurarPecas]);

  /**
   * LANÇA a peça: PROMETE a peça ao conserto e soma na conta da OS, na mesma
   * transação do servidor.
   *
   * Não é baixa (rodada 55). O lançamento acontece antes de o cliente decidir —
   * é ele que monta o orçamento —, então a peça fica reservada: continua na
   * prateleira, ninguém mais pode vendê-la, e volta sozinha se o orçamento for
   * recusado. A baixa vem quando o serviço é autorizado a acontecer.
   *
   * As três recusas que interessam chegam com texto pronto da bancada — peça
   * sem preço de venda, falta de peça com o número, e OS de outro técnico —, e
   * por isso o `catch` mostra a mensagem do servidor em vez de escrever uma
   * segunda versão dela aqui.
   */
  async function lancar(peca: WorkshopPart) {
    const texto = (quantidades[peca.id] ?? '1').replace(',', '.');
    const quantidade = Number(texto);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      setRecusa('Informe uma quantidade maior que zero.');
      return;
    }
    setOcupado(true);
    setRecusa(null);
    try {
      await coreApi.lancarPeca(os!.id, { productId: peca.id, quantity: quantidade });
      setQuantidades((q) => ({ ...q, [peca.id]: '1' }));
      // A gaveta mudou de saldo agora mesmo: releitura, senão a próxima
      // conferência seria feita contra um número velho.
      await Promise.all([carregar(), procurarPecas()]);
    } catch (err) {
      setRecusa(err instanceof ApiRequestError ? err.message : 'Falha ao lançar a peça.');
    } finally {
      setOcupado(false);
    }
  }

  /**
   * DEVOLVE à gaveta o que não foi usado.
   *
   * O mecânico pega três parafusos, usa dois, e o terceiro precisa voltar a
   * existir. O servidor já sabia fazer isso desde a rodada passada e nenhuma
   * tela chamava — era código escrito, testado e inalcançável.
   */
  /**
   * Molde comum das ações da rodada 51: ocupa, executa, recarrega, explica.
   *
   * `mostrar` diz ONDE a recusa aparece. O padrão é o aviso do topo — nunca
   * `setErro`, que é o canal de "não consegui abrir a OS" e troca a página
   * inteira pelo vazio. Quem tem card próprio passa o slot do card, para a
   * recusa nascer ao lado do botão que a pessoa clicou.
   */
  async function executar(
    acao: () => Promise<void>,
    mostrar: (mensagem: string | null) => void = setRecusaAcao,
  ) {
    setOcupado(true);
    mostrar(null);
    try {
      await acao();
      await carregar(true);
    } catch (err) {
      mostrar(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir a ação.');
    } finally {
      setOcupado(false);
    }
  }

  /**
   * A OS EM PAPEL — o documento vem PRONTO do servidor, em A4.
   *
   * A tela não desenha documento: o mesmo HTML serve à fila de impressão e a
   * este botão, e dois desenhos divergiriam no primeiro campo que alguém
   * mudasse num só. Aqui só se abre a janela — e é o diálogo do navegador que
   * oferece "Salvar como PDF", que é o PDF que o dono pediu.
   */
  async function imprimirOs() {
    setImprimindo(true);
    setRecusaAcao(null);
    try {
      const papel = await apiRequest<{ html: string; numero: number }>(
        `/core/workshop/orders/${os!.id}/impressao`,
      );
      const janela = window.open('', '_blank');
      if (janela) {
        janela.document.write(papel.html);
        janela.document.close();
        return;
      }
      /*
        Pop-up bloqueado: o arquivo baixa, e quem abriu imprime de lá.

        O download passa por `salvarArquivo`, que existe justamente porque a
        versão ingênua não funciona: âncora fora do documento não dispara em
        parte dos navegadores, e revogar o endereço na linha seguinte ao clique
        chega cedo demais — o arquivo sai vazio ou nem sai. E a mensagem só
        pode afirmar que baixou se tiver baixado: dizer "foi baixada" quando o
        download falhou manda a pessoa procurar um arquivo que não existe.
      */
      try {
        salvarArquivo(new Blob([papel.html], { type: 'text/html' }), `os-${papel.numero}.html`);
        setRecusaAcao(
          'O navegador bloqueou a janela de impressão: a OS foi baixada como arquivo. '
          + 'Abra o arquivo e use Imprimir (ou Salvar como PDF).',
        );
      } catch {
        setRecusaAcao(
          'O navegador bloqueou a janela de impressão E o download. Libere pop-ups para este '
          + 'endereço e clique de novo.',
        );
      }
    } catch (err) {
      setRecusaAcao(
        err instanceof ApiRequestError ? err.message : 'Não foi possível gerar a OS em papel.',
      );
    } finally {
      setImprimindo(false);
    }
  }

  async function devolver(parte: Parte, quantidade: number) {
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      setRecusa('Informe quanto está voltando para a gaveta.');
      return;
    }
    setOcupado(true);
    setRecusa(null);
    try {
      await coreApi.returnPart(os!.id, parte.id, quantidade);
      setDevolucao(null);
      await Promise.all([carregar(), buscandoPeca ? procurarPecas() : Promise.resolve()]);
    } catch (err) {
      setRecusa(err instanceof ApiRequestError ? err.message : 'Falha ao devolver a peça.');
    } finally {
      setOcupado(false);
    }
  }

  /**
   * O código sai UMA vez, na tela de quem o gerou.
   *
   * Depois disso ele só existe no papel do cliente: o banco guarda o SHA-256,
   * e nem a auditoria registra o texto. Por isso a tela o mostra grande e
   * pede para anotar — reemitir é possível, mas invalida o anterior.
   */
  async function gerarConvite(customerId: string) {
    setErro(null);
    try {
      const r = await apiRequest<{ code: string; customerName: string }>(
        `/core/customers/${customerId}/convite-portal`,
        { method: 'POST' },
      );
      setConvite(r.code);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gerar o acesso.');
    }
  }

  /**
   * Reais digitados viram centavos — pelo interpretador da casa.
   *
   * A versão que estava aqui apagava TODO ponto como separador de milhar antes
   * de olhar se havia vírgula: quem digitasse `12.50` no teclado numérico
   * lançava mão de obra de R$ 1.250,00. É o mesmo defeito de cem vezes que
   * `parseReaisToCents` foi escrito para fechar, e ele estava importado neste
   * arquivo por outro motivo.
   *
   * `NaN` no lugar do `null` porque quem chama decide pelo `Number.isFinite` —
   * e devolver zero aqui faria "digitou errado" virar "mão de obra de graça".
   */
  function reaisParaCents(texto: string): number {
    return parseReaisToCents(texto) ?? NaN;
  }

  async function salvarMaoDeObra() {
    const cents = reaisParaCents(maoDeObra || '0');
    if (!Number.isFinite(cents) || cents < 0) {
      setRecusaServico('Informe um valor de mão de obra válido.');
      return;
    }
    setOcupado(true);
    setRecusaServico(null);
    try {
      await apiRequest(`/core/workshop/orders/${os!.id}/labor`, {
        method: 'POST',
        body: { laborCents: cents },
      });
      await carregar(true);
    } catch (err) {
      setRecusaServico(
        err instanceof ApiRequestError ? err.message : 'Falha ao salvar a mão de obra.',
      );
    } finally {
      setOcupado(false);
    }
  }

  /** O primeiro tempo do orçamento: registra o pedido e avisa a linha do tempo. */
  async function pedirAprovacao() {
    setOcupado(true);
    setRecusaServico(null);
    try {
      await apiRequest(`/core/workshop/orders/${os!.id}/pedir-aprovacao`, {
        method: 'POST',
        body: {},
      });
      await carregar(true);
    } catch (err) {
      setRecusaServico(
        err instanceof ApiRequestError ? err.message : 'Falha ao pedir a aprovação.',
      );
    } finally {
      setOcupado(false);
    }
  }

  /** Conclusão técnica: com custo vai ao caixa; sem custo exige motivo válido. */
  async function concluir(forcarChecklist = false) {
    if (!diagnostico.trim()) {
      setRecusaServico('Escreva o diagnóstico/conclusão antes de fechar.');
      return;
    }
    setOcupado(true);
    setRecusaServico(null);
    try {
      await apiRequest(`/core/workshop/orders/${os!.id}/complete`, {
        method: 'POST',
        body: {
          diagnosis: diagnostico.trim(),
          hasCost: temCusto,
          noCostReason: temCusto ? undefined : motivoSemCusto,
          // A saída de emergência da conferência (rodada 52) — a bancada não
          // trava, e a decisão fica registrada na linha do tempo.
          forcarChecklist,
        },
      });
      setConcluindo(false);
      await carregar(true);
    } catch (err) {
      setRecusaServico(
        err instanceof ApiRequestError ? err.message : 'Falha ao concluir o serviço.',
      );
    } finally {
      setOcupado(false);
    }
  }

  /**
   * Recebimento no caixa da oficina — o fechamento do PDV com a OS como
   * documento (GAP-PRD-104): `RecebimentoOsDialog` divide o valor, calcula o
   * troco, passa o cartão na maquininha, pede gestor para desconto acima da
   * alçada e só oferece faturar a prazo quando o dono ligou.
   *
   * A gaveta é lida pelo diálogo na hora de receber, e não na abertura desta
   * tela: entre abrir a OS e receber por ela pode ter passado o turno inteiro.
   * A política do fiado vem da fila do caixa — `/sale-policies` é de gerente.
   */
  function abrirRecebimento() {
    setRecusaServico(null);
    setAvisoCaixa(null);
    void oficinaCaixaApi
      .fila()
      .then((f) => setFaturamentoAPrazo(f.faturamentoAPrazo))
      // Sem a política, o diálogo simplesmente não oferece o fiado.
      .catch(() => setFaturamentoAPrazo(null));
    setRecebendo(true);
  }

  /** O comprovante da venda da OS — a mesma fila de impressão do PDV. */
  async function imprimirComprovante(saleId: string) {
    try {
      await printDocument('SALE_RECEIPT', saleId);
    } catch (err) {
      setRecusaServico(
        err instanceof ApiRequestError
          ? `Não foi possível imprimir: ${err.message}`
          : 'Não foi possível imprimir o comprovante. Confira a impressora e tente de novo.',
      );
    }
  }

  async function comentar() {
    if (!comentario.trim()) return;
    setOcupado(true);
    try {
      await apiRequest(`/core/workshop/orders/${os!.id}/comments`, {
        method: 'POST',
        body: { body: comentario.trim() },
      });
      setComentario('');
      await carregar(true);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar o comentário.');
    } finally {
      setOcupado(false);
    }
  }

  if (carregando) {
    return (
      <AppShell>
        <p role="status">Carregando…</p>
      </AppShell>
    );
  }

  /*
    O VAZIO É PARA "NÃO CONSEGUI ABRIR A OS" — e só.

    Enquanto `erro` sozinho decidia isto, QUALQUER recusa de ação apagava a
    página: subir a 21ª foto trocava a OS inteira por "Ordem de serviço não
    encontrada — Esta OS já tem 20 fotos". Sumiam peças, mão de obra,
    conferência e histórico, e a mensagem ainda por cima mentia sobre o que
    aconteceu. Recusa de ação agora tem slot próprio, ao lado do que foi
    clicado, como em peças (`recusa`) e na conclusão (`recusaServico`).
  */
  if (!os) {
    return (
      <AppShell>
        <Card>
          <EmptyState
            title="Ordem de serviço não encontrada"
            description={erro ?? 'Ela pode ter sido aberta em outra oficina.'}
            action={
              <Link to="/sistema/oficina">
                <Button variant="secondary">Voltar ao quadro</Button>
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  /*
    QUEM PODE LANÇAR PEÇA NESTA OS, agora.

    São três condições, e cada uma tem uma recusa correspondente no servidor.
    A tela não inventa regra nova: ela deixa de oferecer o que levaria 403 ou
    409, e diz por quê — botão que sempre falha ensina a pessoa a desconfiar
    do sistema.
  */
  const osFinalizada = os.status === 'finalizada';
  /** Itens que ninguém conferiu — é o que o servidor exige antes de fechar. */
  const checklistPendente = checklist.filter((i) => i.answer === 'pendente').length;
  const deOutroTecnico = Boolean(os.mechanic_id && meuId && os.mechanic_id !== meuId);
  const podeLancar = mexeEmPeca && !osFinalizada && !deOutroTecnico;
  /*
    DEVOLVER tem a régua do servidor (GAP-PRD-103): quem assumiu a OS, ou a
    gerência da oficina — que remaneja o que sobrou sem precisar assumir.
    Lançar continua sendo só de quem assumiu (`addPart` recusa o gerente).
  */
  const podeDevolver = mexeEmPeca && !osFinalizada && (!deOutroTecnico || gerenteDaOficina);
  /*
    QUEM COMENTA NESTA OS (GAP-PRD-102): o balcão e a gerência falam em
    qualquer OS; o mecânico fala na que assumiu (ou na que ninguém assumiu).
    A caixa de comentário não se oferece a quem levaria 403.
  */
  const podeComentarNestaOs = podeComentar && !(falaComoTecnico && deOutroTecnico);
  /*
    O card de serviço segue as MESMAS recusas do servidor:
    - mão de obra: setLabor recusa OS de outro técnico;
    - concluir: completeTechnical exige ser QUEM ASSUMIU — nem gerente passa;
    - pedir aprovação: só com a OS viva e com valor.
  */
  // "Viva na bancada" — a MESMA lista do servidor (ORDER_STATUSES_ON_BENCH).
  // Ela era escrita por complemento e não soube da coluna `parada_setor`
  // quando ela nasceu: a OS parada no setor perdia peça, mão de obra e
  // conclusão na tela, embora o servidor as aceitasse.
  const osViva = [
    'em_aberto',
    'em_andamento',
    'manutencao_externa',
    'parada_setor',
    'aguardando_peca',
  ].includes(os.status);
  const mexeNaConta = mexeEmPeca && osViva && !deOutroTecnico;
  const souOResponsavel = Boolean(os.mechanic_id && meuId && os.mechanic_id === meuId);
  // Pedido de pé só conta com a OS na bancada — fora dela o servidor recusa a
  // decisão (GAP-PRD-182) e o selo "aguardando o cliente" seria mentira.
  const aguardandoCliente = osViva && Boolean(os.approval_requested_at && !os.approved_at);
  /*
    O card só existe quando tem ALGO a oferecer ou a contar. Na OS finalizada
    sem orçamento aprovado ele ficava vazio — título e subtítulo emoldurando
    nada, visto na verificação em tela contra a OS #2 real.
  */
  /** OS paga por uma venda: é o que tem comprovante e estorno (GAP-PRD-105). */
  const pagaComVenda = os.status === 'finalizada' && Boolean(os.sale_id);
  const temServicoEConta =
    (mexeEmPeca || pedeAprovacao || caixaDaOficina) &&
    (osViva || os.status === 'aguardando_pagamento' || aguardandoCliente ||
      Boolean(os.approved_at) || Boolean(recusaServico) ||
      (caixaDaOficina && (pagaComVenda || Boolean(avisoCaixa))));
  const porQueNaoLanca = !mexeEmPeca
    ? null
    : osFinalizada
      ? 'OS finalizada: a conta já fechou. Peça lançada agora mudaria um valor que o cliente já pagou.'
      : deOutroTecnico
        ? gerenteDaOficina
          ? `Esta OS foi assumida por ${os.mechanic_name ?? 'outro técnico'}. Quem lança peça é quem assumiu; a gerência pode devolver a que sobrou.`
          : `Esta OS foi assumida por ${os.mechanic_name ?? 'outro técnico'}. Quem lança e devolve peça é quem assumiu.`
        : null;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', `OS #${os.number}`]}
        title={`OS #${os.number}`}
        subtitle={os.workshop_name ?? undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {/*
              A OS EM PAPEL (rodada 54).

              O documento existia no servidor desde a fila de impressão e
              nenhuma tela jamais o chamou: quem precisava entregar um papel ao
              cliente não tinha por onde. O botão vale DESDE A ABERTURA — na
              entrada ele sai com a conferência e a assinatura de recebimento;
              na entrega, com diagnóstico, peças e valores. É o mesmo papel,
              mais cheio.

              O alcance é o mesmo da leitura da OS: quem abre a ordem imprime.
              O papel não mostra nada que a tela já não mostre a essas pessoas.
            */}
            <Button
              variant="secondary"
              loading={imprimindo}
              onClick={() => void imprimirOs()}
            >
              Imprimir OS
            </Button>
            <Link to="/sistema/oficina">
              <Button variant="secondary">Voltar ao quadro</Button>
            </Link>
          </div>
        }
      />

      {/*
        Recusa de ação sem card próprio (assumir, mover, largar, replanejar).
        Ela aparece AQUI e a OS continua inteira embaixo — antes, qualquer
        recusa destas trocava a página pelo vazio "não encontrada".
      */}
      {recusaAcao && (
        <p
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)]
            bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {recusaAcao}
        </p>
      )}

      {/* A OS fora das regras atuais e o conserto dela (GAP-PRD-188). */}
      <RegularizarOsCard
        orderId={os.id}
        numero={os.number}
        irregularidades={os.irregularidades ?? []}
        semDinheiro={
          os.parts.length === 0 && !os.sale_id && Number(os.total_cents) === 0
          && Number(os.labor_cents) === 0
        }
        naBancada={os.status !== 'aguardando_pagamento' && os.status !== 'finalizada'}
        podeRegularizar={gerenteDaOficina}
        onRegularizada={() => void carregar(true)}
      />

      {convite && (
        <Card className="mb-5">
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Anote e entregue ao cliente. O código aparece uma vez só e vale 72 horas.
          </p>
          <p className="m-0 font-mono text-[28px] tracking-[0.2em] font-bold">{convite}</p>
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            Ele usa em <strong>Minha conta › Meus equipamentos</strong>.
          </p>
        </Card>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap gap-6 items-start">
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Cliente</p>
            <p className="m-0 font-semibold">{os.customer_display ?? 'Sem cliente'}</p>
            {os.customer_display && !os.customer_id && (
              // O aviso existe para a hora do caixa: OS sem cliente do cadastro
              // não fatura a prazo, e é melhor descobrir aqui que na cobrança.
              <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                Digitado no balcão, sem vínculo com o cadastro
              </p>
            )}
            {os.customer_phone && (
              <p className="m-0 text-[length:var(--gs-text-sm)]">{os.customer_phone}</p>
            )}
            {/*
              O CONVITE FICA AQUI, e não só na tela de Clientes.

              Quem entrega o papel é quem atende — e na oficina de moto o
              mecânico É o balcão. A tela de Clientes é do ambiente de gestão:
              pôr o botão só lá seria dá-lo a quem nunca chega até ele.

              Só aparece com cliente do cadastro: convite para um nome digitado
              à mão não teria a quem ligar a conta.
            */}
            {os.customer_id && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => void gerarConvite(os.customer_id!)}
              >
                Gerar acesso ao portal
              </Button>
            )}
          </div>

          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Equipamento</p>
            <p className="m-0 font-semibold">{os.equipment_display ?? '—'}</p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {[
                os.equipment_public_id ? `#${os.equipment_public_id}` : null,
                os.plate,
                os.equipment_serial,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          </div>

          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Situação</p>
            <Badge tone={STATUS_TONE[os.status] ?? 'neutral'}>
              {STATUS_LABELS[os.status] ?? os.status}
            </Badge>
            <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
              {os.mechanic_name ?? 'Sem responsável'}
            </p>
            <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Prioridade {PRIORITY_LABELS[os.priority] ?? os.priority}
              {os.due_date ? ` · prazo ${os.due_date.slice(0, 10)}` : ''}
            </p>
          </div>

          <div className="ml-auto text-right">
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Total</p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold tabular-nums">
              {formatCents(os.total_cents)}
            </p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] tabular-nums">
              Mão de obra {formatCents(os.labor_cents)} · Peças {formatCents(os.parts_cents)}
            </p>
          </div>
        </div>
      </Card>

      {(os.complaint || os.diagnosis) && (
        <Card className="mb-5">
          {os.complaint && (
            <>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Reclamação do cliente
              </p>
              <p className="m-0 mb-3">{os.complaint}</p>
            </>
          )}
          {os.diagnosis && (
            <>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Diagnóstico</p>
              <p className="m-0">{os.diagnosis}</p>
            </>
          )}
        </Card>
      )}

      {/*
        A CONFERÊNCIA DE ENTRADA (rodada 52).

        A lista que evita a discussão de balcão — "o carregador veio junto",
        "esse risco já era assim". Nasce com a OS, a partir do modelo da
        bancada, e item sem resposta segura a conclusão técnica: conferência
        que ninguém faz não serve para nada.
      */}
      {checklist.length > 0 && (
        <Card
          title={`Conferência de entrada (${checklist.filter((i) => i.answer !== 'pendente').length}/${checklist.length})`}
          subtitle="O que chegou junto com o aparelho. Item sem resposta segura a conclusão."
          className="mb-5"
        >
          {recusaConferencia && (
            <p
              role="alert"
              className="mb-3 px-3 py-2 rounded-[var(--gs-radius)]
                bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
            >
              {recusaConferencia}
            </p>
          )}
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {checklist.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--gs-border)] pb-2 last:border-0"
              >
                <div>
                  <span
                    className={
                      item.answer === 'pendente'
                        ? 'font-semibold'
                        : 'text-[var(--gs-text-soft)]'
                    }
                  >
                    {item.item}
                  </span>
                  {item.note && (
                    <span className="ml-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {item.note}
                    </span>
                  )}
                </div>
                {/*
                  O realce aponta para a ESCOLHA, não para o desfazer.

                  As duas respostas são sempre botões visíveis — item por
                  responder precisa parecer clicável — e a escolhida fica em
                  primário. "Limpar" é ação, não estado: só existe depois que há
                  resposta para desfazer. O primeiro desenho pintava de primário
                  a "resposta atual", e como item novo nasce `pendente` quem
                  ganhava destaque era justamente o Limpar.
                */}
                <div className="flex gap-1">
                  {(['sim', 'nao'] as const).map((resposta) => (
                    <Button
                      key={resposta}
                      size="sm"
                      variant={item.answer === resposta ? 'primary' : 'secondary'}
                      disabled={ocupado || osFinalizada || !podeComentar}
                      onClick={() =>
                        void executar(async () => {
                          await apiRequest(
                            `/core/workshop/orders/${os.id}/checklist/${item.id}`,
                            { method: 'PATCH', body: { answer: resposta } },
                          );
                        }, setRecusaConferencia)
                      }
                    >
                      {resposta === 'sim' ? 'Veio' : 'Não veio'}
                    </Button>
                  ))}
                  {item.answer !== 'pendente' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={ocupado || osFinalizada || !podeComentar}
                      onClick={() =>
                        void executar(async () => {
                          await apiRequest(
                            `/core/workshop/orders/${os.id}/checklist/${item.id}`,
                            { method: 'PATCH', body: { answer: 'pendente' } },
                          );
                        }, setRecusaConferencia)
                      }
                    >
                      Limpar
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        FOTOS — a prova do que chegou e do que foi feito (rodada 52).

        O arquivo vai para o disco do servidor; o navegador reduz antes de
        enviar. O sistema anterior guardava base64 no armazenamento local e
        duas fotos derrubavam a persistência de TODAS as ordens.
      */}
      <Card
        title={`Fotos (${fotos.length})`}
        subtitle="Entrada, defeito e serviço — é o que encerra discussão no balcão."
        className="mb-5"
      >
        {recusaFoto && (
          <p
            role="alert"
            className="mb-3 px-3 py-2 rounded-[var(--gs-radius)]
              bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
          >
            {recusaFoto}
          </p>
        )}
        {podeFotografar && !osFinalizada && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select
              aria-label="Tipo da foto"
              value={tipoDaFoto}
              onChange={(e) => setTipoDaFoto(e.target.value)}
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            >
              {Object.entries(FOTO_ROTULO).map(([valor, rotulo]) => (
                <option key={valor} value={valor}>
                  {rotulo}
                </option>
              ))}
            </select>
            {/*
              BOTÃO DE VERDADE, com o campo de arquivo escondido atrás dele.

              O desenho anterior era um `<label>` embrulhando um input
              `display:none`: nenhum dos dois entra na ordem de tabulação, e
              "Adicionar foto" simplesmente não existia para quem usa teclado —
              o foco pulava do seletor de tipo direto para a primeira
              miniatura.
            */}
            <Button
              type="button"
              disabled={subindo}
              onClick={() => escolherFoto.current?.click()}
            >
              {subindo ? 'Enviando…' : 'Adicionar foto'}
            </Button>
            <input
              ref={escolherFoto}
              type="file"
              accept="image/*"
              capture="environment"
              aria-hidden="true"
              tabIndex={-1}
              className="hidden"
              disabled={subindo}
              onChange={(e) => {
                const arquivo = e.target.files?.[0];
                e.target.value = '';
                if (!arquivo) return;
                setSubindo(true);
                setRecusaFoto(null);
                void (async () => {
                  try {
                    const dataUrl = await reduzirImagem(arquivo);
                    await apiRequest(`/core/workshop/orders/${os.id}/photos`, {
                      method: 'POST',
                      body: { dataUrl, fileName: arquivo.name, kind: tipoDaFoto },
                    });
                    await carregar(true);
                  } catch (err) {
                    // No card, nunca em `setErro`: a recusa da foto não pode
                    // apagar a OS da tela.
                    setRecusaFoto(
                      err instanceof ApiRequestError
                        ? err.message
                        : 'Não foi possível enviar a foto.',
                    );
                  } finally {
                    setSubindo(false);
                  }
                })();
              }}
            />
          </div>
        )}

        {fotos.length === 0 ? (
          <EmptyState
            title="Nenhuma foto"
            description="Registre como o aparelho chegou — é o que encerra discussão depois."
          />
        ) : (
          <ul className="list-none p-0 m-0 grid gap-3 grid-cols-2 sm:grid-cols-4">
            {fotos.map((foto) => (
              <li key={foto.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setAmpliada({
                      url: coreApi.imageUrl(foto.url),
                      alt: `${FOTO_ROTULO[foto.kind] ?? foto.kind} da OS ${os.number}`,
                    })
                  }
                  className="p-0 border-0 bg-transparent cursor-pointer"
                >
                  {/*
                    O endereço é montado com `coreApi.imageUrl`: o banco guarda
                    o caminho RELATIVO À API (`/uploads/os/...`), e é a API que
                    serve `/uploads/**`. Escrito cru, o navegador o resolveria
                    contra a origem da SPA e nenhuma foto apareceria.
                  */}
                  <img
                    src={coreApi.imageUrl(foto.url)}
                    alt={`${FOTO_ROTULO[foto.kind] ?? foto.kind} da OS ${os.number}`}
                    className="w-full h-24 object-cover rounded-[var(--gs-radius)]
                      border border-[var(--gs-border)]"
                  />
                </button>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {FOTO_ROTULO[foto.kind] ?? foto.kind}
                  </span>
                  {mexeEmPeca && !osFinalizada && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={ocupado}
                      onClick={() =>
                        void executar(async () => {
                          await apiRequest(
                            `/core/workshop/orders/${os.id}/photos/${foto.id}`,
                            { method: 'DELETE' },
                          );
                        }, setRecusaFoto)
                      }
                    >
                      Apagar
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        A FOTO AMPLIADA SAI PELO TECLADO.

        `aria-modal="true"` declara o resto da página inexistente para o leitor
        de tela: sem Escape e sem botão de fechar, quem abriu a foto por
        teclado ficava preso. E o texto alternativo é o MESMO da miniatura —
        "Foto ampliada" não informa nada a quem não vê a imagem.
      */}
      {ampliada && (
        <div
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label={ampliada.alt}
          onClick={() => setAmpliada(null)}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 cursor-zoom-out"
        >
          <button
            type="button"
            autoFocus
            onClick={() => setAmpliada(null)}
            className="absolute top-4 right-4 px-4 py-2 rounded-[var(--gs-radius)]
              bg-[var(--gs-surface)] text-[var(--gs-text)] border-0 font-semibold cursor-pointer"
          >
            Fechar
          </button>
          <img
            src={ampliada.url}
            alt={ampliada.alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full cursor-default"
          />
        </div>
      )}

      {/*
        PRIORIDADE, PRAZO E DEVOLUÇÃO AO QUADRO (rodada 51).

        Replanejar segue a mesma régua do servidor: o responsável mexe no
        próprio serviço, o gerente em qualquer um, e OS sem dono qualquer
        técnico prioriza (é a triagem). Devolver ao quadro é o inverso do
        assumir — justificativa obrigatória, porque é a primeira coisa que o
        próximo técnico vai ler.
      */}
      {mexeEmPeca && !osFinalizada && (
        <Card
          title="Prioridade e prazo"
          subtitle="A prioridade ordena o quadro e define a régua do SLA; o prazo é a promessa ao cliente."
          className="mb-5"
        >
          {(!deOutroTecnico || gerenteDaOficina) ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Prioridade">
                {(p) => (
                  <select
                    {...p}
                    value={(plano ?? { priority: os.priority }).priority}
                    onChange={(e) =>
                      setPlano({
                        priority: e.target.value,
                        dueDate: (plano ?? { dueDate: os.due_date?.slice(0, 10) ?? '' }).dueDate,
                      })
                    }
                    className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  >
                    {['urgente', 'alta', 'media', 'baixa'].map((prio) => (
                      <option key={prio} value={prio}>
                        {PRIORITY_LABELS[prio]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Prazo prometido">
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={(plano ?? { dueDate: os.due_date?.slice(0, 10) ?? '' }).dueDate}
                    onChange={(e) =>
                      setPlano({
                        priority: (plano ?? { priority: os.priority }).priority,
                        dueDate: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <Button
                disabled={ocupado || !plano}
                onClick={() =>
                  void executar(async () => {
                    await apiRequest(`/core/workshop/orders/${os.id}/plan`, {
                      method: 'PATCH',
                      body: {
                        priority: plano!.priority,
                        dueDate: plano!.dueDate || null,
                      },
                    });
                    setPlano(null);
                  })
                }
              >
                Salvar plano
              </Button>
            </div>
          ) : (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Quem replaneja é o responsável ({os.mechanic_name ?? 'outro técnico'}) ou o
              gerente da oficina.
            </p>
          )}

          {os.mechanic_id && osViva && (souOResponsavel || gerenteDaOficina) && (
            <div className="mt-4 pt-3 border-t border-[var(--gs-border)]">
              {!devolvendo ? (
                <Button variant="secondary" onClick={() => setDevolvendo(true)}>
                  Devolver ao quadro
                </Button>
              ) : (
                <div>
                  <Field
                    label="Justificativa obrigatória"
                    required
                    hint="Por que está largando esta OS? É o que o próximo técnico vai ler primeiro."
                  >
                    {(p) => (
                      <textarea
                        {...p}
                        value={justificativa}
                        onChange={(e) => setJustificativa(e.target.value)}
                        maxLength={500}
                        rows={2}
                        placeholder="Ex.: não tenho experiência com este controlador; saio de férias na sexta…"
                        className="w-full px-3 py-2 border border-[var(--gs-border-strong)]
                          rounded-[var(--gs-radius)] text-[length:var(--gs-text-base)]"
                      />
                    )}
                  </Field>
                  <div className="flex gap-2 mt-2">
                    <Button
                      disabled={ocupado || !justificativa.trim()}
                      onClick={() =>
                        void executar(async () => {
                          await apiRequest(`/core/workshop/orders/${os.id}/release`, {
                            method: 'POST',
                            // O retrato da ficha (GAP-PRD-183): se a OS mudou
                            // enquanto a tela estava aberta, o servidor recusa.
                            body: {
                              reason: justificativa.trim(),
                              expectedStatus: os.status,
                              expectedStatusChangedAt: os.status_changed_at ?? null,
                            },
                          });
                          setDevolvendo(false);
                          setJustificativa('');
                        })
                      }
                    >
                      Confirmar devolução
                    </Button>
                    <Button variant="ghost" onClick={() => setDevolvendo(false)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/*
        FECHAR E COBRAR A OS PELA TELA — as rotas existiam desde a rodada da
        oficina e nenhuma tela as chamava (auditoria: 5 rotas órfãs). O
        mecânico via a OS e não conseguia fechá-la pelo sistema.
      */}
      {temServicoEConta && (
        <Card
          title="Serviço e conta"
          subtitle="Mão de obra, orçamento com o cliente e conclusão técnica."
          className="mb-5"
        >
          {recusaServico && (
            <p
              role="alert"
              className="m-0 mb-3 px-3 py-2 rounded-[var(--gs-radius)]
                bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
            >
              {recusaServico}
            </p>
          )}

          {/* O selo do orçamento: o que o cliente já respondeu — ou ainda não. */}
          {aguardandoCliente && (
            <p className="m-0 mb-3">
              <Badge tone="warning">Orçamento aguardando o cliente</Badge>{' '}
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                pedido em {quando(os.approval_requested_at!)} — ele decide em Minha conta ›
                Meus equipamentos
              </span>
            </p>
          )}
          {os.approved_at && (
            <p className="m-0 mb-3">
              <Badge tone="success">Orçamento aprovado pelo cliente</Badge>{' '}
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                em {quando(os.approved_at)}
              </span>
            </p>
          )}

          {/*
            O QUE O CLIENTE RECEBEU (GAP-PRD-036). "Enviado" era o rótulo de um
            botão que não enviava nada; agora quem diz é a fila de e-mail.
          */}
          {avisos && (aguardandoCliente || avisos.avisos.length > 0) && (
            <div
              aria-label="Avisos ao cliente"
              className="mb-3 text-[length:var(--gs-text-sm)]"
            >
              {avisos.emailDoCliente === null && (
                <p role="status" className="m-0 mb-1 text-[var(--gs-warning)]">
                  O cliente não tem e-mail cadastrado: nenhum aviso sai por e-mail. Avise por
                  telefone e registre a resposta dele no balcão.
                </p>
              )}
              {avisos.avisos.length > 0 && (
                <ul className="m-0 pl-5 text-[var(--gs-muted)]">
                  {avisos.avisos.map((a) => (
                    <li key={a.id}>
                      <strong className="text-[var(--gs-text)]">{a.templateLabel}</strong>:{' '}
                      {situacaoDoAviso(a, avisos.envioLigado)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {mexeNaConta && (
            <div className="flex flex-wrap items-end gap-3 mb-4">
              <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                <span className="text-[var(--gs-muted)]">Mão de obra (R$)</span>
                <input
                  inputMode="decimal"
                  value={maoDeObra}
                  onChange={(e) => setMaoDeObra(e.target.value)}
                  placeholder="150,00"
                  className="w-32 px-3 py-2 text-right rounded-[var(--gs-radius)]
                    border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] tabular-nums"
                />
              </label>
              <Button size="sm" loading={ocupado} onClick={() => void salvarMaoDeObra()}>
                Salvar mão de obra
              </Button>
              {pedeAprovacao && !aguardandoCliente && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={ocupado}
                  onClick={() => void pedirAprovacao()}
                  disabled={os.total_cents <= 0}
                  title={
                    os.total_cents <= 0
                      ? 'Lance mão de obra ou peças antes: orçamento zerado não tem o que aprovar.'
                      : 'Registra o pedido e, se o cliente tiver e-mail, põe o aviso na fila.'
                  }
                >
                  {/* O nome diz o que o botão FAZ — pedir — e não promete envio (GAP-PRD-036). */}
                  {os.approved_at ? 'Pedir nova aprovação do cliente' : 'Pedir aprovação do cliente'}
                </Button>
              )}
            </div>
          )}

          {/* Concluir: SÓ quem assumiu — a mesma régua do servidor. */}
          {osViva &&
            (souOResponsavel ? (
              concluindo ? (
                <div className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
                  <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                    <span className="text-[var(--gs-muted)]">Diagnóstico / o que foi feito</span>
                    <textarea
                      rows={3}
                      value={diagnostico}
                      onChange={(e) => setDiagnostico(e.target.value)}
                      className="w-full p-3 rounded-[var(--gs-radius)]
                        border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-4 mt-3 text-[length:var(--gs-text-sm)]">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="custo-os"
                        checked={temCusto}
                        onChange={() => setTemCusto(true)}
                      />
                      Com cobrança — vai para o caixa
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="custo-os"
                        checked={!temCusto}
                        onChange={() => setTemCusto(false)}
                      />
                      Sem custo
                    </label>
                    {!temCusto && (
                      <select
                        aria-label="Motivo de não cobrar"
                        value={motivoSemCusto}
                        onChange={(e) => setMotivoSemCusto(e.target.value)}
                        className="px-2 py-1 rounded-[var(--gs-radius)]
                          border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                      >
                        <option value="garantia">Garantia</option>
                        <option value="cortesia_autorizada">Cortesia autorizada</option>
                        <option value="retrabalho">Retrabalho</option>
                      </select>
                    )}
                  </div>
                  {/*
                    A conferência de entrada por fazer aparece AQUI, onde a
                    decisão acontece — e com o caminho de forçar ao lado. No
                    sistema anterior a tela de detalhe bloqueava sem oferecer
                    onde completar, e a pessoa ficava presa entre "voltar" e
                    "forçar".
                  */}
                  {checklistPendente > 0 && (
                    <p className="mt-3 mb-0 px-3 py-2 rounded-[var(--gs-radius)]
                      bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]">
                      A conferência de entrada tem {checklistPendente} item(ns) sem resposta —
                      responda acima, ou conclua assim mesmo (fica registrado).
                    </p>
                  )}
                  {conferenciaIlegivel && (
                    <p className="mt-3 mb-0 px-3 py-2 rounded-[var(--gs-radius)]
                      bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]">
                      A conferência de entrada não pôde ser lida — recarregue a OS, ou conclua
                      assim mesmo (fica registrado).
                    </p>
                  )}
                  <div className="flex gap-2 mt-3">
                    <Button
                      size="sm"
                      loading={ocupado}
                      onClick={() => void concluir(false)}
                      disabled={checklistPendente > 0 || conferenciaIlegivel}
                    >
                      Confirmar conclusão
                    </Button>
                    {(checklistPendente > 0 || conferenciaIlegivel) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={ocupado}
                        onClick={() => void concluir(true)}
                      >
                        Concluir assim mesmo
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setConcluindo(false)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setConcluindo(true)}>
                  Concluir serviço
                </Button>
              )
            ) : (
              mexeEmPeca && (
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {os.mechanic_id
                    ? `Quem conclui é ${os.mechanic_name ?? 'o técnico que assumiu'} — a régua vale até para o gerente.`
                    : 'A OS ainda não foi assumida: assumir no quadro é o primeiro passo.'}
                </p>
              )
            ))}

          {/* O que o caixa acabou de fazer — recebido ou estornado. */}
          {avisoCaixa && (
            <p
              role="status"
              className="m-0 px-3 py-2 rounded-[var(--gs-radius)]
                bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]"
            >
              {avisoCaixa}
            </p>
          )}

          {/* O CAIXA: a fila de aguardando_pagamento termina aqui. */}
          {os.status === 'aguardando_pagamento' &&
            (caixaDaOficina ? (
              <div className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
                <p className="m-0 font-semibold">Receber {formatCents(os.total_cents)}</p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <Button size="sm" loading={ocupado} onClick={abrirRecebimento}>
                    Registrar recebimento
                  </Button>
                </div>
                <p className="m-0 mt-2 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  O fechamento do PDV: divide entre as formas, calcula o troco, passa o cartão na
                  maquininha e dá desconto pela alçada. Cria a venda no caixa da oficina e finaliza
                  a OS — o mesmo fato econômico, registrado uma vez.
                </p>
              </div>
            ) : (
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Pronto para cobrança: quem registra o recebimento é o caixa da oficina.
              </p>
            ))}

          {/*
            A OS PAGA TEM COMPROVANTE E TEM VOLTA (GAP-PRD-105).

            A imutabilidade continua: peça, mão de obra e movimento seguem
            recusados na OS finalizada. O que existe agora é o caminho de volta
            autorizado — estornar o recebimento cancela a venda e devolve a OS
            à fila do caixa, com o motivo na linha do tempo.
          */}
          {pagaComVenda && caixaDaOficina && (
            <div className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] flex flex-wrap items-center gap-2">
              <p className="m-0 font-semibold mr-auto">
                Recebida{os.paid_at ? ` em ${dataHoraBR(os.paid_at)}` : ''} — {formatCents(os.total_cents)}
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void imprimirComprovante(os.sale_id!)}
              >
                Imprimir comprovante
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEstornando(true)}>
                Estornar recebimento
              </Button>
            </div>
          )}
        </Card>
      )}

      {recebendo && (
        <RecebimentoOsDialog
          os={os}
          faturamentoAPrazo={faturamentoAPrazo}
          onCancel={() => setRecebendo(false)}
          onRecebido={(r) => {
            setRecebendo(false);
            setAvisoCaixa(
              r.replay
                ? `Este recebimento já tinha sido registrado — venda #${r.sale.number}. Nada foi cobrado de novo.`
                : r.sale.change_cents > 0
                  ? `Recebida — venda #${r.sale.number}. TROCO ${formatCents(r.sale.change_cents)}.`
                  : `Recebida — venda #${r.sale.number}.`,
            );
            void carregar(true);
          }}
        />
      )}

      {estornando && (
        <EstornoOsDialog
          os={os}
          onCancel={() => setEstornando(false)}
          onEstornado={() => {
            setEstornando(false);
            setAvisoCaixa('Recebimento estornado — a OS voltou para a fila do caixa.');
            void carregar(true);
          }}
        />
      )}

      {/*
        A OS PAGA CHEGA AO FISCAL (GAP-PRD-024). A venda do checkout sai
        itemizada: a peça vai para a NFC-e, a mão de obra para a NFS-e. O
        cartão só existe depois do pagamento — antes dele não há venda.
      */}
      {os.status === 'finalizada' && os.sale_id && (
        <DocumentosFiscaisDaOs saleId={os.sale_id} podeEmitir={caixaDaOficina} />
      )}

      <Card
        title="Peças aplicadas"
        subtitle="Lançar PROMETE a peça a este conserto: ela fica presa na gaveta e ninguém mais a vende. A baixa acontece quando o serviço é autorizado. Devolver solta a que não foi usada."
        className="mb-5"
        actions={
          podeLancar ? (
            <Button
              size="sm"
              variant={buscandoPeca ? 'secondary' : 'primary'}
              onClick={() => setBuscandoPeca((v) => !v)}
            >
              {buscandoPeca ? 'Fechar a gaveta' : 'Acrescentar peça'}
            </Button>
          ) : undefined
        }
      >
        {/* A recusa da bancada mora aqui dentro, coladinha no que foi clicado. */}
        {recusa && (
          <p
            role="alert"
            className="m-0 mb-3 px-3 py-2 rounded-[var(--gs-radius)]
              bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
          >
            {recusa}
          </p>
        )}

        {porQueNaoLanca && (
          <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {porQueNaoLanca}
          </p>
        )}

        {buscandoPeca && podeLancar && (
          <div className="mb-4 p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
            <SearchInput
              value={buscaPeca}
              onChange={setBuscaPeca}
              onEnter={() => void procurarPecas()}
              placeholder="Nome, código ou código de barras da peça…"
              autoFocus
            />
            <div className="mt-3">
              {achados === null ? (
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Abrindo a gaveta…
                </p>
              ) : achados.length === 0 ? (
                /*
                  Estado vazio da BUSCA, e ele diz a verdade para quem lê:
                  ou a bancada não tem peça cadastrada, ou o nome digitado não
                  existe. Não manda ninguém a tela de cadastro — o leitor típico
                  desta tela é o mecânico, e o roteador fecha a gestão para ele.
                */
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {buscaPeca.trim()
                    ? `Nenhuma peça desta bancada bate com "${buscaPeca.trim()}".`
                    : 'Esta bancada ainda não tem peça na gaveta. Peça entra pela nota do fornecedor e é marcada como peça no cadastro do produto.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                    <thead>
                      <tr className="text-left text-[var(--gs-muted)]">
                        <th className="py-2">Peça</th>
                        <th className="py-2">Código</th>
                        <th className="py-2 text-right">Disponível</th>
                        {/* PREÇO, nunca custo: é o que entra na conta do cliente. */}
                        <th className="py-2 text-right">Preço</th>
                        <th className="py-2 text-right">Levar</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {achados.map((peca) => (
                        <tr key={peca.id} className="border-t border-[var(--gs-border)]">
                          <td className="py-2">
                            {peca.name}
                            {peca.below_minimum && (
                              <span className="ml-2">
                                <Badge tone="warning">Repor</Badge>
                              </span>
                            )}
                          </td>
                          <td className="py-2 font-mono text-[var(--gs-muted)]">
                            {peca.internal_code}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatQuantity(peca.available)}
                            {peca.reserved > 0 && (
                              // Reservado tem TRÊS origens — pedido da loja,
                              // orçamento e locação. Nomear uma delas aqui
                              // descreveria o estado errado.
                              <span className="text-[var(--gs-muted)]">
                                {' '}
                                ({formatQuantity(peca.reserved)} reservada)
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {peca.price_cents > 0 ? (
                              formatCents(peca.price_cents)
                            ) : (
                              // O aviso vem ANTES do clique: o servidor recusa
                              // esta peça, e descobrir isso só no erro faria a
                              // pessoa achar que o sistema quebrou.
                              <Badge tone="danger">sem preço</Badge>
                            )}
                          </td>
                          <td className="py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              aria-label={`Quantidade de ${peca.name}`}
                              value={quantidades[peca.id] ?? '1'}
                              onChange={(e) =>
                                setQuantidades((q) => ({ ...q, [peca.id]: e.target.value }))
                              }
                              className="w-20 px-2 py-1 text-right rounded-[var(--gs-radius)]
                                border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                            />
                          </td>
                          <td className="py-2 text-right">
                            <Button
                              size="sm"
                              loading={ocupado}
                              onClick={() => void lancar(peca)}
                            >
                              Lançar
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {os.parts.length === 0 ? (
          <EmptyState
            title="Nenhuma peça"
            description={
              podeLancar
                ? 'Nenhuma peça reservada para esta OS. Acrescente o que for usando — a peça fica presa a este conserto e sai do estoque quando o serviço for autorizado.'
                : 'Nenhuma peça reservada para esta OS.'
            }
            action={
              podeLancar && !buscandoPeca ? (
                <Button onClick={() => setBuscandoPeca(true)}>Acrescentar peça</Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Peça</th>
                  <th className="py-2 text-right">Qtd.</th>
                  <th className="py-2 text-right">Devolvida</th>
                  <th className="py-2 text-right">Unitário</th>
                  <th className="py-2 text-right">Total</th>
                  {podeDevolver && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {os.parts.map((p) => {
                  const devolvida = Number(p.returned_quantity ?? 0);
                  const naOS = p.quantity - devolvida;
                  // Guardado como objeto, e não como booleano: é o que permite
                  // ler `emDevolucao.quantidade` abaixo sem o TypeScript
                  // reclamar que a devolução pode ser nula.
                  const emDevolucao = devolucao && devolucao.partId === p.id ? devolucao : null;
                  return (
                    <tr key={p.id} className="border-t border-[var(--gs-border)] align-top">
                      <td className="py-2">{p.description ?? '—'}</td>
                      <td className="py-2 text-right tabular-nums">{formatQuantity(p.quantity)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {devolvida > 0 ? formatQuantity(devolvida) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCents(p.unit_price_cents)}
                      </td>
                      {/*
                        O total da LINHA guarda o que foi requisitado; o que a
                        OS cobra é o que ficou. Mostrar os 1.800 de uma bateria
                        já devolvida faria a soma da tabela não bater com o
                        total do cabeçalho, e quem confere passaria a tarde
                        procurando o erro na conta certa.
                      */}
                      <td className="py-2 text-right tabular-nums">
                        {formatCents(
                          devolvida > 0 ? Math.round(p.unit_price_cents * naOS) : p.total_cents,
                        )}
                      </td>
                      {podeDevolver && (
                        <td className="py-2 text-right">
                          {naOS <= 0 ? (
                            <Badge tone="neutral">devolvida</Badge>
                          ) : emDevolucao ? (
                            <span className="inline-flex items-center gap-2">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                aria-label={`Quantidade a devolver de ${p.description ?? 'peça'}`}
                                value={emDevolucao.quantidade}
                                onChange={(e) =>
                                  setDevolucao({ partId: p.id, quantidade: e.target.value })
                                }
                                className="w-20 px-2 py-1 text-right rounded-[var(--gs-radius)]
                                  border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                              />
                              <Button
                                size="sm"
                                loading={ocupado}
                                onClick={() =>
                                  void devolver(p, Number(emDevolucao.quantidade.replace(',', '.')))
                                }
                              >
                                Confirmar
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDevolucao(null)}
                              >
                                Cancelar
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                setDevolucao({ partId: p.id, quantidade: String(naOS) })
                              }
                            >
                              Devolver
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        Linha do tempo e comentários juntos, em ordem: é a história da OS, e ler
        as duas em telas separadas obrigaria a pessoa a montar a sequência de
        cabeça. Nada aqui é editável — nada aqui foi editado.
      */}
      <Card title="O que aconteceu">
        {/* O comentário entra AQUI, no fio da história — a rota existia órfã. */}
        {podeComentarNestaOs && !osFinalizada && (
          <div className="mb-4 flex gap-2 items-start">
            <textarea
              rows={2}
              aria-label="Novo comentário"
              placeholder="Anotar algo na OS — o cliente com portal também lê."
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              className="flex-1 p-3 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            />
            <Button
              size="sm"
              loading={ocupado}
              disabled={!comentario.trim()}
              onClick={() => void comentar()}
            >
              Registrar
            </Button>
          </div>
        )}
        {os.events.length === 0 && os.comments.length === 0 ? (
          <EmptyState title="Sem histórico" description="A OS acabou de ser aberta." />
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-3">
            {[
              ...os.events.map((e) => ({
                id: `e-${e.id}`,
                em: e.created_at,
                titulo:
                  e.from_status && e.to_status
                    ? `${STATUS_LABELS[e.from_status] ?? e.from_status} → ${STATUS_LABELS[e.to_status] ?? e.to_status}`
                    : (STATUS_LABELS[e.to_status ?? ''] ?? 'Evento'),
                corpo: e.note,
                autor: null as string | null,
              })),
              ...os.comments.map((c) => ({
                id: `c-${c.id}`,
                em: c.created_at,
                // A voz de quem falou (GAP-PRD-102): o cliente pelo portal, o
                // balcão (atendente/caixa) e a equipe da bancada.
                titulo:
                  c.author_kind === 'proprietario'
                    ? 'Fala do cliente'
                    : c.author_kind === 'balcao'
                      ? 'Anotação do balcão'
                      : 'Comentário',
                corpo: c.body,
                autor: c.author_name,
              })),
            ]
              .sort((a, b) => a.em.localeCompare(b.em))
              .map((linha) => (
                <li
                  key={linha.id}
                  className="border-l-2 border-[var(--gs-border)] pl-3 py-1"
                >
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {quando(linha.em)}
                    {linha.autor ? ` · ${linha.autor}` : ''}
                  </p>
                  <p className="m-0 font-semibold">{linha.titulo}</p>
                  {linha.corpo && <p className="m-0">{linha.corpo}</p>}
                </li>
              ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}

/**
 * Ponte entre o PrintEngine e o navegador.
 *
 * O navegador NÃO imprime em silêncio — ele abre a caixa de diálogo do
 * sistema. Isso é limitação do ambiente, não uma escolha: prometer impressão
 * automática sem o agente local faria o operador achar que o cupom saiu quando
 * nada saiu. A mesma janela serve para salvar em PDF.
 *
 * O ciclo de estado do job é respeitado: `printing` antes de abrir a janela,
 * `printed` só depois de o navegador confirmar que o diálogo foi concluído.
 *
 * ## O 401 QUE ESTA TELA MOSTROU TODO DIA
 *
 * Este arquivo abria a janela com `window.open(coreApi.printDocumentUrl(id))`,
 * apontando para `GET /core/print/jobs/:id/document`. Aquela rota passa por
 * `authMiddleware`, que lê o token SÓ de `req.headers.authorization` — não há
 * cookie nem `?token=` — e uma janela aberta por URL não manda cabeçalho
 * nenhum. Medido no navegador: a rota respondia 401
 * `API_AUTHENTICATION_REQUIRED`, e quem fechava uma venda no balcão via um
 * JSON de erro de autenticação no lugar do cupom, com o cliente esperando.
 *
 * O conserto é o mesmo caminho de todo download autenticado do sistema:
 * buscar com o Bearer (`apiBinary`), virar `Blob`, e abrir o endereço `blob:`
 * — que é local e não passa por rota nenhuma, logo não precisa de token.
 *
 * O documento é buscado ANTES de a janela abrir, e essa ordem também é
 * conserto: falhar antes significa que o job vai para `failed` com o motivo do
 * servidor na mensagem, em vez de abrir uma janela em branco que ninguém sabe
 * interpretar.
 */
import { apiBinary } from './api/client';
import { coreApi, type PrintJob } from './api/core';
import { acompanharNoAgente, impressaoApi } from './api/impressao';

/**
 * Abre o documento numa janela e dispara a impressão.
 *
 * Devolve o job com o estado alcançado. Se o operador cancelar o diálogo, o
 * job fica em `printing` — e não em `printed`, porque nada foi impresso.
 */
export async function printJobInBrowser(job: PrintJob): Promise<void> {
  await coreApi.advancePrintJob(job.id, 'printing');

  let endereco: string;
  try {
    const documento = await apiBinary(
      `/core/print/jobs/${job.id}/document`,
      `documento-${job.id}.html`,
    );
    endereco = URL.createObjectURL(documento.blob);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : 'Falha ao obter o documento.';
    await coreApi.advancePrintJob(job.id, 'failed', motivo);
    throw err;
  }

  const janela = window.open(endereco, '_blank', 'width=420,height=640');

  if (!janela) {
    // O Blob ficaria preso na memória da aba para sempre se ninguém abrisse a
    // janela que iria lê-lo.
    URL.revokeObjectURL(endereco);
    await coreApi.advancePrintJob(
      job.id,
      'failed',
      'O navegador bloqueou a janela de impressão. Libere pop-ups para este endereço.',
    );
    throw new Error(
      'O navegador bloqueou a janela de impressão. Libere pop-ups para este endereço.',
    );
  }

  /*
    O `afterprint` NÃO É PROVA DE PAPEL (F-cupom-fiscal-18).

    Ele gravava `printed` — e o evento dispara igual quando o operador CANCELA
    o diálogo do Windows. A fila registrava "impresso" para o cupom que nunca
    saiu, e o histórico mentia justamente na conferência. O navegador não diz
    se o papel saiu; então o job fica em `printing`, que é a verdade que o
    cabeçalho desta função sempre prometeu ("se o operador cancelar o diálogo,
    o job fica em `printing`"). O `afterprint` só faz a faxina: solta o Blob e
    fecha a janela.
  */
  janela.addEventListener('load', () => {
    janela.addEventListener('afterprint', () => {
      // Só aqui o conteúdo já foi lido: soltar antes tiraria a página de baixo
      // da janela no meio do diálogo.
      URL.revokeObjectURL(endereco);
      janela.close();
    });
    janela.print();
  });
}

/*
  O JOB QUE O AGENTE NÃO PEGOU A TEMPO É CANCELADO (F-cupom-fiscal-09).

  O prazo da tela vencia com o job ainda `ready` e ele ficava na fila: a tela
  dizia "não confirmou", o caixa apertava Imprimir de novo e nascia um segundo
  job. O agente voltava minutos depois e imprimia OS DOIS, no meio do
  atendimento de outro cliente.

  Agora, vencido o prazo com o job `ready`, a tela DESISTE dele pela rota
  atômica (`/desistir`): o servidor cancela só se ele ainda está `ready` — o
  agente só pega job `ready`, então o cancelado não sai mais. Se o agente pegou
  no meio do caminho, a tela diz "está saindo, aguarde o papel" em vez de mandar
  reimprimir.
*/
/*
  "CANCELADO" SÓ QUANDO FOI (revisão de F-cupom-fiscal-09).

  A primeira versão devolvia "nada" em qualquer desfecho que não fosse papel —
  e a tela dizia "o pedido foi cancelado para não sair depois" também quando a
  releitura falhou pela rede, quando o servidor recusou o cancelamento com o
  job AINDA na fila, e quando o agente tinha FALHADO (sem papel). No primeiro
  e no segundo caso o cupom continuava `ready`: o caixa, confiante, pedia
  Imprimir de novo, e o agente imprimia os dois — o defeito que esta função
  existe para fechar. Agora cada desfecho tem o nome dele.
*/
type Desistencia = ImpressaoFeita | 'cancelado' | 'incerto';

const AGENTE_IMPRIMINDO =
  'O agente do caixa pegou o cupom agora e está imprimindo — aguarde o papel, não imprima de novo.';

/** O que o job relido diz — `na-fila` quando ele ainda espera o agente. */
function desfechoDoJob(job: PrintJob | null): Desistencia | 'na-fila' {
  if (!job) return 'incerto';
  if (job.status === 'printed') return { ...job, via: 'agente', aviso: null };
  if (job.status === 'printing') throw new Error(AGENTE_IMPRIMINDO);
  if (job.status === 'failed') throw new Error(job.error ?? 'O agente local não conseguiu imprimir.');
  if (job.status === 'cancelled') return 'cancelado';
  if (job.status === 'ready') return 'na-fila';
  return 'incerto';
}

/*
  A DESISTÊNCIA É ATÔMICA (F-cupom-fiscal-09, a parte que faltava).

  Era "reler; se ainda `ready`, mandar `cancelled` por `/status`". Entre as duas
  idas o agente podia pegar o cupom — e o servidor aceita `printing →
  cancelled`: a tela dizia "cancelado para não sair depois" e o papel saía. A
  rota `/desistir` cancela SÓ se o job ainda está `ready`, na mesma instrução
  do banco. Com 200, cancelou de verdade. Com 409 `CORE_PRINT_JOB_TAKEN`, o
  agente já pegou: quem diz o desfecho é o estado de agora (imprimindo, impresso
  ou falhou). Qualquer outra falha (a rede) não prova nada — e aí a tela não
  afirma cancelamento.
*/
async function desistirDoJobDoAgente(jobId: string): Promise<Desistencia> {
  try {
    await coreApi.desistirDoJobDeImpressao(
      jobId,
      'O agente local não pegou o cupom no prazo do balcão: cancelado para não sair depois.',
    );
    return 'cancelado';
  } catch {
    const depois = desfechoDoJob(await impressaoApi.job(jobId).catch(() => null));
    // Cancelado por outro caminho (outra aba, a gestão) — o fato vale igual.
    if (depois !== 'na-fila') return depois;
    // Ainda na fila: a desistência NÃO valeu (a rede, um 500). O cupom pode sair.
    return 'incerto';
  }
}

/** O job e POR ONDE o papel saiu — e, se caiu para o navegador, por quê. */
export type ImpressaoFeita = PrintJob & { via: 'agente' | 'navegador'; aviso: string | null };

/**
 * Enfileira e imprime em um passo — o gesto mais comum no balcão.
 *
 * O SERVIDOR decide o transporte (GAP-PRD-082): com a térmica de agente deste
 * caixa e o agente no ar, o job vai pelo agente e nenhuma janela abre — a
 * tela espera o agente dizer `printed` (ou a falha dele, com o motivo). Sem
 * isso, o job nasce para o navegador com o motivo em `fallback_reason`, e a
 * caixa de diálogo abre como sempre.
 */
export async function printDocument(
  documentType: string,
  documentId: string,
  opcoes: {
    terminalId?: string | null;
    openDrawer?: boolean;
    acompanhamento?: { intervaloMs?: number; prazoMs?: number };
  } = {},
): Promise<ImpressaoFeita> {
  const job = await coreApi.createPrintJob({
    documentType,
    documentId,
    terminalId: opcoes.terminalId ?? undefined,
    openDrawer: opcoes.openDrawer || undefined,
  });
  if (job.transport === 'agent') {
    const final = await acompanharNoAgente(job.id, opcoes.acompanhamento);
    if (final.status === 'printed') return { ...final, via: 'agente', aviso: null };
    if (final.status === 'failed') {
      throw new Error(final.error ?? 'O agente local não conseguiu imprimir.');
    }
    if (final.status === 'printing') {
      // Pegou e ainda não terminou: cancelar tiraria da fila um cupom que está
      // saindo, e mandar reimprimir daria dois papéis.
      throw new Error(
        'O agente do caixa está imprimindo e ainda não confirmou — aguarde o papel antes de imprimir de novo.',
      );
    }
    const desfecho = await desistirDoJobDoAgente(job.id);
    if (typeof desfecho === 'object') return desfecho;
    if (desfecho === 'cancelado') {
      throw new Error(
        'O agente local não pegou o cupom a tempo, e o pedido foi cancelado para não sair depois. Confira a '
          + 'impressora e o agente do caixa e peça Imprimir de novo.',
      );
    }
    throw new Error(
      'O agente local não confirmou a impressão, e a tela não conseguiu cancelar o pedido: o cupom ainda pode '
        + 'sair quando o agente voltar. Confira a impressora antes de pedir Imprimir de novo.',
    );
  }
  await printJobInBrowser(job);
  return { ...job, via: 'navegador', aviso: job.fallback_reason ?? null };
}

/**
 * ============================================================================
 * A NOTA DO PEDIDO ONLINE VAI AO CLIENTE (GAP-PRD-037)
 * ============================================================================
 *
 * O QUE ERA: a NF-e do pedido online era emitida, autorizada pela SEFAZ — e
 * ficava só no sistema. Nenhum import de e-mail em nada do fiscal: o
 * destinatário nunca recebia o XML nem o DANFE, e só quem abrisse a tela
 * Fiscal da loja via que a nota existia.
 *
 * O QUE É: no instante em que a NF-e (modelo 55) de um pedido vira
 * `AUTHORIZED`, um e-mail entra na fila com um .zip anexo: o XML autorizado
 * (`nfeProc` — a nota assinada costurada com o protocolo, o documento que
 * vale) e o DANFE para imprimir. O arquivo vai para o cofre de anexos (uma
 * vez, faxinado depois de entregue), a mensagem é única por nota (dedupe), e
 * falha ao enfileirar NUNCA desfaz a autorização (`queueMensagemPronta`).
 *
 * O QUE ELE NÃO FAZ, DE PROPÓSITO
 *
 * - Nota de HOMOLOGAÇÃO não vai: não tem valor fiscal, e mandar "sua nota
 *   fiscal" ao cliente com um documento de teste seria entregar um papel que
 *   parece nota sem haver nota.
 * - Sem `nfeProc` montável (protocolo sem `nProt`, XML assinado ausente), não
 *   vai — e fica no log: um e-mail com XML sem protocolo seria a mesma
 *   mentira.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { logError } from '../../utils/errors.js';
import { renderDanfe } from '../core/DanfeRenderer.js';
import { montarProcNfe } from '../core/FiscalProcNfe.js';
import { montarZip, type ArquivoDoZip } from '../core/ZipWriter.js';
import { publicBaseUrl } from '../core/PublicUrl.js';
import { queueMensagemPronta } from './EmailService.js';
import { assinaturaDaEmpresa } from './IdentidadeDoRemetente.js';

interface DocumentoDaNota {
  id: string;
  order_id: string | null;
  model: string;
  status: string;
  environment: string;
  serie: number;
  number: number;
  access_key: string | null;
  xml_signed: string | null;
  xml_authorized: string | null;
}

interface PedidoDaNota {
  id: string;
  number: number;
  customer_name: string | null;
  customer_email: string | null;
  loja: string | null;
}

/** A chave em blocos de quatro, como no DANFE. */
function chaveLegivel(chave: string): string {
  return chave.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/**
 * Enfileira o e-mail da nota autorizada de um pedido — ou não faz nada,
 * quando a nota não é de pedido, não é de produção, ou não há o que anexar.
 *
 * Chamada por `FiscalQueueService.applyResponse`, o único ponto em que um
 * documento vira `AUTHORIZED`. Devolve o id da mensagem (ou `null`).
 */
export function avisarNotaDoPedido(companyId: string, documentId: string): string | null {
  try {
    ensureCoreSchema();
    const db = getConnection();
    const doc = db
      .prepare(
        `SELECT id, order_id, model, status, environment, serie, number, access_key,
                xml_signed, xml_authorized
           FROM core_fiscal_documents WHERE id = ? AND company_id = ?`,
      )
      .get(documentId, companyId) as DocumentoDaNota | undefined;
    if (!doc || doc.model !== '55' || !doc.order_id || doc.status !== 'AUTHORIZED') return null;
    if (doc.environment !== 'production') return null;

    const pedido = db
      .prepare(
        `SELECT o.id, o.number, o.customer_name, o.customer_email, c.trade_name AS loja
           FROM core_orders o
           JOIN core_companies c ON c.id = o.company_id
          WHERE o.id = ? AND o.company_id = ?`,
      )
      .get(doc.order_id, companyId) as PedidoDaNota | undefined;
    if (!pedido) return null;

    const xml = montarProcNfe({ xmlAssinado: doc.xml_signed, protocolo: doc.xml_authorized });
    if (!xml) {
      logError('nota_do_pedido_sem_xml_autorizado', { documentId, orderId: doc.order_id });
      return null;
    }
    const chave = doc.access_key ?? '';
    const arquivos: ArquivoDoZip[] = [{ nome: `${chave || `nfe-${doc.number}`}-procNFe.xml`, conteudo: xml }];
    try {
      arquivos.push({ nome: `DANFE-NFe-${doc.number}.html`, conteudo: renderDanfe(companyId, doc.id) });
    } catch (err) {
      // Sem DANFE ainda há a nota: o XML é o documento que vale.
      logError('danfe_do_pedido_indisponivel', {
        documentId,
        motivo: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }

    const loja = (pedido.loja ?? '').trim() || 'Grupo Sampaio';
    const nome = (pedido.customer_name ?? '').trim();
    const temDanfe = arquivos.length > 1;
    return queueMensagemPronta({
      companyId,
      template: 'nota_disponivel',
      toAddress: pedido.customer_email,
      subject: `${loja} · nota fiscal do pedido #${pedido.number}`,
      bodyText:
        (nome ? `Olá, ${nome}.\n\n` : 'Olá.\n\n')
        + `A nota fiscal eletrônica do pedido #${pedido.number} (NF-e nº ${doc.number}, `
        + `série ${doc.serie}) foi autorizada pela SEFAZ.\n`
        + (chave ? `Chave de acesso: ${chaveLegivel(chave)}\n` : '')
        + '\nEm anexo, um arquivo .zip com:\n'
        + '- o XML da nota — o documento fiscal que vale; guarde-o;\n'
        + (temDanfe ? '- o DANFE — a versão para imprimir (abra no navegador).\n' : '')
        + `\nO pedido continua em Minha conta: ${publicBaseUrl()}/minha-conta/pedidos/${pedido.id}\n\n`
        + (assinaturaDaEmpresa(companyId) ?? `${loja} — Grupo Sampaio`),
      payload: {
        orderId: pedido.id,
        numeroPedido: Number(pedido.number),
        documentId: doc.id,
        numeroNota: Number(doc.number),
        serie: Number(doc.serie),
      },
      dedupeKey: `nota_disponivel:${doc.id}`,
      anexo: {
        nome: `NF-e ${doc.number} - pedido ${pedido.number}.zip`,
        bytes: montarZip(arquivos),
      },
    });
  } catch (err) {
    // A autorização vale mais que o aviso: nada aqui pode desfazê-la.
    logError('nota_do_pedido_nao_enfileirada', {
      documentId,
      motivo: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return null;
  }
}

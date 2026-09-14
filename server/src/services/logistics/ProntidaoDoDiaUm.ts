/**
 * ============================================================================
 * A CONFIGURAÇÃO DO DIA 1, LOJA POR LOJA (GAP-PRD-034)
 * ============================================================================
 *
 * O que a auditoria leu no banco da loja (só leitura): nenhuma operação com
 * entrega configurada (todas só retirada, pelo padrão seguro), produtos
 * publicados sem peso e medidas, CEP de origem só numa empresa, cobranças
 * nascendo "unconfigured" por falta de Asaas, e-mail parado na fila por falta
 * de SMTP, nenhuma credencial de transportadora.
 *
 * Nada disso é defeito: cada item tem tela e serviço prontos. O que faltava
 * era o dono ENXERGAR, num lugar só e por operação, o que ainda está por
 * fazer — sem abrir seis telas para descobrir, e sem ninguém do
 * desenvolvimento para dizer. Esta é essa lista: cada item diz o estado, o que
 * falta em palavras de gente, QUEM resolve (o dono pela tela, ou quem
 * administra o servidor pelo `.env`) e ONDE.
 *
 * Três estados, e nenhum é enfeite:
 *
 *   ok        — configurado; nada a fazer;
 *   pendente  — falta configurar, e sem isso a loja opera pela metade;
 *   escolha   — não é falta: é uma decisão que a loja pode tomar ou não
 *               (vender só com retirada; frete só pela tabela da loja).
 *
 * Nada aqui chama provedor: é leitura do que está gravado.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { getShippingSettings } from '../core/CheckoutShippingService.js';
import { listProductsMissingShippingData } from '../core/OrderShippingService.js';
import { getAsaasStatus } from '../core/PaymentService.js';
import { emailStatus } from '../notifications/EmailService.js';
import { buildLogisticsReadinessChecklist, originZipOf } from './LogisticsReadinessService.js';
import { pendenciasDoRemetente } from './EnvioDoPedidoService.js';

export type EstadoDoItem = 'ok' | 'pendente' | 'escolha';

/** Quem resolve: o dono (ou gerente) pela tela, ou quem administra o servidor. */
export type QuemResolve = 'loja' | 'servidor';

export interface ItemDoDiaUm {
  chave: string;
  titulo: string;
  estado: EstadoDoItem;
  detalhe: string;
  quem: QuemResolve;
  /** A tela onde se resolve. `null` quando é variável do servidor. */
  onde: string | null;
}

export interface ProntidaoDaOperacao {
  companyId: string;
  companyName: string;
  itens: ItemDoDiaUm[];
  pendentes: number;
  pronta: boolean;
}

function reais(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function itemEntrega(companyId: string): ItemDoDiaUm {
  const s = getShippingSettings(companyId);
  const base = { chave: 'entrega', titulo: 'Entrega pelo site', quem: 'loja' as const, onde: '/sistema/loja/entrega' };
  if (!s.delivery_enabled) {
    return {
      ...base,
      estado: 'escolha',
      detalhe: s.pickup_enabled
        ? 'A loja oferece só RETIRADA (o padrão seguro). Para vender com entrega, ligue a entrega e informe o frete da tabela da loja.'
        : 'Nem retirada nem entrega estão ligadas: o checkout não tem como fechar pedido.',
    };
  }
  const tabela = s.flat_rate_cents === null ? 'sem tabela' : `tabela ${reais(Number(s.flat_rate_cents))}`;
  const gratis = s.free_above_cents === null ? '' : `, grátis acima de ${reais(Number(s.free_above_cents))}`;
  return { ...base, estado: 'ok', detalhe: `Entrega ligada (${tabela}${gratis}).` };
}

function itemProdutos(companyId: string): ItemDoDiaUm[] {
  const db = getConnection();
  const publicados = Number(
    (db
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND active = 1 AND publish_online = 1')
      .get(companyId) as { n: number }).n,
  );
  const semMedidas = listProductsMissingShippingData(companyId);
  const onde = '/sistema/produtos/prontidao-online';
  const publicadosItem: ItemDoDiaUm = {
    chave: 'produtos_publicados',
    titulo: 'Produtos na loja online',
    estado: publicados > 0 ? 'ok' : 'pendente',
    detalhe: publicados > 0
      ? `${publicados} produto(s) publicado(s).`
      : 'Nenhum produto publicado: a vitrine desta operação está vazia.',
    quem: 'loja',
    onde,
  };
  const nomes = semMedidas.slice(0, 5).map((m) => m.productName).join(', ');
  const medidasItem: ItemDoDiaUm = {
    chave: 'medidas',
    titulo: 'Peso e medidas dos produtos publicados',
    estado: publicados === 0 ? 'escolha' : semMedidas.length === 0 ? 'ok' : 'pendente',
    detalhe: publicados === 0
      ? 'Sem produto publicado, não há o que medir.'
      : semMedidas.length === 0
        ? 'Todos os produtos publicados têm peso e medidas.'
        : `${semMedidas.length} de ${publicados} produto(s) publicado(s) sem peso ou medidas`
          + ` (${nomes}${semMedidas.length > 5 ? '…' : ''}). Sem isso, o frete não cota e só a retirada fica disponível.`,
    quem: 'loja',
    onde,
  };
  return [publicadosItem, medidasItem];
}

function itemOrigem(companyId: string): ItemDoDiaUm[] {
  const cep = originZipOf(companyId);
  const remetente = pendenciasDoRemetente(companyId);
  const onde = '/sistema/fiscal/configuracao';
  return [
    {
      chave: 'cep_origem',
      titulo: 'CEP de onde a mercadoria sai',
      estado: cep ? 'ok' : 'pendente',
      detalhe: cep
        ? `CEP ${cep.slice(0, 5)}-${cep.slice(5)}.`
        : 'Sem o CEP da operação não há cotação de transportadora nem estimativa na página do produto.',
      quem: 'loja',
      onde,
    },
    {
      chave: 'remetente',
      titulo: 'Endereço do remetente (etiqueta)',
      estado: remetente.length === 0 ? 'ok' : 'pendente',
      detalhe: remetente.length === 0
        ? 'Razão social, CNPJ, endereço e telefone completos.'
        : `Para a etiqueta sair, falta: ${remetente.join(', ')}.`,
      quem: 'loja',
      onde,
    },
  ];
}

function itemTransportadora(companyId: string): ItemDoDiaUm {
  const logistica = buildLogisticsReadinessChecklist(companyId);
  const me = logistica.providers.find((p) => p.carrier === 'melhor_envio');
  const travaDoServidor = me?.access.locks.includes('PRODUCAO_DESABILITADA_NO_PROCESSO') ?? false;
  return {
    chave: 'transportadora',
    titulo: 'Transportadora (Melhor Envio)',
    // Sem transportadora a loja ainda entrega pela tabela: é escolha, não falta.
    estado: logistica.checkoutCarrier.active ? 'ok' : travaDoServidor ? 'pendente' : 'escolha',
    detalhe: logistica.checkoutCarrier.active
      ? logistica.checkoutCarrier.message
      : `${logistica.checkoutCarrier.message} Com o token de produção, a loja cota, compra etiqueta e rastreia `
        + 'pelo Melhor Envio (Correios e Jadlog inclusos).',
    quem: travaDoServidor ? 'servidor' : 'loja',
    onde: travaDoServidor ? null : '/sistema/loja/logistica',
  };
}

function itemAsaas(companyId: string): ItemDoDiaUm {
  const s = getAsaasStatus({ companyId });
  const semCobranca = Number(
    (getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_payment_intents WHERE company_id = ? AND status = 'unconfigured'",
      )
      .get(companyId) as { n: number }).n,
  );
  const base = { chave: 'asaas', titulo: 'Cobrança online (Asaas)', onde: '/sistema/integracoes/asaas' };
  if (s.configured && s.environment === 'production') {
    return { ...base, quem: 'loja', estado: 'ok', detalhe: 'Cobrança online em produção.' };
  }
  const acumulados = semCobranca > 0 ? ` ${semCobranca} pedido(s) já nasceram sem cobrança online.` : '';
  if (s.configured) {
    const trava = s.productionBlockedBy.length > 0 ? ` Trava: ${s.productionBlockedBy.join(', ')}.` : '';
    return {
      ...base,
      quem: 'loja',
      estado: 'pendente',
      detalhe: `Chave de SANDBOX: a cobrança é de teste. Guarde a chave de produção.${trava}${acumulados}`,
    };
  }
  return {
    ...base,
    quem: 'loja',
    estado: 'pendente',
    detalhe: 'Sem a chave do Asaas desta operação, o pedido nasce "Pagamento online indisponível" e só a baixa '
      + `manual paga.${acumulados}`,
  };
}

function itemEmail(companyId: string): ItemDoDiaUm {
  const s = emailStatus(companyId);
  const fila = s.pending > 0 ? ` ${s.pending} mensagem(ns) esperando na fila.` : '';
  return {
    chave: 'email',
    titulo: 'E-mail para o cliente (SMTP)',
    estado: s.enabled ? 'ok' : 'pendente',
    detalhe: s.enabled
      ? `Envio ligado.${fila}`
      : `O servidor ainda não tem SMTP: falta ${s.missing.join(', ')}. Os avisos ao cliente ficam na fila até lá.${fila}`,
    // O SMTP é do SERVIDOR, não da operação: vale para as seis de uma vez.
    quem: 'servidor',
    onde: '/sistema/loja/emails',
  };
}

export function prontidaoDaOperacao(companyId: string): ProntidaoDaOperacao {
  ensureCoreSchema();
  const empresa = getConnection()
    .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name: string } | undefined;
  const itens: ItemDoDiaUm[] = [
    itemEntrega(companyId),
    ...itemProdutos(companyId),
    ...itemOrigem(companyId),
    itemTransportadora(companyId),
    itemAsaas(companyId),
    itemEmail(companyId),
  ];
  const pendentes = itens.filter((i) => i.estado === 'pendente').length;
  return {
    companyId,
    companyName: empresa?.trade_name ?? companyId,
    itens,
    pendentes,
    pronta: pendentes === 0,
  };
}

/** Várias operações de uma vez — a visão de quem responde pelo grupo. */
export function prontidaoDasOperacoes(companyIds: string[]): ProntidaoDaOperacao[] {
  return companyIds.map(prontidaoDaOperacao);
}

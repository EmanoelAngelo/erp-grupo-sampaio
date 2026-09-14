import { randomUUID } from 'node:crypto';
import { deleteRows, findOneRow, insertRow } from '../../db/database.js';
import { ApiError } from '../../utils/errors.js';
import { chaveReusada, impressaoSeladaDe, outraImpressao } from './ImpressaoDaRequisicao.js';

export function requireIdempotencyKey(key: string | undefined): string {
  const trimmed = key?.trim();
  if (!trimmed) throw new ApiError('API_IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key obrigatória.', 400);
  return trimmed;
}

/**
 * O pedido HTTP que a chave protege: método, rota e corpo (RES-IDEM-VIZ).
 *
 * A rota é o caminho REAL (com o id do recurso), sem a query: a mesma chave
 * mandada a outro recurso é outro pedido.
 */
export interface RequisicaoIdempotente {
  method: string;
  rota: string;
  corpo: unknown;
}

/** Monta a `RequisicaoIdempotente` de uma requisição do Express. */
export function requisicaoDe(req: { method: string; baseUrl?: string; path: string; body?: unknown }): RequisicaoIdempotente {
  return { method: String(req.method).toUpperCase(), rota: `${req.baseUrl ?? ''}${req.path}`, corpo: req.body ?? null };
}

/**
 * O que a memória da chave guarda: a resposta e, desde o RES-IDEM-VIZ, a
 * impressão do pedido (ausente na memória anterior a ela).
 *
 * O tipo tem NOME de propósito: `um-escritor-por-conceito.test.ts` acha os
 * leitores de cada coleção por `findOneRow<…>('coleção'`, e um tipo literal
 * com `Record<…>` e `;` no lugar do genérico escondia este leitor do
 * inventário.
 */
type MemoriaDaChave = {
  id: string;
  response: Record<string, unknown>;
  fingerprint?: string;
};

function memoriaDaChave(key: string, companyId: string) {
  return findOneRow<MemoriaDaChave>('api_idempotency_keys', (row) => row.id === `${companyId}:${key}`);
}

/**
 * A MESMA CHAVE COM OUTRO PEDIDO É RECUSADA (RES-IDEM-VIZ).
 *
 * A memória guardava só a RESPOSTA: a mesma chave com outro corpo — outro CSC,
 * outra credencial, outra maquininha — devolvia a resposta do primeiro pedido
 * como se fosse do segundo, e o segundo nunca era gravado. Agora a memória
 * guarda também a impressão do pedido (método, rota e corpo canônico), selada
 * por HMAC porque esses corpos carregam token e senha; o reenvio igual devolve
 * a resposta guardada, e o diferente é 422 CORE_IDEMPOTENCY_KEY_REUSED.
 *
 * Memória anterior à impressão (sem `fingerprint`) devolve a resposta, como
 * sempre: não há com o que comparar.
 *
 * Exposta à parte para a rota que faz trabalho ANTES do handler (a rodada de
 * homologação, a cotação de frete) recusar antes de gastá-lo.
 */
export function conferirRequisicaoRepetida(key: string, companyId: string, requisicao: RequisicaoIdempotente): void {
  const existing = memoriaDaChave(key, companyId);
  if (existing && outraImpressao(existing.fingerprint, impressaoSeladaDe(requisicao))) {
    throw chaveReusada(`outro pedido em ${requisicao.method} ${requisicao.rota}`);
  }
}

export function withIdempotency<T extends Record<string, unknown>>(
  key: string,
  companyId: string,
  handler: () => T,
  requisicao: RequisicaoIdempotente,
): T {
  const impressao = impressaoSeladaDe(requisicao);
  const existing = memoriaDaChave(key, companyId);
  if (existing) {
    if (outraImpressao(existing.fingerprint, impressao)) {
      throw chaveReusada(`outro pedido em ${requisicao.method} ${requisicao.rota}`);
    }
    return existing.response as T;
  }
  const response = handler();
  insertRow('api_idempotency_keys', {
    id: `${companyId}:${key}`,
    companyId,
    idempotencyKey: key,
    response,
    fingerprint: impressao,
    createdAt: new Date().toISOString(),
  });
  return response;
}

/*
  O LOG DE REQUISIÇÃO TEM TETO: 30 DIAS.

  Todo ApiError vira uma linha aqui — e era para sempre. Sem leitor no
  repositório e sem poda, a tabela só crescia: cada 404 de pacote antigo em
  cache, cada validação recusada, uma linha até o disco acabar. Trinta dias
  cobrem qualquer diagnóstico razoável de produção; mais velho que isso é
  peso morto.

  A poda roda AQUI DENTRO, e não num agendador: este é o único escritor da
  tabela, então só existe crescimento quando este caminho executa — quem
  cria o problema paga a limpeza. Um timer separado seria mais uma coisa
  para esquecer de subir, e importar a poda num tick de outro domínio
  acoplaria dois módulos por causa de um DELETE.

  O custo é amortizado: a poda dispara uma vez a cada GRAVACOES_ENTRE_PODAS
  gravações (e na primeira do processo, para o boot já sanear o acumulado).
  Entre uma poda e outra a tabela carrega no máximo o excedente de um ciclo,
  e cada varredura percorre uma tabela limitada pela própria retenção.
*/
export const RETENCAO_DO_REQUEST_LOG_DIAS = 30;
const GRAVACOES_ENTRE_PODAS = 100;
let gravacoesDesdeAPoda = GRAVACOES_ENTRE_PODAS;

function podarRequestLogsVencidos(): void {
  const limite = new Date(
    Date.now() - RETENCAO_DO_REQUEST_LOG_DIAS * 86_400_000,
  ).toISOString();
  // ISO-8601 em UTC ordena como texto; linha sem createdAt não tem idade e
  // fica — apagar o que não se sabe datar seria esconder, não podar.
  deleteRows('api_request_logs', (r) => typeof r.createdAt === 'string' && r.createdAt < limite);
}

export function createRequestLog(input: {
  companyId?: string;
  method: string;
  path: string;
  status: number;
  requestId: string;
}): void {
  gravacoesDesdeAPoda += 1;
  if (gravacoesDesdeAPoda > GRAVACOES_ENTRE_PODAS) {
    gravacoesDesdeAPoda = 0;
    podarRequestLogsVencidos();
  }
  insertRow('api_request_logs', {
    id: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
  });
}

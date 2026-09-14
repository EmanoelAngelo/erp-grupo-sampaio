/**
 * Ponte entre o cliente DAQUI e o cliente lá no Asaas.
 *
 * O Asaas NÃO é dono do cadastro. Ele guarda uma cópia do mínimo necessário
 * para emitir a cobrança; quem manda no cliente é `core_customers`. Por isso
 * este módulo só faz uma coisa: descobrir (ou criar) o id remoto e guardar o
 * vínculo. Nome, documento e contato não voltam de lá para cá.
 *
 * O vínculo é POR OPERAÇÃO E POR AMBIENTE. Duas razões:
 *
 *  - cada operação tem conta Asaas própria, então o mesmo CPF vira dois
 *    clientes remotos diferentes — reaproveitar o id de uma na outra faria a
 *    cobrança sair na conta errada;
 *  - sandbox e produção são contas distintas, e um id de sandbox não existe
 *    em produção.
 *
 * A UNIQUE `(company_id, customer_id, environment)` é o que segura dois
 * checkouts simultâneos do mesmo cliente: o segundo colide e relê o vínculo
 * do primeiro em vez de criar um cliente duplicado no provedor.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface AsaasCustomerLink {
  id: string;
  companyId: string;
  customerId: string;
  environment: string;
  asaasCustomerId: string;
}

/** Cria a cobrança lá fora. É o contrato mínimo que este módulo precisa. */
export interface AsaasCustomerGateway {
  createCustomer(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function toLink(row: Record<string, unknown>): AsaasCustomerLink {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    customerId: String(row.customer_id),
    environment: String(row.environment),
    asaasCustomerId: String(row.asaas_customer_id),
  };
}

export function findAsaasCustomerLink(input: {
  companyId: string;
  customerId: string;
  environment: string;
}): AsaasCustomerLink | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT * FROM core_asaas_customers
        WHERE company_id = ? AND customer_id = ? AND environment = ?`,
    )
    .get(input.companyId, input.customerId, input.environment) as
    | Record<string, unknown>
    | undefined;
  return row ? toLink(row) : null;
}

/** Grava o vínculo. Repetir não duplica: a chave única resolve no banco. */
export function saveAsaasCustomerLink(input: {
  companyId: string;
  customerId: string;
  environment: string;
  asaasCustomerId: string;
}): AsaasCustomerLink {
  ensureCoreSchema();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_asaas_customers
         (id, company_id, customer_id, environment, asaas_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, customer_id, environment)
       DO UPDATE SET asaas_customer_id = excluded.asaas_customer_id, updated_at = excluded.updated_at`,
    )
    .run(
      randomUUID(),
      input.companyId,
      input.customerId,
      input.environment,
      input.asaasCustomerId,
      agora,
      agora,
    );
  return findAsaasCustomerLink(input)!;
}

/**
 * Id do cliente no Asaas — reaproveitado quando já existe.
 *
 * Idempotente por construção: com vínculo, nem chama o provedor. Sem vínculo,
 * cria e guarda. Duas chamadas concorrentes acabam no mesmo id porque a
 * segunda perde a corrida na UNIQUE e relê.
 */
export async function resolveAsaasCustomer(input: {
  companyId: string;
  environment: string;
  gateway: AsaasCustomerGateway;
  customer: {
    id: string;
    name: string;
    document?: string | null;
    email?: string | null;
    phone?: string | null;
  };
}): Promise<AsaasCustomerLink> {
  ensureCoreSchema();

  const existente = findAsaasCustomerLink({
    companyId: input.companyId,
    customerId: input.customer.id,
    environment: input.environment,
  });
  if (existente) return existente;

  // O provedor exige CPF/CNPJ para emitir cobrança. Recusar aqui, com o nome
  // do campo, é melhor do que deixar o Asaas responder um erro genérico
  // depois do pedido já criado.
  const documento = input.customer.document?.replace(/\D/g, '') ?? '';
  if (!documento) {
    throw new ApiError(
      'CORE_ASAAS_CUSTOMER_DOCUMENT_REQUIRED',
      'O CPF ou CNPJ do cliente é obrigatório para gerar a cobrança.',
      400,
    );
  }

  const resposta = await input.gateway.createCustomer({
    name: input.customer.name,
    cpfCnpj: documento,
    email: input.customer.email ?? undefined,
    mobilePhone: input.customer.phone ?? undefined,
    // Amarra os dois lados: pelo id do ERP dá para achar o cliente lá.
    externalReference: input.customer.id,
  });

  const remoto = String(resposta.id ?? '');
  if (!remoto) {
    throw new ApiError(
      'CORE_ASAAS_CUSTOMER_FAILED',
      'O Asaas não devolveu o identificador do cliente.',
      502,
    );
  }

  return saveAsaasCustomerLink({
    companyId: input.companyId,
    customerId: input.customer.id,
    environment: input.environment,
    asaasCustomerId: remoto,
  });
}

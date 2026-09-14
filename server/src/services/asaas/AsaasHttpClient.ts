import { secretProvider } from '../../secrets/SecretProvider.js';
import { getAsaasApiKey } from '../integrations/AsaasCredentialService.js';
import { loadEnv } from '../../config/env.js';
import { ApiError, logError } from '../../utils/errors.js';

export type AsaasFetch = typeof fetch;

export interface AsaasHttpClientOptions {
  environment: 'sandbox' | 'production';
  fetchImpl?: AsaasFetch;
  correlationId?: string;
  companyId?: string;
  storeId?: string;
  operationalUnitId?: string;
}

export class AsaasHttpClient {
  private readonly fetchImpl: AsaasFetch;
  private readonly environment: 'sandbox' | 'production';
  private readonly correlationId?: string;
  private readonly companyId?: string;
  private readonly storeId?: string;
  private readonly operationalUnitId?: string;

  constructor(options: AsaasHttpClientOptions) {
    this.environment = options.environment;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.correlationId = options.correlationId;
    this.companyId = options.companyId;
    this.storeId = options.storeId;
    this.operationalUnitId = options.operationalUnitId;
  }

  private baseUrl(): string {
    const env = loadEnv();
    return this.environment === 'production'
      ? env.ASAAS_PRODUCTION_BASE_URL
      : env.ASAAS_BASE_URL;
  }

  private apiKey(): string {
    const key = this.companyId
      ? getAsaasApiKey(this.companyId, this.environment, {
          storeId: this.storeId,
          operationalUnitId: this.operationalUnitId,
        })
      : secretProvider.getAsaasApiKey(this.environment);
    if (!key) throw new ApiError('ASAAS_CREDENTIAL_MISSING', 'Credenciais Asaas não configuradas.', 503);
    return key;
  }

  private integrationAllowed(): boolean {
    if (this.companyId && getAsaasApiKey(this.companyId, this.environment, {
      storeId: this.storeId,
      operationalUnitId: this.operationalUnitId,
    })) {
      return true;
    }
    const env = loadEnv();
    if (this.environment === 'sandbox') return env.asaasEnabled === true;
    return env.asaasEnabled === true && env.asaasProductionEnabled === true;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retry = 0,
  ): Promise<T> {
    const env = loadEnv();
    if (!this.integrationAllowed()) {
      throw new ApiError('ASAAS_DISABLED', 'Integração Asaas desabilitada.', 503);
    }
    if (this.environment === 'production' && !env.asaasProductionEnabled) {
      throw new ApiError('ASAAS_PRODUCTION_DISABLED', 'Produção Asaas desabilitada.', 403);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.ASAAS_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          access_token: this.apiKey(),
          'X-Correlation-Id': this.correlationId ?? '',
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (res.status === 429 && retry < env.ASAAS_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
        return this.request<T>(method, path, body, retry + 1);
      }
      if (!res.ok) {
        throw new ApiError('ASAAS_REMOTE_ERROR', `Erro Asaas ${res.status}`, res.status, data);
      }
      return data as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logError('asaas_request_failed', { path, method });
      throw new ApiError('ASAAS_CONNECTION_FAILED', 'Falha de conexão com Asaas.', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(): Promise<{ ok: true; environment: string }> {
    await this.request('GET', '/finance/balance');
    return { ok: true, environment: this.environment };
  }

  async createCustomer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/customers', payload);
  }

  async getCustomer(id: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/customers/${id}`);
  }

  async createPayment(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/payments', payload);
  }

  async getPayment(id: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/payments/${id}`);
  }

  /**
   * Lista cobranças por filtro (`externalReference`, `status`…).
   *
   * É a pergunta que faltava depois de um timeout na criação (GAP-PRD-049): a
   * resposta não voltou, mas a cobrança pode ter nascido lá. O id da origem vai
   * como `externalReference` em toda criação, e é por ele que se procura.
   */
  async listPayments(filtro: Record<string, string>): Promise<Record<string, unknown>> {
    const consulta = new URLSearchParams(filtro).toString();
    return this.request('GET', `/payments${consulta ? `?${consulta}` : ''}`);
  }

  /**
   * Remove (cancela) a cobrança no provedor — `DELETE /payments/{id}`.
   *
   * Era `POST /payments/{id}/cancel`, que a API v3 do Asaas NÃO tem (a
   * remoção de cobrança é o DELETE, como a de plano de parcelas e a de
   * assinatura logo abaixo; o aviso que volta é PAYMENT_DELETED). Os dublês
   * dos testes respondiam ao endereço inventado, e ninguém via. Apareceu
   * quando a homologação passou a executar o cancelamento de verdade
   * (GAP-PRD-169): o cancelamento do título, do pedido e do PIX do balcão ia a
   * um endereço inexistente.
   */
  async cancelPayment(id: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/payments/${id}`);
  }

  async getPixQrCode(paymentId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/payments/${paymentId}/pixQrCode`);
  }

  async getIdentificationField(paymentId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/payments/${paymentId}/identificationField`);
  }

  /** Estorno integral de uma cobrança. O dinheiro volta pelo mesmo meio. */
  async refundPayment(id: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/payments/${id}/refund`, {});
  }

  /**
   * Estorno do PLANO de parcelas inteiro (GAP-PRD-114). No cartão parcelado o
   * provedor cria uma cobrança por parcela; estornar só a primeira devolveria
   * uma parcela e deixaria as outras cobradas no cartão do cliente.
   */
  async refundInstallment(installmentId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/installments/${installmentId}/refund`, {});
  }

  /** Remove o PLANO de parcelas inteiro — todas as parcelas ainda não pagas. */
  async cancelInstallment(installmentId: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/installments/${installmentId}`);
  }

  async createCheckout(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/checkouts', payload);
  }

  async getCheckout(id: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/checkouts/${id}`);
  }

  async createSubscription(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/subscriptions', payload);
  }

  async cancelSubscription(id: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/subscriptions/${id}`);
  }
}

import { loadEnv } from '../config/env.js';

export interface SecretStatus {
  configured: boolean;
  environment: 'sandbox' | 'production';
  maskedHint?: string;
  lastValidatedAt?: string;
  status: 'missing' | 'configured' | 'invalid';
}

export interface SecretProvider {
  getAsaasApiKey(environment: 'sandbox' | 'production'): string | null;
  getAsaasWebhookToken(): string | null;
  getAsaasStatus(environment: 'sandbox' | 'production'): SecretStatus;
  maskSecret(value: string): string;
}

function mask(value: string): string {
  if (!value || value.length < 4) return '****';
  return `****${value.slice(-4)}`;
}

export class EnvironmentSecretProvider implements SecretProvider {
  maskSecret(value: string): string {
    return mask(value);
  }

  getAsaasApiKey(environment: 'sandbox' | 'production'): string | null {
    const env = loadEnv();
    if (environment === 'production') {
      if (env.asaasProductionEnabled !== true) return null;
      const key = env.ASAAS_PRODUCTION_API_KEY?.trim();
      return key || null;
    }
    if (env.asaasEnabled !== true) return null;
    const key = env.ASAAS_API_KEY?.trim();
    return key || null;
  }

  getAsaasWebhookToken(): string | null {
    const token = loadEnv().ASAAS_WEBHOOK_AUTH_TOKEN?.trim();
    return token || null;
  }

  getAsaasStatus(environment: 'sandbox' | 'production'): SecretStatus {
    const key = this.getAsaasApiKey(environment);
    return {
      configured: Boolean(key),
      environment,
      maskedHint: key ? this.maskSecret(key) : undefined,
      status: key ? 'configured' : 'missing',
    };
  }
}

export const secretProvider: SecretProvider = new EnvironmentSecretProvider();

/**
 * ============================================================================
 * O INVENTÁRIO DO COFRE — o que está selado, e com qual chave
 * ============================================================================
 *
 * Existe UM cofre neste projeto (`FiscalSecretVault`: AES-256-GCM, chave
 * derivada de `DEVORA_ENCRYPTION_KEY` por scrypt) e SEIS serviços que o usam,
 * cada um guardando num lugar diferente. Essa dispersão é a razão deste
 * arquivo: perguntar "o que está selado?" exigia conhecer os seis, e foi assim
 * que se descobriu tarde que tudo estava selado com a chave PADRÃO de
 * desenvolvimento.
 *
 * ## O que este módulo NUNCA faz
 *
 * Não decifra para mostrar. A única pergunta que ele responde sobre o conteúdo
 * é binária — "abre com a chave atual?" — e ela é respondida tentando abrir e
 * jogando o resultado fora. Nenhum valor entra em retorno, log ou exceção.
 *
 * ## Por que a lista de lugares é escrita à mão
 *
 * Porque ela é o CONTRATO. Um cofre novo que não apareça aqui é um segredo que
 * a rotação de chave esqueceria — e um segredo esquecido numa rotação é um
 * segredo perdido. `o-cofre-nao-esconde-ninguem.test.ts` compara esta lista
 * com os chamadores reais de `encryptFiscalSecret` e fica vermelho quando
 * alguém acrescenta um sétimo.
 */
import { getConnection } from './sqlite.js';
import { findRows, updateRows, type DbSchema } from './database.js';
import {
  decryptFiscalSecret,
  decryptWithKey,
  encryptFiscalSecret,
  encryptWithKey,
} from '../services/fiscal/FiscalSecretVault.js';

/** Onde um segredo mora, e como se chega ao texto cifrado dele. */
export interface LugarDeSegredo {
  /** O que é, para o relatório. */
  tipo: string;
  /**
   * A coleção JSON ou tabela relacional.
   *
   * Tipado como chave do esquema de propósito: um nome que não existe passa a
   * ser erro de compilação, e não uma coleção vazia lida em silêncio — que é
   * como um segredo escaparia da rotação.
   */
  store: keyof DbSchema | string;
  /** Coleção JSON (`findRows`) ou tabela com coluna (`SELECT`). */
  forma: 'json' | 'coluna';
  /** No caso `json`, o campo que carrega o texto cifrado. */
  campo?: string;
  /** No caso `coluna`, a coluna cifrada e a chave primária. */
  coluna?: string;
  /** Serviço que responde por ele — para quem for procurar a tela. */
  servico: string;
}

/**
 * OS SEIS LUGARES.
 *
 * Ordem estável, para o relatório sair sempre igual e a diferença entre duas
 * execuções ser real.
 */
export const LUGARES: LugarDeSegredo[] = [
  {
    tipo: 'a1_pfx',
    store: 'fiscal_certificate_references',
    forma: 'json',
    campo: 'encryptedPfx',
    servico: 'FiscalCertificateService',
  },
  {
    tipo: 'a1_password',
    store: 'fiscal_certificate_references',
    forma: 'json',
    campo: 'encryptedPassword',
    servico: 'FiscalCertificateService',
  },
  {
    tipo: 'integration_secret',
    store: 'integration_secrets',
    forma: 'json',
    campo: 'encryptedValue',
    servico: 'IntegrationSecretVaultService',
  },
  {
    tipo: 'nfce_csc',
    store: 'nfce_settings',
    forma: 'json',
    campo: 'encryptedCsc',
    servico: 'NfceCscService',
  },
  {
    tipo: 'logistics_credential',
    store: 'logistics_carrier_credentials',
    forma: 'json',
    campo: 'encryptedPayload',
    servico: 'LogisticsCredentialService',
  },
  {
    tipo: 'payment_terminal_credential',
    store: 'payment_terminal_configurations',
    forma: 'json',
    campo: 'encryptedPayload',
    servico: 'PaymentTerminalCredentialService',
  },
  {
    // O segredo HMAC de cada agente local de maquininha (GAP-PRD-014): sem ele
    // o servidor não confere a assinatura das respostas do PinPad.
    tipo: 'payment_terminal_agent_secret',
    store: 'payment_terminal_local_agents',
    forma: 'json',
    campo: 'encryptedSecret',
    servico: 'PaymentTerminalLocalAgentService',
  },
  {
    tipo: 'email_password',
    store: 'core_mail_inboxes',
    forma: 'coluna',
    coluna: 'secret_cipher',
    servico: 'MailInboxService',
  },
  {
    // O link de recuperação de senha e o código de verificação que esperam o
    // carteiro (GAP-PRD-007). Vida curta — apagados ao sair, desistir ou
    // vencer (1 hora) —, mas selados com a MESMA chave: uma rotação no meio da
    // hora tem de ressela-los, ou a mensagem pendente não abriria mais.
    tipo: 'email_conteudo_protegido',
    store: 'core_email_segredos',
    forma: 'coluna',
    coluna: 'segredo_cifrado',
    servico: 'EmailService',
  },
  {
    // O segredo do cliente OAuth do "Entrar com Google" (GAP-PRD-027). Da
    // instalação: `company_id` fica nulo na linha única.
    tipo: 'google_oauth_client_secret',
    store: 'core_portal_google_login',
    forma: 'coluna',
    coluna: 'secret_cipher',
    servico: 'GoogleLoginConfigService',
  },
];

/** Um segredo encontrado, descrito SEM o valor. */
export interface SegredoNoCofre {
  tipo: string;
  store: string;
  servico: string;
  /** Id da linha, para a rotação saber o que reescrever. */
  rowId: string;
  companyId: string | null;
  /** `sandbox`/`production`/`homologation` quando o registro diz; senão null. */
  ambiente: string | null;
  /** Rótulo extra do próprio registro (o `secretType`, a unidade). */
  detalhe: string | null;
  /** Abre com a chave que o processo está usando AGORA? */
  decryptableWithCurrentKey: boolean;
  /**
   * Último toque HUMANO na credencial, quando o registro guarda um.
   *
   * Não é o instante do resselo: `resselarNoLugar` troca só o texto cifrado
   * e deixa o carimbo em paz, de propósito. É isso que permite ao
   * diagnóstico responder "esta credencial viveu selada pela chave
   * publicada?" depois de a rotação já ter passado por ela.
   */
  atualizadoEm: string | null;
}

/** O carimbo do último toque humano, no nome que cada coleção usa. */
function atualizadoEmDe(d: Record<string, unknown>): string | null {
  for (const k of ['updatedAt', 'updated_at', 'createdAt', 'created_at']) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function ambienteDe(d: Record<string, unknown>): string | null {
  for (const k of ['environment', 'ambiente', 'mode']) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  // O tipo do segredo às vezes carrega o ambiente no nome.
  const tipo = String(d.secretType ?? '');
  if (/sandbox/i.test(tipo)) return 'sandbox';
  if (/production/i.test(tipo)) return 'production';
  return null;
}

function detalheDe(d: Record<string, unknown>): string | null {
  for (const k of ['secretType', 'operationalUnitId', 'carrier', 'provider']) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Abre?
 *
 * Tenta decifrar e DESCARTA o resultado. O texto claro existe por uma
 * instrução e some — nunca é devolvido, registrado nem comparado.
 *
 * Sem `chave`, usa a do ambiente; com ela, responde por uma chave
 * específica — é assim que a rotação confere que a ANTIGA deixou de abrir.
 */
function abre(cifrado: string, chave?: string): boolean {
  try {
    if (chave === undefined) decryptFiscalSecret(cifrado);
    else decryptWithKey(cifrado, chave);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tudo o que está selado, em todos os lugares, sem nenhum valor.
 *
 * `chave` ausente pergunta pela chave do ambiente. Informada, pergunta por
 * ela — o que permite dizer "a antiga já não abre" sem trocar o ambiente do
 * processo.
 */
export function inventariarSegredos(chave?: string): SegredoNoCofre[] {
  const achados: SegredoNoCofre[] = [];

  for (const lugar of LUGARES) {
    if (lugar.forma === 'json') {
      let linhas: Record<string, unknown>[];
      try {
        linhas = findRows<Record<string, unknown>>(lugar.store as keyof DbSchema, () => true);
      } catch {
        // Coleção que ainda não existe neste banco: nada selado nela.
        continue;
      }
      for (const d of linhas) {
        const cifrado = d[lugar.campo as string];
        if (typeof cifrado !== 'string' || !cifrado) continue;
        achados.push({
          tipo: lugar.tipo,
          store: lugar.store,
          servico: lugar.servico,
          rowId: String(d.id ?? ''),
          companyId: (d.companyId as string) ?? null,
          ambiente: ambienteDe(d),
          detalhe: detalheDe(d),
          decryptableWithCurrentKey: abre(cifrado, chave),
          atualizadoEm: atualizadoEmDe(d),
        });
      }
      continue;
    }

    // Tabela relacional.
    try {
      const linhas = getConnection()
        .prepare(
          `SELECT id, company_id, updated_at, created_at, ${lugar.coluna} AS cifrado `
            + `FROM ${lugar.store} `
            + `WHERE ${lugar.coluna} IS NOT NULL AND ${lugar.coluna} <> ''`,
        )
        .all() as unknown as {
          id: string;
          company_id: string | null;
          updated_at: string | null;
          created_at: string | null;
          cifrado: string;
        }[];
      for (const l of linhas) {
        achados.push({
          tipo: lugar.tipo,
          store: lugar.store,
          servico: lugar.servico,
          rowId: String(l.id),
          companyId: l.company_id ?? null,
          ambiente: null,
          detalhe: null,
          decryptableWithCurrentKey: abre(l.cifrado, chave),
          atualizadoEm: l.updated_at ?? l.created_at ?? null,
        });
      }
    } catch {
      // Tabela ausente neste banco.
    }
  }

  return achados;
}

/**
 * Reescreve UM segredo, a partir do texto claro que já está em memória.
 *
 * Sem `chave`, sela com a do ambiente. A rotação passa a NOVA explicitamente,
 * porque o processo dela ainda está com a antiga carregada.
 */
export function resselarNoLugar(
  lugar: LugarDeSegredo,
  rowId: string,
  claro: string,
  chave?: string,
): void {
  const novo = chave === undefined ? encryptFiscalSecret(claro) : encryptWithKey(claro, chave);
  if (lugar.forma === 'json') {
    updateRows(
      lugar.store as keyof DbSchema,
      (r) => String((r as Record<string, unknown>).id) === rowId,
      (r) => ({ ...r, [lugar.campo as string]: novo }),
    );
    return;
  }
  getConnection()
    .prepare(`UPDATE ${lugar.store} SET ${lugar.coluna} = ? WHERE id = ?`)
    .run(novo, rowId);
}

/**
 * O TEXTO CIFRADO BRUTO de um segredo, para a rotação abrir com a chave
 * antiga.
 *
 * Devolve o CIFRADO, nunca o claro. Quem chama é a rotação, que o abre em
 * memória e o descarta — e é por isso que esta função existe separada do
 * inventário: o inventário não deve ter meio de entregar conteúdo a ninguém.
 */
export function cifradoDe(s: SegredoNoCofre): string | null {
  const lugar = LUGARES.find((l) => l.tipo === s.tipo && l.store === s.store);
  if (!lugar) return null;
  if (lugar.forma === 'json') {
    const linhas = findRows<Record<string, unknown>>(
      lugar.store as keyof DbSchema,
      (r) => String((r as Record<string, unknown>).id) === s.rowId,
    );
    const v = linhas[0]?.[lugar.campo as string];
    return typeof v === 'string' && v ? v : null;
  }
  const linha = getConnection()
    .prepare(`SELECT ${lugar.coluna} AS cifrado FROM ${lugar.store} WHERE id = ?`)
    .get(s.rowId) as { cifrado?: string } | undefined;
  return linha?.cifrado ?? null;
}

/** O lugar de um segredo, para quem for resselá-lo. */
export function lugarDe(s: SegredoNoCofre): LugarDeSegredo | undefined {
  return LUGARES.find((l) => l.tipo === s.tipo && l.store === s.store);
}
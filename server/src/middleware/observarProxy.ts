/**
 * ============================================================================
 * O SERVIDOR PERCEBE O PROXY QUE NINGUÉM DECLAROU (GAP-PRD-055)
 * ============================================================================
 *
 * `DEVORA_TRUST_PROXY` é o número de saltos de proxy na frente da API, e só
 * quem publica sabe a topologia — por isso o valor é do dono. Mas o erro de
 * deixá-lo em 0 atrás de um proxy é mudo: o servidor sobe, responde, e só
 * depois as seis operações descobrem que dividem UM balde de 300 requisições
 * por minuto (o do IP do proxy), e que o bloqueio de login por par voltou a
 * trancar o gerente em todos os caixas.
 *
 * O sinal existe em cada requisição: um proxy reverso acrescenta
 * `X-Forwarded-For`. Este middleware observa esse sinal e o contrário dele:
 *
 *   - `PROXY_NAO_DECLARADO`: chegou `X-Forwarded-For` com o valor em 0. Ou há
 *     um proxy na frente e o valor está errado, ou alguém está mandando o
 *     cabeçalho à mão — nos dois casos, quem publica precisa olhar.
 *   - `PROXY_DECLARADO_MAS_ACESSO_DIRETO`: o valor é > 0 e chegou requisição
 *     SEM o cabeçalho, de fora da máquina. Há um caminho até a API que não
 *     passa pelo proxy — e por ele o `X-Forwarded-For` que o cliente escrever
 *     seria acreditado. (Loopback não conta: é a sonda de saúde do próprio
 *     host, ou o proxy local conferindo a porta.)
 *
 * Cada estado é avisado UMA vez no log por processo (`publicacao_proxy_*`,
 * nível `warn`) e fica em `estadoDaPublicacao()`, que a prontidão da
 * instalação (`/core/system/secrets-readiness`, campo `publicacao`) devolve.
 *
 * Não muda comportamento nenhum: não liga nem desliga `trust proxy` sozinho.
 * Confiar em cabeçalho por palpite seria abrir exatamente o buraco que o
 * valor explícito existe para fechar.
 */
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';
import { sanitizeForLog } from '../utils/errors.js';

export type EstadoDaPublicacao =
  | 'SERVIDO_DIRETO'
  | 'PROXY_DECLARADO'
  | 'PROXY_NAO_DECLARADO'
  | 'PROXY_DECLARADO_MAS_ACESSO_DIRETO';

type Observacao = { primeiraVez: string; ultimaVez: string; vezes: number };

let proxyNaoDeclarado: Observacao | null = null;
let acessoDireto: Observacao | null = null;

function ehLoopback(endereco: string): boolean {
  return (
    endereco === '127.0.0.1'
    || endereco === '::1'
    || endereco.startsWith('127.')
    || endereco.startsWith('::ffff:127.')
  );
}

function avisar(mensagem: string, meta: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: 'warn', message: mensagem, ...(sanitizeForLog(meta) as object) }));
}

function anotar(atual: Observacao | null): Observacao {
  const agora = new Date().toISOString();
  if (!atual) return { primeiraVez: agora, ultimaVez: agora, vezes: 1 };
  return { ...atual, ultimaVez: agora, vezes: atual.vezes + 1 };
}

export function observarProxy(req: Request, _res: Response, next: NextFunction): void {
  try {
    const saltos = loadEnv().DEVORA_TRUST_PROXY;
    const temCabecalho = typeof req.headers['x-forwarded-for'] === 'string'
      && req.headers['x-forwarded-for'].trim() !== '';
    const socket = req.socket?.remoteAddress ?? '';

    if (saltos === 0 && temCabecalho) {
      const primeira = proxyNaoDeclarado === null;
      proxyNaoDeclarado = anotar(proxyNaoDeclarado);
      if (primeira) {
        avisar('publicacao_proxy_nao_declarado', {
          socket,
          orientacao:
            'Chegou X-Forwarded-For com DEVORA_TRUST_PROXY=0. Se a API está atrás de um proxy '
            + 'reverso (nginx, Caddy, túnel), defina DEVORA_TRUST_PROXY com o número de saltos '
            + '(1 no caso normal) e reinicie: sem isso, todas as operações dividem o limite de '
            + 'requisições e o bloqueio de login do IP do proxy.',
        });
      }
    } else if (saltos > 0 && !temCabecalho && socket && !ehLoopback(socket)) {
      const primeira = acessoDireto === null;
      acessoDireto = anotar(acessoDireto);
      if (primeira) {
        avisar('publicacao_proxy_contornado', {
          socket,
          orientacao:
            `DEVORA_TRUST_PROXY=${saltos}, mas chegou requisição sem X-Forwarded-For vinda de fora `
            + 'da máquina: há um caminho até a API que não passa pelo proxy. Feche a porta da API '
            + 'para fora (só o proxy deve alcançá-la) — por esse caminho um X-Forwarded-For escrito '
            + 'pelo cliente seria acreditado.',
        });
      }
    }
  } catch {
    // Observar nunca derruba requisição.
  }
  next();
}

/** O que a instalação sabe sobre a própria publicação — sem valor sensível nenhum. */
export function estadoDaPublicacao(): {
  trustProxy: number;
  estado: EstadoDaPublicacao;
  proxyNaoDeclarado: Observacao | null;
  acessoDiretoComProxyDeclarado: Observacao | null;
} {
  const saltos = loadEnv().DEVORA_TRUST_PROXY;
  let estado: EstadoDaPublicacao;
  if (saltos === 0) estado = proxyNaoDeclarado ? 'PROXY_NAO_DECLARADO' : 'SERVIDO_DIRETO';
  else estado = acessoDireto ? 'PROXY_DECLARADO_MAS_ACESSO_DIRETO' : 'PROXY_DECLARADO';
  return {
    trustProxy: saltos,
    estado,
    proxyNaoDeclarado,
    acessoDiretoComProxyDeclarado: acessoDireto,
  };
}

/** Zera o que foi observado — para os testes, que sobem vários apps no mesmo processo. */
export function esquecerObservacoesDoProxy(): void {
  proxyNaoDeclarado = null;
  acessoDireto = null;
}

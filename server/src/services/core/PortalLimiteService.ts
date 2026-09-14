/**
 * OS TETOS DAS PORTAS PÚBLICAS DO PORTAL — criar conta e pedir recuperação.
 *
 * Até o lote E3 da remediação as duas portas só tinham o limite GLOBAL de
 * 300 requisições por minuto por origem (`app.ts`): dava para criar 18 mil
 * contas por hora de um mesmo endereço (GAP-PRD-192) e mandar dez, cem, mil
 * e-mails de recuperação para a caixa de qualquer cliente (GAP-PRD-116).
 *
 * POR QUE NO BANCO, E NÃO NA MEMÓRIA DO PROCESSO
 *
 * O `express-rate-limit` guarda o balde na memória: reiniciar a API (o
 * `tsx watch` reinicia a cada arquivo salvo; um deploy reinicia sempre) zera
 * o teto, e dois processos teriam dois baldes. O teto de uma hora precisa
 * sobreviver a isso, como o controle de tentativas do login já sobrevive
 * (`IdentityService.recordLoginAttempt`).
 *
 * O QUE FICA GRAVADO
 *
 * Só a impressão digital (SHA-256) da chave — a origem (IP) ou a conta —, a
 * ação e o instante. O IP cru não é guardado: é dado pessoal, e para contar
 * basta saber que duas requisições vieram do MESMO lugar. As linhas com mais
 * de 24 horas são apagadas a cada uso: o teto mais longo aqui é de uma hora.
 *
 * QUEM É A "ORIGEM"
 *
 * `req.ip` — o mesmo que o limite global usa. Servido direto, é o cliente.
 * Atrás de proxy reverso, é o proxy, até o dono declarar os saltos confiáveis
 * em `DEVORA_TRUST_PROXY` (ver o bloco "QUEM O LIMITE DE TAXA ESTÁ CONTANDO"
 * em `app.ts`); esta regra herda a mesma decisão, não inventa outra.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

const HORA_MS = 60 * 60 * 1000;
const RETENCAO_MS = 24 * HORA_MS;

/** Um número inteiro positivo do ambiente, ou o padrão. */
function doAmbiente(nome: string, padrao: number): number {
  const bruto = Number(process.env[nome]);
  return Number.isInteger(bruto) && bruto > 0 ? bruto : padrao;
}

/**
 * Os tetos. O padrão é o que uma loja do tamanho do grupo usa com folga; o
 * dono que publica atrás de uma rede compartilhada (e sem declarar o proxy)
 * pode subir pelo ambiente sem mexer em código.
 */
export function tetosDoPortal(): {
  cadastrosPorOrigemHora: number;
  recuperacoesPorOrigemHora: number;
  recuperacoesPorContaHora: number;
  cuponsErradosPorOrigemHora: number;
} {
  return {
    // Criar conta: 10 por hora do mesmo endereço. Uma família, um escritório
    // ou um balcão atendendo cabem; um robô criando contas em massa, não.
    cadastrosPorOrigemHora: doAmbiente('DEVORA_PORTAL_CADASTROS_POR_ORIGEM_HORA', 10),
    // Pedir recuperação: 10 por hora do mesmo endereço, qualquer e-mail —
    // corta a varredura de caixas alheias a partir de um lugar só.
    recuperacoesPorOrigemHora: doAmbiente('DEVORA_PORTAL_RECUPERACOES_POR_ORIGEM_HORA', 10),
    // Por CONTA: 3 links por hora, o mesmo teto dos códigos de verificação
    // (`MAX_CODIGOS_POR_HORA`). Este não responde 429 — ver
    // `CustomerPortalService.pedirRecuperacaoSenha`.
    recuperacoesPorContaHora: doAmbiente('DEVORA_PORTAL_RECUPERACOES_POR_CONTA_HORA', 3),
    // Cupom ERRADO (GAP-PRD-123): 20 códigos que não valem por hora do mesmo
    // endereço. Quem digita o cupom da campanha erra dois ou três; quem varre
    // códigos para achar o cupom de uso único de outra pessoa, não. Só o ERRO
    // conta — acertar o cupom não gasta a vaga de ninguém.
    cuponsErradosPorOrigemHora: doAmbiente('DEVORA_PORTAL_CUPONS_ERRADOS_POR_ORIGEM_HORA', 20),
  };
}

export type AcaoLimitada = 'cadastro' | 'recuperacao' | 'cupom';

function impressao(acao: AcaoLimitada, chave: string): string {
  return createHash('sha256').update(`portal-limite:${acao}:${chave}`).digest('hex');
}

const MENSAGEM: Record<AcaoLimitada, string> = {
  cadastro:
    'Muitas contas criadas a partir desta conexão na última hora. Tente de novo mais tarde — se você já tem conta, use "Entrar".',
  recuperacao:
    'Muitos pedidos de recuperação a partir desta conexão na última hora. Confira sua caixa de entrada (e o spam): o último link enviado vale por 1 hora.',
  cupom:
    'Muitos cupons que não valem, digitados a partir desta conexão na última hora. Confira o código da campanha e tente de novo mais tarde.',
};

/**
 * Conta UMA passagem pela porta, ou recusa com 429 se o teto da janela já foi
 * atingido. A passagem recusada não conta — senão quem insiste nunca sairia
 * da janela.
 *
 * Sem origem (chamada interna, sem requisição), não há o que contar: o teto
 * é das PORTAS públicas, e as rotas sempre passam a origem.
 */
export function consumirLimite(input: {
  acao: AcaoLimitada;
  origem: string | null | undefined;
  maximo: number;
  janelaMs?: number;
  agora?: Date;
  /**
   * `false` só CONFERE: recusa com 429 se o teto já foi atingido, sem contar
   * esta passagem. É o modo do cupom (GAP-PRD-123), em que só o ERRO conta —
   * a porta confere antes de olhar o código e registra depois, se ele não
   * valeu. Ausente = conta, como sempre.
   */
  registrar?: boolean;
}): void {
  ensureCoreSchema();
  if (!input.origem) return;
  const janela = input.janelaMs ?? HORA_MS;
  const agora = input.agora ?? new Date();
  const chave = impressao(input.acao, input.origem);

  withTransaction(() => {
    const db = getConnection();
    db.prepare('DELETE FROM core_portal_limites WHERE created_at < ?').run(
      new Date(agora.getTime() - RETENCAO_MS).toISOString(),
    );
    const desde = new Date(agora.getTime() - janela).toISOString();
    const linhas = db
      .prepare(
        `SELECT created_at FROM core_portal_limites
          WHERE acao = ? AND chave = ? AND created_at > ?
          ORDER BY created_at`,
      )
      .all(input.acao, chave, desde) as { created_at: string }[];
    if (linhas.length >= input.maximo) {
      // Quando a passagem mais antiga da janela sair dela, abre uma vaga.
      const libera = new Date(linhas[0].created_at).getTime() + janela;
      const minutos = Math.max(1, Math.ceil((libera - agora.getTime()) / 60_000));
      throw new ApiError(`PORTAL_LIMITE_${input.acao.toUpperCase()}`, MENSAGEM[input.acao], 429, {
        tenteEmMinutos: minutos,
      });
    }
    if (input.registrar === false) return;
    db.prepare(
      'INSERT INTO core_portal_limites (id, acao, chave, created_at) VALUES (?, ?, ?, ?)',
    ).run(randomUUID(), input.acao, chave, agora.toISOString());
  });
}

/** A origem da requisição, do jeito que o limite global a enxerga. */
export function origemDaRequisicao(req: {
  ip?: string;
  socket?: { remoteAddress?: string | null };
}): string | null {
  return req.ip || req.socket?.remoteAddress || null;
}

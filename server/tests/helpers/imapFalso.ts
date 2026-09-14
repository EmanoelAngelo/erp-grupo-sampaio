/**
 * Um servidor IMAP de mentira, do tamanho do que o `MailInboxService` usa.
 *
 * Substitui o módulo `imapflow` inteiro (`vi.mock('imapflow', …)`): nenhum
 * teste sai para a rede, e o comportamento que importa do protocolo fica
 * reproduzido de propósito, porque é nele que o defeito morava:
 *
 *   - FETCH usa BODY.PEEK: ler o conteúdo NÃO marca a mensagem como lida
 *     (é o que o imapflow faz — `lib/commands/fetch.js`);
 *   - UID `N:*` com N além do último UID devolve a ÚLTIMA mensagem (RFC 3501:
 *     `*` é o maior UID em uso, e o intervalo vale nos dois sentidos);
 *   - nenhum outro comando pode rodar dentro do laço do `fetch` — no imapflow
 *     isso trava a conexão ("You can not run any IMAP commands in this loop");
 *     aqui, lança, para o teste pegar;
 *   - UIDVALIDITY por pasta: quando muda, os UIDs antigos não valem mais.
 *
 * O conteúdo das mensagens é RFC 822 de verdade, lido pelo `mailparser` real.
 */

export interface MensagemFalsa {
  uid: number;
  flags: Set<string>;
  source: Buffer;
  /** Some entre a busca e o download (outra pessoa apagou). */
  sumiu?: boolean;
  /** Tamanho anunciado pelo servidor, quando o teste quer um valor diferente do real. */
  tamanho?: number;
}

interface PastaFalsa {
  uidNext: number;
  msgs: MensagemFalsa[];
}

export const estadoImap = {
  uidValidity: 7001n,
  pastas: new Map<string, PastaFalsa>(),
  /**
   * Quando preenchido, `connect()` falha como o imapflow falha no LOGIN
   * recusado: `Command failed`, `authenticationFailed: true` e o texto do
   * provedor em `response`.
   */
  falhaNoLogin: null as string | null,
  /** Quando preenchido, `connect()` falha como rede fora (ECONNREFUSED). */
  falhaDeRede: null as string | null,
  /** STORE recusado (caixa somente leitura). */
  somenteLeitura: false,
  comandos: [] as string[],
  /** UIDs cujo conteúdo inteiro foi baixado. */
  downloads: [] as number[],
  conexoes: 0,
  /** Opções da última conexão, para conferir que o log fica desligado. */
  ultimaConfig: null as Record<string, unknown> | null,
  fetchEmCurso: false,
};

export function reiniciarImap(): void {
  estadoImap.uidValidity = 7001n;
  estadoImap.pastas = new Map([['INBOX', { uidNext: 1, msgs: [] }]]);
  estadoImap.falhaNoLogin = null;
  estadoImap.falhaDeRede = null;
  estadoImap.somenteLeitura = false;
  estadoImap.comandos = [];
  estadoImap.downloads = [];
  estadoImap.conexoes = 0;
  estadoImap.ultimaConfig = null;
  estadoImap.fetchEmCurso = false;
}

function pasta(nome: string): PastaFalsa {
  const p = estadoImap.pastas.get(nome);
  if (!p) {
    // Como o imapflow: mensagem genérica, código e texto do servidor à parte.
    throw Object.assign(new Error('Command failed'), {
      serverResponseCode: 'NONEXISTENT',
      response: `[NONEXISTENT] Unknown Mailbox: ${nome} (Failure)`,
    });
  }
  return p;
}

/** Entrega uma mensagem na pasta, com o próximo UID. Devolve o UID. */
export function entregar(source: Buffer, opcoes: { pasta?: string; lida?: boolean } = {}): number {
  const p = pasta(opcoes.pasta ?? 'INBOX');
  const uid = p.uidNext;
  p.uidNext += 1;
  p.msgs.push({ uid, flags: new Set(opcoes.lida ? ['\\Seen'] : []), source });
  return uid;
}

export function mensagensDa(nome = 'INBOX'): MensagemFalsa[] {
  return pasta(nome).msgs;
}

export function lida(uid: number, nome = 'INBOX'): boolean {
  return Boolean(pasta(nome).msgs.find((m) => m.uid === uid)?.flags.has('\\Seen'));
}

/** Uma e-mail RFC 822 com (ou sem) anexo XML. */
export function emailCru(input: {
  assunto: string;
  de?: string;
  anexo?: { nome: string; conteudo: string; tipo?: string };
}): Buffer {
  const cabecalho = [
    `From: ${input.de ?? 'Fornecedor <nfe@fornecedor.com.br>'}`,
    'To: notas@loja.com.br',
    `Subject: ${input.assunto}`,
    'Date: Tue, 01 Sep 2026 10:00:00 -0300',
    'MIME-Version: 1.0',
  ];
  if (!input.anexo) {
    return Buffer.from(
      [...cabecalho, 'Content-Type: text/plain; charset=utf-8', '', 'Promoção da semana.', ''].join(
        '\r\n',
      ),
    );
  }
  const b = `limite-${input.anexo.nome.replace(/\W/g, '')}`;
  return Buffer.from(
    [
      ...cabecalho,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Segue a nota fiscal.',
      `--${b}`,
      `Content-Type: ${input.anexo.tipo ?? 'application/xml'}; name="${input.anexo.nome}"`,
      `Content-Disposition: attachment; filename="${input.anexo.nome}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(input.anexo.conteudo).toString('base64'),
      `--${b}--`,
      '',
    ].join('\r\n'),
  );
}

type Faixa = number | string | number[] | Record<string, unknown>;

function uidsDaFaixa(faixa: string | number | number[]): number[] {
  if (Array.isArray(faixa)) return faixa.map(Number);
  return String(faixa)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

class ImapFlowFalso {
  mailbox: false | { path: string; uidValidity: bigint; exists: number; uidNext: number } = false;
  private aberta: string | null = null;

  constructor(config: Record<string, unknown>) {
    estadoImap.ultimaConfig = config;
  }

  private comando(nome: string): void {
    if (estadoImap.fetchEmCurso) {
      throw new Error(`deadlock: ${nome} dentro do laço do fetch`);
    }
    estadoImap.comandos.push(nome);
  }

  private atual(): PastaFalsa {
    if (!this.aberta) throw new Error('No mailbox selected');
    return pasta(this.aberta);
  }

  async connect(): Promise<void> {
    this.comando('LOGIN');
    if (estadoImap.falhaDeRede) {
      throw Object.assign(new Error(estadoImap.falhaDeRede), { code: 'ECONNREFUSED' });
    }
    if (estadoImap.falhaNoLogin) {
      throw Object.assign(new Error('Command failed'), {
        authenticationFailed: true,
        serverResponseCode: 'AUTHENTICATIONFAILED',
        response: estadoImap.falhaNoLogin,
      });
    }
    estadoImap.conexoes += 1;
  }

  async getMailboxLock(nome: string): Promise<{ release: () => void }> {
    this.comando(`SELECT ${nome}`);
    const p = pasta(nome);
    this.aberta = nome;
    this.mailbox = {
      path: nome,
      uidValidity: estadoImap.uidValidity,
      exists: p.msgs.length,
      uidNext: p.uidNext,
    };
    return { release: () => undefined };
  }

  async status(
    nome: string,
  ): Promise<{ path: string; messages: number; unseen: number; uidValidity: bigint }> {
    this.comando(`STATUS ${nome}`);
    const p = pasta(nome);
    return {
      path: nome,
      messages: p.msgs.length,
      unseen: p.msgs.filter((m) => !m.flags.has('\\Seen')).length,
      uidValidity: estadoImap.uidValidity,
    };
  }

  async search(consulta: Record<string, unknown>): Promise<number[]> {
    this.comando(`SEARCH ${JSON.stringify(consulta)}`);
    const msgs = [...this.atual().msgs].sort((a, b) => a.uid - b.uid);
    let saida = msgs;
    if (consulta.seen === false) saida = saida.filter((m) => !m.flags.has('\\Seen'));
    if (typeof consulta.uid === 'string') {
      const [inicioTxt, fimTxt] = consulta.uid.split(':');
      const inicio = Number(inicioTxt);
      const maior = msgs.length ? msgs[msgs.length - 1].uid : 0;
      const fim = fimTxt === '*' ? maior : Number(fimTxt);
      // `N:*` com N > maior UID vira `maior:N` — devolve a última mensagem.
      const [a, b] = inicio <= fim ? [inicio, fim] : [fim, inicio];
      saida = saida.filter((m) => m.uid >= a && m.uid <= b);
    }
    return saida.map((m) => m.uid);
  }

  async fetchAll(
    faixa: Faixa,
  ): Promise<{ uid: number; size: number }[]> {
    this.comando('FETCH (metadados)');
    const uids = new Set(uidsDaFaixa(faixa as string | number | number[]));
    return this.atual()
      .msgs.filter((m) => uids.has(m.uid) && !m.sumiu)
      .map((m) => ({ uid: m.uid, size: m.tamanho ?? m.source.length }));
  }

  async fetchOne(
    uid: string | number,
  ): Promise<false | { uid: number; source: Buffer; size: number }> {
    this.comando(`FETCH ${uid}`);
    const m = this.atual().msgs.find((x) => x.uid === Number(uid));
    if (!m || m.sumiu) return false;
    estadoImap.downloads.push(m.uid);
    // BODY.PEEK: baixar não marca como lida.
    return { uid: m.uid, source: m.source, size: m.tamanho ?? m.source.length };
  }

  /** O laço antigo: `fetch({ seen: false })` com BODY.PEEK. */
  async *fetch(
    faixa: Faixa,
  ): AsyncGenerator<{ uid: number; source: Buffer; envelope: Record<string, unknown> }> {
    this.comando(`FETCH ${JSON.stringify(faixa)}`);
    let msgs = [...this.atual().msgs].sort((a, b) => a.uid - b.uid);
    if (typeof faixa === 'object' && !Array.isArray(faixa) && faixa.seen === false) {
      msgs = msgs.filter((m) => !m.flags.has('\\Seen'));
    }
    estadoImap.fetchEmCurso = true;
    try {
      for (const m of msgs) {
        estadoImap.downloads.push(m.uid);
        yield { uid: m.uid, source: m.source, envelope: {} };
      }
    } finally {
      estadoImap.fetchEmCurso = false;
    }
  }

  async messageFlagsAdd(
    faixa: string | number | number[],
    flags: string[],
  ): Promise<boolean> {
    this.comando(`STORE ${String(faixa)} +FLAGS ${flags.join(' ')}`);
    if (estadoImap.somenteLeitura) throw new Error('STORE failed: mailbox is read-only');
    const uids = new Set(uidsDaFaixa(faixa));
    for (const m of this.atual().msgs) {
      if (uids.has(m.uid)) for (const f of flags) m.flags.add(f);
    }
    return true;
  }

  async messageMove(
    faixa: string | number | number[],
    destino: string,
  ): Promise<{ path: string; destination: string }> {
    this.comando(`MOVE ${String(faixa)} ${destino}`);
    const alvo = pasta(destino);
    const origem = this.atual();
    const uids = new Set(uidsDaFaixa(faixa));
    const movidas = origem.msgs.filter((m) => uids.has(m.uid));
    origem.msgs = origem.msgs.filter((m) => !uids.has(m.uid));
    for (const m of movidas) {
      alvo.msgs.push({ ...m, uid: alvo.uidNext, flags: new Set(m.flags) });
      alvo.uidNext += 1;
    }
    return { path: this.aberta ?? '', destination: destino };
  }

  async mailboxCreate(nome: string): Promise<{ path: string; created: boolean }> {
    this.comando(`CREATE ${nome}`);
    if (estadoImap.pastas.has(nome)) return { path: nome, created: false };
    estadoImap.pastas.set(nome, { uidNext: 1, msgs: [] });
    return { path: nome, created: true };
  }

  async logout(): Promise<void> {
    estadoImap.comandos.push('LOGOUT');
  }
}

/** O que o `vi.mock('imapflow', …)` devolve. */
export const moduloImapFalso = { ImapFlow: ImapFlowFalso };

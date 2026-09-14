/**
 * ============================================================================
 * O CARTEIRO EXISTE — rodada 49
 * ============================================================================
 *
 * A fila de e-mail estava pronta desde a rodada 38 — montagem no instante do
 * fato, dedupe, tela de gestão — e `flushEmailQueue` era um esboço honesto:
 * `sent: 0` sempre, nenhum transporte, nenhum UPDATE. O cliente confirmava a
 * conta, pagava, trocava a senha, e NADA chegava na caixa de entrada.
 *
 * Esta rodada liga o transporte de verdade (SMTP via nodemailer, credencial
 * só no ambiente) e enfileira os dois avisos que nem existiam: conta criada e
 * senha alterada. As regras que este arquivo trava:
 *
 *   - sem credencial, NADA muda — a fila acumula e nada é marcado como
 *     enviado (o princípio de sempre: não existe "fingir que mandou");
 *   - com credencial, o pendente SAI e o banco diz enviado, com hora;
 *   - falha de envio conta tentativa e guarda o motivo SEM a senha — o
 *     last_error aparece na tela do gestor, e tela vaza em print;
 *   - seis falhas espaçadas viram `failed` (GAP-PRD-038: antes eram cinco
 *     batidas seguidas), e o flush seguinte não insiste no morto;
 *   - criar conta enfileira o aviso nos DOIS caminhos (registro aberto e
 *     convite do balcão); trocar a senha enfileira nos DOIS caminhos (logado
 *     e pelo link de recuperação) — e nenhum corpo carrega senha ou token.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *   - tirando o UPDATE de enviado, o caso do envio fica com a fila pendente;
 *   - tirando a limpeza da senha do motivo, o caso do vazamento fica com a
 *     senha de aplicativo no last_error;
 *   - tirando o enfileiramento de `senha_alterada` do changePassword, o caso
 *     da troca logada não acha linha nenhuma.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  flushEmailQueue,
  queueEmail,
  startEmailFlushWorker,
  stopEmailFlushWorker,
  tickDoCarteiro,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import {
  pedirRecuperacaoSenha,
  redefinirSenhaComToken,
  registerCustomerAccount,
  registerWithInvite,
} from '../src/services/core/CustomerPortalService.js';
import { changePassword } from '../src/services/core/CustomerAccountService.js';

/**
 * O nodemailer é dublado NO IMPORT: `carteiroReal` o carrega por import
 * dinâmico, e sem este dublê as ~15 linhas de configuração (host, porta,
 * secure, requireTLS, auth, o shape do sendMail) ficariam com cobertura ZERO
 * — qualquer regressão ali só apareceria em produção como last_error.
 */
const { criarTransporte, sendMail, transporteExplode } = vi.hoisted(() => ({
  criarTransporte: vi.fn(),
  sendMail: vi.fn(),
  transporteExplode: { valor: false },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (config: unknown) => {
      criarTransporte(config);
      if (transporteExplode.valor) throw new Error('config quebrada');
      return { sendMail };
    },
  },
}));

const SENHA_DO_APP = 'senha-de-app-supersecreta';

const EMAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;
const originais = new Map<string, string | undefined>();

function comCredencial(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_HOST = 'smtp.gmail.com';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_PASSWORD = SENHA_DO_APP;
  resetEnvCacheForTests();
}

function semCredencial(): void {
  // Vazio, e não ausente: o `.env` do dono pode ter as chaves preenchidas, e
  // `loadDotEnvFiles` só escreve por cima de chave AUSENTE — string vazia
  // vence o arquivo. Sem isso, a suíte quebraria (ou pior: ENVIARIA e-mail
  // de verdade) no dia em que a credencial real entrasse no `.env`.
  for (const v of EMAIL_VARS) process.env[v] = '';
  // O interruptor é um enum ('true'|'false') — vazio não valida.
  process.env.EMAIL_ENABLED = 'false';
  resetEnvCacheForTests();
}

/** Carteiro dublado: grava o que enviaria; falha sob comando. */
function carteiroDublado(falha?: () => Error): CarteiroSmtp & { enviados: MensagemSmtp[] } {
  const enviados: MensagemSmtp[] = [];
  return {
    enviados,
    enviar(msg: MensagemSmtp): Promise<void> {
      if (falha) return Promise.reject(falha());
      enviados.push(msg);
      return Promise.resolve();
    },
  };
}

let gringa: string;

function enfileirar(dedupe = `fato-${randomUUID()}`): void {
  const id = queueEmail({
    companyId: gringa,
    template: 'pagamento_confirmado',
    toAddress: 'ana@exemplo.com',
    dedupeKey: dedupe,
    context: { storeName: 'Gringa', customerName: 'Ana', orderNumber: 7, totalCents: 12345 },
  });
  expect(id).toBeTruthy();
}

function filaCrua(): { status: string; attempts: number; last_error: string | null; sent_at: string | null; template: string; to_address: string; body_text: string; company_id: string }[] {
  return getConnection()
    .prepare('SELECT status, attempts, last_error, sent_at, template, to_address, body_text, company_id FROM core_email_queue ORDER BY created_at')
    .all() as unknown as { status: string; attempts: number; last_error: string | null; sent_at: string | null; template: string; to_address: string; body_text: string; company_id: string }[];
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  semCredencial();
  criarTransporte.mockClear();
  sendMail.mockReset();
  transporteExplode.valor = false;
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda', kind: 'retail' });
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const original = originais.get(v);
    if (original === undefined) delete process.env[v];
    else process.env[v] = original;
  }
  resetEnvCacheForTests();
});

for (const v of EMAIL_VARS) originais.set(v, process.env[v]);

describe('sem credencial, nada muda', () => {
  it('o flush não toca a fila e diz o que falta', async () => {
    enfileirar();
    const r = await flushEmailQueue();
    expect(r.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(r.sent).toBe(0);
    expect(r.missing).toContain('EMAIL_SMTP_HOST');
    expect(filaCrua()[0].status).toBe('pending');
  });
});

describe('com credencial, o pendente sai', () => {
  it('envia, marca enviado com hora, e o carteiro recebe a mensagem inteira', async () => {
    comCredencial();
    enfileirar('fato-a');
    enfileirar('fato-b');
    const carteiro = carteiroDublado();

    const r = await flushEmailQueue({ carteiro });
    expect(r.readiness).toBe('READY');
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(0);

    const linhas = filaCrua();
    expect(linhas).toHaveLength(2);
    for (const linha of linhas) {
      expect(linha.status).toBe('sent');
      expect(linha.sent_at).toBeTruthy();
      expect(linha.attempts).toBe(1);
    }

    expect(carteiro.enviados).toHaveLength(2);
    const msg = carteiro.enviados[0];
    expect(msg.from).toBe('grupo@sampaio.com.br');
    expect(msg.to).toBe('ana@exemplo.com');
    expect(msg.subject).toContain('pagamento do pedido #7 confirmado');
    expect(msg.text).toContain('preparando seus itens');
  });

  it('o que já saiu não sai duas vezes', async () => {
    comCredencial();
    enfileirar();
    const carteiro = carteiroDublado();
    await flushEmailQueue({ carteiro });
    await flushEmailQueue({ carteiro });
    expect(carteiro.enviados).toHaveLength(1);
  });

  it('dois flushes SOBREPOSTOS entregam UMA vez — quem chega junto recebe o flush em voo', async () => {
    /*
      A sobreposição real: o worker de 60 s preso no `await` do SMTP e o
      gerente clicando "Processar fila". Sem exclusão, o segundo SELECT via
      as MESMAS linhas ainda `pending` e o cliente recebia o aviso em dobro —
      inclusive o de "sua senha foi alterada", que duplicado vira ruído de
      segurança. O segundo chamador não dispara nada: recebe o RESULTADO do
      flush que já andava.
    */
    comCredencial();
    enfileirar();
    let soltar!: () => void;
    const preso = new Promise<void>((res) => {
      soltar = res;
    });
    const enviados: MensagemSmtp[] = [];
    const lento: CarteiroSmtp = {
      async enviar(msg: MensagemSmtp): Promise<void> {
        await preso;
        enviados.push(msg);
      },
    };
    const outro = carteiroDublado();

    const a = flushEmailQueue({ carteiro: lento });
    const b = flushEmailQueue({ carteiro: outro });
    soltar();
    const [ra, rb] = await Promise.all([a, b]);

    expect(enviados).toHaveLength(1);
    expect(outro.enviados).toHaveLength(0);
    expect(rb).toBe(ra);
    expect(filaCrua()[0].status).toBe('sent');
  });
});

describe('o carteiro real — nodemailer dublado no import', () => {
  it('porta 465 é TLS implícito, e o sendMail recebe a mensagem inteira', async () => {
    comCredencial();
    enfileirar();
    sendMail.mockResolvedValue({});

    // Sem carteiro injetado: o flush constrói o real — que cai no dublê.
    const r = await flushEmailQueue();
    expect(r.sent).toBe(1);

    expect(criarTransporte).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: 'grupo@sampaio.com.br', pass: SENHA_DO_APP },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'grupo@sampaio.com.br',
        to: 'ana@exemplo.com',
        subject: expect.stringContaining('pagamento do pedido #7'),
        text: expect.stringContaining('preparando seus itens'),
      }),
    );
  });

  it('fora da 465, requireTLS é OBRIGATÓRIO — downgrade vira erro, não senha no fio', async () => {
    /*
      Na 587 o STARTTLS do nodemailer é oportunista: um servidor (ou um
      homem-no-meio removendo a capability) sem STARTTLS deixaria o AUTH sair
      em texto claro — a senha de app em base64 reversível. `requireTLS`
      transforma o downgrade em erro duro.
    */
    comCredencial();
    process.env.EMAIL_SMTP_PORT = '587';
    resetEnvCacheForTests();
    enfileirar();
    sendMail.mockResolvedValue({});

    await flushEmailQueue();
    expect(criarTransporte).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it('transporte que nem constrói: o tick NÃO derruba nada e a fila fica como está', async () => {
    comCredencial();
    enfileirar();
    transporteExplode.valor = true;

    // O catch é DO TICK: a falha de construção escapa do flush (não é falha
    // de UMA mensagem) e o worker precisa sobreviver a ela batida após batida.
    await expect(tickDoCarteiro()).resolves.toBeUndefined();
    expect(filaCrua()[0].status).toBe('pending');
  });
});

describe('falha de envio', () => {
  it('conta a tentativa, guarda o motivo SEM a senha, e o e-mail espera a próxima', async () => {
    comCredencial();
    enfileirar();
    // O erro do provedor carrega a senha — acontece em erro de AUTH. O motivo
    // guardado vai para a tela do gestor, e tela vaza em print.
    const carteiro = carteiroDublado(
      () => new Error(`535 auth failed for password ${SENHA_DO_APP} (rede caiu)`),
    );

    const r = await flushEmailQueue({ carteiro });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0); // ainda não desistiu: volta a tentar.

    const [linha] = filaCrua();
    expect(linha.status).toBe('pending');
    expect(linha.attempts).toBe(1);
    expect(linha.last_error).toMatch(/rede caiu/);
    expect(linha.last_error).not.toContain(SENHA_DO_APP);
  });

  it('seis falhas ESPAÇADAS viram failed — e o flush seguinte não insiste no morto', async () => {
    /*
      Desde o GAP-PRD-038 a falha empurra a próxima tentativa (1, 5, 30, 120,
      720 min) e só a SEXTA desiste — antes eram cinco batidas seguidas, e
      cinco minutos de SMTP fora matavam a fila. O relógio é injetado: cada
      volta anda meio dia, mais que a maior espera.
    */
    comCredencial();
    enfileirar();
    const quebrado = carteiroDublado(() => new Error('rede caiu'));
    let agora = Date.now();
    for (let i = 0; i < 6; i += 1) {
      await flushEmailQueue({ carteiro: quebrado, agora: new Date(agora) });
      agora += 13 * 60 * 60 * 1000;
    }

    const [linha] = filaCrua();
    expect(linha.status).toBe('failed');
    expect(linha.attempts).toBe(6);

    const bom = carteiroDublado();
    const r = await flushEmailQueue({ carteiro: bom, agora: new Date(agora) });
    expect(r.sent).toBe(0);
    expect(bom.enviados).toHaveLength(0);
  });
});

describe('conta criada avisa por e-mail', () => {
  it('no registro aberto', async () => {
    await registerCustomerAccount({
      email: 'nova@exemplo.com',
      password: 'senha-forte-8',
      termsAccepted: true,
    });
    const avisos = filaCrua().filter((l) => l.template === 'conta_criada');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].to_address).toBe('nova@exemplo.com');
    expect(avisos[0].body_text).toMatch(/conta/i);
    // Nenhum segredo no corpo: nem a senha, nem hash.
    expect(avisos[0].body_text).not.toContain('senha-forte-8');
  });

  it('no resgate do convite do balcão — assinado pela empresa DO CONVITE', async () => {
    /*
      Com uma empresa só no banco, o fallback de `empresaParaEmailDaConta`
      (primeira ativa) coincidiria com a do convite e a atribuição errada
      passaria verde. A segunda empresa desfaz o disfarce: se o aviso sair
      pela "primeira ativa" em vez da empresa do convite, a asserção do
      company_id fica vermelha — e company_id decide em QUAL tela de gestor
      o e-mail aparece.
    */
    const conceito = upsertCompany({
      slug: 'conceito',
      tradeName: 'Conceito',
      legalName: 'Conceito Ltda',
      kind: 'retail',
    });
    const agora = new Date().toISOString();
    const clienteId = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
         VALUES (?, ?, 'Dona da Moto', 1, ?, ?)`,
      )
      .run(clienteId, conceito, agora, agora);

    await registerWithInvite({
      email: 'balcao@exemplo.com',
      password: 'senha-forte-8',
      customerId: clienteId,
      companyId: conceito,
      termsAccepted: true,
    });
    const avisos = filaCrua().filter((l) => l.template === 'conta_criada');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].to_address).toBe('balcao@exemplo.com');
    expect(avisos[0].company_id).toBe(conceito);
  });

  it('e-mail sem domínio: a conta NÃO nasce, o aviso não entra, e nada explode', async () => {
    /*
      Até o GAP-PRD-192, `registerCustomerAccount` só exigia o arroba e a
      conta nascia com um endereço que `isDeliverableAddress` recusava — sem
      aviso e sem código de confirmação, para sempre. Agora o cadastro exige
      e-mail sintaticamente válido (`PoliticaDoCadastro.emailValido`): a
      recusa vem antes de qualquer efeito, e a fila continua limpa.
    */
    await expect(
      registerCustomerAccount({
        email: 'ana@semdominio',
        password: 'senha-forte-8',
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ code: 'PORTAL_INVALID_EMAIL', status: 400 });
    const conta = getConnection()
      .prepare("SELECT id FROM core_customer_accounts WHERE email = 'ana@semdominio'")
      .get();
    expect(conta).toBeUndefined();
    expect(filaCrua().filter((l) => l.template === 'conta_criada')).toHaveLength(0);
  });
});

describe('senha alterada avisa por e-mail', () => {
  it('na troca logada — e o corpo não carrega a senha nova', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    await changePassword({
      accountId: sessao.account.id,
      currentSessionToken: sessao.token,
      currentPassword: 'senha-antiga-8',
      newPassword: 'senha-novissima-8',
    });
    const avisos = filaCrua().filter((l) => l.template === 'senha_alterada');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].to_address).toBe('ana@exemplo.com');
    expect(avisos[0].body_text).not.toContain('senha-novissima-8');
    expect(avisos[0].body_text).not.toContain('senha-antiga-8');
  });

  it('na redefinição pelo link — e o corpo não carrega o token', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    // O token real é gerado dentro de `pedirRecuperacaoSenha` e nunca sai do
    // e-mail. Para o teste, planta-se um reset com hash conhecido — o mesmo
    // SHA-256 do serviço.
    const token = 'token-de-teste-conhecido';
    getConnection()
      .prepare(
        `INSERT INTO core_customer_password_resets
           (id, account_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        randomUUID(),
        sessao.account.id,
        createHash('sha256').update(token).digest('hex'),
        new Date(Date.now() + 3_600_000).toISOString(),
        new Date().toISOString(),
      );

    await redefinirSenhaComToken({ token, password: 'senha-do-link-8' });

    const avisos = filaCrua().filter((l) => l.template === 'senha_alterada');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].body_text).not.toContain(token);
    expect(avisos[0].body_text).not.toContain('senha-do-link-8');
  });

  it('pedir a recuperação NÃO avisa "senha alterada" — nada mudou ainda', async () => {
    await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    pedirRecuperacaoSenha('ana@exemplo.com');
    expect(filaCrua().filter((l) => l.template === 'senha_alterada')).toHaveLength(0);
    expect(filaCrua().filter((l) => l.template === 'recuperacao_senha')).toHaveLength(1);
  });
});

describe('o worker de fundo', () => {
  it('o tick entrega quando a credencial existe', async () => {
    comCredencial();
    enfileirar();
    const carteiro = carteiroDublado();
    await tickDoCarteiro(carteiro);
    expect(carteiro.enviados).toHaveLength(1);
    expect(filaCrua()[0].status).toBe('sent');
  });

  it('o tick sem credencial não toca em nada — a fila acumula, que é o certo', async () => {
    enfileirar();
    const carteiro = carteiroDublado();
    await tickDoCarteiro(carteiro);
    expect(carteiro.enviados).toHaveLength(0);
    expect(filaCrua()[0].status).toBe('pending');
  });

  it('ligar entrega já na subida — sem esperar o primeiro minuto', async () => {
    /*
      O servidor pode ter passado a noite desligado com fila acumulada: o
      worker entrega JÁ na subida (`void tickDoCarteiro()` antes do
      setInterval). Relógio real de propósito — o dublê de timers do vitest
      não convive com o import dinâmico do vite-node, e o que este caso
      protege é o tick imediato, não a cadência de 60 s (que é uma linha de
      setInterval, coberta por leitura).
    */
    comCredencial();
    enfileirar();
    sendMail.mockResolvedValue({});
    try {
      startEmailFlushWorker();
      await vi.waitFor(() => {
        expect(sendMail).toHaveBeenCalledTimes(1);
      });
      expect(filaCrua()[0].status).toBe('sent');
    } finally {
      stopEmailFlushWorker();
    }
  });
});

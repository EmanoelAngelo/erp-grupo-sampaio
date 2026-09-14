/**
 * Identidade do cliente no portal.
 *
 * TRÊS DECISÕES QUE MOLDAM TUDO AQUI
 *
 * 1. IDENTIDADE NÃO É CADASTRO COMERCIAL. `core_customers` é por operação: o
 *    mesmo CPF na Gringa e no Preço Justo são dois cadastros, porque são duas
 *    empresas com CNPJ próprio. A PESSOA é uma só, e é ela que entra. Por isso
 *    a conta vive em tabela própria, com o e-mail como identidade, e se liga a
 *    quantos cadastros forem dela.
 *
 * 2. CLIENTE NÃO É OPERADOR. A sessão do portal fica em
 *    `core_customer_sessions`, separada de `api_sessions`, com token OPACO.
 *    Um token de cliente não pode ser aceito onde se espera um token
 *    administrativo — e o contrário seria pior ainda, porque daria escopo de
 *    PDV ou de gerente a quem só comprou uma jaqueta.
 *
 * 3. SENHA, E NÃO CÓDIGO POR E-MAIL. O sistema não tem canal de envio de
 *    e-mail — só leitura de caixa para importar NF-e. Código temporário ou
 *    magic link nasceriam sem como chegar ao cliente, o que é auth pela
 *    metade. A senha usa o mesmo Argon2id do acesso administrativo, e o mesmo
 *    controle de tentativas.
 *
 * A LIMITAÇÃO QUE FECHOU NA RODADA 50: com o carteiro da rodada 49, o
 * cadastro passou a confirmar a titularidade do e-mail por CÓDIGO — e a
 * confirmação ganhou um dente: o vínculo dos pedidos pela CO-PROVA
 * (e-mail + documento digitados) só nasce DEPOIS que o código volta.
 * Antes disso, quem CONHECESSE o e-mail (público) e o CPF (semi-público)
 * de outra pessoa recebia na hora o histórico de compras dela.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword, verifyPassword, wasteVerificationTime } from '../auth/PasswordService.js';
import {
  clearLoginAttempts,
  countRecentFailures,
  isLockedOut,
  recordLoginAttempt,
} from '../auth/IdentityService.js';
import {
  queueContaCriadaEmail,
  queuePasswordResetEmail,
  queueSenhaAlteradaEmail,
  queueVerificacaoEmail,
} from '../notifications/EmailService.js';
import { publicBaseUrl } from './PrintRenderer.js';
import { linkDeRastreio, nomeDaTransportadora } from '../logistics/RastreioPublico.js';
import { rastreioParaCliente } from '../logistics/RastreioDoCliente.js';
import { exigirEmailValido, exigirSenhaForte, NOME_MAX, nomeDaPessoa } from './PoliticaDoCadastro.js';
import { consumirLimite, tetosDoPortal } from './PortalLimiteService.js';
import { diaDaLoja } from './CalendarioOperacional.js';
import { somarDiasUteis } from './DiasUteis.js';

/**
 * A SESSÃO DESLIZA (GAP-PRD-193).
 *
 * Uma hora SEM USO derruba a sessão — curto porque o portal guarda pedido,
 * endereço e documento. Mas era uma hora FIXA desde o login: a conta caía no
 * meio da navegação, com o carrinho montado. Agora cada uso empurra o
 * vencimento para uma hora dali (`resolveCustomerSession`), com escrita no
 * banco no máximo a cada 5 minutos, até o TETO de 24 horas desde o login —
 * aba esquecida aberta não vira sessão eterna.
 */
const SESSION_TTL_MS = 60 * 60 * 1000;
export const SESSAO_ABSOLUTA_MS = 24 * 60 * 60 * 1000;
const RENOVAR_A_CADA_MS = 5 * 60 * 1000;

export interface CustomerAccount {
  id: string;
  email: string;
  /** Nulo = ainda não provou a caixa de entrada (rodada 50). */
  emailVerifiedAt: string | null;
}

export interface CustomerSession {
  token: string;
  expiresAt: string;
  account: CustomerAccount;
  /** Cadastros ligados a esta conta, um por operação onde comprou. */
  customers: { customerId: string; companyId: string; companyName: string }[];
}

function normalizeEmail(bruto: string): string {
  return String(bruto ?? '').trim().toLowerCase();
}

function onlyDigits(bruto: string): string {
  return String(bruto ?? '').replace(/\D/g, '');
}

/**
 * Chave usada no controle de tentativas.
 *
 * Prefixada para não se confundir com o login administrativo: um cliente
 * errando a senha não pode travar o operador de mesmo nome, nem o contrário.
 */
function attemptKey(email: string): string {
  return `portal:${email}`;
}

function listLinks(accountId: string): CustomerSession['customers'] {
  return getConnection()
    .prepare(
      `SELECT l.customer_id AS customerId, l.company_id AS companyId,
              c.trade_name AS companyName
         FROM core_customer_account_links l
         JOIN core_companies c ON c.id = l.company_id
        WHERE l.account_id = ?
        ORDER BY c.trade_name`,
    )
    .all(accountId) as unknown as CustomerSession['customers'];
}

/**
 * Liga a conta aos cadastros que são PROVADAMENTE da mesma pessoa.
 *
 * Um cliente que comprou na Gringa e no Preço Justo tem dois cadastros; ele
 * precisa ver os dois sem precisar de duas contas. O vínculo é recalculado a
 * cada login porque uma compra nova pode ter criado um cadastro em outra
 * operação depois. Esta função só INSERE: vínculo que existe continua.
 *
 * AS TRÊS PROVAS (GAP-PRD-006), cada uma gravada em `proof`:
 *
 *   'coprova'   — o cadastro carrega o e-mail PROVADO desta conta E um
 *                 documento que a conta alcança (o informado agora, ou o de
 *                 um cadastro já vinculado). Cadastro por cadastro: o
 *                 documento só traz o cadastro que também carrega o e-mail.
 *   'documento' — o documento que alguém da LOJA escreveu alcança os
 *                 cadastros com o mesmo documento nas outras operações. Vale
 *                 o documento de um vínculo de CONVITE (o papel entregue no
 *                 balcão) e o de um cadastro feito NO BALCÃO
 *                 (`origin = 'balcao'`). É assim que a dona da moto,
 *                 cadastrada sem e-mail na PJ Motors, vê a moto pela conta.
 *   'email'     — com a caixa provada e NENHUM documento alcançado, os
 *                 cadastros SEM documento que têm aquele e-mail.
 *
 * O QUE DEIXOU DE VALER, E POR QUÊ. Até aqui o documento de QUALQUER cadastro
 * vinculado se propagava ao grupo inteiro. Só que o cadastro que o checkout
 * público cria carrega um CPF DIGITADO — por quem quer que fosse. A auditoria
 * reproduziu: o atacante compra na Gringa (onde a vítima não tem cadastro) com
 * o CPF dela e o próprio e-mail, abre conta com os dois, prova a própria caixa
 * — e a propagação ligava a conta dele ao cadastro da vítima no Preço Justo,
 * na Oficina, em todo lugar. CPF digitado não é prova; o balcão é.
 *
 * Consequência aceita e declarada: quem só tem cadastro criado pela loja
 * online não alcança, pelo documento, o cadastro de balcão SEM e-mail de
 * outra operação — traz pelo convite do balcão. Os PEDIDOS da loja online não
 * dependem disto: eles são da conta que os fechou, ou do e-mail provado que
 * foi digitado neles (ver `filtroDoDono`).
 */
function syncLinks(
  accountId: string,
  email: string,
  documento?: string | null,
  /*
    SEM A CAIXA PROVADA, NADA PELO E-MAIL (rodada 50) — e, desde o GAP-PRD-006,
    nada pela co-prova também: e-mail + documento só provam alguma coisa
    quando o e-mail é da pessoa. Quem ainda não provou fica com o que o
    convite deu e com o que o balcão escreveu.
  */
  emailProvado = false,
): void {
  const db = getConnection();
  const agora = new Date().toISOString();
  const emailNormalizado = normalizeEmail(email);
  const inserir = db.prepare(
    `INSERT INTO core_customer_account_links
       (id, account_id, customer_id, company_id, created_at, proof)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, customer_id) DO NOTHING`,
  );
  const ligar = (linhas: { id: string; company_id: string }[], prova: string) => {
    for (const c of linhas) inserir.run(randomUUID(), accountId, c.id, c.company_id, agora, prova);
  };
  const emLista = (valores: string[]) => valores.map(() => '?').join(', ');

  // 1. Co-prova: documento alcançado E e-mail provado, no MESMO cadastro.
  const declarados = new Set<string>();
  const informado = onlyDigits(documento ?? '');
  if (informado) declarados.add(informado);
  for (const linha of db
    .prepare(
      `SELECT DISTINCT c.document AS document
         FROM core_customer_account_links l
         JOIN core_customers c ON c.id = l.customer_id
        WHERE l.account_id = ? AND c.document IS NOT NULL AND TRIM(c.document) <> ''`,
    )
    .all(accountId) as unknown as { document: string }[]) {
    declarados.add(linha.document);
  }
  const docsDeclarados = [...declarados];
  if (docsDeclarados.length > 0 && emailProvado && emailNormalizado) {
    ligar(
      db
        .prepare(
          // `IN ()` é erro de sintaxe no SQLite — por isso o `if` acima.
          `SELECT id, company_id FROM core_customers
            WHERE active = 1 AND LOWER(TRIM(email)) = ?
              AND document IN (${emLista(docsDeclarados)})`,
        )
        .all(emailNormalizado, ...docsDeclarados) as unknown as { id: string; company_id: string }[],
      'coprova',
    );
  }

  // 2. O documento que a LOJA escreveu alcança as outras operações.
  const confiaveis = (
    db
      .prepare(
        `SELECT DISTINCT c.document AS document
           FROM core_customer_account_links l
           JOIN core_customers c ON c.id = l.customer_id
          WHERE l.account_id = ?
            AND (l.proof IN ('convite', 'documento') OR c.origin = 'balcao')
            AND c.document IS NOT NULL AND TRIM(c.document) <> ''`,
      )
      .all(accountId) as unknown as { document: string }[]
  ).map((l) => l.document);
  if (confiaveis.length > 0) {
    ligar(
      db
        .prepare(
          `SELECT id, company_id FROM core_customers
            WHERE active = 1 AND document IN (${emLista(confiaveis)})`,
        )
        .all(...confiaveis) as unknown as { id: string; company_id: string }[],
      'documento',
    );
  }

  /*
    3. E-mail provado, só para quem não alcança documento NENHUM — e só
       cadastro sem documento. Quem TEM documento é identificado por ele, e
       o e-mail não compete com o documento (rodada 17): o cadastro de outra
       pessoa que o balcão preencheu com o meu e-mail, sem CPF, fica de fora.
  */
  if (docsDeclarados.length === 0 && confiaveis.length === 0 && emailProvado && emailNormalizado) {
    ligar(
      db
        .prepare(
          `SELECT id, company_id FROM core_customers
            WHERE active = 1 AND LOWER(TRIM(email)) = ?
              AND (document IS NULL OR TRIM(document) = '')`,
        )
        .all(emailNormalizado) as unknown as { id: string; company_id: string }[],
      'email',
    );
  }
}

function abrirSessao(account: CustomerAccount): CustomerSession {
  const db = getConnection();
  // Token opaco: 32 bytes de aleatoriedade. Não há nada no token para a loja
  // ler — quem resolve é o servidor.
  const token = randomBytes(32).toString('base64url');
  const expiraEm = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO core_customer_sessions (id, account_id, expires_at, revoked, created_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(token, account.id, expiraEm, new Date().toISOString());
  db.prepare('UPDATE core_customer_accounts SET last_login_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    account.id,
  );
  return { token, expiresAt: expiraEm, account, customers: listLinks(account.id) };
}

/** Resposta única para credencial inválida — não revela se a conta existe. */
function credencialInvalida(): ApiError {
  return new ApiError(
    'PORTAL_INVALID_CREDENTIALS',
    'E-mail ou senha inválidos.',
    401,
  );
}

/**
 * Cria o acesso ao portal.
 *
 * Exige e-mail E documento que batam com um cadastro de cliente existente:
 * sem confirmação por e-mail, é o que se pode pedir como prova de que a pessoa
 * comprou. Não é o CPF servindo de senha — a senha é escolhida por ela; o
 * documento é só a prova de matrícula.
 */
/**
 * O portão do consentimento (LGPD, rodada 45).
 *
 * SÓ o booleano true vale: 'true' em string, 1, objeto truthy — nada disso
 * é um clique consciente no aceite; é cliente de API mal escrito, e conta
 * criada sem consentimento real é passivo jurídico, não cadastro.
 */
export function exigirAceiteDosTermos(valor: unknown): void {
  if (valor !== true) {
    throw new ApiError(
      'PORTAL_TERMS_REQUIRED',
      'Para criar a conta é preciso aceitar os Termos de Uso e a Política de Privacidade.',
      400,
    );
  }
}

/**
 * O que o cadastro manual confere ANTES de qualquer efeito (GAP-PRD-192).
 *
 * O "contém @" e os 8 caracteres de antes deixavam nascer conta com
 * 'ana@exemplo' e '12345678'. Agora: e-mail sintaticamente válido, nome de
 * pessoa quando veio (em branco ou longo demais é recusado — não se grava
 * lixo), e a senha pela política única (`PoliticaDoCadastro`).
 *
 * O NOME É OPCIONAL NA API, OBRIGATÓRIO NA TELA. A tela de criar conta pede
 * e manda sempre; o servidor aceita o corpo sem ele para não quebrar quem
 * já chama a rota (o convite do balcão, clientes de API) — e a conta sem
 * nome não compra: o checkout cobra o nome no fechamento
 * (`camposQueFaltam`).
 */
function conferirCadastro(input: {
  email: unknown;
  password: unknown;
  name?: unknown;
}): { email: string; nome: string | null } {
  const email = exigirEmailValido(input.email);
  let nome: string | null = null;
  if (input.name !== undefined && input.name !== null) {
    nome = nomeDaPessoa(input.name);
    if (!nome) {
      throw new ApiError(
        'PORTAL_INVALID_NAME',
        `Informe seu nome (até ${NOME_MAX} caracteres).`,
        400,
      );
    }
  }
  exigirSenhaForte(input.password, { email });
  return { email, nome };
}

export async function registerCustomerAccount(input: {
  email: string;
  /** Opcional desde a rodada 38: sem ele, a conta nasce vazia. */
  document?: string;
  password: string;
  /** O aceite dos termos e da política — exigido desde a rodada 45. */
  termsAccepted?: unknown;
  /** O nome da pessoa (GAP-PRD-192) — guardado na conta. */
  name?: unknown;
  /**
   * De onde veio o pedido (`req.ip`). Presente, conta no teto de cadastros
   * por origem (`PortalLimiteService`). As rotas sempre passam.
   */
  origem?: string | null;
}): Promise<CustomerSession> {
  ensureCoreSchema();
  exigirAceiteDosTermos(input.termsAccepted);
  const { email, nome } = conferirCadastro(input);
  const documento = onlyDigits(input.document ?? '');

  // O teto conta só o que passou da validação: a tentativa com senha fraca
  // não cria nada nem revela nada, e a pessoa que erra não perde a vez. A
  // de e-mail JÁ CADASTRADO conta — a 409 diz quem tem conta.
  consumirLimite({
    acao: 'cadastro',
    origem: input.origem,
    maximo: tetosDoPortal().cadastrosPorOrigemHora,
  });

  const db = getConnection();
  if (db.prepare('SELECT id FROM core_customer_accounts WHERE email = ?').get(email)) {
    throw new ApiError(
      'PORTAL_ACCOUNT_EXISTS',
      'Já existe acesso para este e-mail. Use "entrar".',
      409,
    );
  }

  /*
    CRIAR A CONTA É ABERTO; VINCULAR UM CADASTRO CONTINUA EXIGINDO A CO-PROVA.

    Até a rodada 38, o registro EXIGIA e-mail + documento no mesmo cadastro
    existente — sem uma compra anterior, ninguém criava conta. O banco tinha
    zero contas e um cliente elegível: o portal nascia inacessível.

    Agora a conta nasce só com e-mail e senha. O que NÃO afrouxou é o que puxa
    os pedidos de alguém: `syncLinks` só é chamado quando há a CO-PROVA — um
    cadastro com ESTE e-mail E ESTE documento juntos. Saber só o CPF (que é
    semi-público) não basta: sem o e-mail que foi usado com ele, não há
    cadastro que co-bata, e a conta nasce vazia. Quem comprou vincula na hora,
    informando o documento; quem não informou vincula depois (`vincularPorDocumento`).

    Documento que não co-bate NÃO é erro: a conta é criada mesmo assim, vazia.
    Recusar aqui recriaria a barreira que esta rodada existe para tirar.
  */
  const coBate = documento
    ? (db
        .prepare(
          'SELECT id FROM core_customers WHERE active = 1 AND LOWER(TRIM(email)) = ? AND document = ? LIMIT 1',
        )
        .get(email, documento) as { id: string } | undefined)
    : undefined;

  const hash = await hashPassword(input.password);
  const id = randomUUID();
  const agora = new Date().toISOString();

  return withTransaction(() => {
    db.prepare(
      `INSERT INTO core_customer_accounts
         (id, email, password_hash, accepted_terms_at, name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      // O MOMENTO do aceite é a prova que a LGPD pede — gravado no nascimento.
      // O nome nasce NA CONTA (GAP-PRD-192), onde o perfil o lê (GAP-PRD-133).
    ).run(id, email, hash, agora, nome, agora, agora);
    /*
      A CO-PROVA NÃO VINCULA MAIS NA HORA (rodada 50).

      E-mail + documento no mesmo cadastro provam que a pessoa CONHECE os
      dois dados — não que é dona da caixa de entrada. O e-mail é público e
      o CPF é semi-público: com os dois de outra pessoa, o registro antigo
      entregava na hora o histórico de compras dela. O documento co-provado
      fica guardado no código de verificação, e o vínculo nasce em
      `confirmarEmail` — quando o código que foi PARA AQUELA CAIXA voltar.
    */
    criarVerificacao(id, email, coBate ? documento : null);
    // O dono do e-mail fica sabendo que a conta nasceu — inclusive se não
    // foi ele quem a criou (rodada 49).
    const companyId = empresaParaEmailDaConta(id);
    if (companyId) {
      queueContaCriadaEmail({ companyId, toAddress: email, dedupeKey: `conta_criada:${id}` });
    }
    return abrirSessao({ id, email, emailVerifiedAt: null });
  });
}

/**
 * Vincula à conta os cadastros que co-batem o documento informado.
 *
 * É o "claim" de quem criou a conta aberta e depois quer trazer os pedidos que
 * fez como visitante, ou os cadastros que já tinha. A CO-PROVA é a mesma do
 * registro: precisa existir um cadastro com o e-mail DESTA conta E o documento
 * informado juntos. Sem isso, não vincula — informar o CPF de outra pessoa não
 * traz os pedidos dela, porque o e-mail não confere.
 *
 * Devolve quantos vínculos a conta passou a ter (para a tela dizer se achou).
 */
export function vincularPorDocumento(input: {
  accountId: string;
  document: string;
}): { linked: number; novos: number } {
  ensureCoreSchema();
  const documento = onlyDigits(input.document);
  const db = getConnection();

  const conta = db
    .prepare(
      'SELECT email, email_verified_at FROM core_customer_accounts WHERE id = ? AND active = 1',
    )
    .get(input.accountId) as { email: string; email_verified_at: string | null } | undefined;
  if (!conta) throw new ApiError('PORTAL_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);

  // A mesma regra do registro (rodada 50): documento digitado só puxa
  // pedidos para uma caixa de entrada PROVADA. Sem a prova, e-mail alheio +
  // CPF alheio entregariam o histórico de outra pessoa.
  if (!conta.email_verified_at) {
    throw new ApiError(
      'PORTAL_EMAIL_NAO_VERIFICADO',
      'Confirme seu e-mail antes de vincular compras pelo documento — o código está na sua caixa de entrada.',
      403,
    );
  }

  const coBate = documento
    ? db
        .prepare(
          'SELECT id FROM core_customers WHERE active = 1 AND LOWER(TRIM(email)) = ? AND document = ? LIMIT 1',
        )
        .get(conta.email, documento)
    : undefined;

  // Quantos NASCERAM agora — é o que a tela diz. O total sozinho mentia: a
  // conta que já tinha um vínculo (da compra logada) lia "vinculados" mesmo
  // quando o documento não trouxe nada.
  const antes = listLinks(input.accountId).length;
  if (coBate) {
    withTransaction(() => syncLinks(input.accountId, conta.email, documento, true));
  }
  const depois = listLinks(input.accountId).length;
  return { linked: depois, novos: depois - antes };
}

/**
 * Cria a conta a partir do CONVITE entregue no balcão.
 *
 * ## Por que este caminho precisa existir
 *
 * `registerCustomerAccount` exige e-mail E documento no MESMO cadastro. O
 * cliente de oficina é cadastrado no balcão com nome e telefone — `email` é
 * nulo — então ele nunca passaria por lá. Sem este caminho o portal nasce
 * inacessível para exatamente quem ele serve.
 *
 * O convite é a outra prova: um código que só quem estava no balcão recebeu.
 *
 * ## O QUE ESTA FUNÇÃO NÃO FAZ, E É O PONTO
 *
 * Ela NÃO chama `syncLinks`, e a omissão é deliberada.
 *
 * `syncLinks` liga a conta a todo cadastro do GRUPO cujo e-mail ou documento
 * casem — sem filtro de empresa. No registro comum isso é seguro, porque para
 * chegar lá a pessoa já provou e-mail + documento de um cadastro existente.
 * Aqui não há essa prova: o e-mail é escolhido por quem resgata e ninguém o
 * verifica. Passar por `syncLinks` significaria que, de posse de um papel do
 * balcão, eu me registro com o e-mail de outra pessoa e recebo os cadastros
 * dela em todas as operações do grupo.
 *
 * O convite insere UM vínculo: o do cliente que ele nomeia. E não escreve
 * `core_customers.email` — o cadastro fiscal não é alterado por quem resgatou.
 */
export async function registerWithInvite(input: {
  email: string;
  password: string;
  customerId: string;
  companyId: string;
  /** O convite troca a co-prova, não o consentimento. */
  termsAccepted?: unknown;
  /** O nome digitado; sem ele, vale o do cadastro que a LOJA fez no balcão. */
  name?: unknown;
  /** Nome do cadastro do convite — escrito pela loja, não por quem resgata. */
  nomeDoCadastro?: string | null;
  /** De onde veio o pedido — conta no teto de cadastros (GAP-PRD-192). */
  origem?: string | null;
}): Promise<CustomerSession> {
  ensureCoreSchema();
  exigirAceiteDosTermos(input.termsAccepted);
  const { email, nome } = conferirCadastro(input);
  consumirLimite({
    acao: 'cadastro',
    origem: input.origem,
    maximo: tetosDoPortal().cadastrosPorOrigemHora,
  });

  const db = getConnection();
  if (db.prepare('SELECT id FROM core_customer_accounts WHERE email = ?').get(email)) {
    throw new ApiError(
      'PORTAL_ACCOUNT_EXISTS',
      'Já existe acesso para este e-mail. Entre na conta e use o código lá dentro.',
      409,
    );
  }

  const hash = await hashPassword(input.password);
  const id = randomUUID();
  const agora = new Date().toISOString();

  return withTransaction(() => {
    db.prepare(
      `INSERT INTO core_customer_accounts
         (id, email, password_hash, accepted_terms_at, name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      // O MOMENTO do aceite é a prova que a LGPD pede — gravado no nascimento.
    ).run(id, email, hash, agora, nome ?? nomeDaPessoa(input.nomeDoCadastro), agora, agora);
    // UM vínculo, o do convite. Sem syncLinks.
    db.prepare(
      `INSERT INTO core_customer_account_links
         (id, account_id, customer_id, company_id, created_at, proof)
       VALUES (?, ?, ?, ?, ?, 'convite')`,
    ).run(randomUUID(), id, input.customerId, input.companyId, agora);
    // O aviso de nascimento (rodada 49) — aqui a empresa é a do convite.
    queueContaCriadaEmail({
      companyId: input.companyId,
      toAddress: email,
      dedupeKey: `conta_criada:${id}`,
    });
    // O código também sai (rodada 50) — mas SEM co-prova pendente: o papel
    // do balcão já é a prova deste único vínculo, que nasceu acima.
    criarVerificacao(id, email, null);
    return abrirSessao({ id, email, emailVerifiedAt: null });
  });
}

export async function loginCustomer(input: {
  email: string;
  password: string;
  ip?: string | null;
}): Promise<CustomerSession> {
  ensureCoreSchema();
  const email = normalizeEmail(input.email);
  const chave = attemptKey(email);

  // Por par (chave + origem), como no login do ERP desde a rodada 34: sem a
  // origem, o teto seria só o alto, e oito erros de um celular não travariam.
  if (isLockedOut(chave, input.ip)) {
    throw new ApiError(
      'PORTAL_LOCKED_OUT',
      'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      429,
    );
  }

  const conta = getConnection()
    .prepare(
      'SELECT id, email, password_hash, active, email_verified_at, has_password FROM core_customer_accounts WHERE email = ?',
    )
    .get(email) as
    | {
        id: string;
        email: string;
        password_hash: string;
        active: number;
        email_verified_at: string | null;
        has_password: number;
      }
    | undefined;

  /*
    CONTA SEM SENHA (GAP-PRD-027) — a que nasceu pelo "Entrar com Google" —
    recebe a MESMA resposta de credencial inválida, depois do mesmo tempo
    gasto: dizer "esta conta entra pelo Google" contaria a quem digita um
    e-mail qualquer que ele tem conta aqui. A tela de entrar avisa, para
    todo mundo, que quem criou a conta pelo Google entra pelo botão.
  */
  if (!conta || conta.active !== 1 || Number(conta.has_password) === 0) {
    // Gasta o mesmo tempo de uma verificação real: sem isso, a diferença de
    // resposta diz quais e-mails têm conta.
    await wasteVerificationTime();
    recordLoginAttempt(chave, input.ip ?? null, false);
    throw credencialInvalida();
  }

  const resultado = await verifyPassword(input.password, conta.password_hash);
  if (!resultado.valid) {
    recordLoginAttempt(chave, input.ip ?? null, false);
    throw credencialInvalida();
  }

  recordLoginAttempt(chave, input.ip ?? null, true);
  clearLoginAttempts(chave);
  // Sem documento a passar: a conta não guarda nenhum. `syncLinks` descobre os
  // documentos que ela JÁ alcança pelos vínculos existentes — é assim que a
  // compra nova feita no balcão, num cadastro sem e-mail, chega até aqui.
  // O ramo do e-mail só vale se a caixa provou dona; o do documento (cliente
  // de balcão, via convite) segue valendo sempre — ver `syncLinks`.
  syncLinks(conta.id, conta.email, null, Boolean(conta.email_verified_at));
  return abrirSessao({
    id: conta.id,
    email: conta.email,
    emailVerifiedAt: conta.email_verified_at,
  });
}

/**
 * Resolve o token de sessão.
 *
 * Sessão expirada ou revogada NÃO é sessão. A checagem é por consulta, não
 * por confiança no que o cliente mandou.
 */
export function resolveCustomerSession(token: string | undefined | null): {
  account: CustomerAccount;
  customerIds: string[];
  /** O vencimento DEPOIS da renovação deslizante. */
  expiresAt: string;
  /** O teto: 24 h desde o login (GAP-PRD-193). */
  absoluteExpiresAt: string;
} | null {
  ensureCoreSchema();
  if (!token) return null;

  const linha = getConnection()
    .prepare(
      `SELECT s.account_id, s.expires_at, s.revoked, s.created_at, a.email, a.active,
              a.email_verified_at
         FROM core_customer_sessions s
         JOIN core_customer_accounts a ON a.id = s.account_id
        WHERE s.id = ?`,
    )
    .get(token) as
    | {
        account_id: string;
        expires_at: string;
        revoked: number;
        created_at: string;
        email: string;
        active: number;
        email_verified_at: string | null;
      }
    | undefined;

  if (!linha || linha.revoked === 1 || linha.active !== 1) return null;
  const agora = Date.now();
  const vence = new Date(linha.expires_at).getTime();
  if (vence <= agora) return null;

  /*
    RENOVAÇÃO DESLIZANTE (GAP-PRD-193): o uso empurra o vencimento para uma
    hora dali, sem passar do teto de 24 h desde o login. Só escreve se o
    ganho for de 5 minutos ou mais — cada clique não vira um UPDATE.
  */
  const teto = new Date(linha.created_at).getTime() + SESSAO_ABSOLUTA_MS;
  const novoVencimento = Math.min(agora + SESSION_TTL_MS, teto);
  let expiresAt = linha.expires_at;
  if (novoVencimento - vence >= RENOVAR_A_CADA_MS) {
    expiresAt = new Date(novoVencimento).toISOString();
    getConnection()
      .prepare('UPDATE core_customer_sessions SET expires_at = ? WHERE id = ? AND revoked = 0')
      .run(expiresAt, token);
  }

  return {
    account: {
      id: linha.account_id,
      email: linha.email,
      emailVerifiedAt: linha.email_verified_at,
    },
    customerIds: listLinks(linha.account_id).map((l) => l.customerId),
    expiresAt,
    absoluteExpiresAt: new Date(teto).toISOString(),
  };
}

/**
 * A porta de quem PROVOU a identidade por fora — o "Entrar com Google"
 * (GAP-PRD-027).
 *
 * O Google entrega um e-mail com `email_verified`: é a mesma prova de caixa
 * que o código de 6 dígitos dá, e quem chama já gravou `email_verified_at`.
 * Daqui para a frente é a entrada comum: os vínculos se recalculam com o
 * e-mail PROVADO (inclusive a co-prova que esperava a verificação, como no
 * `confirmarEmail`), e a sessão nasce do mesmo jeito da do login por senha —
 * token opaco, uma hora, em `core_customer_sessions`.
 *
 * Não confere credencial nenhuma: quem chama É a conferência (id_token
 * verificado). Por isso não é rota, e só `GoogleLoginService` a usa.
 */
export function abrirSessaoPorIdentidadeProvada(accountId: string): CustomerSession {
  ensureCoreSchema();
  const conta = getConnection()
    .prepare(
      'SELECT id, email, active, email_verified_at FROM core_customer_accounts WHERE id = ?',
    )
    .get(accountId) as
    | { id: string; email: string; active: number; email_verified_at: string | null }
    | undefined;
  if (!conta || conta.active !== 1) {
    throw new ApiError('PORTAL_CONTA_INATIVA', 'Esta conta está desativada. Fale com a loja.', 403);
  }
  return withTransaction(() => {
    const provado = Boolean(conta.email_verified_at);
    const pendente = provado ? coProvaPendente(conta.id) : null;
    syncLinks(conta.id, conta.email, pendente, provado);
    if (pendente) {
      // A co-prova que esperava a caixa foi usada: o código dela não vale mais.
      getConnection()
        .prepare(
          'UPDATE core_customer_email_verifications SET used_at = ? WHERE account_id = ? AND used_at IS NULL',
        )
        .run(new Date().toISOString(), conta.id);
    }
    return abrirSessao({
      id: conta.id,
      email: conta.email,
      emailVerifiedAt: conta.email_verified_at,
    });
  });
}

/** Encerra só a sessão do portal — não toca em carrinho, pedido ou cadastro. */
export function logoutCustomer(token: string | undefined | null): void {
  ensureCoreSchema();
  if (!token) return;
  getConnection()
    .prepare('UPDATE core_customer_sessions SET revoked = 1 WHERE id = ?')
    .run(token);
}

/**
 * Sai de todos os OUTROS dispositivos — mantém a sessão atual.
 *
 * "Segurança" da conta: quem desconfia que a sessão vazou (um computador
 * público onde esqueceu de sair) derruba as outras sem perder a que está
 * usando. Trocar a senha já faz isso; este caminho existe para quem só quer
 * cortar as outras sessões sem mexer na senha.
 */
export function revogarOutrasSessoes(accountId: string, tokenAtual: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare('UPDATE core_customer_sessions SET revoked = 1 WHERE account_id = ? AND id <> ?')
    .run(accountId, tokenAtual);
}

// --------------------------------------------------- recuperação de senha

/** Uma hora. Link de senha que dura o dia é link que vaza no histórico. */
const RESET_TTL_MS = 60 * 60 * 1000;

function hashDoToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A empresa que "assina" os e-mails da CONTA. Grupo, não operação.
 *
 * Exportada desde a rodada 49: o aviso de senha alterada da troca logada
 * (`CustomerAccountService.changePassword`) precisa da mesma resposta.
 */
export function empresaParaEmailDaConta(accountId: string): string | null {
  const db = getConnection();
  const vinculada = db
    .prepare('SELECT company_id FROM core_customer_account_links WHERE account_id = ? LIMIT 1')
    .get(accountId) as { company_id: string } | undefined;
  if (vinculada) return vinculada.company_id;
  // Conta aberta, sem vínculo ainda: qualquer operação serve de remetente —
  // o corpo do e-mail diz "Grupo Sampaio", não o nome da loja.
  const qualquer = db
    .prepare('SELECT id FROM core_companies WHERE active = 1 ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined;
  return qualquer?.id ?? null;
}

// --------------------------------------------- verificação do e-mail (r50)

/** O código vale por uma hora — o mesmo prazo do link de recuperação. */
const VERIFICACAO_TTL_MS = 60 * 60 * 1000;
/** Teto de códigos por hora: reenvio é botão, e botão apanha clique. */
const MAX_CODIGOS_POR_HORA = 3;

function gerarCodigoDeVerificacao(): string {
  // `randomInt` é CSPRNG e sem viés de módulo. Seis dígitos, com zeros à
  // esquerda: um código é coisa que se digita do celular olhando o e-mail.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Cria e envia UM código de verificação.
 *
 * `linkDocument` é a co-prova do registro esperando a prova do e-mail: o
 * vínculo dos pedidos só nasce quando o código voltar (`confirmarEmail`).
 * Guarda-se o SHA-256 do código, nunca o código — mesmo molde do reset.
 */
function criarVerificacao(accountId: string, email: string, linkDocument: string | null): void {
  const db = getConnection();
  const recentes = db
    .prepare(
      `SELECT COUNT(*) AS c FROM core_customer_email_verifications
        WHERE account_id = ? AND created_at > ?`,
    )
    .get(accountId, new Date(Date.now() - VERIFICACAO_TTL_MS).toISOString()) as { c: number };
  if (recentes.c >= MAX_CODIGOS_POR_HORA) {
    throw new ApiError(
      'PORTAL_VERIFICACAO_LIMITE',
      'Muitos códigos pedidos. Use o último que chegou — ele vale por 1 hora.',
      429,
    );
  }

  const agora = new Date().toISOString();
  // SÓ O ÚLTIMO CÓDIGO VALE. Cada novo invalida os pendentes anteriores da
  // conta (rodada 50): sem isto, com o teto de 3/hora havia até três códigos
  // válidos ao mesmo tempo — três alvos por palpite, triplicando a chance da
  // força bruta. Um código de cada vez é o padrão de todo reenvio.
  db.prepare(
    `UPDATE core_customer_email_verifications
        SET used_at = ?
      WHERE account_id = ? AND used_at IS NULL`,
  ).run(agora, accountId);

  const codigo = gerarCodigoDeVerificacao();
  db.prepare(
    `INSERT INTO core_customer_email_verifications
       (id, account_id, code_hash, link_document, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    randomUUID(),
    accountId,
    hashDoToken(codigo),
    linkDocument,
    new Date(Date.now() + VERIFICACAO_TTL_MS).toISOString(),
    agora,
  );

  const companyId = empresaParaEmailDaConta(accountId);
  if (companyId) {
    queueVerificacaoEmail({
      companyId,
      toAddress: email,
      codigo,
      // O dedupe inclui a CONTA: dois códigos de 6 dígitos de contas
      // diferentes podem colidir (espaço 10^6), e a UNIQUE global de
      // `dedupe_key` faria o segundo e-mail NÃO ser enfileirado — aquela
      // conta ficaria sem código. Com o account_id, cada conta tem o seu.
      dedupeKey: `verificacao:${accountId}:${hashDoToken(codigo)}`,
    });
  }
}

/** O documento da co-prova que ainda espera o código — se houver. */
function coProvaPendente(accountId: string): string | null {
  const linha = getConnection()
    .prepare(
      `SELECT link_document FROM core_customer_email_verifications
        WHERE account_id = ? AND used_at IS NULL AND link_document IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(accountId) as { link_document: string } | undefined;
  return linha?.link_document ?? null;
}

/**
 * Reenvia o código — carregando junto a co-prova pendente, se houver: o
 * código que expirou não pode levar embora o vínculo que esperava por ele.
 */
export function pedirVerificacaoEmail(accountId: string): { alreadyVerified: boolean } {
  ensureCoreSchema();
  const conta = getConnection()
    .prepare(
      'SELECT email, email_verified_at FROM core_customer_accounts WHERE id = ? AND active = 1',
    )
    .get(accountId) as { email: string; email_verified_at: string | null } | undefined;
  if (!conta) throw new ApiError('PORTAL_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);
  if (conta.email_verified_at) return { alreadyVerified: true };

  criarVerificacao(accountId, conta.email, coProvaPendente(accountId));
  return { alreadyVerified: false };
}

/**
 * Teto de palpites de código POR CONTA, apertado de propósito (rodada 50).
 *
 * O lockout do login tem dois tetos: 5 por par (login+origem) e 50 por login
 * de qualquer origem. Aqueles números são calibrados para o modelo do login,
 * onde o dono é a VÍTIMA e o teto por conta é frouxo para não trancar o
 * gerente no sábado. Aqui o modelo se inverte: quem adivinha o código É o
 * dono da conta (registrou com o e-mail do alvo) e troca de origem à vontade,
 * então o teto por origem nunca morde e o de 50/15min sozinho deixaria ~200
 * palpites/hora. Com um teto próprio e baixo — e só UM código válido de cada
 * vez (`criarVerificacao` invalida os anteriores) — a força bruta do código
 * de 6 dígitos deixa de ser viável.
 */
const MAX_PALPITES_DE_CODIGO = 8;

/**
 * O código voltou: o e-mail provou dono.
 *
 * É AQUI que a co-prova do registro vira vínculo — nunca antes. Código errado
 * conta tentativa no controle por CONTA; errar demais tranca por uns minutos,
 * não para sempre.
 */
export function confirmarEmail(input: {
  accountId: string;
  codigo: string;
  ip?: string | null;
}): void {
  ensureCoreSchema();
  const db = getConnection();
  const chave = `verificacao:${input.accountId}`;
  // Teto POR CONTA, e apertado — ver `MAX_PALPITES_DE_CODIGO`. O `isLockedOut`
  // por origem entra junto (trava o aparelho que insiste), mas não é o que
  // segura o atacante que roda de IP.
  if (
    countRecentFailures(chave) >= MAX_PALPITES_DE_CODIGO ||
    isLockedOut(chave, input.ip)
  ) {
    throw new ApiError(
      'PORTAL_LOCKED_OUT',
      'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      429,
    );
  }

  const conta = db
    .prepare('SELECT email FROM core_customer_accounts WHERE id = ? AND active = 1')
    .get(input.accountId) as { email: string } | undefined;
  if (!conta) throw new ApiError('PORTAL_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);

  const linha = db
    .prepare(
      `SELECT id, link_document, expires_at FROM core_customer_email_verifications
        WHERE account_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .get(input.accountId, hashDoToken(String(input.codigo ?? '').trim())) as
    | { id: string; link_document: string | null; expires_at: string }
    | undefined;

  if (!linha || new Date(linha.expires_at).getTime() < Date.now()) {
    recordLoginAttempt(chave, input.ip ?? null, false);
    throw new ApiError(
      'PORTAL_CODIGO_INVALIDO',
      'Código inválido ou vencido. Peça um novo pela tela da conta.',
      400,
    );
  }

  const agora = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      `UPDATE core_customer_accounts
          SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(agora, agora, input.accountId);
    db.prepare('UPDATE core_customer_email_verifications SET used_at = ? WHERE id = ?').run(
      agora,
      linha.id,
    );
    // A co-prova esperava por isto: agora — e só agora — os pedidos chegam.
    if (linha.link_document) {
      syncLinks(input.accountId, conta.email, linha.link_document, true);
    }
  });
  clearLoginAttempts(chave);
}

/**
 * Pede a recuperação de senha.
 *
 * NUNCA revela se o e-mail existe — responder diferente para conta ausente é
 * dizer a um atacante quais e-mails têm conta. Existindo, gera um token de uso
 * único (guarda-se o SHA-256, nunca o token) e enfileira o e-mail com o link.
 * O e-mail fica na fila até haver SMTP.
 *
 * OS TETOS (GAP-PRD-116). Dez pedidos seguidos geravam dez e-mails e dez
 * links vivos ao mesmo tempo — qualquer pessoa bombardeava a caixa de
 * qualquer cliente, e a reputação do remetente da loja pagava. No molde do
 * código de verificação (rodada 50):
 *
 *   - por ORIGEM, 10 pedidos por hora, qualquer e-mail → 429. Não revela
 *     nada: conta requisições, exista a conta ou não;
 *   - por CONTA, pedido repetido em menos de 2 minutos não gera outro link,
 *     e no máximo 3 links por hora. Estes somem em SILÊNCIO, com a mesma
 *     resposta de sempre — um 429 aqui diria a quem digita um e-mail
 *     qualquer que aquela conta existe;
 *   - cada link novo INVALIDA os anteriores ainda não usados: só o último
 *     vale, como só o último código vale.
 */
const REENVIO_MINIMO_MS = 2 * 60 * 1000;

export function pedirRecuperacaoSenha(email: string, opcoes: { origem?: string | null } = {}): void {
  ensureCoreSchema();
  const tetos = tetosDoPortal();
  consumirLimite({
    acao: 'recuperacao',
    origem: opcoes.origem,
    maximo: tetos.recuperacoesPorOrigemHora,
  });
  const normalizado = normalizeEmail(email);
  const db = getConnection();
  const conta = db
    .prepare('SELECT id, email FROM core_customer_accounts WHERE email = ? AND active = 1')
    .get(normalizado) as { id: string; email: string } | undefined;
  if (!conta) return; // silêncio proposital: sem enumeração.

  const agoraMs = Date.now();
  const recentes = db
    .prepare(
      `SELECT created_at FROM core_customer_password_resets
        WHERE account_id = ? AND created_at > ?
        ORDER BY created_at DESC`,
    )
    .all(conta.id, new Date(agoraMs - RESET_TTL_MS).toISOString()) as { created_at: string }[];
  // Clique duplo / impaciência: o link de agora há pouco ainda está a caminho.
  if (recentes[0] && agoraMs - new Date(recentes[0].created_at).getTime() < REENVIO_MINIMO_MS) {
    return;
  }
  // Teto da hora: silêncio, com a mesma resposta (sem enumeração).
  if (recentes.length >= tetos.recuperacoesPorContaHora) return;

  const token = randomBytes(32).toString('base64url');
  const agora = new Date(agoraMs).toISOString();
  withTransaction(() => {
    // SÓ O ÚLTIMO LINK VALE: os pendentes da conta morrem aqui.
    db.prepare(
      `UPDATE core_customer_password_resets
          SET used_at = ?
        WHERE account_id = ? AND used_at IS NULL`,
    ).run(agora, conta.id);
    db.prepare(
      `INSERT INTO core_customer_password_resets
         (id, account_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(
      randomUUID(),
      conta.id,
      hashDoToken(token),
      new Date(agoraMs + RESET_TTL_MS).toISOString(),
      agora,
    );
  });

  const companyId = empresaParaEmailDaConta(conta.id);
  if (companyId) {
    queuePasswordResetEmail({
      companyId,
      toAddress: conta.email,
      resetLink: `${publicBaseUrl()}/redefinir-senha?token=${token}`,
      // Um pedido por token: o dedupe é o próprio token, então cada pedido
      // enfileira o seu, e pedir de novo não sobrescreve o anterior.
      dedupeKey: `reset:${hashDoToken(token)}`,
    });
  }
}

/**
 * Redefine a senha a partir do token do e-mail.
 *
 * O token vale UMA vez e por pouco tempo. Redefinir DERRUBA todas as sessões:
 * se a senha foi trocada porque vazou, as sessões abertas com a senha antiga
 * não podem continuar valendo.
 */
export async function redefinirSenhaComToken(input: {
  token: string;
  password: string;
}): Promise<void> {
  ensureCoreSchema();
  // A política de senha (GAP-PRD-192) antes de olhar o token: a regra que
  // não depende de quem é a conta responde igual para qualquer link.
  exigirSenhaForte(input.password);
  const db = getConnection();
  const linha = db
    .prepare(
      `SELECT r.id, r.account_id, r.expires_at, r.used_at, a.email
         FROM core_customer_password_resets r
         JOIN core_customer_accounts a ON a.id = r.account_id
        WHERE r.token_hash = ?`,
    )
    .get(hashDoToken(input.token)) as
    | { id: string; account_id: string; expires_at: string; used_at: string | null; email: string }
    | undefined;

  if (!linha || linha.used_at || new Date(linha.expires_at).getTime() < Date.now()) {
    throw new ApiError(
      'PORTAL_RESET_INVALID',
      'Este link de recuperação não vale mais. Peça um novo.',
      400,
    );
  }
  // O e-mail como senha só se confere com o link já válido. A recusa não
  // gasta o link: com uma senha boa, ele continua valendo.
  exigirSenhaForte(input.password, { email: linha.email });

  const hash = await hashPassword(input.password);
  const agora = new Date().toISOString();
  withTransaction(() => {
    // A conta que entrava só pelo Google passa a ter senha também
    // (GAP-PRD-027): o link foi para a caixa que o Google já provou.
    db.prepare(
      'UPDATE core_customer_accounts SET password_hash = ?, has_password = 1, updated_at = ? WHERE id = ?',
    ).run(hash, agora, linha.account_id);
    db.prepare('UPDATE core_customer_password_resets SET used_at = ? WHERE id = ?').run(agora, linha.id);
    // A senha mudou: nenhuma sessão antiga continua.
    db.prepare('UPDATE core_customer_sessions SET revoked = 1 WHERE account_id = ?').run(
      linha.account_id,
    );
    /*
      O link foi PARA a caixa e VOLTOU: isso prova o e-mail tanto quanto o
      código (rodada 50). Vale como verificação — e destrava a co-prova que
      estivesse esperando, pelo mesmo caminho do `confirmarEmail`.
    */
    db.prepare(
      `UPDATE core_customer_accounts
          SET email_verified_at = COALESCE(email_verified_at, ?)
        WHERE id = ?`,
    ).run(agora, linha.account_id);
    // E o dono do e-mail fica sabendo — se não foi ele, reage agora
    // (rodada 49). O corpo não carrega token nem senha.
    const conta = db
      .prepare('SELECT email FROM core_customer_accounts WHERE id = ?')
      .get(linha.account_id) as { email: string } | undefined;
    const companyId = empresaParaEmailDaConta(linha.account_id);
    if (conta && companyId) {
      queueSenhaAlteradaEmail({
        companyId,
        toAddress: conta.email,
        dedupeKey: `senha_alterada:${linha.account_id}:${agora}`,
      });
    }
    // A co-prova que esperava a verificação destrava aqui também.
    const pendente = coProvaPendente(linha.account_id);
    if (conta && pendente) {
      // O link do e-mail provou a caixa (email_verified_at acima).
      syncLinks(linha.account_id, conta.email, pendente, true);
    }
  });
}

// ------------------------------------------------------- pedidos do cliente

/**
 * Rótulos em português dos estados que existem de verdade.
 *
 * Nenhum estado foi criado para melhorar texto: a lista é a mesma de
 * `FULFILLMENT_STATUSES` mais os de pagamento. Estado desconhecido volta como
 * veio — inventar tradução esconderia um estado novo que ninguém mapeou.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  aguardando_pagamento: 'Aguardando pagamento',
  pago: 'Pagamento confirmado',
  separacao: 'Em separação',
  conferencia: 'Em conferência',
  embalado: 'Embalado',
  expedido: 'Enviado',
  pronto_para_retirada: 'Pronto para retirada',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  reembolsado: 'Reembolsado',
  pagamento_apos_cancelamento: 'Pagamento recebido após o cancelamento',
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Aguardando pagamento',
  confirmed: 'Pago',
  overdue: 'Vencido',
  refunded: 'Estornado',
  chargeback: 'Contestado',
  cancelled: 'Cancelada',
  failed: 'Falhou',
  paid_after_cancel: 'Recebido após o cancelamento',
  unconfigured: 'Pagamento online indisponível',
};

export interface CustomerOrderRow {
  id: string;
  number: number;
  storeName: string;
  createdAt: string;
  totalCents: number;
  status: string;
  statusLabel: string;
  paymentStatus: string | null;
  paymentStatusLabel: string | null;
  paymentMethod: string | null;
  deliveryMethod: string;
  trackingCode: string | null;
  trackingUrl: string | null;
  carrierName: string | null;
}

/**
 * DE QUEM É UM PEDIDO DA LOJA ONLINE (GAP-PRD-006/043).
 *
 * Era "de qualquer conta ligada ao cadastro do cliente" — e o cadastro é
 * achado pelo CPF DIGITADO no checkout. Quem soubesse o CPF de alguém
 * fabricava o vínculo e passava a ler e CANCELAR os pedidos dessa pessoa; e o
 * cliente novo que comprava logado não via o próprio pedido, porque o checkout
 * não ligava nada à conta.
 *
 * Agora o pedido pertence a quem PROVOU que o fez:
 *
 *   - à CONTA que o fechou (`customer_account_id`) — só a ela, mesmo que o
 *     cadastro fiscal do pedido esteja ligado a outra conta;
 *   - ou, no pedido de visitante (sem conta), ao dono do E-MAIL digitado nele,
 *     desde que a conta tenha PROVADO essa caixa. É para esse endereço que o
 *     pedido já mandou o recibo, o PIX e cada mudança de estado: a conta que
 *     prova a caixa não lê nada que já não tenha recebido.
 *
 * Conta que ainda não provou a caixa vê só o que ela mesma fechou.
 */
function filtroDoDono(dono: CustomerAccount): { sql: string; params: (string | number)[] } {
  const email = normalizeEmail(dono.email);
  const provado = dono.emailVerifiedAt && email ? 1 : 0;
  return {
    sql: `(o.customer_account_id = ?
           OR (o.customer_account_id IS NULL AND ? = 1
               AND o.customer_email IS NOT NULL AND LOWER(TRIM(o.customer_email)) = ?))`,
    params: [dono.id, provado, email],
  };
}

/**
 * Pedidos da PESSOA, de todas as operações onde ela comprou.
 *
 * O dono vem da SESSÃO, nunca de parâmetro. Aceitar um id do cliente
 * permitiria ler o pedido de qualquer um só trocando o número na URL — que é
 * exatamente o furo que este portal existe para não ter. A regra de quem é
 * dono está em `filtroDoDono`.
 */
export function listCustomerOrders(dono: CustomerAccount): CustomerOrderRow[] {
  ensureCoreSchema();
  const filtro = filtroDoDono(dono);
  const linhas = getConnection()
    .prepare(
      `SELECT o.id, o.number, o.created_at, o.total_cents, o.status, o.payment_method,
              o.shipping_method, o.tracking_code, o.shipping_carrier, c.trade_name AS store_name,
              (SELECT p.status FROM core_payment_intents p
                WHERE p.origin_type = 'ecommerce_order' AND p.origin_id = o.id
                ORDER BY p.created_at DESC LIMIT 1) AS payment_status
         FROM core_orders o
         JOIN core_companies c ON c.id = o.company_id
        WHERE ${filtro.sql}
        ORDER BY o.created_at DESC`,
    )
    .all(...filtro.params) as unknown as Record<string, unknown>[];

  return linhas.map((r) => ({
    id: String(r.id),
    number: Number(r.number),
    storeName: String(r.store_name),
    createdAt: String(r.created_at),
    totalCents: Number(r.total_cents),
    status: String(r.status),
    statusLabel: ORDER_STATUS_LABEL[String(r.status)] ?? String(r.status),
    paymentStatus: (r.payment_status as string | null) ?? null,
    paymentStatusLabel: r.payment_status
      ? (PAYMENT_STATUS_LABEL[String(r.payment_status)] ?? String(r.payment_status))
      : null,
    paymentMethod: (r.payment_method as string | null) ?? null,
    deliveryMethod: isPickupMethod(r.shipping_method as string | null) ? 'retirada' : 'entrega',
    trackingCode: (r.tracking_code as string | null) ?? null,
    // O link da transportadora (GAP-PRD-119): o código sozinho mandava o
    // cliente adivinhar em que site procurar.
    trackingUrl: linkDeRastreio(r.shipping_carrier as string | null, r.tracking_code as string | null),
    carrierName: nomeDaTransportadora(r.shipping_carrier as string | null),
  }));
}

function isPickupMethod(metodo: string | null): boolean {
  const m = (metodo ?? '').toLowerCase();
  return m === 'retirada' || m === 'pickup';
}

/**
 * O prazo que o cliente lê no acompanhamento.
 *
 * TRÊS ESTADOS, E NENHUM DELES É UM CHUTE
 *
 *   `prometido`  — há prazo cotado E o pedido já foi expedido: dá para dizer
 *                  a data. É o único caso em que uma data aparece na tela.
 *   `previsto`   — há prazo, mas a encomenda ainda não saiu. Contar a partir
 *                  de hoje seria prometer uma data que a separação ainda pode
 *                  atrasar; então diz-se o prazo, não a data.
 *   `sem_prazo`  — ninguém cotou nada. A tela diz isso, em vez de inventar.
 *
 * `real` distingue prazo de transportadora de prazo da tabela da loja. Os dois
 * podem ser mostrados — ambos foram prometidos por alguém —, mas a origem
 * acompanha, porque "o Correios disse" e "a loja estimou" não valem o mesmo.
 */
export interface DeliveryEstimate {
  kind: 'prometido' | 'previsto' | 'sem_prazo';
  days: number | null;
  /**
   * Só em `prometido`: o DIA de calendário da loja (AAAA-MM-DD) — nunca um
   * instante, que a tela converteria de novo e poderia recuar um dia.
   */
  dueDate: string | null;
  real: boolean;
}

/** Etapas em que a encomenda já saiu da loja. */
const JA_SAIU = new Set(['expedido', 'entregue']);

export function deliveryEstimate(input: {
  status: string;
  estimatedDays: number | null;
  quoteReal: boolean;
  dispatchedAt: string | null;
}): DeliveryEstimate {
  const dias = input.estimatedDays;
  if (dias === null || !Number.isFinite(dias) || dias <= 0) {
    return { kind: 'sem_prazo', days: null, dueDate: null, real: input.quoteReal };
  }

  if (JA_SAIU.has(input.status) && input.dispatchedAt) {
    /*
      A contagem começa na POSTAGEM, que é o que a transportadora promete — no
      DIA DA LOJA (GAP-PRD-196). Antes ela usava `getDay()` do fuso do
      processo: num servidor em UTC, a expedição das 21h30 de quinta já era
      sexta, o fim de semana entrava no meio e a data pulava para segunda.
      Dia útil: sem fim de semana nem feriado nacional — somar dias corridos
      anteciparia a promessa em quase uma semana no pior caso. Prazo
      fracionado de transportadora arredonda para cima: prometer depois, nunca
      antes.
    */
    return {
      kind: 'prometido',
      days: dias,
      dueDate: somarDiasUteis(diaDaLoja(input.dispatchedAt), Math.ceil(dias)),
      real: input.quoteReal,
    };
  }

  return { kind: 'previsto', days: dias, dueDate: null, real: input.quoteReal };
}

/**
 * Detalhe de UM pedido — só se ele for da pessoa autenticada.
 *
 * Devolve `null` quando não é dela. A rota transforma isso em 404: dizer
 * "existe, mas você não pode ver" já entrega que o pedido existe. É esta a
 * porta do CANCELAMENTO pelo portal também — a regra é uma só (`filtroDoDono`).
 */
export function getCustomerOrder(
  dono: CustomerAccount,
  orderId: string,
): Record<string, unknown> | null {
  ensureCoreSchema();
  const db = getConnection();
  const filtro = filtroDoDono(dono);

  const pedido = db
    .prepare(
      `SELECT o.*, c.trade_name AS store_name, c.slug AS store_slug
         FROM core_orders o
         JOIN core_companies c ON c.id = o.company_id
        WHERE o.id = ? AND ${filtro.sql}`,
    )
    .get(orderId, ...filtro.params) as Record<string, unknown> | undefined;
  if (!pedido) return null;

  const itens = db
    .prepare(
      `SELECT i.description, i.quantity, i.unit_price_cents, i.total_cents,
              i.discount_cents, p.image_url
         FROM core_order_items i
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE i.order_id = ?`,
    )
    .all(orderId) as unknown as Record<string, unknown>[];

  // A cobrança vem do que está GRAVADO. Buscar o QR no provedor a cada
  // abertura da tela seria latência para o cliente e consumo de limite por
  // um dado que não muda enquanto a cobrança existir.
  const pagamentos = db
    .prepare(
      `SELECT method, status, qr_payload, invoice_url, amount_cents, created_at
         FROM core_payment_intents
        WHERE origin_type = 'ecommerce_order' AND origin_id = ?
        ORDER BY created_at`,
    )
    .all(orderId) as unknown as Record<string, unknown>[];

  const eventos = db
    .prepare(
      'SELECT status, note, origin, created_at FROM core_order_events WHERE order_id = ? ORDER BY created_at',
    )
    .all(orderId) as unknown as Record<string, unknown>[];

  return {
    id: pedido.id,
    number: pedido.number,
    storeName: pedido.store_name,
    storeSlug: pedido.store_slug,
    createdAt: pedido.created_at,
    status: pedido.status,
    statusLabel: ORDER_STATUS_LABEL[String(pedido.status)] ?? pedido.status,
    itemsCents: pedido.items_cents,
    // O cupom (GAP-PRD-123): `itemsCents` já é líquido dele; o bruto dos itens
    // é itemsCents + discountCents. Zero e nulo = pedido sem cupom.
    discountCents: Number(pedido.discount_cents ?? 0),
    couponCode: pedido.coupon_code ?? null,
    shippingCents: pedido.shipping_cents,
    totalCents: pedido.total_cents,
    deliveryMethod: isPickupMethod(pedido.shipping_method as string | null)
      ? 'retirada'
      : 'entrega',
    shippingZip: pedido.shipping_zip,
    shippingAddress: pedido.shipping_address,
    /*
      O RETRATO EM CAMPOS (GAP-PRD-115): para onde vai e quem recebe; e em
      nome de quem e de onde a nota sai. Nulo = pedido sem endereço salvo
      (visitante, endereço digitado, ou anterior à regra) — aí vale a linha
      \`shippingAddress\`.
    */
    shippingAddressDetail: pedido.shipping_street
      ? {
          recipientName: pedido.shipping_recipient_name ?? null,
          street: pedido.shipping_street,
          number: pedido.shipping_number ?? null,
          complement: pedido.shipping_complement ?? null,
          district: pedido.shipping_district ?? null,
          city: pedido.shipping_city ?? null,
          state: pedido.shipping_state ?? null,
          zip: pedido.shipping_zip ?? null,
          cityIbge: pedido.shipping_city_ibge ?? null,
        }
      : null,
    billingAddress: pedido.billing_street
      ? {
          name: pedido.billing_name ?? null,
          street: pedido.billing_street,
          number: pedido.billing_number ?? null,
          complement: pedido.billing_complement ?? null,
          district: pedido.billing_district ?? null,
          city: pedido.billing_city ?? null,
          state: pedido.billing_state ?? null,
          zip: pedido.billing_zip ?? null,
          cityIbge: pedido.billing_city_ibge ?? null,
        }
      : null,
    shippingServiceName: pedido.shipping_service_name ?? null,
    trackingCode: pedido.tracking_code,
    /*
      O RASTREIO DE VERDADE (GAP-PRD-119): quem leva, o link da página pública
      da transportadora e os eventos que o PROVEDOR informou — com a falha da
      última consulta dita, quando houve. Era só o código em texto. Abrir esta
      tela não chama o provedor: lê o que a última consulta gravou.
    */
    shippingCarrier: pedido.shipping_carrier ?? null,
    carrierName: nomeDaTransportadora(pedido.shipping_carrier as string | null),
    trackingUrl: linkDeRastreio(pedido.shipping_carrier as string | null, pedido.tracking_code as string | null),
    tracking: rastreioParaCliente(String(pedido.id)),
    // A data de expedição sai da LINHA DO TEMPO, não de um campo à parte:
    // é o mesmo instante que o cliente vê no histórico, e assim o prazo não
    // pode divergir do que a tela já mostra.
    deliveryEstimate: deliveryEstimate({
      status: String(pedido.status),
      estimatedDays:
        pedido.shipping_estimated_days === null || pedido.shipping_estimated_days === undefined
          ? null
          : Number(pedido.shipping_estimated_days),
      quoteReal: Number(pedido.shipping_quote_real ?? 0) === 1,
      dispatchedAt:
        (eventos.find((e) => String(e.status) === 'expedido')?.created_at as string | undefined)
        ?? null,
    }),
    customer: {
      name: pedido.customer_name,
      email: pedido.customer_email,
      // Documento mascarado: o cliente confere os últimos dígitos sem que a
      // tela exponha o número inteiro.
      document: maskDocument(pedido.customer_document as string | null),
    },
    items: itens.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      // A parte do cupom desta linha (GAP-PRD-123); totalCents já é líquido.
      discountCents: Number(i.discount_cents ?? 0),
      imageUrl: i.image_url ?? null,
    })),
    payments: pagamentos.map((p) => ({
      method: p.method,
      status: p.status,
      statusLabel: PAYMENT_STATUS_LABEL[String(p.status)] ?? p.status,
      amountCents: p.amount_cents,
      pixPayload: p.qr_payload ?? null,
      invoiceUrl: p.invoice_url ?? null,
    })),
    timeline: eventos.map((e) => ({
      status: e.status,
      statusLabel: ORDER_STATUS_LABEL[String(e.status)] ?? e.status,
      note: e.note ?? null,
      // Quem disse: "entregue" pela transportadora e "entregue" pela loja não
      // valem o mesmo. Nulo = evento anterior ao registro da origem.
      origin: e.origin ?? null,
      createdAt: e.created_at,
    })),
  };
}

/** Mostra só os últimos dígitos: confere sem expor. */
function maskDocument(documento: string | null): string | null {
  const digitos = onlyDigits(documento ?? '');
  if (digitos.length < 4) return null;
  return `••• ${digitos.slice(-4)}`;
}

/*
  Aqui existiu um `recentFailuresFor` cujo comentário prometia "para a tela
  avisar antes de travar" — tela nenhuma jamais chamou. Saiu com a promessa
  junto: avisar quantas tentativas restam é dizer ao atacante quanto ele ainda
  pode tentar, e a recusa com trava já conta a verdade a quem errou de boa fé.
*/

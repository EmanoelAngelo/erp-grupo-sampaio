/**
 * A conta do cliente: endereços salvos e troca de senha.
 *
 * Separado de `CustomerPortalService` porque aquele arquivo responde por
 * IDENTIDADE (quem é, entrou, saiu) e este por CADASTRO (onde mora, qual
 * senha). Misturar os dois faria o arquivo de autenticação crescer com
 * assuntos que não são dele.
 *
 * O ENDEREÇO É DA CONTA, NÃO DO CADASTRO POR OPERAÇÃO
 *
 * A pessoa mora num lugar só. Se o endereço pertencesse ao cadastro de cada
 * empresa, comprar na Gringa e no Preço Justo exigiria digitar tudo duas
 * vezes, e mudar de casa em um lugar deixaria o outro entregando no endereço
 * antigo.
 *
 * O pedido continua guardando o endereço COPIADO no momento da compra. É
 * deliberado: mudar de casa não pode reescrever para onde um pedido antigo foi
 * entregue.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword, verifyPassword, wasteVerificationTime } from '../auth/PasswordService.js';
import { queueSenhaAlteradaEmail } from '../notifications/EmailService.js';
import { empresaParaEmailDaConta } from './CustomerPortalService.js';
import { isValidCpf } from './CatalogService.js';
import { isValidCnpj } from './FiscalConfigService.js';
import { exigirSenhaForte, nomeDaPessoa } from './PoliticaDoCadastro.js';
import { CODIGO_DA_UF, conferirMunicipio, porQueNaoConfere } from './MunicipiosIbge.js';

function onlyDigits(bruto: string): string {
  return String(bruto ?? '').replace(/\D/g, '');
}

/**
 * PARA QUE O ENDEREÇO SERVE (GAP-PRD-115).
 *
 * 'entrega'     — para onde a mercadoria vai;
 * 'faturamento' — o endereço do destinatário da NOTA;
 * 'ambos'       — o caso comum: a casa da pessoa.
 *
 * Faturar exige o código IBGE do município (a NF-e identifica o município
 * por ele, não pelo nome). Por isso endereço sem IBGE só pode ser de entrega.
 */
export type TipoDeEndereco = 'entrega' | 'faturamento' | 'ambos';
const TIPOS: readonly TipoDeEndereco[] = ['entrega', 'faturamento', 'ambos'];

/*
  O prefixo do código IBGE é o código da UF (`CODIGO_DA_UF`, que mora com a
  tabela de municípios em `MunicipiosIbge.ts`). Um IBGE de São Paulo (35…)
  num endereço do Rio Grande do Sul (43…) produziria uma nota que a SEFAZ
  recusa — ou pior, que ela aceita com o município errado.
*/

/** O tipo de uma linha — a anterior à regra vale pelo IBGE que tem. */
export function tipoDoEndereco(row: { kind?: unknown; city_ibge?: unknown }): TipoDeEndereco {
  const gravado = String(row.kind ?? '');
  if ((TIPOS as readonly string[]).includes(gravado)) return gravado as TipoDeEndereco;
  return row.city_ibge ? 'ambos' : 'entrega';
}

export function serveParaEntrega(tipo: TipoDeEndereco): boolean {
  return tipo !== 'faturamento';
}

export function serveParaFaturamento(tipo: TipoDeEndereco): boolean {
  return tipo !== 'entrega';
}

export interface CustomerAddress {
  id: string;
  label: string | null;
  zip: string;
  street: string;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  /** Código IBGE do município. A NF-e identifica o município por ele. */
  cityIbge: string | null;
  isDefault: boolean;
  /** Para que serve (GAP-PRD-115). */
  kind: TipoDeEndereco;
  /** Quem recebe; nulo = o nome da conta. */
  recipientName: string | null;
  usableForShipping: boolean;
  usableForBilling: boolean;
}

function toAddress(row: Record<string, unknown>): CustomerAddress {
  const kind = tipoDoEndereco(row);
  return {
    id: String(row.id),
    label: (row.label as string | null) ?? null,
    zip: String(row.zip),
    street: String(row.street),
    number: (row.number as string | null) ?? null,
    complement: (row.complement as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    city: String(row.city),
    state: String(row.state),
    cityIbge: (row.city_ibge as string | null) ?? null,
    isDefault: Boolean(Number(row.is_default)),
    kind,
    recipientName: (row.recipient_name as string | null) ?? null,
    usableForShipping: serveParaEntrega(kind),
    usableForBilling: serveParaFaturamento(kind),
  };
}

/** Endereços da conta, o padrão primeiro. */
export function listAddresses(accountId: string): CustomerAddress[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT * FROM core_customer_addresses
        WHERE account_id = ? ORDER BY is_default DESC, created_at`,
    )
    .all(accountId) as unknown as Record<string, unknown>[];
  return linhas.map(toAddress);
}

export interface AddressInput {
  label?: string;
  zip: string;
  street: string;
  number?: string;
  complement?: string;
  district?: string;
  city: string;
  state: string;
  cityIbge?: string;
  isDefault?: boolean;
  /** 'entrega' | 'faturamento' | 'ambos'. Ausente: 'ambos' com IBGE, senão 'entrega'. */
  kind?: unknown;
  /** Quem recebe no endereço. */
  recipientName?: unknown;
}

interface EnderecoConferido {
  zip: string;
  state: string;
  ibge: string | null;
  kind: TipoDeEndereco;
  recipientName: string | null;
}

function validar(input: AddressInput): EnderecoConferido {
  const zip = onlyDigits(input.zip);
  if (zip.length !== 8) {
    throw new ApiError('PORTAL_INVALID_ZIP', 'CEP deve ter 8 dígitos.', 400);
  }
  if (!input.street?.trim()) {
    throw new ApiError('PORTAL_INVALID_ADDRESS', 'Informe a rua.', 400);
  }
  if (!input.city?.trim()) {
    throw new ApiError('PORTAL_INVALID_ADDRESS', 'Informe a cidade.', 400);
  }
  const state = String(input.state ?? '').trim().toUpperCase();
  if (!CODIGO_DA_UF[state]) {
    throw new ApiError('PORTAL_INVALID_ADDRESS', 'UF inválida: use a sigla do estado (RS, SP, RJ…).', 400);
  }
  // Guardar formato errado seria pior do que não guardar: a rejeição só
  // apareceria na SEFAZ, com a mercadoria já a caminho.
  const ibge = onlyDigits(input.cityIbge ?? '');
  if (ibge && ibge.length !== 7) {
    throw new ApiError('PORTAL_INVALID_ADDRESS', 'Código IBGE do município tem 7 dígitos.', 400);
  }
  if (ibge) {
    /*
      COM A TABELA OFICIAL CARREGADA (IBGE-MUNICIPIOS), o código tem de ser de
      um município que EXISTE e é desta UF — e a recusa diz de que cidade ele
      é. Sem a tabela, a regra de antes: o prefixo da UF.
    */
    const conferido = conferirMunicipio(ibge, state);
    if (conferido.tabela === 'carregada') {
      if (!conferido.confere) {
        const motivo = porQueNaoConfere(ibge, state, conferido.municipio);
        throw new ApiError(
          'PORTAL_IBGE_NAO_CONFERE',
          `${motivo.charAt(0).toUpperCase()}${motivo.slice(1)}. Escolha a cidade na lista do formulário: o código vem junto.`,
          422,
          { cityIbge: ibge, state, municipio: conferido.municipio },
        );
      }
    } else if (ibge.slice(0, 2) !== CODIGO_DA_UF[state]) {
      throw new ApiError(
        'PORTAL_INVALID_ADDRESS',
        `O código IBGE ${ibge} não é de um município de ${state} (os de ${state} começam com ${CODIGO_DA_UF[state]}).`,
        400,
      );
    }
  }

  let kind: TipoDeEndereco;
  if (input.kind === undefined || input.kind === null || input.kind === '') {
    kind = ibge ? 'ambos' : 'entrega';
  } else if ((TIPOS as readonly unknown[]).includes(input.kind)) {
    kind = input.kind as TipoDeEndereco;
  } else {
    throw new ApiError(
      'PORTAL_INVALID_ADDRESS',
      'Tipo de endereço inválido: use "entrega", "faturamento" ou "ambos".',
      400,
    );
  }
  // FATURAR EXIGE O IBGE (GAP-PRD-115): o endereço que vai na nota precisa
  // do município pelo código. Sem ele, o endereço serve para entregar.
  if (serveParaFaturamento(kind) && !ibge) {
    throw new ApiError(
      'PORTAL_IBGE_OBRIGATORIO',
      'Para usar este endereço na nota fiscal (faturamento), informe o código IBGE do município — 7 dígitos. Sem ele, salve como endereço só de entrega.',
      400,
    );
  }

  let recipientName: string | null = null;
  if (input.recipientName !== undefined && input.recipientName !== null && String(input.recipientName).trim()) {
    recipientName = nomeDaPessoa(input.recipientName);
    if (!recipientName) {
      throw new ApiError('PORTAL_INVALID_ADDRESS', 'Nome de quem recebe: até 120 caracteres.', 400);
    }
  }

  return { zip, state, ibge: ibge || null, kind, recipientName };
}

/**
 * Salva um endereço.
 *
 * O primeiro vira padrão sozinho: obrigar a marcar "padrão" quando só existe
 * um é pedir um clique que não decide nada.
 */
export function addAddress(accountId: string, input: AddressInput): CustomerAddress {
  ensureCoreSchema();
  const { zip, state, ibge, kind, recipientName } = validar(input);

  return withTransaction(() => {
    const db = getConnection();
    const quantos = (
      db
        .prepare('SELECT COUNT(*) c FROM core_customer_addresses WHERE account_id = ?')
        .get(accountId) as { c: number }
    ).c;

    const padrao = Boolean(input.isDefault) || quantos === 0;
    if (padrao) {
      // Um padrão só. Dois marcados fariam o checkout escolher por ordem de
      // inserção — uma decisão que ninguém tomou.
      db.prepare('UPDATE core_customer_addresses SET is_default = 0 WHERE account_id = ?').run(
        accountId,
      );
    }

    const id = randomUUID();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_customer_addresses
         (id, account_id, label, zip, street, number, complement, district, city, state,
          city_ibge, is_default, kind, recipient_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      accountId,
      input.label?.trim() || null,
      zip,
      input.street.trim(),
      input.number?.trim() || null,
      input.complement?.trim() || null,
      input.district?.trim() || null,
      input.city.trim(),
      state,
      ibge,
      padrao ? 1 : 0,
      kind,
      recipientName,
      agora,
      agora,
    );

    return listAddresses(accountId).find((a) => a.id === id)!;
  });
}

/**
 * Edita um endereço — o formulário inteiro, como o POST (GAP-PRD-115).
 *
 * Antes não havia edição: corrigir o número exigia apagar e recriar, e o
 * endereço recriado perdia o "padrão". Só o da PRÓPRIA conta: o de outra é
 * 404, não 403 — confirmar que o id existe já contaria algo.
 *
 * `isDefault: true` torna este o padrão. `false` não "despadroniza": a conta
 * não fica sem padrão por um PUT — o padrão muda escolhendo outro.
 *
 * Pedidos já feitos NÃO mudam: eles guardam o retrato do endereço.
 */
export function updateAddress(accountId: string, addressId: string, input: AddressInput): CustomerAddress {
  ensureCoreSchema();
  const { zip, state, ibge, kind, recipientName } = validar(input);
  return withTransaction(() => {
    const db = getConnection();
    const existe = db
      .prepare('SELECT id FROM core_customer_addresses WHERE id = ? AND account_id = ?')
      .get(addressId, accountId);
    if (!existe) throw new ApiError('PORTAL_ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);

    if (input.isDefault === true) {
      db.prepare('UPDATE core_customer_addresses SET is_default = 0 WHERE account_id = ?').run(accountId);
    }
    db.prepare(
      `UPDATE core_customer_addresses
          SET label = ?, zip = ?, street = ?, number = ?, complement = ?, district = ?,
              city = ?, state = ?, city_ibge = ?, kind = ?, recipient_name = ?,
              is_default = CASE WHEN ? = 1 THEN 1 ELSE is_default END,
              updated_at = ?
        WHERE id = ? AND account_id = ?`,
    ).run(
      input.label?.trim() || null,
      zip,
      input.street.trim(),
      input.number?.trim() || null,
      input.complement?.trim() || null,
      input.district?.trim() || null,
      input.city.trim(),
      state,
      ibge,
      kind,
      recipientName,
      input.isDefault === true ? 1 : 0,
      new Date().toISOString(),
      addressId,
      accountId,
    );
    return listAddresses(accountId).find((a) => a.id === addressId)!;
  });
}

export function setDefaultAddress(accountId: string, addressId: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    // Endereço de outra conta responde 404, não 403: confirmar que o id existe
    // já contaria algo sobre a conta alheia.
    const existe = db
      .prepare('SELECT id FROM core_customer_addresses WHERE id = ? AND account_id = ?')
      .get(addressId, accountId);
    if (!existe) throw new ApiError('PORTAL_ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);

    db.prepare('UPDATE core_customer_addresses SET is_default = 0 WHERE account_id = ?').run(
      accountId,
    );
    db.prepare(
      'UPDATE core_customer_addresses SET is_default = 1, updated_at = ? WHERE id = ?',
    ).run(new Date().toISOString(), addressId);
  });
}

/**
 * Remove um endereço.
 *
 * Se o removido era o padrão, o mais antigo restante assume — deixar a conta
 * sem padrão faria o próximo checkout começar em branco sem motivo.
 */
export function removeAddress(accountId: string, addressId: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const atual = db
      .prepare('SELECT is_default FROM core_customer_addresses WHERE id = ? AND account_id = ?')
      .get(addressId, accountId) as { is_default: number } | undefined;
    if (!atual) throw new ApiError('PORTAL_ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);

    db.prepare('DELETE FROM core_customer_addresses WHERE id = ?').run(addressId);

    if (Number(atual.is_default)) {
      const proximo = db
        .prepare(
          'SELECT id FROM core_customer_addresses WHERE account_id = ? ORDER BY created_at LIMIT 1',
        )
        .get(accountId) as { id: string } | undefined;
      if (proximo) {
        db.prepare('UPDATE core_customer_addresses SET is_default = 1 WHERE id = ?').run(
          proximo.id,
        );
      }
    }
  });
}

/**
 * Troca a senha da conta.
 *
 * EXIGE A SENHA ATUAL. Sem isso, quem pegasse o computador destravado do
 * cliente trocaria a senha e tomaria a conta: o token de sessão sozinho não
 * pode valer como prova de identidade para mudar credencial.
 *
 * Todas as OUTRAS sessões caem. É o comportamento esperado — se a senha está
 * sendo trocada porque alguém tinha acesso, esse alguém precisa perder o
 * acesso agora. A sessão de quem trocou continua, para a pessoa não ser
 * expulsa da própria tela.
 */
export async function changePassword(input: {
  accountId: string;
  /** O token É o id da sessão; ver `resolveCustomerSession`. */
  currentSessionToken: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  ensureCoreSchema();
  const db = getConnection();

  const conta = db
    .prepare(
      'SELECT id, email, password_hash, has_password FROM core_customer_accounts WHERE id = ? AND active = 1',
    )
    .get(input.accountId) as
    | { id: string; email: string; password_hash: string; has_password: number }
    | undefined;
  if (!conta) {
    await wasteVerificationTime();
    throw new ApiError('PORTAL_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);
  }
  /*
    CONTA QUE ENTRA SÓ PELO GOOGLE (GAP-PRD-027) não tem "senha atual" para
    conferir — e criar a primeira senha só com o token de sessão contrariaria
    a regra de cima. A primeira senha nasce pelo link de recuperação, que vai
    para a caixa provada.
  */
  if (Number(conta.has_password) === 0) {
    throw new ApiError(
      'PORTAL_CONTA_SEM_SENHA',
      'Sua conta entra pelo Google e ainda não tem senha. Para criar uma, use "Esqueci minha senha" na tela de entrar — o link chega no seu e-mail.',
      409,
    );
  }

  const confere = await verifyPassword(input.currentPassword, conta.password_hash);
  if (!confere.valid) {
    throw new ApiError('PORTAL_WRONG_PASSWORD', 'Senha atual incorreta.', 401);
  }
  // A mesma política do cadastro e da redefinição (GAP-PRD-192).
  exigirSenhaForte(input.newPassword, { email: conta.email });
  if (input.newPassword === input.currentPassword) {
    throw new ApiError('PORTAL_SAME_PASSWORD', 'A senha nova precisa ser diferente da atual.', 400);
  }

  const hash = await hashPassword(input.newPassword);
  withTransaction(() => {
    const agora = new Date().toISOString();
    db.prepare(
      'UPDATE core_customer_accounts SET password_hash = ?, updated_at = ? WHERE id = ?',
    ).run(hash, agora, input.accountId);

    db.prepare('UPDATE core_customer_sessions SET revoked = 1 WHERE account_id = ? AND id <> ?').run(
      input.accountId,
      input.currentSessionToken,
    );

    // O dono do e-mail fica sabendo da troca — se não foi ele, reage agora
    // (rodada 49). O corpo não carrega senha nenhuma.
    const companyId = empresaParaEmailDaConta(input.accountId);
    if (companyId) {
      queueSenhaAlteradaEmail({
        companyId,
        toAddress: conta.email,
        dedupeKey: `senha_alterada:${input.accountId}:${agora}`,
      });
    }
  });
}

/**
 * O que a conta mostra de dados cadastrais, e o que dá para editar.
 *
 * O e-mail é o login e não muda aqui (mudá-lo mudaria a identidade da conta e
 * os vínculos).
 *
 * OS DADOS MORAM NA CONTA (GAP-PRD-133/205). Antes a conta só guardava e-mail
 * e senha: a leitura pegava o "primeiro" cadastro vinculado e a escrita
 * percorria os vínculos. Conta sem vínculo — toda conta nova — salvava em
 * lugar nenhum e respondia "Dados atualizados."; conta com dois cadastros
 * mostrava o nome de um deles pela ordem das linhas.
 *
 * Agora nome, telefone e documento ficam em `core_customer_accounts`. A
 * escrita continua refletindo nome e telefone nos cadastros vinculados — o
 * cliente que corrige o telefone não quer fazer isso loja por loja —, mas o
 * que a conta lê é o que ela mesma guardou.
 *
 * CONTA ANTIGA, SEM NOME PRÓPRIO: fala o cadastro vinculado MAIS RECENTEMENTE
 * (o vínculo mais novo, e no empate o cadastro atualizado por último). É a
 * compra mais recente da pessoa, e é regra — não ordem de inserção. O campo
 * `nameSource` diz de onde veio, para a tela não fingir que é da conta.
 */
export type CampoDoCadastro = 'email_verificado' | 'nome' | 'documento' | 'telefone';

export interface PerfilDoCliente {
  email: string;
  name: string | null;
  phone: string | null;
  /** 'conta' = guardado na conta; 'cadastro' = conta antiga, lido do vínculo mais recente. */
  nameSource: 'conta' | 'cadastro' | null;
  /** O CPF/CNPJ declarado, mascarado (••• 1234). Inteiro, não sai pela API. */
  documentMasked: string | null;
  hasDocument: boolean;
  emailVerified: boolean;
  /**
   * A conta tem senha? Falso = nasceu pelo "Entrar com Google" (GAP-PRD-027)
   * e ainda não criou uma: a tela troca o "Trocar senha" pelo caminho da
   * recuperação, que é por onde a primeira senha nasce.
   */
  hasPassword: boolean;
  /**
   * O que ainda falta para fechar pedido — a regra de "cadastro completo" do
   * checkout (GAP-PRD-028). A tela usa para pedir antes; o servidor recusa
   * de novo no fechamento.
   */
  faltando: CampoDoCadastro[];
}

interface LinhaDaConta {
  email: string;
  name: string | null;
  phone: string | null;
  document: string | null;
  email_verified_at: string | null;
  has_password: number;
}

function lerConta(accountId: string): LinhaDaConta {
  const conta = getConnection()
    .prepare(
      `SELECT email, name, phone, document, email_verified_at, has_password
         FROM core_customer_accounts WHERE id = ? AND active = 1`,
    )
    .get(accountId) as LinhaDaConta | undefined;
  if (!conta) throw new ApiError('PORTAL_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);
  return conta;
}

function mascarar(documento: string | null): string | null {
  const digitos = onlyDigits(documento ?? '');
  return digitos.length >= 4 ? `••• ${digitos.slice(-4)}` : null;
}

/**
 * O que falta para comprar. Uma lista só, na ordem em que a tela pede:
 * a caixa provada (é para ela que o pedido e o PIX vão), o nome, o documento
 * (a nota e a cobrança exigem) e o telefone (a loja avisa da entrega por ele).
 */
export function camposQueFaltam(dados: {
  name: string | null;
  phone: string | null;
  document: string | null;
  emailVerified: boolean;
}): CampoDoCadastro[] {
  const faltando: CampoDoCadastro[] = [];
  if (!dados.emailVerified) faltando.push('email_verificado');
  if (!String(dados.name ?? '').trim()) faltando.push('nome');
  if (!documentoValido(onlyDigits(dados.document ?? ''))) faltando.push('documento');
  if (onlyDigits(dados.phone ?? '').length < 10) faltando.push('telefone');
  return faltando;
}

/** CPF ou CNPJ com os dígitos verificadores certos — nada além disso. */
export function documentoValido(digitos: string): boolean {
  return digitos.length === 11 ? isValidCpf(digitos) : digitos.length === 14 ? isValidCnpj(digitos) : false;
}

export function getProfile(accountId: string): PerfilDoCliente {
  ensureCoreSchema();
  const conta = lerConta(accountId);

  // Conta antiga, sem nome próprio: o vínculo mais recente fala por ela.
  const cadastro =
    conta.name && conta.phone
      ? undefined
      : (getConnection()
          .prepare(
            `SELECT c.name, c.phone
               FROM core_customer_account_links l
               JOIN core_customers c ON c.id = l.customer_id
              WHERE l.account_id = ?
              ORDER BY l.created_at DESC, c.updated_at DESC, c.id
              LIMIT 1`,
          )
          .get(accountId) as { name: string | null; phone: string | null } | undefined);

  const name = conta.name ?? cadastro?.name ?? null;
  const phone = conta.phone ?? cadastro?.phone ?? null;
  const emailVerified = Boolean(conta.email_verified_at);

  return {
    email: conta.email,
    name,
    phone,
    nameSource: conta.name ? 'conta' : name ? 'cadastro' : null,
    documentMasked: mascarar(conta.document),
    hasDocument: Boolean(conta.document),
    emailVerified,
    hasPassword: Number(conta.has_password) !== 0,
    faltando: camposQueFaltam({ name, phone, document: conta.document, emailVerified }),
  };
}

export function updateProfile(
  accountId: string,
  input: { name?: string; phone?: string; document?: string },
): PerfilDoCliente {
  ensureCoreSchema();
  const db = getConnection();
  const conta = lerConta(accountId);

  const nome = typeof input.name === 'string' ? input.name.trim() : undefined;
  const telefone = typeof input.phone === 'string' ? input.phone.trim() : undefined;
  if (nome !== undefined && nome.length === 0) {
    throw new ApiError('PORTAL_INVALID_NAME', 'O nome não pode ficar em branco.', 400);
  }

  /*
    O DOCUMENTO SE DECLARA UMA VEZ.

    É por ele que o checkout acha ou cria o cadastro da operação — e a nota
    sai no nome de quem tem aquele CPF. Trocar por um PUT deixaria qualquer
    sessão (inclusive a de um computador esquecido aberto) mudar em nome de
    quem as próximas notas saem. Mandar o mesmo de novo não é troca.
  */
  const documento = typeof input.document === 'string' ? onlyDigits(input.document) : undefined;
  if (documento !== undefined && documento !== '') {
    if (!documentoValido(documento)) {
      throw new ApiError(
        'PORTAL_INVALID_DOCUMENT',
        'CPF ou CNPJ inválido: confira os números — os dígitos finais não conferem.',
        400,
      );
    }
    if (conta.document && conta.document !== documento) {
      throw new ApiError(
        'PORTAL_DOCUMENTO_DEFINIDO',
        'Esta conta já tem CPF/CNPJ. Para trocar, fale com a loja.',
        409,
      );
    }
  }

  // Os cadastros vinculados recebem nome e telefone — a conta é uma pessoa, e
  // o cadastro por loja é o mesmo alguém repetido. O documento NÃO desce: o
  // do cadastro é o que a loja escreveu, e é a prova que o portal usa.
  const alvos = db
    .prepare('SELECT customer_id FROM core_customer_account_links WHERE account_id = ?')
    .all(accountId) as { customer_id: string }[];

  withTransaction(() => {
    const agora = new Date().toISOString();
    db.prepare(
      `UPDATE core_customer_accounts
          SET name = COALESCE(?, name),
              phone = CASE WHEN ? = 1 THEN ? ELSE phone END,
              document = COALESCE(document, ?),
              updated_at = ?
        WHERE id = ?`,
    ).run(
      nome ?? null,
      telefone === undefined ? 0 : 1,
      telefone === undefined ? null : telefone || null,
      documento || null,
      agora,
      accountId,
    );
    for (const alvo of alvos) {
      if (nome !== undefined) {
        db.prepare('UPDATE core_customers SET name = ?, updated_at = ? WHERE id = ?').run(
          nome,
          agora,
          alvo.customer_id,
        );
      }
      if (telefone !== undefined) {
        db.prepare('UPDATE core_customers SET phone = ?, updated_at = ? WHERE id = ?').run(
          telefone,
          agora,
          alvo.customer_id,
        );
      }
    }
  });

  return getProfile(accountId);
}

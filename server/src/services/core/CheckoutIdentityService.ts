/**
 * QUEM ESTÁ COMPRANDO — a identidade do checkout da loja online.
 *
 * Arquivo próprio porque a pergunta é própria: `StorefrontService.checkout`
 * responde por PEDIDO (preço, estoque, frete, número), e este responde por
 * PESSOA (qual cadastro fiscal o pedido usa, de quem o pedido é, e o que esse
 * gesto pode mudar).
 *
 * A REGRA QUE O GAP-PRD-006 IMPÔS
 *
 * O CPF digitado no checkout IDENTIFICA o cadastro fiscal da operação — a nota
 * sai no nome de quem tem aquele CPF, e o `UNIQUE (company_id, document)` diz
 * que só existe um. Mas o CPF digitado NÃO PROVA quem está digitando. Então:
 *
 *   - o checkout nunca reescreve um cadastro que já existe (e-mail, telefone,
 *     endereço): o pedido guarda a cópia do que foi digitado nele;
 *   - o pedido não vira de ninguém por causa do cadastro — ele é da conta que
 *     o fechou, ou do e-mail provado que foi digitado nele
 *     (`CustomerPortalService.filtroDoDono`).
 *
 * A REGRA QUE O GAP-PRD-028/043 IMPÔS
 *
 * Comprar exige conta — por padrão. A loja que quiser vender também para
 * visitante liga isso na tela de administração (`checkout_mode`), e a decisão
 * fica registrada na trilha de auditoria. Com conta, o pedido nasce NA conta
 * (`customer_account_id`), o cadastro da operação é achado ou criado e ligado
 * a ela, e o fechamento exige o cadastro completo: e-mail provado, nome,
 * CPF/CNPJ válido e telefone.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { findOrCreateCustomer } from './CatalogService.js';
import {
  camposQueFaltam,
  documentoValido,
  getProfile,
  serveParaEntrega,
  serveParaFaturamento,
  tipoDoEndereco,
  type TipoDeEndereco,
} from './CustomerAccountService.js';
import { emailValido, nomeDaPessoa, normalizarEmail } from './PoliticaDoCadastro.js';
import { conferirMunicipio, porQueNaoConfere, type Municipio } from './MunicipiosIbge.js';

function soDigitos(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function texto(valor: unknown): string {
  return String(valor ?? '').trim();
}

// ------------------------------------------------------------ a política

export type ModoDoCheckout = 'conta' | 'visitante';

/** O padrão seguro: sem decisão do dono, comprar exige conta. */
export const MODO_PADRAO_DO_CHECKOUT: ModoDoCheckout = 'conta';

export interface PoliticaDoCheckout {
  mode: ModoDoCheckout;
  padrao: ModoDoCheckout;
  /** O dono já escolheu? Falso = está valendo o padrão. */
  configurado: boolean;
}

export function politicaDoCheckout(companyId: string): PoliticaDoCheckout {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT checkout_mode FROM core_storefront_settings WHERE company_id = ?')
    .get(companyId) as { checkout_mode: string | null } | undefined;
  const gravado = linha?.checkout_mode;
  return {
    // Qualquer valor que não seja exatamente 'visitante' vale como 'conta':
    // um texto torto no banco não pode abrir a loja para quem não tem conta.
    mode: gravado === 'visitante' ? 'visitante' : 'conta',
    padrao: MODO_PADRAO_DO_CHECKOUT,
    configurado: gravado === 'visitante' || gravado === 'conta',
  };
}

export function modoDoCheckout(companyId: string): ModoDoCheckout {
  return politicaDoCheckout(companyId).mode;
}

/** Basta UMA loja do carrinho exigir conta para o carrinho inteiro exigir. */
export function carrinhoExigeConta(companyIds: string[]): boolean {
  return companyIds.some((id) => modoDoCheckout(id) === 'conta');
}

export function definirModoDoCheckout(companyId: string, modo: unknown): PoliticaDoCheckout {
  ensureCoreSchema();
  if (modo !== 'conta' && modo !== 'visitante') {
    throw new ApiError(
      'CORE_CHECKOUT_MODE_INVALID',
      'Escolha "conta" (comprar exige conta) ou "visitante" (aceita também quem compra sem conta).',
      400,
    );
  }
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_storefront_settings (company_id, banner_active, checkout_mode, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT (company_id) DO UPDATE
          SET checkout_mode = excluded.checkout_mode, updated_at = excluded.updated_at`,
    )
    .run(companyId, modo, agora);
  return politicaDoCheckout(companyId);
}

// ---------------------------------------------------- o comprador da conta

export interface CompradorDaConta {
  accountId: string;
  /** O e-mail PROVADO da conta — é o do pedido, não o que o corpo mandar. */
  email: string;
  name: string;
  phone: string;
  document: string;
}

const NOME_DO_CAMPO: Record<string, string> = {
  email_verificado: 'confirmar o e-mail',
  nome: 'nome',
  documento: 'CPF ou CNPJ',
  telefone: 'telefone',
};

/**
 * Confere a conta e completa o cadastro com o que veio no checkout.
 *
 * O que a conta ainda não tem e o corpo trouxe é GUARDADO na conta — é assim
 * que o formulário do checkout completa o cadastro do cliente novo sem mandar
 * ele para outra tela. O que a conta já tem não é trocado daqui: o nome e o
 * telefone digitados valem para ESTE pedido, e o documento, se vier diferente
 * do da conta, é recusado (a nota sai no documento da conta).
 *
 * Nada é gravado se o cadastro continuar incompleto: recusa que grava metade
 * mente sobre não ter feito nada.
 */
export function prepararComprador(
  accountId: string,
  input: { name?: unknown; phone?: unknown; document?: unknown },
): CompradorDaConta {
  ensureCoreSchema();
  const db = getConnection();
  const conta = db
    .prepare(
      `SELECT email, name, phone, document, email_verified_at
         FROM core_customer_accounts WHERE id = ? AND active = 1`,
    )
    .get(accountId) as
    | {
        email: string;
        name: string | null;
        phone: string | null;
        document: string | null;
        email_verified_at: string | null;
      }
    | undefined;
  if (!conta) throw new ApiError('PORTAL_UNAUTHENTICATED', 'Entre na sua conta para continuar.', 401);

  // A caixa provada vem primeiro: é para ela que o pedido, o PIX e cada
  // mudança de estado vão — e é ela que faz o pedido aparecer na conta.
  if (!conta.email_verified_at) {
    throw new ApiError(
      'PORTAL_EMAIL_NAO_VERIFICADO',
      'Confirme seu e-mail para finalizar a compra — o código está na sua caixa de entrada (Minha conta).',
      403,
      { faltando: ['email_verificado'] },
    );
  }

  const docDigitado = soDigitos(input.document);
  if (conta.document && docDigitado && docDigitado !== conta.document) {
    throw new ApiError(
      'CHECKOUT_DOCUMENTO_DIFERENTE',
      'O CPF/CNPJ informado não é o desta conta. A nota sai no documento da conta; para trocá-lo, fale com a loja.',
      409,
    );
  }
  if (!conta.document && docDigitado && !documentoValido(docDigitado)) {
    throw new ApiError(
      'PORTAL_INVALID_DOCUMENT',
      'CPF ou CNPJ inválido: confira os números — os dígitos finais não conferem.',
      400,
    );
  }

  // O perfil já resolve a conta antiga sem nome próprio (vínculo mais recente).
  const perfil = getProfile(accountId);
  const nomeDigitado = texto(input.name);
  const telefoneDigitado = texto(input.phone);
  const name = nomeDigitado || perfil.name || '';
  const phone = telefoneDigitado || perfil.phone || '';
  const document = conta.document ?? docDigitado;

  const faltando = camposQueFaltam({ name, phone, document, emailVerified: true });
  if (faltando.length > 0) {
    throw new ApiError(
      'PORTAL_CADASTRO_INCOMPLETO',
      `Complete seu cadastro para finalizar: ${faltando.map((c) => NOME_DO_CAMPO[c] ?? c).join(', ')}.`,
      422,
      { faltando },
    );
  }

  // Completo: o que faltava NA CONTA e veio no checkout fica guardado nela.
  db.prepare(
    `UPDATE core_customer_accounts
        SET name = COALESCE(name, ?),
            phone = COALESCE(phone, ?),
            document = COALESCE(document, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(
    conta.name ? null : nomeDigitado || null,
    conta.phone ? null : telefoneDigitado || null,
    conta.document ? null : docDigitado || null,
    new Date().toISOString(),
    accountId,
  );

  return { accountId, email: conta.email.trim().toLowerCase(), name, phone, document };
}

// ------------------------------------------------------ o endereço salvo

function cepFormatado(zip: string): string {
  return zip.length === 8 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip;
}

/**
 * O RETRATO de um endereço salvo, do jeito que o pedido o guarda
 * (GAP-PRD-115): cada campo na sua coluna, mais a linha de texto de sempre
 * (etiqueta, telas antigas). É CÓPIA — editar ou apagar o endereço depois
 * não reescreve para onde um pedido antigo foi, nem em nome de quem a nota
 * dele saiu.
 */
export interface RetratoDoEndereco {
  addressId: string;
  /** O apelido ("Casa", "Trabalho"), para a recusa dizer QUAL endereço. */
  label: string | null;
  zip: string;
  street: string;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  cityIbge: string | null;
  /** Quem recebe, se o endereço declara; nulo = o nome do comprador. */
  recipientName: string | null;
  kind: TipoDeEndereco;
  /** A linha única, no formato que o pedido sempre guardou. */
  texto: string;
}

function retrato(e: Record<string, string | null>): RetratoDoEndereco {
  const zip = soDigitos(e.zip);
  const partes = [
    `${e.street}, ${e.number || 's/n'}${e.complement ? ` — ${e.complement}` : ''}`,
    e.district,
    `${e.city}/${e.state}`,
    `CEP ${cepFormatado(zip)}`,
  ].filter(Boolean);
  return {
    addressId: String(e.id),
    label: e.label?.trim() || null,
    zip,
    street: String(e.street ?? ''),
    number: e.number ?? null,
    complement: e.complement ?? null,
    district: e.district ?? null,
    city: String(e.city ?? ''),
    state: String(e.state ?? ''),
    cityIbge: e.city_ibge ?? null,
    recipientName: e.recipient_name ?? null,
    kind: tipoDoEndereco(e),
    texto: partes.join(' · '),
  };
}

/**
 * O endereço salvo escolhido no checkout, para ENTREGAR ou para FATURAR.
 *
 * Só da PRÓPRIA conta: id de outra conta é 404 (não 403 — confirmar que o id
 * existe já contaria algo). E o tipo precisa servir para o uso: endereço só
 * de faturamento não recebe mercadoria, e endereço só de entrega (sem IBGE)
 * não vai na nota — 422 antes de reservar qualquer coisa.
 */
export function enderecoDoCheckout(
  accountId: string,
  addressId: string,
  uso: 'entrega' | 'faturamento' = 'entrega',
): RetratoDoEndereco {
  ensureCoreSchema();
  const e = getConnection()
    .prepare('SELECT * FROM core_customer_addresses WHERE id = ? AND account_id = ?')
    .get(addressId, accountId) as Record<string, string | null> | undefined;
  if (!e) throw new ApiError('PORTAL_ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);

  const r = retrato(e);
  const serve = uso === 'entrega' ? serveParaEntrega(r.kind) : serveParaFaturamento(r.kind);
  if (!serve) {
    throw new ApiError(
      'CHECKOUT_ENDERECO_TIPO',
      uso === 'entrega'
        ? 'Este endereço está salvo só para faturamento. Escolha um endereço de entrega.'
        : 'Este endereço está salvo só para entrega (sem o código IBGE do município) e não pode ir na nota. Escolha um endereço de faturamento.',
      422,
      { addressId, uso },
    );
  }
  /*
    O ENDEREÇO DA NOTA CONFERE O CÓDIGO NA TABELA (IBGE-MUNICIPIOS). É deste
    endereço que o pedido tira `billing_city_ibge`, e é esse retrato que a NF-e
    lê. Endereço salvo antes da tabela passou só pelo formato — com um código
    digitado errado, a compra fechava e a nota saía com um cMun que não é
    município nenhum, recusada pela SEFAZ depois de numerada. A entrega é
    conferida em `conferirEntregaDaConta` (só quando alguma loja entrega).
  */
  if (uso === 'faturamento') {
    const errado = codigoQueNaoConfere(r);
    if (errado) {
      const qual = r.label ? `O endereço "${r.label}"` : 'O endereço de faturamento';
      throw new ApiError(
        'CHECKOUT_ENDERECO_INCOMPLETO',
        `${qual} não pode ir na nota fiscal: ${errado.motivo}. `
          + 'Escolha a cidade de novo em Minha conta › Meus endereços (Editar) e finalize de novo.',
        422,
        { addressId, uso, faltando: ['ibge'], municipio: errado.municipio },
      );
    }
  }
  return r;
}

/**
 * O código IBGE do retrato NÃO confere com a tabela oficial? (IBGE-MUNICIPIOS)
 *
 * `null` quando não há o que recusar: sem código (endereço só de entrega), ou
 * com a tabela vazia (vale a regra de antes, o formato). Com a tabela e um
 * código que não é município da UF do endereço, o porquê — na frase que a
 * recusa usa.
 */
function codigoQueNaoConfere(r: RetratoDoEndereco): { motivo: string; municipio: Municipio | null } | null {
  const ibge = soDigitos(r.cityIbge);
  if (ibge.length !== 7) return null;
  const uf = texto(r.state).toUpperCase();
  const conferido = conferirMunicipio(ibge, uf);
  if (conferido.tabela !== 'carregada' || conferido.confere) return null;
  return { motivo: porQueNaoConfere(ibge, uf, conferido.municipio), municipio: conferido.municipio };
}

// ------------------------------------ a entrega da conta (GAP-PRD-028)

/** O nome de cada campo que falta, como a recusa o diz. */
const CAMPO_DA_ENTREGA: Record<string, string> = {
  rua: 'a rua',
  numero: 'o número (ou "S/N")',
  bairro: 'o bairro',
  cidade: 'a cidade',
  uf: 'a UF',
  cep: 'o CEP',
  ibge: 'o código IBGE do município',
};

/** O que falta num endereço para ele RECEBER um pedido, na ordem do formulário. */
export function faltaParaEntregar(r: RetratoDoEndereco): string[] {
  const falta: string[] = [];
  if (!texto(r.street)) falta.push('rua');
  if (!texto(r.number)) falta.push('numero');
  if (!texto(r.district)) falta.push('bairro');
  if (!texto(r.city)) falta.push('cidade');
  if (!texto(r.state)) falta.push('uf');
  if (soDigitos(r.zip).length !== 8) falta.push('cep');
  if (soDigitos(r.cityIbge).length !== 7) falta.push('ibge');
  return falta;
}

function juntarComE(partes: string[]): string {
  if (partes.length <= 1) return partes.join('');
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

/**
 * O ENDEREÇO DE ENTREGA DE QUEM TEM CONTA — conferido no fechamento, para
 * cada loja que vai ENTREGAR (retirada não pede endereço).
 *
 * A reauditoria do GAP-PRD-028 achou o servidor aceitando, com sessão do
 * portal, o endereço em texto solto (`shippingAddress`) sem
 * `shippingAddressId`: só a tela obrigava o endereço salvo. Com conta, então:
 *
 *   - a entrega vai para um endereço SALVO da conta — texto digitado é
 *     recusado (422 CHECKOUT_ENDERECO_SALVO_OBRIGATORIO). É o endereço salvo
 *     que o pedido retrata em colunas, que a etiqueta e a NF-e leem;
 *   - o endereço está COMPLETO: rua, número, bairro, cidade, UF, CEP e o
 *     código IBGE do município (422 CHECKOUT_ENDERECO_INCOMPLETO nomeando
 *     tudo o que falta de uma vez, e onde completar). O destinatário não
 *     falta nunca: sem `recipient_name`, quem recebe é quem compra — o
 *     retrato grava um ou outro (`StorefrontService.checkout`).
 *
 * Chamado antes de cotar o frete (senão o texto solto sem CEP saía como
 * "informe um CEP"), reservar estoque, numerar pedido ou emitir cobrança.
 */
export function conferirEntregaDaConta(endereco: RetratoDoEndereco | null): void {
  if (!endereco) {
    throw new ApiError(
      'CHECKOUT_ENDERECO_SALVO_OBRIGATORIO',
      'Com conta, a entrega vai para um endereço salvo na sua conta: escolha um endereço de entrega (ou cadastre um) e finalize de novo.',
      422,
    );
  }
  const faltando = faltaParaEntregar(endereco);
  if (faltando.length > 0) {
    const qual = endereco.label ? `O endereço "${endereco.label}"` : 'O endereço de entrega';
    throw new ApiError(
      'CHECKOUT_ENDERECO_INCOMPLETO',
      `${qual} está incompleto para receber o pedido: falta ${juntarComE(
        faltando.map((c) => CAMPO_DA_ENTREGA[c]),
      )}. Complete em Minha conta › Meus endereços (Editar) e finalize de novo.`,
      422,
      { addressId: endereco.addressId, faltando },
    );
  }
  /*
    COM A TABELA OFICIAL CARREGADA (IBGE-MUNICIPIOS), o código tem de ser de
    um município que existe e é da UF do endereço. Endereço salvo antes da
    tabela passou só pelo formato; aqui ele é conferido de novo, e a recusa é
    a mesma do endereço incompleto (a tela oferece "Completar"), com o motivo.
    Sem a tabela, o formato acima basta — a regra de antes.
  */
  const ibge = soDigitos(endereco.cityIbge);
  const uf = texto(endereco.state).toUpperCase();
  const conferido = conferirMunicipio(ibge, uf);
  if (conferido.tabela === 'carregada' && !conferido.confere) {
    const qual = endereco.label ? `O endereço "${endereco.label}"` : 'O endereço de entrega';
    throw new ApiError(
      'CHECKOUT_ENDERECO_INCOMPLETO',
      `${qual} não pode receber o pedido: ${porQueNaoConfere(ibge, uf, conferido.municipio)}. `
        + 'Escolha a cidade de novo em Minha conta › Meus endereços (Editar) e finalize de novo.',
      422,
      { addressId: endereco.addressId, faltando: ['ibge'], municipio: conferido.municipio },
    );
  }
}

/**
 * O endereço de FATURAMENTO quando o checkout não escolheu um.
 *
 * Primeiro o próprio endereço de entrega, se ele também fatura (o caso comum:
 * a casa da pessoa). Senão, o endereço de faturamento da conta — o padrão
 * primeiro. Sem nenhum, `null`: o pedido nasce, e a nota do pedido diz que
 * falta o endereço de faturamento (`OrderInvoiceService`), em vez de inventar
 * município.
 *
 * Com a tabela oficial carregada (IBGE-MUNICIPIOS), o endereço cujo código
 * não é município da UF também não serve para a nota: salvo antes da tabela,
 * ele passou só pelo formato. Pula para o próximo que confere — ou fica sem.
 */
export function faturamentoPadraoDaConta(
  accountId: string,
  entrega?: RetratoDoEndereco | null,
): RetratoDoEndereco | null {
  const serveParaANota = (r: RetratoDoEndereco) => serveParaFaturamento(r.kind) && !codigoQueNaoConfere(r);
  if (entrega && serveParaANota(entrega)) return entrega;
  const linhas = getConnection()
    .prepare(
      `SELECT * FROM core_customer_addresses
        WHERE account_id = ? ORDER BY is_default DESC, created_at`,
    )
    .all(accountId) as Record<string, string | null>[];
  const achado = linhas.map(retrato).find(serveParaANota);
  return achado ?? null;
}

// ------------------------------------------------ o visitante (GAP-PRD-191)

export interface CompradorVisitante {
  name: string;
  /** Só os dígitos, já com o dígito verificador conferido. */
  document: string;
  /** Normalizado (sem espaço, minúsculo). */
  email: string;
  phone?: string;
}

const CAMPO_DO_VISITANTE: Record<string, string> = {
  nome: 'nome',
  documento: 'CPF ou CNPJ válido (os dígitos finais conferem)',
  email: 'e-mail válido',
};

/**
 * Confere quem compra SEM conta — antes de cotar, reservar ou numerar.
 *
 * A auditoria fechou pela API um pedido só com o nome: 201, cobrança
 * `failed` (o provedor exige o documento) e o estoque reservado por 25
 * horas, sem e-mail para avisar ninguém. Toda forma de pagamento da vitrine é
 * cobrança online, e a cobrança exige o CPF/CNPJ; o e-mail é por onde o
 * pedido e o PIX chegam. Então os dois são obrigatórios — o documento com os
 * dígitos verificadores conferidos (11 dígitos quaisquer não bastam) e o
 * e-mail sintaticamente válido.
 *
 * A recusa nomeia TODOS os campos de uma vez, em `details.campos`: quem
 * erra dois campos não precisa descobrir o segundo no reenvio.
 */
export function conferirVisitante(input: {
  name?: unknown;
  document?: unknown;
  email?: unknown;
  phone?: unknown;
}): CompradorVisitante {
  const nome = nomeDaPessoa(input.name);
  const documento = soDigitos(input.document);
  const campos: string[] = [];
  if (!nome) campos.push('nome');
  if (!documentoValido(documento)) campos.push('documento');
  if (!emailValido(input.email)) campos.push('email');
  if (campos.length > 0) {
    throw new ApiError(
      'CHECKOUT_VISITANTE_INCOMPLETO',
      `Para fechar o pedido, informe: ${campos.map((c) => CAMPO_DO_VISITANTE[c]).join(', ')}.`,
      400,
      { campos },
    );
  }
  const telefone = texto(input.phone);
  return {
    name: nome!,
    document: documento,
    email: normalizarEmail(input.email),
    phone: telefone || undefined,
  };
}

// ----------------------------------------------------- o cadastro do pedido

/**
 * O cadastro do pedido de VISITANTE — quem compra sem conta.
 *
 * Com documento, o documento e só ele acha o cadastro: casar pelo e-mail
 * digitado e carimbar o CPF num cadastro de outra pessoa seria uma escrita
 * anônima no cadastro alheio. Sem documento, o e-mail acha um cadastro SEM
 * documento (o comprador que também não informou CPF da outra vez).
 *
 * Em nenhum dos casos o cadastro achado é alterado — ver o bloco `existente`
 * de `findOrCreateCustomer`. Não achando, nasce um cadastro novo com o que
 * foi digitado ('loja_online': o documento dele não é prova para o portal).
 */
export function cadastroDoVisitante(
  companyId: string,
  input: { name: string; document?: string; email?: string; phone?: string; address?: string },
): Record<string, unknown> {
  const documento = soDigitos(input.document);
  const dados = {
    name: input.name,
    document: documento || undefined,
    email: input.email,
    phone: input.phone,
    address: input.address,
  };
  if (documento) {
    // Com documento, `matchBy: 'document'` sempre devolve um cadastro: o que
    // tem o documento, ou um novo com ele.
    return findOrCreateCustomer(companyId, dados, { matchBy: 'document', origin: 'loja_online' })!;
  }
  return findOrCreateCustomer(companyId, dados, { origin: 'loja_online' });
}

type LinhaDeCadastro = Record<string, unknown> & { id: string; company_id: string };

/**
 * O cadastro do pedido feito por uma CONTA — dentro da transação do checkout.
 *
 * Na ordem, e cada passo diz por que pode:
 *
 *   1. a conta JÁ tem cadastro ligado nesta operação → é ele (o do mesmo
 *      documento, se houver mais de um). É dela: o que estiver VAZIO nele
 *      (e-mail, telefone) é preenchido com o da conta.
 *   2. existe cadastro com o documento da conta nesta operação:
 *        a. ele carrega o e-mail PROVADO da conta → co-prova: liga e usa;
 *        b. não carrega → o pedido usa esse cadastro fiscal (a nota é de quem
 *           tem o CPF), mas NÃO liga a conta a ele e NÃO o altera. O pedido é
 *           da conta pela coluna `customer_account_id`, e o histórico daquele
 *           cadastro continua fora do alcance dela. É o GAP-PRD-006 fechado
 *           também para quem tem conta.
 *   3. existe cadastro SEM documento com o e-mail provado da conta → é dela
 *      (mesma prova do login): liga e usa, sem carimbar documento.
 *   4. nada → cria o cadastro com os dados da conta e liga ('checkout').
 */
export function cadastroDaConta(
  companyId: string,
  comprador: CompradorDaConta,
  endereco?: string,
): LinhaDeCadastro {
  const db = getConnection();
  const agora = new Date().toISOString();
  const ligar = (customerId: string, prova: string) =>
    db
      .prepare(
        `INSERT INTO core_customer_account_links
           (id, account_id, customer_id, company_id, created_at, proof)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, customer_id) DO NOTHING`,
      )
      .run(randomUUID(), comprador.accountId, customerId, companyId, agora, prova);
  const preencherVazios = (customerId: string) =>
    db
      .prepare(
        `UPDATE core_customers
            SET email = CASE WHEN email IS NULL OR TRIM(email) = '' THEN ? ELSE email END,
                phone = CASE WHEN phone IS NULL OR TRIM(phone) = '' THEN ? ELSE phone END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(comprador.email, comprador.phone || null, agora, customerId);
  const ler = (id: string) =>
    db.prepare('SELECT * FROM core_customers WHERE id = ?').get(id) as LinhaDeCadastro;

  // 1. O que já é da conta nesta operação.
  const ligado = db
    .prepare(
      `SELECT c.id FROM core_customer_account_links l
         JOIN core_customers c ON c.id = l.customer_id
        WHERE l.account_id = ? AND l.company_id = ? AND c.active = 1
        ORDER BY (c.document = ?) DESC, l.created_at DESC
        LIMIT 1`,
    )
    .get(comprador.accountId, companyId, comprador.document) as { id: string } | undefined;
  if (ligado) {
    preencherVazios(ligado.id);
    return ler(ligado.id);
  }

  // 2. O cadastro fiscal de quem tem este documento nesta operação.
  const doDocumento = db
    .prepare('SELECT * FROM core_customers WHERE company_id = ? AND document = ?')
    .get(companyId, comprador.document) as LinhaDeCadastro | undefined;
  if (doDocumento) {
    const coProva =
      Number(doDocumento.active) === 1
      && texto(doDocumento.email).toLowerCase() === comprador.email;
    if (coProva) {
      ligar(doDocumento.id, 'coprova');
      return ler(doDocumento.id);
    }
    // Sem prova: usa, não liga, não altera.
    return doDocumento;
  }

  // 3. O cadastro sem documento que carrega o e-mail provado.
  const doEmail = db
    .prepare(
      `SELECT id FROM core_customers
        WHERE company_id = ? AND active = 1 AND LOWER(TRIM(email)) = ?
          AND (document IS NULL OR TRIM(document) = '')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId, comprador.email) as { id: string } | undefined;
  if (doEmail) {
    ligar(doEmail.id, 'email');
    preencherVazios(doEmail.id);
    return ler(doEmail.id);
  }

  // 4. Nada: o cadastro nasce da conta.
  const novo = findOrCreateCustomer(
    companyId,
    {
      name: comprador.name,
      document: comprador.document,
      email: comprador.email,
      phone: comprador.phone || undefined,
      address: endereco,
    },
    { matchBy: 'document', origin: 'loja_online' },
  ) as LinhaDeCadastro;
  ligar(String(novo.id), 'checkout');
  return novo;
}

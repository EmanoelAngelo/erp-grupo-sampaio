/**
 * ============================================================================
 * OS MUNICÍPIOS DO IBGE — o código sai do nome da cidade (IBGE-MUNICIPIOS)
 * ============================================================================
 *
 * Depois do GAP-PRD-028, a compra com conta e ENTREGA exige o código IBGE do
 * município no endereço salvo (a NF-e e a etiqueta identificam o município por
 * ele, não pelo nome). O cliente o digitava à mão, com a instrução de "buscar
 * no site do IBGE" — e cliente de loja online não sabe o que é isso: a compra
 * não fechava.
 *
 * Este módulo é a tabela oficial de municípios e tudo o que a usa:
 *
 *   - LER a lista oficial (o JSON da API de localidades do IBGE, ou um CSV
 *     simples `codigo;nome;uf`) e CONFERI-LA antes de gravar: 7 dígitos, os
 *     dois primeiros = o código da UF, nome presente, sem código repetido e,
 *     por padrão, o total plausível da lista inteira (~5.570). Lista que não
 *     passa não grava NADA;
 *   - GRAVAR numa transação, idempotente: a lista nova é a verdade — o que
 *     entrou é inserido, o nome corrigido é atualizado, o código que saiu da
 *     lista é removido, e o igual fica;
 *   - BUSCAR pelo nome sem acento e sem caixa, por UF, no máximo 20 — a rota
 *     pública que o formulário do endereço usa;
 *   - CONFERIR um código contra a UF do endereço.
 *
 * A TABELA NASCE VAZIA. Nada aqui inventa município: quem a enche é o dono,
 * uma vez, com o comando `scripts/carregar-municipios-ibge` (que busca a URL
 * oficial com --baixar, ou lê o arquivo que ele baixou). Enquanto ela está
 * vazia, o sistema faz exatamente o que fazia: o código é digitado, e só o
 * formato e o prefixo da UF são conferidos.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { DDL_DOS_MUNICIPIOS_IBGE, ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

/** A lista oficial: GET da API de localidades do IBGE (dado público). */
export const URL_OFICIAL_DOS_MUNICIPIOS = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios';

/**
 * O prefixo do código IBGE do município é o código da UF. Um IBGE de São
 * Paulo (35…) num endereço do Rio Grande do Sul (43…) produziria uma nota que
 * a SEFAZ recusa — ou pior, que ela aceita com o município errado.
 */
export const CODIGO_DA_UF: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
};

/**
 * Quantos municípios a lista oficial pode ter para ser a lista INTEIRA. O
 * Brasil tem 5.571 (divisão de 2024); a faixa deixa folga para município
 * criado ou extinto, e recusa arquivo cortado pela metade ou de outra coisa —
 * carregar só uma parte faria o servidor recusar os códigos que faltaram.
 */
export const FAIXA_PLAUSIVEL: readonly [number, number] = [5500, 5700];

/** O teto de sugestões por busca: a pessoa escolhe, não rola uma lista. */
export const LIMITE_DA_BUSCA = 20;

export interface Municipio {
  codigo: string;
  nome: string;
  uf: string;
}

/** "5571" → "5.571" — sem depender do ICU do Node. */
export function comMilhar(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * O nome como a busca o compara: sem acento, minúsculo, pontuação vira
 * espaço. "Sant'Ana do Livramento" → "sant ana do livramento".
 */
export function normalizarParaBusca(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A lista não passou na conferência. Nada foi gravado. */
export class ListaDeMunicipiosInvalida extends Error {
  constructor(readonly problemas: string[]) {
    super(problemas.join('; '));
    this.name = 'ListaDeMunicipiosInvalida';
  }
}

/** Um município como veio da lista, com onde estava (para a recusa apontar). */
export interface MunicipioLido extends Municipio {
  onde: string;
}

function texto(valor: unknown): string {
  if (typeof valor === 'string') return valor.trim();
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return '';
}

/** Desce num objeto sem confiar no formato: qualquer degrau faltando é `undefined`. */
function em(objeto: unknown, ...caminho: string[]): unknown {
  let atual: unknown = objeto;
  for (const chave of caminho) {
    if (!atual || typeof atual !== 'object') return undefined;
    atual = (atual as Record<string, unknown>)[chave];
  }
  return atual;
}

/**
 * Lê a lista oficial, sem conferir ainda.
 *
 * JSON: o formato de GET /api/v1/localidades/municipios — `id` (o código de 7
 * dígitos), `nome`, e a UF em `microrregiao.mesorregiao.UF.sigla`. Município
 * criado depois da última divisão em microrregiões vem com `microrregiao`
 * NULA; a UF dele está em `regiao-imediata.regiao-intermediaria.UF.sigla`.
 * Aceita também a forma simples `{ codigo, nome, uf }`.
 *
 * CSV: `codigo;nome;uf` (ou com vírgula), cabeçalho opcional, BOM tolerado.
 */
export function lerListaDoIbge(conteudo: string): MunicipioLido[] {
  // `trim()` também tira o BOM do começo (U+FEFF é espaço para o JavaScript):
  // arquivo salvo pelo Bloco de Notas do Windows começa com ele.
  const limpo = String(conteudo ?? '').trim();
  if (!limpo) throw new ListaDeMunicipiosInvalida(['a lista está vazia']);

  if (limpo.startsWith('[') || limpo.startsWith('{')) {
    let dados: unknown;
    try {
      dados = JSON.parse(limpo);
    } catch {
      throw new ListaDeMunicipiosInvalida(['o arquivo começa como JSON, mas não é JSON válido']);
    }
    if (!Array.isArray(dados)) {
      throw new ListaDeMunicipiosInvalida([
        'o JSON não é uma lista — a API do IBGE devolve uma lista de municípios: [{ "id": 4314407, "nome": "Pelotas", … }]',
      ]);
    }
    return dados.map((item, i) => ({
      codigo: texto(em(item, 'id')) || texto(em(item, 'codigo')),
      nome: texto(em(item, 'nome')),
      uf: (
        texto(em(item, 'microrregiao', 'mesorregiao', 'UF', 'sigla'))
        || texto(em(item, 'regiao-imediata', 'regiao-intermediaria', 'UF', 'sigla'))
        || texto(em(item, 'uf'))
      ).toUpperCase(),
      onde: `item ${i + 1}`,
    }));
  }

  const linhas = limpo.split(/\r?\n/);
  const separador = linhas[0].includes(';') ? ';' : linhas[0].includes('\t') ? '\t' : ',';
  const lidos: MunicipioLido[] = [];
  linhas.forEach((linha, i) => {
    if (!linha.trim()) return;
    const celulas = linha.split(separador).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    // Cabeçalho: a primeira linha cuja primeira célula não é número.
    if (i === 0 && !/^\d/.test(celulas[0] ?? '')) return;
    lidos.push({
      codigo: celulas[0] ?? '',
      nome: celulas[1] ?? '',
      uf: (celulas[2] ?? '').toUpperCase(),
      onde: `linha ${i + 1}`,
    });
  });
  if (lidos.length === 0) throw new ListaDeMunicipiosInvalida(['o CSV não tem nenhuma linha de município']);
  return lidos;
}

/**
 * Confere a lista inteira e devolve só o que vai para a tabela — ou recusa com
 * TODOS os problemas de uma vez (quem corrige o arquivo não precisa descobrir
 * o segundo erro na segunda tentativa).
 *
 * `faixa` nula não confere o total (uso de teste com amostra declarada).
 */
export function validarListaDeMunicipios(
  lidos: MunicipioLido[],
  faixa: readonly [number, number] | null = FAIXA_PLAUSIVEL,
): Municipio[] {
  const problemas: string[] = [];
  const vistos = new Map<string, string>();
  for (const m of lidos) {
    if (!/^\d{7}$/.test(m.codigo)) {
      problemas.push(`${m.onde}: o código "${m.codigo}" não tem 7 dígitos`);
      continue;
    }
    const prefixo = CODIGO_DA_UF[m.uf];
    if (!prefixo) {
      problemas.push(`${m.onde}: a UF "${m.uf}" não existe`);
    } else if (m.codigo.slice(0, 2) !== prefixo) {
      problemas.push(
        `${m.onde}: o código ${m.codigo} começa com ${m.codigo.slice(0, 2)}, e os municípios de ${m.uf} começam com ${prefixo}`,
      );
    }
    if (!m.nome) problemas.push(`${m.onde}: o município ${m.codigo} está sem nome`);
    else if (m.nome.length > 120) problemas.push(`${m.onde}: o nome do município ${m.codigo} passa de 120 caracteres`);
    const anterior = vistos.get(m.codigo);
    if (anterior) problemas.push(`${m.onde}: o código ${m.codigo} já apareceu (${anterior})`);
    else vistos.set(m.codigo, m.onde);
  }
  if (faixa && (lidos.length < faixa[0] || lidos.length > faixa[1])) {
    problemas.push(
      `${comMilhar(lidos.length)} município(s): a lista oficial do IBGE tem cerca de 5.570 (aceito de ${comMilhar(faixa[0])} a ${comMilhar(faixa[1])}) — o arquivo está incompleto ou é de outra coisa`,
    );
  }
  if (problemas.length > 0) throw new ListaDeMunicipiosInvalida(problemas);
  return lidos.map(({ codigo, nome, uf }) => ({ codigo, nome, uf }));
}

export interface ResultadoDaCarga {
  novos: number;
  alterados: number;
  removidos: number;
  iguais: number;
  total: number;
}

/**
 * Grava a lista (já conferida) numa transação. A lista nova é a verdade: o
 * que entrou é inserido, o nome ou a UF que mudou é atualizado, o código que
 * saiu é removido. Rodar duas vezes com a mesma lista não muda nada.
 *
 * Cria SÓ esta tabela se ela ainda não existe (banco que não subiu nesta
 * versão): o esquema inteiro é trabalho do boot da API, não deste comando.
 */
export function gravarMunicipios(lista: Municipio[]): ResultadoDaCarga {
  const db = getConnection();
  db.exec(DDL_DOS_MUNICIPIOS_IBGE);
  return withTransaction(() => {
    const atuais = new Map(
      (db.prepare('SELECT codigo, nome, uf FROM core_ibge_municipios').all() as unknown as Municipio[]).map((m) => [
        m.codigo,
        m,
      ]),
    );
    const agora = new Date().toISOString();
    const inserir = db.prepare(
      'INSERT INTO core_ibge_municipios (codigo, nome, uf, nome_busca, atualizado_em) VALUES (?, ?, ?, ?, ?)',
    );
    const atualizar = db.prepare(
      'UPDATE core_ibge_municipios SET nome = ?, uf = ?, nome_busca = ?, atualizado_em = ? WHERE codigo = ?',
    );
    const remover = db.prepare('DELETE FROM core_ibge_municipios WHERE codigo = ?');
    const r: ResultadoDaCarga = { novos: 0, alterados: 0, removidos: 0, iguais: 0, total: lista.length };
    const naLista = new Set<string>();
    for (const m of lista) {
      naLista.add(m.codigo);
      const atual = atuais.get(m.codigo);
      if (!atual) {
        inserir.run(m.codigo, m.nome, m.uf, normalizarParaBusca(m.nome), agora);
        r.novos += 1;
      } else if (atual.nome !== m.nome || atual.uf !== m.uf) {
        atualizar.run(m.nome, m.uf, normalizarParaBusca(m.nome), agora, m.codigo);
        r.alterados += 1;
      } else {
        r.iguais += 1;
      }
    }
    for (const codigo of atuais.keys()) {
      if (!naLista.has(codigo)) {
        remover.run(codigo);
        r.removidos += 1;
      }
    }
    return r;
  });
}

/** Quantos municípios há na tabela. Tabela que ainda não existe = 0. */
export function contarMunicipios(db: DatabaseSync = getConnection()): number {
  try {
    return Number((db.prepare('SELECT COUNT(*) AS c FROM core_ibge_municipios').get() as { c: number }).c);
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return 0;
    throw err;
  }
}

export interface ResultadoDaBusca {
  /** A tabela tem município: o formulário mostra as sugestões. */
  carregada: boolean;
  total: number;
  itens: Municipio[];
}

/**
 * A busca da rota pública: pelo nome sem acento e sem caixa, dentro da UF
 * (quando dada), o começo do nome primeiro, no máximo 20. "santana" acha
 * "Sant'Ana do Livramento" — a comparação também ignora os espaços.
 */
export function buscarMunicipios(entrada: { uf?: unknown; q?: unknown }): ResultadoDaBusca {
  ensureCoreSchema();
  const db = getConnection();
  const sigla = typeof entrada.uf === 'string' ? entrada.uf.trim().toUpperCase() : '';
  if (sigla && !CODIGO_DA_UF[sigla]) {
    throw new ApiError('MUNICIPIOS_UF_INVALIDA', 'UF inválida: use a sigla do estado (RS, SP, RJ…).', 400);
  }
  const total = contarMunicipios(db);
  const termo = normalizarParaBusca(typeof entrada.q === 'string' ? entrada.q.slice(0, 80) : '');
  const colado = termo.replace(/ /g, '');
  if (total === 0 || colado.length < 2) return { carregada: total > 0, total, itens: [] };

  // `termo` só tem [a-z0-9 ]: nenhum curinga do LIKE chega aqui.
  const itens = db
    .prepare(
      `SELECT codigo, nome, uf FROM core_ibge_municipios
        WHERE (? = '' OR uf = ?)
          AND (nome_busca LIKE ? OR replace(nome_busca, ' ', '') LIKE ?)
        ORDER BY CASE WHEN nome_busca LIKE ? OR replace(nome_busca, ' ', '') LIKE ? THEN 0 ELSE 1 END,
                 nome_busca, uf
        LIMIT ?`,
    )
    .all(sigla, sigla, `%${termo}%`, `%${colado}%`, `${termo}%`, `${colado}%`, LIMITE_DA_BUSCA) as unknown as Municipio[];
  return { carregada: true, total, itens: itens.map((m) => ({ codigo: m.codigo, nome: m.nome, uf: m.uf })) };
}

export type ConferenciaDoMunicipio =
  | { tabela: 'vazia' }
  | { tabela: 'carregada'; confere: boolean; municipio: Municipio | null };

/**
 * O código informado é de um município desta UF? Com a tabela vazia a
 * resposta é "não dá para saber" (`tabela: 'vazia'`) — e quem chama aplica a
 * regra de antes (formato e prefixo).
 */
export function conferirMunicipio(codigo: string, uf: string): ConferenciaDoMunicipio {
  ensureCoreSchema();
  const db = getConnection();
  const achado = db
    .prepare('SELECT codigo, nome, uf FROM core_ibge_municipios WHERE codigo = ?')
    .get(codigo) as unknown as Municipio | undefined;
  if (achado) {
    return {
      tabela: 'carregada',
      confere: achado.uf === uf,
      municipio: { codigo: achado.codigo, nome: achado.nome, uf: achado.uf },
    };
  }
  if (!db.prepare('SELECT 1 FROM core_ibge_municipios LIMIT 1').get()) return { tabela: 'vazia' };
  return { tabela: 'carregada', confere: false, municipio: null };
}

/** A frase da recusa, em minúscula (quem chama compõe a frase dele). */
export function porQueNaoConfere(codigo: string, uf: string, municipio: Municipio | null): string {
  return municipio
    ? `o código IBGE ${codigo} é de ${municipio.nome} (${municipio.uf}), não de um município de ${uf}`
    : `o código IBGE ${codigo} não é de nenhum município de ${uf} na tabela oficial do IBGE`;
}

// ─────────────────────────────────────── a nota confere o município (R3-IBGE)
//
// A tabela valia ao SALVAR o endereço e no FECHAMENTO do pedido. Faltava a
// EMISSÃO — o lugar onde o código errado custa mais caro: a SEFAZ recusa a
// nota DEPOIS de numerada (número queimado, inutilização). O pedido fechado
// antes da tabela guarda no retrato o código que o cliente digitou, e o
// emitente aceitava qualquer código de 7 dígitos. As funções abaixo são a
// régua única das duas pontas; com a tabela vazia, nenhuma diz nada (vale a
// regra de antes, o formato).

function soDigitos(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function sigla(uf: string | null | undefined): string {
  return String(uf ?? '').trim().toUpperCase();
}

/**
 * Os dois nomes são da mesma cidade? Sem acento, sem caixa, sem pontuação e
 * sem espaço — "SANTANA DO LIVRAMENTO" é "Sant'Ana do Livramento".
 */
export function mesmoNomeDeCidade(a: string | null | undefined, b: string | null | undefined): boolean {
  const colar = (t: string | null | undefined) => normalizarParaBusca(t ?? '').replace(/ /g, '');
  const x = colar(a);
  return x !== '' && x === colar(b);
}

/**
 * O município do DESTINATÁRIO de uma nota não confere com a tabela?
 *
 * `null` quando não há o que dizer: código fora do formato ou UF desconhecida
 * (a validação do leiaute já cobra os dois), tabela vazia (a regra de antes),
 * ou o código é de um município da UF que a cidade escrita (`cidade`) não
 * contradiz. Senão, o porquê — na frase de `porQueNaoConfere` — e o município
 * do código, quando ele existe.
 */
export function municipioDaNotaQueNaoConfere(
  codigo: string | null | undefined,
  uf: string | null | undefined,
  cidade?: string | null,
): { motivo: string; municipio: Municipio | null } | null {
  const ibge = soDigitos(codigo);
  const estado = sigla(uf);
  if (ibge.length !== 7 || !CODIGO_DA_UF[estado]) return null;
  const conferido = conferirMunicipio(ibge, estado);
  if (conferido.tabela !== 'carregada') return null;
  if (!conferido.confere) {
    return { motivo: porQueNaoConfere(ibge, estado, conferido.municipio), municipio: conferido.municipio };
  }
  /*
    O CÓDIGO É DA UF — MAS DE OUTRA CIDADE DELA? (verificação do R3-IBGE.) Um
    código válido de Porto Alegre num endereço escrito "Pelotas" passa pela
    SEFAZ, e a nota sai AUTORIZADA com o município errado. Só aponta quando o
    nome escrito é, sem dúvida, o de OUTRA cidade da UF (uma só com esse nome):
    nome abreviado, com erro de digitação ou com a UF no fim não contradiz
    nada — o código é da UF, e quem o declara errado não pode ser um palpite.
  */
  const doCodigo = conferido.municipio;
  const escrita = String(cidade ?? '').trim();
  if (!doCodigo || !escrita || mesmaCidadeEscrita(escrita, doCodigo)) return null;
  const outra = municipioPeloNome(escrita, estado);
  if (!outra || outra.codigo === doCodigo.codigo) return null;
  return {
    motivo:
      `o código IBGE ${ibge} é de ${doCodigo.nome} (${doCodigo.uf}), e a cidade escrita no endereço é `
      + `"${escrita}" — outra cidade de ${estado}`,
    municipio: doCodigo,
  };
}

/**
 * O nome escrito sem a UF no fim, quando ela vem separada: "Pelotas - RS",
 * "Pelotas/RS", "Pelotas (RS)" → "pelotas". Só a UF pedida sai; outra fica.
 */
function nomeSemUfNoFim(escrita: string, uf: string): string {
  const n = normalizarParaBusca(escrita);
  const fim = ` ${sigla(uf).toLowerCase()}`;
  return fim.length === 3 && n.endsWith(fim) ? n.slice(0, -3) : n;
}

/**
 * A cidade escrita é a deste município? O nome dele (sem acento, caixa,
 * pontuação e espaço) — ou o nome dele com a UF DELE no fim, o jeito comum de
 * escrever a cidade num cadastro ("Macapá - AP"): o código continua sendo o
 * dela, e a SEFAZ não confere o nome. A UF de outro estado no fim não passa.
 */
function mesmaCidadeEscrita(escrita: string, municipio: Municipio): boolean {
  return (
    mesmoNomeDeCidade(escrita, municipio.nome)
    || mesmoNomeDeCidade(nomeSemUfNoFim(escrita, municipio.uf), municipio.nome)
  );
}

/**
 * A cidade da UF que tem ESTE nome, quando há uma só — a sugestão que a
 * correção do pedido oferece ("pelo nome, Pelotas é 4314407"). Nome que não
 * bate com nenhuma (ou com mais de uma) não sugere nada: quem escolhe é gente.
 * "Pelotas - RS" também é Pelotas: a UF no fim sai na segunda tentativa.
 */
export function municipioPeloNome(nome: string | null | undefined, uf: string | null | undefined): Municipio | null {
  const estado = sigla(uf);
  if (!CODIGO_DA_UF[estado]) return null;
  const buscar = (texto: string): Municipio | null => {
    const colado = normalizarParaBusca(texto).replace(/ /g, '');
    if (!colado) return null;
    ensureCoreSchema();
    const achados = getConnection()
      .prepare(
        `SELECT codigo, nome, uf FROM core_ibge_municipios
          WHERE uf = ? AND replace(nome_busca, ' ', '') = ? LIMIT 2`,
      )
      .all(estado, colado) as unknown as Municipio[];
    return achados.length === 1 ? { codigo: achados[0].codigo, nome: achados[0].nome, uf: achados[0].uf } : null;
  };
  const escrito = String(nome ?? '');
  return buscar(escrito) ?? buscar(nomeSemUfNoFim(escrito, estado));
}

export interface MunicipioDoCadastro {
  codigo: string | null | undefined;
  uf: string | null | undefined;
  cidade: string | null | undefined;
}

/**
 * O que está errado no município de um cadastro (o EMITENTE), dado o que a
 * tabela achou para o código — `null` se nada. Confere as três coisas que
 * andam juntas: o código existe, é da UF, e é da cidade escrita no cadastro.
 * A terceira importa porque a SEFAZ aceita um código válido de OUTRA cidade
 * da mesma UF — e a nota sai autorizada com o município errado.
 */
export function problemaDoMunicipioDoCadastro(e: MunicipioDoCadastro, achado: Municipio | null): string | null {
  const ibge = soDigitos(e.codigo);
  const estado = sigla(e.uf);
  if (!achado) {
    return estado
      ? porQueNaoConfere(ibge, estado, null)
      : `o código IBGE ${ibge} não é de nenhum município na tabela oficial do IBGE`;
  }
  if (estado && achado.uf !== estado) return porQueNaoConfere(ibge, estado, achado);
  const cidade = String(e.cidade ?? '').trim();
  if (cidade && !mesmaCidadeEscrita(cidade, achado)) {
    return `o código IBGE ${ibge} é de ${achado.nome} (${achado.uf}), e a cidade do cadastro é "${cidade}"`;
  }
  return null;
}

/**
 * O município do EMITENTE não confere com a tabela? `null` com a tabela vazia
 * ou com o código fora do formato (o checklist já cobra o formato).
 */
export function municipioDoEmitenteQueNaoConfere(e: MunicipioDoCadastro): string | null {
  const ibge = soDigitos(e.codigo);
  if (ibge.length !== 7) return null;
  ensureCoreSchema();
  const db = getConnection();
  const achado = db
    .prepare('SELECT codigo, nome, uf FROM core_ibge_municipios WHERE codigo = ?')
    .get(ibge) as unknown as Municipio | undefined;
  if (!achado && !db.prepare('SELECT 1 FROM core_ibge_municipios LIMIT 1').get()) return null;
  return problemaDoMunicipioDoCadastro(e, achado ? { codigo: achado.codigo, nome: achado.nome, uf: achado.uf } : null);
}

export interface EmitenteForaDaTabela {
  /** A razão social (ou o nome fantasia) da operação. */
  empresa: string;
  codigo: string;
  motivo: string;
}

/**
 * Os emitentes cujo município não confere com a tabela — para a conferência
 * da implantação. Recebe a conexão porque, antes de subir, o banco é aberto
 * SÓ PARA LEITURA (nada aqui cria tabela). `null` quando não há o que
 * conferir: tabela vazia, ou nenhum emitente com código de 7 dígitos.
 */
export function emitentesForaDaTabela(
  db: DatabaseSync = getConnection(),
): { conferidos: number; fora: EmitenteForaDaTabela[] } | null {
  if (contarMunicipios(db) === 0) return null;
  let linhas: Array<Record<string, string | null>>;
  try {
    linhas = db
      .prepare(
        `SELECT f.company_id, f.legal_name, f.trade_name, f.city_ibge, f.uf, f.city_name,
                m.codigo AS m_codigo, m.nome AS m_nome, m.uf AS m_uf
           FROM core_fiscal_configs f
           LEFT JOIN core_ibge_municipios m ON m.codigo = f.city_ibge
          ORDER BY f.legal_name, f.company_id`,
      )
      .all() as unknown as Array<Record<string, string | null>>;
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return null;
    throw err;
  }
  let conferidos = 0;
  const fora: EmitenteForaDaTabela[] = [];
  for (const l of linhas) {
    const ibge = soDigitos(l.city_ibge);
    if (ibge.length !== 7) continue;
    conferidos += 1;
    const achado = l.m_codigo ? { codigo: String(l.m_codigo), nome: String(l.m_nome), uf: String(l.m_uf) } : null;
    const motivo = problemaDoMunicipioDoCadastro({ codigo: ibge, uf: l.uf, cidade: l.city_name }, achado);
    if (motivo) {
      fora.push({ empresa: String(l.legal_name || l.trade_name || l.company_id), codigo: ibge, motivo });
    }
  }
  return conferidos === 0 ? null : { conferidos, fora };
}

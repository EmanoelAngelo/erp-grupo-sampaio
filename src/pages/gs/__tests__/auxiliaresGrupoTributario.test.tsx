/**
 * ============================================================================
 * EDITAR O NOME DO GRUPO TRIBUTÁRIO APAGAVA QUATRO COLUNAS
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * `upsertTaxGroup` grava TODAS as colunas do grupo a cada salvar, e
 * `opcional(undefined)` devolve `null`. O formulário desta tela montava o corpo
 * com DOZE chaves — e o grupo tem QUINZE colunas graváveis. Faltavam
 * `cfopInternal`, `cfopExternal`, `origin` e `cstIcms`.
 *
 * Consequência: abrir um grupo, corrigir o NOME e salvar apagava o CFOP
 * interno, o CFOP interestadual, a origem da mercadoria e o CST de ICMS — em
 * silêncio, sem aviso nenhum, com a tela dizendo "Grupo salvo.".
 *
 * O estrago aparecia longe: `TributacaoDoItem` passa a recusar a emissão de
 * TODO produto sem CFOP próprio ("não tem CFOP, e o grupo X não tem CFOP
 * interno"), e em regime normal a recusa vira "não tem CST de ICMS". Com o
 * cliente no balcão, meses depois de alguém ter corrigido um acento.
 *
 * O comentário no próprio arquivo já descrevia este defeito e dizia que o
 * formulário "tinha seis campos e o grupo tem treze". Entraram PIS, COFINS,
 * pCredSN e IPI; estes quatro ficaram para trás. É a assinatura da LISTA POR
 * COMPLEMENTO: uma relação de campos escrita à mão, que alguém tem de lembrar
 * de completar sempre que uma coluna nasce — e ninguém lembra.
 *
 * ## O QUE ESTE ARQUIVO COBRE: A CLASSE, NÃO OS QUATRO CAMPOS
 *
 * Um teste por campo esquecido ficaria verde no dia em que a décima sexta
 * coluna nascesse. O caso central percorre TODAS as colunas graváveis do grupo
 * e exige que salvar-só-o-nome devolva cada uma como veio. E o conserto do
 * lado do código é do mesmo tamanho: um `Record` TOTAL sobre as chaves do tipo
 * `GrupoTributario`, que deixa de COMPILAR quando uma coluna entra sem
 * formulário.
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *   - tire uma coluna do mapa do corpo e o caso da varredura acusa qual;
 *   - deixe de CARREGAR uma coluna no "Editar" e ela viaja vazia — o corpo tem
 *     a chave e o valor é nulo, que é exatamente o defeito original;
 *   - tire o campo da tela e não há como preencher o que o salvar reescreve.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import AuxiliaresCatalogoPage from '../AuxiliaresCatalogoPage';

/**
 * Um grupo COM TUDO PREENCHIDO, como `listTaxGroups` o devolve (`SELECT g.*`,
 * portanto snake_case cru do banco).
 */
const GRUPO_COMPLETO = {
  id: 'tg-1',
  code: 'PADRAO',
  name: 'Padrão',
  regime: 'simples',
  ncm: '23061000',
  cest: '2806200',
  cfop_internal: '5102',
  cfop_external: '6102',
  origin: '0',
  cst_icms: '00',
  csosn: '102',
  p_cred_sn: '2.50',
  cst_pis: '49',
  cst_cofins: '49',
  cst_ipi: '53',
  ipi_rate_code: 'IPI0',
  // As quatro colunas do ICMS do regime normal (GAP-PRD-021): a varredura
  // exige que também elas voltem como vieram.
  icms_rate_code: 'ICMS17',
  p_red_bc: '41.18',
  fcp_rate_code: 'FCP2',
  c_benef: 'RS801001',
  active: 1,
  usage: 7,
};

/**
 * O MAPA TOTAL DA VARREDURA: coluna do banco → chave que o servidor lê.
 *
 * É a mesma relação que `upsertTaxGroup` consome (`input.cfopInternal`,
 * `input.cstIcms`, …). Escrita aqui de novo, de propósito: se o conserto
 * mudasse a tela e o teste ao mesmo tempo pela mesma constante, os dois
 * concordariam sobre uma lista incompleta.
 */
const COLUNAS_GRAVAVEIS: [keyof typeof GRUPO_COMPLETO, string][] = [
  ['code', 'code'],
  ['name', 'name'],
  ['regime', 'regime'],
  ['ncm', 'ncm'],
  ['cest', 'cest'],
  ['cfop_internal', 'cfopInternal'],
  ['cfop_external', 'cfopExternal'],
  ['origin', 'origin'],
  ['cst_icms', 'cstIcms'],
  ['csosn', 'csosn'],
  ['p_cred_sn', 'pCredSn'],
  ['cst_pis', 'cstPis'],
  ['cst_cofins', 'cstCofins'],
  ['cst_ipi', 'cstIpi'],
  ['ipi_rate_code', 'ipiRateCode'],
  ['icms_rate_code', 'icmsRateCode'],
  ['p_red_bc', 'pRedBc'],
  ['fcp_rate_code', 'fcpRateCode'],
  ['c_benef', 'cBenef'],
];

const ALIQUOTAS = [
  { id: 'a-1', code: 'IPI0', name: 'IPI zero', kind: 'ipi', percent: 0, active: 1 },
  { id: 'a-2', code: 'ICMS17', name: 'ICMS 17%', kind: 'icms', percent: 17, active: 1 },
  { id: 'a-3', code: 'FCP2', name: 'FCP 2%', kind: 'fcp', percent: 2, active: 1 },
];

let salvamentos: Record<string, unknown>[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/catalog/tax-groups') && metodo === 'POST') {
      salvamentos.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json(GRUPO_COMPLETO, 201);
    }
    if (alvo.includes('/core/catalog/aux')) {
      return json({
        units: [],
        taxGroups: [GRUPO_COMPLETO],
        taxRates: ALIQUOTAS,
        priceTables: [],
      });
    }
    if (alvo.includes('/core/catalog/custom-fields')) return json({ fields: [] });
    return json({ items: [] });
  });
}

function entrarComoGerente() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do formulário de grupo tributário',
  );
}

beforeEach(() => {
  salvamentos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGerente();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirAbaDeGrupos() {
  render(
    <MemoryRouter>
      <AuxiliaresCatalogoPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Grupos tributários' }));
  await screen.findByText('PADRAO');
}

/** Abre o grupo no formulário pelo botão "Editar" da linha dele. */
async function editarOGrupo() {
  const linha = (await screen.findByText('PADRAO')).closest('tr')!;
  fireEvent.click(within(linha).getByRole('button', { name: 'Editar' }));
  await screen.findByText(/Editando PADRAO/);
}

async function salvar() {
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(salvamentos).toHaveLength(1));
  return salvamentos[0];
}

describe('salvar o grupo tributário reescreve TODAS as colunas — então precisa levá-las', () => {
  it('corrigir só o NOME preserva cada uma das colunas graváveis', async () => {
    await abrirAbaDeGrupos();
    await editarOGrupo();

    // O gesto que quebrava tudo: mexer no nome e salvar.
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Padrão revisado' } });
    const corpo = await salvar();

    // A VARREDURA: coluna por coluna, o corpo tem de repetir o que veio.
    const apagadas: string[] = [];
    for (const [coluna, chave] of COLUNAS_GRAVAVEIS) {
      const esperado = coluna === 'name' ? 'Padrão revisado' : GRUPO_COMPLETO[coluna];
      if (String(corpo[chave] ?? '') !== String(esperado)) {
        apagadas.push(`${coluna} → corpo.${chave} = ${JSON.stringify(corpo[chave])}`);
      }
    }
    expect(apagadas).toEqual([]);

    // E o id viaja: sem ele o POST criaria um segundo grupo com o mesmo código.
    expect(corpo.id).toBe('tg-1');
  });

  it('os quatro campos que faltavam existem NA TELA — não dá para preencher o que não se vê', async () => {
    await abrirAbaDeGrupos();
    await editarOGrupo();

    // Carregados com o valor do grupo: o "Editar" precisa trazê-los, senão o
    // salvar os manda vazios mesmo com a chave no corpo.
    expect((screen.getByLabelText(/CFOP interno/i) as HTMLInputElement).value).toBe('5102');
    expect((screen.getByLabelText(/CFOP interestadual/i) as HTMLInputElement).value).toBe('6102');
    expect((screen.getByLabelText(/Origem da mercadoria/i) as HTMLSelectElement).value).toBe('0');
    expect((screen.getByLabelText(/CST de ICMS/i) as HTMLInputElement).value).toBe('00');
  });

  it('o que se digita nos campos novos chega ao servidor', async () => {
    await abrirAbaDeGrupos();
    await editarOGrupo();

    fireEvent.change(screen.getByLabelText(/CFOP interno/i), { target: { value: '5405' } });
    fireEvent.change(screen.getByLabelText(/CFOP interestadual/i), { target: { value: '6404' } });
    fireEvent.change(screen.getByLabelText(/Origem da mercadoria/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/CST de ICMS/i), { target: { value: '60' } });

    const corpo = await salvar();
    expect(corpo.cfopInternal).toBe('5405');
    expect(corpo.cfopExternal).toBe('6404');
    expect(corpo.origin).toBe('1');
    expect(corpo.cstIcms).toBe('60');
  });

  it('grupo NOVO nasce com o formulário limpo — nada herdado da edição anterior', async () => {
    await abrirAbaDeGrupos();
    await editarOGrupo();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await screen.findByText('Novo grupo tributário');
    expect((screen.getByLabelText(/CFOP interno/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/CST de ICMS/i) as HTMLInputElement).value).toBe('');
    // Sem `id`, o POST cria — com o id herdado, ele SOBRESCREVERIA o grupo que
    // acabou de sair da tela.
    fireEvent.change(screen.getByLabelText(/^Código/), { target: { value: 'NOVO' } });
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Grupo novo' } });
    const corpo = await salvar();
    expect(corpo.id).toBeUndefined();
  });
});
